import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AGENTS, OWN_SOURCE, changeManifest, parseArgs, runCommand, runDryruns, sync, validateManifest } from '../sync.mjs';

const agents = [...AGENTS.keys()];
const entry = (name, source = 'example/skills', auto_sync = true) => ({ name, source, auto_sync });
const catalog = { agents, skills: [entry('one'), entry('two')] };
const stateRoot = mkdtempSync(join(tmpdir(), 'sync-state-test-'));
after(() => rmSync(stateRoot, { recursive: true, force: true }));
const record = (name, targets = agents, source = 'example/skills', sourceType = 'github') => ({
  name, source, sourceType, scope: 'global', path: join(tmpdir(), 'fixture-installed', name), agents: targets.map((agent) => AGENTS.get(agent)),
});
const temporary = (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'sync-test-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
};

function harness({ manifest = catalog, installed = [], failure, result, dryrun } = {}) {
  const calls = [], events = [], logs = [];
  return {
    calls, events, logs, installed,
    dependencies: {
      stateDir: mkdtempSync(join(stateRoot, 'profile-')),
      fetchManifest: () => { events.push('fetch'); return JSON.stringify(manifest); },
      log: (text) => logs.push(text),
      runDryruns: (entries) => { events.push('dryrun'); dryrun?.(entries); },
      runSkills: (args) => {
        calls.push(args); events.push(args[0]);
        if (failure?.(args)) throw new Error('fixture failure');
        if (args[0] === 'list') return JSON.stringify(installed);
        if (args[0] === 'remove') {
          const index = installed.findIndex((item) => item.name === args[1]);
          if (index >= 0) {
            const removed = args.slice(args.indexOf('--agent') + 1).map((agent) => AGENTS.get(agent));
            installed[index].agents = installed[index].agents.filter((agent) => !removed.includes(agent));
            if (!installed[index].agents.length) installed.splice(index, 1);
          }
          return '';
        }
        const names = args.slice(args.indexOf('--skill') + 1, args.indexOf('--agent'));
        const targets = args.slice(args.indexOf('--agent') + 1, args.indexOf('-g'));
        if (result !== undefined) return JSON.stringify(result);
        for (const name of names) {
          const current = installed.find((item) => item.name === name);
          if (current) Object.assign(current, record(name, [...new Set([...targets, ...agents.filter((agent) => current.agents.includes(AGENTS.get(agent)))])], args[1]));
          else installed.push(record(name, targets, args[1]));
        }
        return JSON.stringify(names.map((name) => ({ ...record(name, targets, args[1]), status: 'installed' })));
      },
    },
    run(args = [], dependencies = {}) { return sync(args, { ...this.dependencies, ...dependencies }); },
  };
}

test('every sync reinstalls selected skills and runs dryrun', () => {
  const fixture = harness(); fixture.run();
  assert.deepEqual(fixture.calls[1], ['add', 'example/skills', '--skill', 'one', 'two', '--agent', ...agents, '-g', '--yes', '--json']);
  fixture.run();
  assert.equal(fixture.calls.filter((args) => args[0] === 'add').length, 2);
  assert.equal(fixture.events.filter((event) => event === 'dryrun').length, 2);
  assert.equal(fixture.events.filter((event) => event === 'fetch').length, 2);
});

test('sync reinstalls all targets including previously installed agents', () => {
  const fixture = harness({ installed: [record('one', ['codex']), record('two', ['github-copilot'])] });
  fixture.run();
  assert.deepEqual(fixture.calls[1], ['add', 'example/skills', '--skill', 'one', 'two', '--agent', ...agents, '-g', '--yes', '--json']);
  fixture.run();
  assert.equal(fixture.calls.filter((args) => args[0] === 'add').length, 2);
});

test('shared installations are overwritten even when Codex and Copilot apps are undetected', () => {
  const shared = join(tmpdir(), 'shared');
  const fixture = harness({ installed: ['one', 'two'].map((name) => ({ ...record(name, []), path: join(shared, name) })) });
  fixture.run([], { sharedSkillsDir: shared });
  assert.equal(fixture.calls.length, 2);
  assert.deepEqual(fixture.calls[1], ['add', 'example/skills', '--skill', 'one', 'two', '--agent', ...agents, '-g', '--yes', '--json']);
});

test('overwrite is scoped, source conflicts are checked before installs, untracked records are adopted', () => {
  const fixture = harness({ installed: [record('one'), record('two'), record('other', agents, 'different/repo')] });
  fixture.run(); assert.equal(fixture.calls.length, 2);
  assert.deepEqual(fixture.calls[1].slice(fixture.calls[1].indexOf('--agent') + 1, fixture.calls[1].indexOf('-g')), agents);
  assert.ok(!fixture.calls[1].includes('other'));
  const conflict = harness({ installed: [record('two', agents, 'other/repo')] });
  assert.throws(() => conflict.run(), /来源冲突/); assert.equal(conflict.calls.length, 1);
  const legacy = harness({ installed: [record('one', agents, null, null), record('two', agents, 'EXAMPLE/Skills')] });
  legacy.run(); assert.deepEqual(legacy.calls[1].slice(2, 4), ['--skill', 'one']);
});

test('own and third-party skills are grouped by source and overwritten on every sync', () => {
  const own = 'Charbddlie/everything-harness';
  const manifest = { agents: ['codex'], skills: [entry('one', own), entry('two'), entry('three', own), entry('disabled', own, false)] };
  const fixture = harness({ manifest, installed: manifest.skills.map((item) => record(item.name, ['codex'], item.source)) });
  fixture.run();
  fixture.run();
  const installs = fixture.calls.filter((args) => args[0] === 'add');
  assert.equal(installs.length, 4);
  assert.deepEqual(installs[0], ['add', own, '--skill', 'one', 'three', '--agent', 'codex', '-g', '--yes', '--json']);
  assert.deepEqual(installs[1], ['add', 'example/skills', '--skill', 'two', '--agent', 'codex', '-g', '--yes', '--json']);
  assert.deepEqual(installs.slice(2), installs.slice(0, 2));
});

test('invalid manifests and arguments fail before install', () => {
  for (const manifest of [null, [], {}, { agents, skills: 'bad' }, { agents, skills: [entry('one'), entry('one')] },
    { agents, skills: [entry('*')] }, { agents, skills: [{ ...entry('one'), agents: ['codex'] }] },
    ...['a/..', 'a/b/tree/main', 'a/b;whoami', 'https://github.com/a/b', '-a/b', 'a/b.git'].map((source) => ({ agents, skills: [entry('one', source)] }))]) {
    const fixture = harness({ manifest }); assert.throws(() => fixture.run()); assert.equal(fixture.calls.length, 0);
  }
  for (const args of [['--add'], ['--del'], ['--agents'], ['--agents', 'codex', 'codex'], ['--update'], ['--update', '--add', 'a/b', 'one'], ['--wat'], ['--list', '--del', 'one']]) {
    assert.throws(() => parseArgs(args));
  }
  assert.deepEqual(validateManifest({ agents, skills: [] }), { agents, skills: [] });
});

const localPath = (fixture) => join(fixture.dependencies.stateDir, 'harness.json');
const localManifest = (fixture) => JSON.parse(readFileSync(localPath(fixture), 'utf8'));
const setLocal = (fixture, skills) => writeFileSync(localPath(fixture), JSON.stringify({ skills }, null, 2) + '\n');

test('global remote targets apply to every skill on every sync', () => {
  const manifest = { ...catalog, agents: ['codex'] };
  const fixture = harness({ manifest });
  fixture.run();
  assert.deepEqual(fixture.calls[1], ['add', 'example/skills', '--skill', 'one', 'two', '--agent', 'codex', '-g', '--yes', '--json']);
  fixture.run();
  assert.equal(fixture.calls.filter((args) => args[0] === 'add').length, 2);
  manifest.agents.push('github-copilot');
  fixture.run();
  assert.deepEqual(fixture.calls.at(-1), ['add', 'example/skills', '--skill', 'one', 'two', '--agent', 'codex', 'github-copilot', '-g', '--yes', '--json']);
  assert.deepEqual(localManifest(fixture), { skills: [], fragments: [] });
});

test('local global agents replace remote targets for sync, add and del while keeping skill overrides', () => {
  const manifest = { ...catalog, agents: ['codex'] };
  const fixture = harness({ manifest });
  setLocal(fixture, [entry('one', 'example/skills', false)]);
  fixture.dependencies.runGit = () => assert.fail('local mode must not call Git');
  fixture.run(['--local', '--add_agents', 'github-copilot']);
  fixture.run(['--del_agents', 'codex', '--local']);
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual(localManifest(fixture), { agents: ['github-copilot'], skills: [entry('one', 'example/skills', false)] });
  fixture.run();
  assert.deepEqual(fixture.calls.at(-1), ['add', 'example/skills', '--skill', 'two', '--agent', 'github-copilot', '-g', '--yes', '--json']);
  manifest.agents.push('github-copilot');
  fixture.run();
  assert.deepEqual(fixture.calls.at(-1), ['add', 'example/skills', '--skill', 'two', '--agent', 'github-copilot', '-g', '--yes', '--json']);
  fixture.run(['--local', '--add', 'one']);
  assert.deepEqual(fixture.calls.at(-1), ['add', 'example/skills', '--skill', 'one', '--agent', 'github-copilot', '-g', '--yes', '--json']);
  fixture.installed.find((item) => item.name === 'one').agents.push('Codex');
  fixture.run(['--local', '--del', 'one']);
  assert.deepEqual(fixture.calls.find((args) => args[0] === 'remove'), ['remove', 'one', '-g', '--yes', '--agent', 'github-copilot']);
  assert.deepEqual(fixture.installed.find((item) => item.name === 'one').agents, ['Codex']);
  assert.deepEqual(localManifest(fixture).agents, ['github-copilot']);
  fixture.run(['--list']);
  assert.ok(fixture.logs.some((line) => line.includes('远程 agents：codex, github-copilot\n本机 agents：github-copilot\n生效 agents：github-copilot')));
});

test('empty global targets disable operations without removing installations; agents can be re-enabled', () => {
  const fixture = harness({ installed: [record('one')] });
  fixture.run(['--local', '--del_agents', ...agents]);
  assert.deepEqual(localManifest(fixture), { agents: [], skills: [], fragments: [] });
  for (const args of [[], ['--dryrun']]) fixture.run(args);
  fixture.run(['--list']);
  assert.ok(fixture.logs.some((line) => line.includes('本机 agents：无\n生效 agents：无')));
  assert.equal(fixture.calls.length, 0);
  for (const mode of ['--add', '--del']) assert.throws(() => fixture.run(['--local', mode, 'one']), /agents 为空/);
  assert.deepEqual(localManifest(fixture).skills, []);
  assert.equal(fixture.calls.length, 0);
  fixture.run(['--local', '--add_agents', 'codex']);
  fixture.run();
  assert.deepEqual(fixture.calls.at(-1), ['add', 'example/skills', '--skill', 'one', 'two', '--agent', 'codex', '-g', '--yes', '--json']);
  const emptyRemote = harness({ manifest: { ...catalog, agents: [] } });
  emptyRemote.run();
  assert.equal(emptyRemote.calls.length, 0);
});

test('invalid global agents and agent arguments fail before any skill operation', () => {
  for (const value of [undefined, null, 'codex', ['unknown'], ['codex', 'codex'], [12]]) {
    const remote = harness({ manifest: { ...catalog, agents: value } });
    assert.throws(() => remote.run(), /agent/);
    assert.equal(remote.calls.length, 0);
    if (value === undefined) continue; // Missing local agents means inherit.
    const local = harness();
    writeFileSync(localPath(local), JSON.stringify({ agents: value, skills: [] }));
    assert.throws(() => local.run(), /agent/);
    assert.equal(local.calls.length, 0);
  }
  for (const args of [['--add_agents'], ['--del_agents'], ['--add_agents', 'unknown'], ['--del_agents', 'codex', 'codex'],
    ['--add_agents', 'codex', '--del_agents', 'github-copilot'], ['--add_agents', 'codex', '--update']]) assert.throws(() => parseArgs(args));
});

test('auto_sync defaults and local overrides control repeated sync and dryrun', () => {
  const manifest = { agents, skills: [entry('one'), entry('two', 'example/skills', false), entry('three')] };
  const fixture = harness({ manifest });
  setLocal(fixture, [entry('one', 'example/skills', false), entry('two')]);
  const before = readFileSync(localPath(fixture), 'utf8');
  const checked = [];
  fixture.dependencies.runDryruns = (entries) => checked.push(entries.map((item) => item.name));
  fixture.run();
  assert.deepEqual(fixture.calls[1].slice(3, 5), ['two', 'three']);
  fixture.run();
  assert.deepEqual(fixture.calls.at(-1).slice(3, 5), ['two', 'three']);
  fixture.run(['--dryrun']);
  assert.deepEqual(checked, [['two', 'three'], ['two', 'three'], ['two', 'three']]);
  assert.equal(readFileSync(localPath(fixture), 'utf8'), before);
  assert.ok(!fixture.calls.some((args) => args[0] === 'remove'));
});

test('first sync initializes an empty local manifest so future remote defaults still take effect', () => {
  const manifest = { agents, skills: [entry('one', 'example/skills', false)] };
  const fixture = harness({ manifest });
  fixture.run();
  assert.deepEqual(localManifest(fixture), { skills: [], fragments: [] });
  assert.equal(fixture.calls.length, 0);
  manifest.skills[0].auto_sync = true;
  fixture.run();
  assert.equal(fixture.calls.filter((args) => args[0] === 'add').length, 1);
});

test('old per-skill local agents are ignored while sync overrides are retained', () => {
  const fixture = harness();
  setLocal(fixture, [{ ...entry('one', 'example/skills', false), agents: ['codex'] }, { ...entry('two'), agents: ['codex'] }]);
  fixture.run();
  assert.deepEqual(fixture.calls[1], ['add', 'example/skills', '--skill', 'two', '--agent', ...agents, '-g', '--yes', '--json']);
  fixture.run(['--local', '--auto_sync', 'false', 'two']);
  assert.equal(localManifest(fixture).skills[0].auto_sync, false);
  assert.ok(localManifest(fixture).skills.every((item) => !Object.hasOwn(item, 'agents')));
});

test('local add and del operate first, save overrides, and never use Git or mutate the remote catalog', () => {
  const manifest = { agents, skills: [entry('one', 'example/skills', false), entry('two')] };
  const fixture = harness({ manifest });
  const before = JSON.stringify(manifest);
  fixture.dependencies.runGit = () => assert.fail('local mode must not call Git');
  fixture.dependencies.runDryruns = () => assert.equal(existsSync(localPath(fixture)), false);
  fixture.run(['--add', 'one', '--local']);
  assert.equal(localManifest(fixture).skills[0].auto_sync, true);
  fixture.run(['--local', '--del', 'one']);
  assert.equal(localManifest(fixture).skills[0].auto_sync, false);
  assert.equal(fixture.calls.filter((args) => args[0] === 'remove').length, 1);
  fixture.dependencies.runDryruns = () => {};
  fixture.run();
  assert.ok(!fixture.installed.some((item) => item.name === 'one'));
  assert.equal(JSON.stringify(manifest), before);
});

test('failed local installs, dryruns, and removals preserve settings; retry completes them', () => {
  for (const fixture of [harness({ failure: (args) => args[0] === 'add' }), harness({ dryrun: () => { throw new Error('environment'); } })]) {
    setLocal(fixture, [entry('one', 'example/skills', false)]);
    const before = readFileSync(localPath(fixture), 'utf8');
    assert.throws(() => fixture.run(['--local', '--add', 'one']));
    assert.equal(readFileSync(localPath(fixture), 'utf8'), before);
  }
  const fixture = harness({ installed: [record('one')], failure: (args) => args[0] === 'remove' });
  setLocal(fixture, [entry('one')]);
  const before = readFileSync(localPath(fixture), 'utf8');
  assert.throws(() => fixture.run(['--local', '--del', 'one']), /删除失败/);
  assert.equal(readFileSync(localPath(fixture), 'utf8'), before);
  fixture.installed.length = 0;
  fixture.run(['--local', '--del', 'one']);
  assert.equal(localManifest(fixture).skills[0].auto_sync, false);
});

test('local auto_sync changes only overrides; list shows remote, local and effective states', () => {
  const fixture = harness({ manifest: { agents, skills: [entry('one'), entry('two', 'example/skills', false), entry('three')] } });
  fixture.run(['--local', '--auto_sync', 'false', 'one']);
  fixture.run(['--auto_sync', 'true', 'two', '--local']);
  assert.equal(fixture.calls.length, 0);
  fixture.run(['--local', '--list']);
  const rows = fixture.logs.at(-1).split('\n').map((line) => line.split('\t'));
  assert.deepEqual(rows.map((row) => [row[0], ...row.slice(2, 5)]), [
    ['one', 'true', 'false', 'false'], ['two', 'false', 'true', 'true'], ['three', 'true', '跟随远程', 'true'],
  ]);
  assert.ok(fixture.logs.some((line) => line.includes(`远程 agents：${agents.join(', ')}\n本机 agents：跟随远程\n生效 agents：${agents.join(', ')}`)));
});

test('invalid boolean settings, local manifests and auto_sync arguments fail before operations', () => {
  for (const value of [undefined, 'true', 'false', null, 0]) {
    const fixture = harness({ manifest: { agents, skills: [{ ...entry('one'), auto_sync: value }] } });
    assert.throws(() => fixture.run(), /auto_sync/);
    assert.equal(fixture.calls.length, 0);
  }
  const fixture = harness();
  writeFileSync(localPath(fixture), '{bad');
  assert.throws(() => fixture.run(), /有效 JSON/);
  assert.equal(fixture.calls.length, 0);
  for (const args of [['--auto_sync', 'yes', 'one'], ['--auto_sync', 'false'], ['--auto_sync', 'true', 'one', '--agents', 'codex'],
    ['--auto_sync', 'true', 'one', '--update'], ['--local', '--local', '--list'], ['--local', '--add', 'owner/repo', 'one']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('concurrent local changes are preserved and unknown names fail before touching installations', () => {
  const fixture = harness({ dryrun: () => setLocal(fixture, [entry('two', 'example/skills', false)]) });
  assert.throws(() => fixture.run(['--local', '--add', 'one']), /已被修改/);
  assert.deepEqual(localManifest(fixture).skills.map((item) => item.name), ['two']);
  const other = harness();
  assert.throws(() => other.run(['--local', '--add', 'one', 'unknown']), /不存在/);
  assert.equal(other.calls.length, 0);
});

test('CLI errors and incomplete add results cannot publish success', () => {
  const failed = harness({ failure: (args) => args[0] === 'add' });
  assert.throws(() => failed.run(), /example\/skills.*失败/);
  assert.ok(!failed.events.includes('dryrun'));
  for (const result of [[], {}, [{ name: 'one', status: 'failed' }]]) assert.throws(() => harness({ result }).run());
  assert.throws(() => runCommand(process.execPath, ['-e', 'process.exit(7)']), /退出码 7/);
  assert.throws(() => runCommand('no-such-everything-harness-command', []), /无法执行/);
});

test('list always reads the remote manifest; dryrun never installs', (t) => {
  const root = repository(t), fixture = harness();
  fixture.run(['--list'], { cwd: root });
  assert.equal(fixture.calls.length, 0);
  assert.ok(fixture.logs.at(-1).includes('two')); // absent from the local checkout
  assert.deepEqual(fixture.events, ['fetch']);
  fixture.run(['--dryrun']); assert.deepEqual(fixture.calls, [['list', '-g', '--json']]);
});

test('dryruns report every failure, execute third-party entries, and require own script checks', (t) => {
  const root = temporary(t), logs = [], installed = new Map();
  for (const name of ['one', 'two']) {
    const path = join(root, name); mkdirSync(path);
    writeFileSync(join(path, 'dryrun.mjs'), `console.error('missing-${name}'); process.exitCode = 1;`);
    installed.set(name, { path });
  }
  assert.throws(() => runDryruns(catalog.skills, installed, { log: (line) => logs.push(line) }), /2 个 skill/);
  assert.deepEqual(logs, ['[one] 失败：missing-one', '[two] 失败：missing-two']);
  const path = join(root, 'own'); mkdirSync(join(path, 'scripts'), { recursive: true });
  writeFileSync(join(path, 'scripts', 'helper.mjs'), '');
  logs.length = 0;
  assert.throws(() => runDryruns([entry('own', 'Charbddlie/everything-harness'), entry('absent')], new Map([['own', { path }]]), { log: (line) => logs.push(line) }), /2 个 skill/);
  assert.deepEqual(logs, ['[own] 失败：包含脚本但缺少 dryrun.mjs，请更新此 skill', '[absent] 失败：尚未安装，无法检查环境']);
});

test('dryruns print one result per skill and preserve failure reasons without duplicate labels', (t) => {
  const root = temporary(t), logs = [], installed = new Map();
  const scripts = {
    failed: "console.error('[failed] 失败：missing key'); console.error('[failed] missing curl'); process.exitCode = 1;",
    passed: "console.log('[passed] verbose success details'); console.error('diagnostic output');",
    skipped: null,
    silent: 'process.exitCode = 2;',
  };
  for (const [name, script] of Object.entries(scripts)) {
    const path = join(root, name); mkdirSync(path);
    if (script !== null) writeFileSync(join(path, 'dryrun.mjs'), script);
    installed.set(name, { path });
  }
  assert.throws(() => runDryruns(Object.keys(scripts).map((name) => entry(name)), installed, { log: (line) => logs.push(line) }), /2 个 skill/);
  assert.deepEqual(logs, [
    '[failed] 失败：missing key；missing curl',
    '[passed] 通过',
    '[skipped] 跳过：无检查脚本',
    '[silent] 失败：检查脚本退出：2',
  ]);
});

function repository(t, manifest = { agents, skills: [entry('one')] }, files = {}) {
  const base = temporary(t), root = join(base, 'local'), remote = join(base, 'remote.git'); mkdirSync(root);
  runCommand('git', ['init', '--bare', remote]);
  runCommand('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  const git = (args) => runCommand('git', args, { cwd: root });
  git(['init']); git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(['config', 'user.name', 'Skill Test']); git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'core.hooksPath', join(base, 'no-hooks')]); git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'harness.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(root, 'sync.mjs'), '// test repository\n');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git(['add', '.']); git(['commit', '-m', 'Initial']); git(['remote', 'add', 'origin', remote]); git(['push', '-u', 'origin', 'main']);
  return root;
}

function managed(root) {
  const tempDir = join(dirname(root), 'operations'); mkdirSync(tempDir, { recursive: true });
  return {
    repositoryUrl: join(dirname(root), 'remote.git'), tempDir, cwd: tempDir,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Skill Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Skill Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: join(tempDir, 'no-hooks') },
  };
}

const remoteManifest = (options) => JSON.parse(runCommand('git', ['--git-dir', options.repositoryUrl, 'show', 'main:harness.json']));

for (const fragments of [false, true]) {
  for (const deleted of [false, true]) {
    test(`remote deletion removes ${fragments ? 'fragment file' : 'entire own skill directory'} with deleted=${deleted}`, (t) => {
      const key = fragments ? 'fragments' : 'skills';
      const target = { ...(fragments ? { name: 'one', auto_sync: true } : entry('one', OWN_SOURCE.toUpperCase())),
        ...(deleted ? { auto_sync: false, deleted: true } : {}) };
      const manifest = { agents, skills: [], [key]: [target] };
      const removed = fragments ? ['agents-md/one.md'] : ['skills/one/SKILL.md', 'skills/one/scripts/helper.mjs', 'skills/one/assets/input.txt'];
      const preserved = ['skills/one-more/SKILL.md', 'agents-md/one-more.md', fragments ? 'skills/one/SKILL.md' : 'agents-md/one.md'];
      const files = Object.fromEntries([...removed, ...preserved].map((path) => [path, 'fixture\n']));
      const root = repository(t, manifest, files), options = managed(root), fixture = harness();
      options.env.CODEX_HOME = join(root, 'codex');
      options.env.COPILOT_HOME = join(root, 'copilot');
      const args = [...(fragments ? ['--fragments'] : []), '--del', 'one'];
      fixture.run(args, options);
      const remoteFiles = runCommand('git', ['--git-dir', options.repositoryUrl, 'ls-tree', '-r', '--name-only', 'main']).trim().split('\n');
      for (const path of removed) assert.ok(!remoteFiles.includes(path), path);
      for (const path of preserved) assert.ok(remoteFiles.includes(path), path);
      assert.deepEqual(remoteManifest(options)[key], [{ ...target, auto_sync: false, deleted: true }]);
      const changed = runCommand('git', ['--git-dir', options.repositoryUrl, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'main']).trim().split('\n');
      assert.deepEqual(changed.sort(), [...removed, ...(deleted ? [] : ['harness.json'])].sort());
      for (const path of removed) assert.equal(readFileSync(join(root, path), 'utf8'), files[path]);
      const revision = () => runCommand('git', ['--git-dir', options.repositoryUrl, 'rev-parse', 'main']);
      const head = revision();
      fixture.run(args, options);
      assert.equal(revision(), head);
      assert.deepEqual(readdirSync(options.tempDir), []);
    });
  }
}

test('third-party deletion preserves same-named repository source', (t) => {
  const path = 'skills/one/SKILL.md';
  const options = managed(repository(t, { agents, skills: [entry('one')] }, { [path]: 'keep\n' }));
  harness().run(['--del', 'one'], options);
  assert.equal(runCommand('git', ['--git-dir', options.repositoryUrl, 'show', `main:${path}`]), 'keep\n');
  assert.equal(remoteManifest(options).skills[0].deleted, true);
});

test('local deletion preserves repository source and remote manifest for skills and fragments', (t) => {
  const manifest = { agents, skills: [entry('one', OWN_SOURCE)], fragments: [{ name: 'one', auto_sync: true }] };
  const files = { 'skills/one/SKILL.md': 'skill\n', 'agents-md/one.md': 'fragment\n' };
  const root = repository(t, manifest, files), options = managed(root), fixture = harness({ manifest });
  options.env.CODEX_HOME = join(root, 'codex');
  options.env.COPILOT_HOME = join(root, 'copilot');
  options.runGit = () => assert.fail('Local deletion must not use Git');
  fixture.run(['--local', '--del', 'one'], options);
  fixture.run(['--local', '--fragments', '--del', 'one'], options);
  for (const [path, content] of Object.entries(files)) {
    assert.equal(readFileSync(join(root, path), 'utf8'), content);
    assert.equal(runCommand('git', ['--git-dir', options.repositoryUrl, 'show', `main:${path}`]), content);
  }
  assert.deepEqual(remoteManifest(options), manifest);
});

test('source deletion failures preserve the operation copy and allow retry', (t) => {
  for (const failed of ['rm', 'commit', 'push']) {
    const path = 'skills/one/SKILL.md', manifest = { agents, skills: [entry('one', OWN_SOURCE)] };
    const options = managed(repository(t, manifest, { [path]: 'skill\n' }));
    const fixture = harness({ installed: [record('one', agents, OWN_SOURCE)] });
    assert.throws(() => fixture.run(['--del', 'one'], { ...options,
      runGit(command, args, execution) {
        if (args[0] === failed) throw new Error('fixture failure');
        return runCommand(command, args, execution);
      },
    }), /操作副本已保留/);
    assert.deepEqual(remoteManifest(options), manifest);
    assert.equal(runCommand('git', ['--git-dir', options.repositoryUrl, 'show', `main:${path}`]), 'skill\n');
    const saved = readdirSync(options.tempDir);
    assert.equal(saved.length, 1);
    const copy = join(options.tempDir, saved[0]);
    assert.equal(JSON.parse(readFileSync(join(copy, 'harness.json'))).skills[0].deleted, true);
    assert.equal(existsSync(join(copy, path)), failed === 'rm');
    fixture.run(['--del', 'one'], options);
    assert.equal(remoteManifest(options).skills[0].deleted, true);
    assert.equal(runCommand('git', ['--git-dir', options.repositoryUrl, 'ls-tree', '-r', '--name-only', 'main', '--', 'skills/one']).trim(), '');
    assert.equal(fixture.calls.filter((args) => args[0] === 'remove').length, 1);
  }
});

test('remote fragment switches publish only harness.json and preserve local choices', (t) => {
  const root = repository(t, { ...catalog, fragments: [{ name: 'simple-dev', auto_sync: true }] }), options = managed(root), fixture = harness();
  const localPath = join(fixture.dependencies.stateDir, 'harness.json');
  const local = '{"skills":[],"fragments":[{"name":"simple-dev","auto_sync":true}]}';
  writeFileSync(localPath, local);
  const before = remoteManifest(options);
  fixture.run(['--fragments', '--auto_sync', 'false', 'simple-dev'], options);
  const readRemote = () => JSON.parse(runCommand('git', ['--git-dir', options.repositoryUrl, 'show', 'main:harness.json']));
  assert.deepEqual(readRemote(), { ...before, fragments: [{ name: 'simple-dev', auto_sync: false }] });
  assert.deepEqual(remoteManifest(options).skills, before.skills);
  assert.equal(readFileSync(localPath, 'utf8'), local);
  assert.equal(fixture.calls.length, 0);
  assert.equal(runCommand('git', ['--git-dir', options.repositoryUrl, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'main']).trim(), 'harness.json');
  const revision = () => runCommand('git', ['--git-dir', options.repositoryUrl, 'rev-parse', 'main']);
  const head = revision();
  fixture.run(['--fragments', '--auto_sync', 'false', 'simple-dev'], options);
  assert.equal(revision(), head);
  assert.throws(() => fixture.run(['--fragments', '--auto_sync', 'true', 'unknown'], options), /不存在片段/);
  assert.equal(revision(), head);
  assert.deepEqual(readdirSync(options.tempDir), []);
});

test('remote agent changes publish only global settings, are idempotent, and preserve local overrides', (t) => {
  const options = managed(repository(t)), fixture = harness();
  fixture.run(['--local', '--del_agents', 'github-copilot']);
  const before = readFileSync(localPath(fixture), 'utf8');
  fixture.run(['--del_agents', 'codex'], options);
  assert.deepEqual(remoteManifest(options), { agents: ['github-copilot'], skills: [entry('one')] });
  fixture.run(['--add_agents', 'codex'], options);
  assert.deepEqual(remoteManifest(options).agents, ['github-copilot', 'codex']);
  const revision = () => runCommand('git', ['--git-dir', options.repositoryUrl, 'rev-parse', 'main']);
  const head = revision();
  fixture.run(['--add_agents', 'codex'], options);
  assert.equal(revision(), head);
  fixture.run(['--del_agents', 'github-copilot', 'codex'], options);
  assert.deepEqual(remoteManifest(options).agents, []);
  fixture.run(['--add_agents', 'github-copilot'], options);
  assert.deepEqual(remoteManifest(options).agents, ['github-copilot']);
  assert.equal(fixture.calls.length, 0);
  assert.ok(!fixture.events.includes('dryrun'));
  assert.equal(readFileSync(localPath(fixture), 'utf8'), before);
  assert.equal(runCommand('git', ['--git-dir', options.repositoryUrl, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'main']).trim(), 'harness.json');
  assert.deepEqual(readdirSync(options.tempDir), []);
});

test('remote fragment deletion cleans targets, retains the entry and can retry a failed push', (t) => {
  const manifest = { agents, skills: [entry('one')], fragments: [{ name: 'old-rule', auto_sync: true }] };
  const root = repository(t, manifest), options = managed(root), f = harness();
  options.homeDir = join(dirname(root), 'profile');
  options.env = { ...options.env, CODEX_HOME: join(options.homeDir, '.codex'), COPILOT_HOME: join(options.homeDir, '.copilot') };
  const path = join(options.env.CODEX_HOME, 'AGENTS.md');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'Personal\n<!-- eh:old-rule:start -->\nOld\n<!-- eh:old-rule:end -->\nEnd');
  assert.throws(() => f.run(['--fragments', '--del', 'old-rule'], { ...options,
    runGit(command, args, execution) { if (args[0] === 'push') throw new Error('offline'); return runCommand(command, args, execution); },
  }), /push 失败/);
  assert.equal(readFileSync(path, 'utf8'), 'Personal\n\nEnd');
  assert.deepEqual(remoteManifest(options), manifest);
  f.run(['--fragments', '--del', 'old-rule'], options);
  assert.deepEqual(remoteManifest(options), { ...manifest, fragments: [{ name: 'old-rule', auto_sync: false, deleted: true }] });
  assert.equal(f.calls.length, 0);
  assert.equal(runCommand('git', ['--git-dir', options.repositoryUrl, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'main']).trim(), 'harness.json');
});

test('remote skill add and del use local global targets and preserve other agents', (t) => {
  const options = managed(repository(t)), fixture = harness();
  fixture.run(['--local', '--del_agents', 'codex']);
  fixture.run(['--add', 'third/repo', 'two'], options);
  assert.deepEqual(fixture.calls.find((args) => args[0] === 'add'), ['add', 'third/repo', '--skill', 'two', '--agent', 'github-copilot', '-g', '--yes', '--json']);
  fixture.installed.find((item) => item.name === 'two').agents.push('Codex');
  fixture.run(['--del', 'two'], options);
  assert.deepEqual(fixture.calls.find((args) => args[0] === 'remove'), ['remove', 'two', '-g', '--yes', '--agent', 'github-copilot']);
  assert.deepEqual(fixture.installed.find((item) => item.name === 'two').agents, ['Codex']);
  assert.deepEqual(remoteManifest(options), { agents, skills: [entry('one'), { ...entry('two', 'third/repo', false), deleted: true }] });
});

test('remote skill changes require nonempty targets before installation or publication', (t) => {
  const manifest = { agents: [], skills: [entry('one')] };
  const options = managed(repository(t, manifest)), fixture = harness();
  assert.throws(() => fixture.run(['--add', 'third/repo', 'two'], options), /agents 为空/);
  assert.throws(() => fixture.run(['--del', 'one'], options), /agents 为空/);
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual(remoteManifest(options), manifest);
});

test('remote auto_sync commits only the flag, preserves local overrides and performs no installation', (t) => {
  const options = managed(repository(t)), fixture = harness();
  setLocal(fixture, [entry('one')]);
  const before = readFileSync(localPath(fixture), 'utf8');
  fixture.run(['--auto_sync', 'false', 'one'], options);
  assert.equal(remoteManifest(options).skills[0].auto_sync, false);
  assert.equal(fixture.calls.length, 0);
  assert.equal(readFileSync(localPath(fixture), 'utf8'), before);
  const head = runCommand('git', ['--git-dir', options.repositoryUrl, 'rev-parse', 'main']);
  fixture.run(['--auto_sync', 'false', 'one'], options);
  assert.equal(runCommand('git', ['--git-dir', options.repositoryUrl, 'rev-parse', 'main']), head);
  fixture.run(['--auto_sync', 'true', 'one'], options);
  assert.equal(remoteManifest(options).skills[0].auto_sync, true);
});

test('remote add and del prepare their own checkout, operate locally first, commit only manifest, and push', (t) => {
  const root = repository(t), fixture = harness({ installed: [record('one', ['codex'])] });
  const options = managed(root);
  const git = (args) => runCommand('git', args, { cwd: root });
  writeFileSync(join(root, 'unrelated.txt'), 'keep staged'); git(['add', 'unrelated.txt']);
  const before = readFileSync(join(root, 'harness.json'), 'utf8');
  fixture.dependencies.runDryruns = () => { fixture.events.push('dryrun'); assert.equal(remoteManifest(options).skills.length, 1); };
  options.runGit = (command, args, execution) => { fixture.events.push(`git:${args[0]}`); return runCommand(command, args, execution); };
  fixture.run(['--add', 'third/repo', 'two'], options);
  assert.ok(fixture.events.indexOf('add') < fixture.events.indexOf('dryrun'));
  assert.ok(fixture.events.indexOf('dryrun') < fixture.events.indexOf('git:commit'));
  assert.ok(fixture.events.indexOf('git:commit') < fixture.events.indexOf('git:push'));
  assert.equal(runCommand('git', ['--git-dir', options.repositoryUrl, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'main']).trim(), 'harness.json');
  assert.equal(git(['diff', '--cached', '--name-only']).trim(), 'unrelated.txt');
  assert.equal(readFileSync(join(root, 'harness.json'), 'utf8'), before);
  assert.deepEqual(remoteManifest(options).skills.map((item) => item.name), ['one', 'two']);
  assert.deepEqual(readdirSync(options.tempDir), []);
  fixture.events.length = 0;
  fixture.run(['--del', 'two'], options);
  assert.ok(fixture.events.indexOf('remove') < fixture.events.indexOf('git:commit'));
  assert.deepEqual(fixture.calls.find((args) => args[0] === 'remove'), ['remove', 'two', '-g', '--yes', '--agent', ...agents]);
  assert.deepEqual(remoteManifest(options).skills.filter((item) => !item.deleted).map((item) => item.name), ['one']);
  assert.equal(remoteManifest(options).skills.find((item) => item.name === 'two').deleted, true);
  assert.deepEqual(readdirSync(options.tempDir), []);
});

test('failed installs, dryruns and removals do not change the Git manifest', (t) => {
  const root = repository(t), before = readFileSync(join(root, 'harness.json'), 'utf8');
  const options = managed(root);
  for (const fixture of [harness({ failure: (args) => args[0] === 'add' }), harness({ dryrun: () => { throw new Error('environment'); } })]) {
    assert.throws(() => fixture.run(['--add', 'third/repo', 'two'], options));
    assert.deepEqual(remoteManifest(options), JSON.parse(before));
    assert.deepEqual(readdirSync(options.tempDir), []);
  }
  const remaining = harness({ installed: [record('one', ['codex'])] });
  const runSkills = remaining.dependencies.runSkills;
  remaining.dependencies.runSkills = (args) => args[0] === 'remove' ? '' : runSkills(args);
  assert.throws(() => remaining.run(['--del', 'one'], options), /目标安装仍存在/);
  assert.deepEqual(remoteManifest(options), JSON.parse(before));
});

test('commit or push failures preserve work; rerunning the same command publishes without manual Git', (t) => {
  const root = repository(t), fixture = harness();
  const options = managed(root);
  for (const failed of ['commit', 'push']) {
    assert.throws(() => fixture.run(['--add', 'third/repo', 'two'], { ...options,
      runGit(command, args, execution) { if (args[0] === failed) throw new Error('fixture failure'); return runCommand(command, args, execution); },
    }), /操作副本已保留：[\s\S]*重新运行同一条命令/);
    assert.equal(remoteManifest(options).skills.length, 1);
  }
  const saved = readdirSync(options.tempDir);
  assert.equal(saved.length, 2);
  assert.ok(saved.every((folder) => JSON.parse(readFileSync(join(options.tempDir, folder, 'harness.json'))).skills.length === 2));
  fixture.run(['--add', 'third/repo', 'two'], options);
  assert.equal(remoteManifest(options).skills.length, 2);
  assert.equal(fixture.calls.filter((args) => args[0] === 'add').length, 3);
});

test('dirty user checkouts do not affect remote management; deleting retains a tombstone', (t) => {
  const root = repository(t), fixture = harness(), options = managed(root);
  writeFileSync(join(root, 'harness.json'), JSON.stringify(catalog));
  fixture.run(['--add', 'third/repo', 'two'], { ...options, cwd: root });
  assert.equal(readFileSync(join(root, 'harness.json'), 'utf8'), JSON.stringify(catalog));
  assert.deepEqual(remoteManifest(options).skills.map((item) => item.name), ['one', 'two']);
  const { next } = changeManifest(catalog, parseArgs(['--del', 'one']));
  assert.deepEqual(next.skills, [{ ...entry('one', 'example/skills', false), deleted: true }, entry('two')]);
});

test('fetch or Git identity failures stop before changing local skills', (t) => {
  const options = managed(repository(t));
  for (const failed of ['fetch', 'var']) {
    const fixture = harness();
    assert.throws(() => fixture.run(['--add', 'third/repo', 'two'], { ...options,
      runGit(command, args, execution) { if (args[0] === failed) throw new Error('fixture failure'); return runCommand(command, args, execution); },
    }), /fixture failure/);
    assert.equal(fixture.calls.length, 0);
    assert.deepEqual(readdirSync(options.tempDir), []);
  }
});

test('del can retry publication after local removal already succeeded', (t) => {
  const options = managed(repository(t)), fixture = harness({ installed: [record('one', ['codex'])] });
  assert.throws(() => fixture.run(['--del', 'one'], { ...options,
    runGit(command, args, execution) { if (args[0] === 'push') throw new Error('network'); return runCommand(command, args, execution); },
  }), /push 失败/);
  assert.equal(remoteManifest(options).skills.length, 1);
  fixture.run(['--del', 'one'], options);
  assert.deepEqual(remoteManifest(options).skills, [{ ...entry('one', 'example/skills', false), deleted: true }]);
  assert.equal(fixture.calls.filter((args) => args[0] === 'remove').length, 1);
});

test('a concurrent remote edit rejects push; retry preserves it and applies the requested addition', (t) => {
  const root = repository(t), options = managed(root), fixture = harness();
  fixture.dependencies.runDryruns = () => {
    writeFileSync(join(root, 'harness.json'), JSON.stringify({ agents, skills: [entry('one'), entry('concurrent')] }, null, 2) + '\n');
    runCommand('git', ['commit', '-am', 'Concurrent edit'], { cwd: root });
    runCommand('git', ['push'], { cwd: root });
  };
  assert.throws(() => fixture.run(['--add', 'third/repo', 'two'], options), /push 失败/);
  assert.deepEqual(remoteManifest(options).skills.map((item) => item.name), ['one', 'concurrent']);
  fixture.dependencies.runDryruns = () => {};
  fixture.run(['--add', 'third/repo', 'two'], options);
  assert.deepEqual(remoteManifest(options).skills.map((item) => item.name), ['concurrent', 'one', 'two']);
});

test('file and piped entry points work offline with help and reject bad flags', () => {
  const script = fileURLToPath(new URL('../sync.mjs', import.meta.url));
  for (const [args, input] of [[[script, '--help']], [['--input-type=module', '-', '--help'], readFileSync(script, 'utf8')]]) {
    const result = spawnSync(process.execPath, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /用法/);
  }
  assert.equal(spawnSync(process.execPath, [script, '--invalid']).status, 1);
});

test('sync deletes tombstones before installing renamed skills regardless of local switches', () => {
  for (const autoSync of [true, false]) {
    const manifest = { agents, skills: [
      { ...entry('old', 'example/skills', false), deleted: true }, entry('renamed'),
    ] };
    const f = harness({ manifest, installed: [record('old'), record('unmanaged')] });
    setLocal(f, [entry('old', 'example/skills', autoSync)]);
    f.dependencies.runSkills = ((run) => (args) => {
      if (args[0] === 'remove') assert.ok(f.logs.some((line) => line.includes('skill 已标记删除：old')));
      return run(args);
    })(f.dependencies.runSkills);
    f.run();
    assert.ok(f.events.indexOf('remove') < f.events.indexOf('add'));
    assert.deepEqual(f.installed.map((item) => item.name).sort(), ['renamed', 'unmanaged']);
    assert.equal(manifest.skills[0].deleted, true);
    f.run();
    assert.equal(f.calls.filter((args) => args[0] === 'remove').length, 1);
    assert.equal(f.calls.filter((args) => args[0] === 'add').length, 2);
  }
});

test('dryrun and list show tombstones without removing or checking deleted skill code', () => {
  const f = harness({ manifest: { agents, skills: [{ ...entry('old'), deleted: true }] }, installed: [record('old')] });
  f.dependencies.runDryruns = () => assert.fail('Deleted skills have no dryrun');
  f.run(['--list']);
  assert.equal(f.calls.length, 0);
  assert.ok(f.logs.some((line) => line.includes('已删除（同步时清理）')));
  f.run(['--dryrun']);
  assert.deepEqual(f.calls, [['list', '-g', '--json']]);
  assert.ok(f.logs.some((line) => line.includes('同步时将自动删除')));
  f.run();
  assert.equal(f.installed.length, 0);
});

test('tombstone source conflicts and failed removals leave new installations pending', () => {
  const manifest = { agents, skills: [{ ...entry('old'), deleted: true }, entry('new')] };
  const conflict = harness({ manifest, installed: [record('old', agents, 'unrelated/repo')] });
  assert.throws(() => conflict.run(), /来源冲突/);
  assert.equal(conflict.calls.length, 1);
  const failure = harness({ manifest, installed: [record('old')], failure: (args) => args[0] === 'remove' });
  assert.throws(() => failure.run(), /删除失败/);
  assert.ok(!failure.calls.some((args) => args[0] === 'add'));
  const remaining = harness({ manifest, installed: [record('old')] });
  const run = remaining.dependencies.runSkills;
  remaining.dependencies.runSkills = (args) => args[0] === 'remove' ? '' : run(args);
  assert.throws(() => remaining.run(), /目标安装仍存在/);
  assert.ok(!remaining.calls.some((args) => args[0] === 'add'));
});

test('deleted names cannot be re-added or re-enabled and local settings cannot set deleted', () => {
  const manifest = { agents, skills: [{ ...entry('old', 'example/skills', false), deleted: true }] };
  const f = harness({ manifest });
  for (const args of [['--add', 'example/skills', 'old'], ['--auto_sync', 'true', 'old']]) {
    assert.throws(() => changeManifest(manifest, parseArgs(args)), /已标记删除/);
  }
  for (const args of [['--local', '--add', 'old'], ['--local', '--auto_sync', 'true', 'old']]) {
    assert.throws(() => f.run(args), /已标记删除/);
  }
  assert.equal(f.calls.length, 0);
  assert.throws(() => validateManifest({ agents, skills: [{ ...entry('old'), deleted: 'true' }] }), /deleted/);
  setLocal(f, [{ ...entry('old'), deleted: false }]);
  assert.throws(() => f.run(), /未知字段/);
});
