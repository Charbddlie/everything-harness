import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AGENTS, OWN_SOURCE, changeManifest, parseArgs, runCommand, runDryruns, sync, validateManifest } from '../sync.mjs';

const agents = [...AGENTS.keys()];
const entry = (name, source = 'example/skills') => ({ name, source });
const catalog = { agents, skill: [entry('one'), entry('two')], 'sync-rules': { auto: [{ type_name: 'skill:one' }, { type_name: 'skill:two' }] } };

test('deleted records require typed identities and skill sources with no active overlap', () => {
  const base = { agents, skill: [], 'agents-md': [] };
  for (const deleted of [null, {}, ['skill:old'], [null], [{ type_name: 'skill:old' }],
    [{ type_name: 'skill:old', source: 'bad' }], [{ type_name: 'skills:old', source: 'a/b' }],
    [{ type_name: 'agents-md:old', source: 'a/b' }], [{ type_name: 'agents-md:old', auto_sync: false }],
    [{ type_name: 'agents-md:old' }, { type_name: 'agents-md:old' }]]) {
    assert.throws(() => validateManifest({ ...base, deleted }));
  }
  const deleted = [{ type_name: 'skill:one', source: 'example/skills' }, { type_name: 'agents-md:one' }];
  assert.deepEqual(validateManifest({ ...base, deleted }).deleted, deleted);
  assert.throws(() => validateManifest({ ...base, skill: [entry('one')], deleted }), /同时存在/);
  assert.throws(() => validateManifest({ ...base, 'agents-md': [{ name: 'one' }], deleted }), /同时存在/);
  assert.throws(() => validateManifest({ skill: [], deleted: [] }, { local: true }), /未知字段/);
});
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
      checkSkills: (entries, targets, dependencies, log) => {
        if (entries.length) dependencies.runDryruns(entries, new Map(), { log });
      },
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

test('invalid manifests and arguments fail before install', () => {
  for (const manifest of [null, [], {}, { agents, skill: 'bad' }, { agents, skill: [entry('one'), entry('one')] },
    { agents, skill: [entry('*')] }, { agents, skill: [{ ...entry('one'), agents: ['codex'] }] },
    ...['a/..', 'a/b/tree/main', 'a/b;whoami', 'https://github.com/a/b', '-a/b', 'a/b.git'].map((source) => ({ agents, skill: [entry('one', source)] }))]) {
    const fixture = harness({ manifest }); assert.throws(() => fixture.run()); assert.equal(fixture.calls.length, 0);
  }
  for (const args of [['--add'], ['--del'], ['--agents'], ['--agents', 'codex', 'codex'], ['--update'], ['--update', '--add', 'a/b', 'skill:one'], ['--wat'], ['--list', '--del', 'skill:one']]) {
    assert.throws(() => parseArgs(args));
  }
  assert.deepEqual(validateManifest({ agents, skill: [] }), { agents, skill: [] });
});

const localPath = (fixture) => join(fixture.dependencies.stateDir, 'harness.json');
const localManifest = (fixture) => JSON.parse(readFileSync(localPath(fixture), 'utf8'));
const setLocal = (fixture, skill) => writeFileSync(localPath(fixture), JSON.stringify({ 'sync-rules': { auto: skill.map(({ name }) => ({ type_name: `skill:${name}` })) } }, null, 2) + '\n');

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
  assert.deepEqual(localManifest(fixture), { 'sync-rules': {} });
});

test('empty global targets disable operations without removing installations; agents can be re-enabled', () => {
  const fixture = harness({ installed: [record('one')] });
  fixture.run(['--local', '--del_agents', ...agents]);
  assert.deepEqual(localManifest(fixture), { agents: [], 'sync-rules': {} });
  for (const args of [[], ['--dryrun']]) fixture.run(args);
  fixture.run(['--list']);
  assert.ok(fixture.logs.some((line) => line.includes('本机 agents：无\n生效 agents：无')));
  assert.equal(fixture.calls.length, 0);
  for (const mode of ['--add', '--del']) assert.throws(() => fixture.run(['--local', mode, ...(mode === '--add' ? ['example/skills'] : []), 'skill:one']), /agents 为空/);
  assert.deepEqual(localManifest(fixture)['sync-rules'], {});
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
    writeFileSync(localPath(local), JSON.stringify({ agents: value, skill: [] }));
    assert.throws(() => local.run(), /agent/);
    assert.equal(local.calls.length, 0);
  }
  for (const args of [['--add_agents'], ['--del_agents'], ['--add_agents', 'unknown'], ['--del_agents', 'codex', 'codex'],
    ['--add_agents', 'codex', '--del_agents', 'github-copilot'], ['--add_agents', 'codex', '--update']]) assert.throws(() => parseArgs(args));
});

test('CLI errors and incomplete add results cannot publish success', () => {
  const failed = harness({ failure: (args) => args[0] === 'add' });
  assert.throws(() => failed.run(), /失败/);
  assert.ok(failed.events.includes('dryrun'));
  for (const result of [[], {}, [{ name: 'one', status: 'failed' }]]) assert.throws(() => harness({ result }).run());
  assert.throws(() => runCommand(process.execPath, ['-e', 'process.exit(7)']), /退出码 7/);
  assert.throws(() => runCommand('no-such-everything-harness-command', []), /无法执行/);
});

test('list always reads the remote manifest; dryrun never installs', (t) => {
  const root = repository(t), fixture = harness();
  fixture.run(['--list'], { cwd: root });
  assert.equal(fixture.calls.length, 0);
  assert.ok(fixture.logs.some((line) => line.includes('skill:two'))); // absent from the local checkout
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
  assert.throws(() => runDryruns(catalog.skill, installed, { log: (line) => logs.push(line) }), /2 个 skill/);
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

function repository(t, manifest = { agents, skill: [entry('one')] }, files = {}) {
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
      const key = fragments ? 'agents-md' : 'skill';
      const target = fragments ? { name: 'one' } : entry('one', OWN_SOURCE.toUpperCase());
      const tombstone = { type_name: `${key}:one`, ...(fragments ? {} : { source: target.source }) };
      const manifest = { agents, skill: [], [key]: deleted ? [] : [target], ...(deleted ? { deleted: [tombstone] } : {}) };
      const removed = fragments ? ['agents-md/one.md'] : ['skills/one/SKILL.md', 'skills/one/scripts/helper.mjs', 'skills/one/assets/input.txt'];
      const preserved = ['skills/one-more/SKILL.md', 'agents-md/one-more.md', fragments ? 'skills/one/SKILL.md' : 'agents-md/one.md'];
      const files = Object.fromEntries([...removed, ...preserved].map((path) => [path, 'fixture\n']));
      const root = repository(t, manifest, files), options = managed(root), fixture = harness();
      options.env.CODEX_HOME = join(root, 'codex');
      options.env.COPILOT_HOME = join(root, 'copilot');
      const args = ['--del', `${key}:one`];
      fixture.run(args, options);
      const remoteFiles = runCommand('git', ['--git-dir', options.repositoryUrl, 'ls-tree', '-r', '--name-only', 'main']).trim().split('\n');
      for (const path of removed) assert.ok(!remoteFiles.includes(path), path);
      for (const path of preserved) assert.ok(remoteFiles.includes(path), path);
      assert.deepEqual(remoteManifest(options)[key], []);
      assert.deepEqual(remoteManifest(options).deleted, [tombstone]);
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
  const options = managed(repository(t, { agents, skill: [entry('one')] }, { [path]: 'keep\n' }));
  harness().run(['--del', 'skill:one'], options);
  assert.equal(runCommand('git', ['--git-dir', options.repositoryUrl, 'show', `main:${path}`]), 'keep\n');
  assert.deepEqual(remoteManifest(options).deleted, [{ type_name: 'skill:one', source: 'example/skills' }]);
  harness().run(['--del', 'skill:one'], options);
  assert.equal(runCommand('git', ['--git-dir', options.repositoryUrl, 'show', `main:${path}`]), 'keep\n');
});

test('local deletion preserves repository source and remote manifest for skills and fragments', (t) => {
  const manifest = { agents, skill: [entry('one', OWN_SOURCE)], 'agents-md': [{ name: 'one' }] };
  const files = { 'skills/one/SKILL.md': 'skill\n', 'agents-md/one.md': 'fragment\n' };
  const root = repository(t, manifest, files), options = managed(root), fixture = harness({ manifest });
  options.env.CODEX_HOME = join(root, 'codex');
  options.env.COPILOT_HOME = join(root, 'copilot');
  options.runGit = () => assert.fail('Local deletion must not use Git');
  fixture.run(['--local', '--del', 'skill:one'], options);
  fixture.run(['--local', '--del', 'agents-md:one'], options);
  for (const [path, content] of Object.entries(files)) {
    assert.equal(readFileSync(join(root, path), 'utf8'), content);
    assert.equal(runCommand('git', ['--git-dir', options.repositoryUrl, 'show', `main:${path}`]), content);
  }
  assert.deepEqual(remoteManifest(options), manifest);
});

test('source deletion failures preserve the operation copy and allow retry', (t) => {
  for (const failed of ['rm', 'commit', 'push']) {
    const path = 'skills/one/SKILL.md', manifest = { agents, skill: [entry('one', OWN_SOURCE)] };
    const options = managed(repository(t, manifest, { [path]: 'skill\n' }));
    const fixture = harness({ installed: [record('one', agents, OWN_SOURCE)] });
    assert.throws(() => fixture.run(['--del', 'skill:one'], { ...options,
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
    assert.deepEqual(JSON.parse(readFileSync(join(copy, 'harness.json'))).deleted, [{ type_name: 'skill:one', source: OWN_SOURCE }]);
    assert.equal(existsSync(join(copy, path)), failed === 'rm');
    fixture.run(['--del', 'skill:one'], options);
    assert.deepEqual(remoteManifest(options).deleted, [{ type_name: 'skill:one', source: OWN_SOURCE }]);
    assert.equal(runCommand('git', ['--git-dir', options.repositoryUrl, 'ls-tree', '-r', '--name-only', 'main', '--', 'skills/one']).trim(), '');
    assert.equal(fixture.calls.filter((args) => args[0] === 'remove').length, 1);
  }
});

test('remote agent changes publish only global settings, are idempotent, and preserve local overrides', (t) => {
  const options = managed(repository(t)), fixture = harness();
  fixture.run(['--local', '--del_agents', 'github-copilot']);
  const before = readFileSync(localPath(fixture), 'utf8');
  fixture.run(['--del_agents', 'codex'], options);
  assert.deepEqual(remoteManifest(options), { agents: ['github-copilot'], skill: [entry('one')] });
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
  const manifest = { agents, skill: [entry('one')], 'agents-md': [{ name: 'old-rule' }] };
  const root = repository(t, manifest), options = managed(root), f = harness();
  options.homeDir = join(dirname(root), 'profile');
  options.env = { ...options.env, CODEX_HOME: join(options.homeDir, '.codex'), COPILOT_HOME: join(options.homeDir, '.copilot') };
  const path = join(options.env.CODEX_HOME, 'AGENTS.md');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'Personal\n<!-- eh:old-rule:start -->\nOld\n<!-- eh:old-rule:end -->\nEnd');
  assert.throws(() => f.run(['--del', 'agents-md:old-rule'], { ...options,
    runGit(command, args, execution) { if (args[0] === 'push') throw new Error('offline'); return runCommand(command, args, execution); },
  }), /push 失败/);
  assert.equal(readFileSync(path, 'utf8'), 'Personal\n\nEnd');
  assert.deepEqual(remoteManifest(options), manifest);
  f.run(['--del', 'agents-md:old-rule'], options);
  assert.deepEqual(remoteManifest(options), { ...manifest, 'agents-md': [], deleted: [{ type_name: 'agents-md:old-rule' }] });
  assert.equal(f.calls.length, 0);
  assert.equal(runCommand('git', ['--git-dir', options.repositoryUrl, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'main']).trim(), 'harness.json');
});

test('remote skill add and del use local global targets and preserve other agents', (t) => {
  const options = managed(repository(t)), fixture = harness();
  fixture.run(['--local', '--del_agents', 'codex']);
  fixture.run(['--add', 'third/repo', 'skill:two'], options);
  assert.deepEqual(fixture.calls.find((args) => args[0] === 'add'), ['add', 'third/repo', '--skill', 'two', '--agent', 'github-copilot', '-g', '--yes', '--json']);
  fixture.installed.find((item) => item.name === 'two').agents.push('Codex');
  fixture.run(['--del', 'skill:two'], options);
  assert.deepEqual(fixture.calls.find((args) => args[0] === 'remove'), ['remove', 'two', '-g', '--yes', '--agent', 'github-copilot']);
  assert.deepEqual(fixture.installed.find((item) => item.name === 'two').agents, ['Codex']);
  assert.deepEqual(remoteManifest(options), { agents, skill: [entry('one')], 'sync-rules': { auto: [] }, deleted: [{ type_name: 'skill:two', source: 'third/repo' }] });
});

test('remote skill changes require nonempty targets before installation or publication', (t) => {
  const manifest = { agents: [], skill: [entry('one')] };
  const options = managed(repository(t, manifest)), fixture = harness();
  assert.throws(() => fixture.run(['--add', 'third/repo', 'skill:two'], options), /agents 为空/);
  assert.throws(() => fixture.run(['--del', 'skill:one'], options), /agents 为空/);
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual(remoteManifest(options), manifest);
});

test('remote add and del prepare their own checkout, operate locally first, commit only manifest, and push', (t) => {
  const root = repository(t), fixture = harness({ installed: [record('one', ['codex'])] });
  const options = managed(root);
  const git = (args) => runCommand('git', args, { cwd: root });
  writeFileSync(join(root, 'unrelated.txt'), 'keep staged'); git(['add', 'unrelated.txt']);
  const before = readFileSync(join(root, 'harness.json'), 'utf8');
  fixture.dependencies.runDryruns = () => { fixture.events.push('dryrun'); assert.equal(remoteManifest(options).skill.length, 1); };
  options.runGit = (command, args, execution) => { fixture.events.push(`git:${args[0]}`); return runCommand(command, args, execution); };
  fixture.run(['--add', 'third/repo', 'skill:two'], options);
  assert.ok(fixture.events.indexOf('dryrun') < fixture.events.indexOf('add'));
  assert.ok(fixture.events.indexOf('dryrun') < fixture.events.indexOf('git:commit'));
  assert.ok(fixture.events.indexOf('git:commit') < fixture.events.indexOf('git:push'));
  assert.equal(runCommand('git', ['--git-dir', options.repositoryUrl, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'main']).trim(), 'harness.json');
  assert.equal(git(['diff', '--cached', '--name-only']).trim(), 'unrelated.txt');
  assert.equal(readFileSync(join(root, 'harness.json'), 'utf8'), before);
  assert.deepEqual(remoteManifest(options).skill.map((item) => item.name), ['one', 'two']);
  assert.deepEqual(readdirSync(options.tempDir), []);
  fixture.events.length = 0;
  fixture.run(['--del', 'skill:two'], options);
  assert.ok(fixture.events.indexOf('remove') < fixture.events.indexOf('git:commit'));
  assert.deepEqual(fixture.calls.find((args) => args[0] === 'remove'), ['remove', 'two', '-g', '--yes', '--agent', ...agents]);
  assert.deepEqual(remoteManifest(options).skill.filter((item) => !item.deleted).map((item) => item.name), ['one']);
  assert.deepEqual(remoteManifest(options).deleted, [{ type_name: 'skill:two', source: 'third/repo' }]);
  assert.deepEqual(readdirSync(options.tempDir), []);
});

test('failed installs, dryruns and removals do not change the Git manifest', (t) => {
  const root = repository(t), before = readFileSync(join(root, 'harness.json'), 'utf8');
  const options = managed(root);
  for (const fixture of [harness({ failure: (args) => args[0] === 'add' }), harness({ dryrun: () => { throw new Error('environment'); } })]) {
    assert.throws(() => fixture.run(['--add', 'third/repo', 'skill:two'], options));
    assert.deepEqual(remoteManifest(options), JSON.parse(before));
    assert.deepEqual(readdirSync(options.tempDir), []);
  }
  const remaining = harness({ installed: [record('one', ['codex'])] });
  const runSkills = remaining.dependencies.runSkills;
  remaining.dependencies.runSkills = (args) => args[0] === 'remove' ? '' : runSkills(args);
  assert.throws(() => remaining.run(['--del', 'skill:one'], options), /目标安装仍存在/);
  assert.deepEqual(remoteManifest(options), JSON.parse(before));
});

test('commit or push failures preserve work; rerunning the same command publishes without manual Git', (t) => {
  const root = repository(t), fixture = harness();
  const options = managed(root);
  for (const failed of ['commit', 'push']) {
    assert.throws(() => fixture.run(['--add', 'third/repo', 'skill:two'], { ...options,
      runGit(command, args, execution) { if (args[0] === failed) throw new Error('fixture failure'); return runCommand(command, args, execution); },
    }), /操作副本已保留：[\s\S]*重新运行同一条命令/);
    assert.equal(remoteManifest(options).skill.length, 1);
  }
  const saved = readdirSync(options.tempDir);
  assert.equal(saved.length, 2);
  assert.ok(saved.every((folder) => JSON.parse(readFileSync(join(options.tempDir, folder, 'harness.json'))).skill.length === 2));
  fixture.run(['--add', 'third/repo', 'skill:two'], options);
  assert.equal(remoteManifest(options).skill.length, 2);
  assert.equal(fixture.calls.filter((args) => args[0] === 'add').length, 3);
});

test('dirty user checkouts do not affect remote management; deleting retains a tombstone', (t) => {
  const root = repository(t), fixture = harness(), options = managed(root);
  writeFileSync(join(root, 'harness.json'), JSON.stringify(catalog));
  fixture.run(['--add', 'third/repo', 'skill:two'], { ...options, cwd: root });
  assert.equal(readFileSync(join(root, 'harness.json'), 'utf8'), JSON.stringify(catalog));
  assert.deepEqual(remoteManifest(options).skill.map((item) => item.name), ['one', 'two']);
  const { next } = changeManifest(catalog, parseArgs(['--del', 'skill:one']));
  assert.deepEqual(next.skill, [entry('two')]);
  assert.deepEqual(next.deleted, [{ type_name: 'skill:one', source: 'example/skills' }]);
});

test('fetch or Git identity failures stop before changing local skills', (t) => {
  const options = managed(repository(t));
  for (const failed of ['fetch', 'var']) {
    const fixture = harness();
    assert.throws(() => fixture.run(['--add', 'third/repo', 'skill:two'], { ...options,
      runGit(command, args, execution) { if (args[0] === failed) throw new Error('fixture failure'); return runCommand(command, args, execution); },
    }), /fixture failure/);
    assert.equal(fixture.calls.length, 0);
    assert.deepEqual(readdirSync(options.tempDir), []);
  }
});

test('del can retry publication after local removal already succeeded', (t) => {
  const options = managed(repository(t)), fixture = harness({ installed: [record('one', ['codex'])] });
  assert.throws(() => fixture.run(['--del', 'skill:one'], { ...options,
    runGit(command, args, execution) { if (args[0] === 'push') throw new Error('network'); return runCommand(command, args, execution); },
  }), /push 失败/);
  assert.equal(remoteManifest(options).skill.length, 1);
  fixture.run(['--del', 'skill:one'], options);
  assert.deepEqual(remoteManifest(options).skill, []);
  assert.deepEqual(remoteManifest(options).deleted, [{ type_name: 'skill:one', source: 'example/skills' }]);
  assert.equal(fixture.calls.filter((args) => args[0] === 'remove').length, 1);
});

test('a concurrent remote edit rejects push; retry preserves it and applies the requested addition', (t) => {
  const root = repository(t), options = managed(root), fixture = harness();
  fixture.dependencies.runDryruns = () => {
    writeFileSync(join(root, 'harness.json'), JSON.stringify({ agents, skill: [entry('one'), entry('concurrent')] }, null, 2) + '\n');
    runCommand('git', ['commit', '-am', 'Concurrent edit'], { cwd: root });
    runCommand('git', ['push'], { cwd: root });
  };
  assert.throws(() => fixture.run(['--add', 'third/repo', 'skill:two'], options), /push 失败/);
  assert.deepEqual(remoteManifest(options).skill.map((item) => item.name), ['one', 'concurrent']);
  fixture.dependencies.runDryruns = () => {};
  fixture.run(['--add', 'third/repo', 'skill:two'], options);
  assert.deepEqual(remoteManifest(options).skill.map((item) => item.name), ['concurrent', 'one', 'two']);
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
    const manifest = { agents, skill: [entry('renamed')], 'sync-rules': { auto: [{ type_name: 'skill:renamed' }] }, deleted: [{ type_name: 'skill:old', source: 'example/skills' }] };
    const f = harness({ manifest, installed: [record('old'), record('unmanaged')] });
    writeFileSync(localPath(f), JSON.stringify({ skills: [{ ...entry('old'), auto_sync: autoSync }] }));
    f.dependencies.runSkills = ((run) => (args) => {
      if (args[0] === 'remove') assert.ok(f.logs.some((line) => line.includes('skill 待删除：old')));
      return run(args);
    })(f.dependencies.runSkills);
    f.run();
    assert.ok(f.events.indexOf('remove') < f.events.indexOf('add'));
    assert.deepEqual(f.installed.map((item) => item.name).sort(), ['renamed', 'unmanaged']);
    assert.deepEqual(manifest.deleted, [{ type_name: 'skill:old', source: 'example/skills' }]);
    f.run();
    assert.equal(f.calls.filter((args) => args[0] === 'remove').length, 1);
    assert.equal(f.calls.filter((args) => args[0] === 'add').length, 2);
  }
});

test('dryrun and list show tombstones without removing or checking deleted skill code', () => {
  const f = harness({ manifest: { agents, skill: [], deleted: [{ type_name: 'skill:old', source: 'example/skills' }] }, installed: [record('old')] });
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
  const manifest = { agents, skill: [entry('new')], deleted: [{ type_name: 'skill:old', source: 'example/skills' }] };
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
  const manifest = { agents, skill: [], deleted: [{ type_name: 'skill:old', source: 'example/skills' }] };
  const f = harness({ manifest });
  for (const args of [['--add', 'example/skills', 'skill:old'], ['--auto_sync', 'true', 'skill:old']]) {
    assert.throws(() => changeManifest(manifest, parseArgs(args)), /已标记删除/);
  }
  for (const args of [['--local', '--add', 'skill:old'], ['--local', '--auto_sync', 'true', 'skill:old']]) {
    assert.throws(() => f.run(args), /已标记删除/);
  }
  assert.equal(f.calls.length, 0);
  assert.throws(() => validateManifest({ agents, skill: [{ ...entry('old'), deleted: 'true' }] }), /未知字段/);
  writeFileSync(localPath(f), JSON.stringify({ deleted: [{ type_name: 'skill:old', source: 'example/skills' }] }));
  assert.throws(() => f.run(), /未知字段/);
});

test('remote own-skill add infers its source and registers auto membership', (t) => {
  const options = managed(repository(t, { agents, skill: [] })), f = harness();
  f.run(['--add', 'skill:new'], options);
  assert.deepEqual(remoteManifest(options), {
    agents, skill: [entry('new', OWN_SOURCE)], 'sync-rules': { auto: [{ type_name: 'skill:new' }] },
  });
  assert.equal(f.calls.find((args) => args[0] === 'add')[1], OWN_SOURCE);
});

test('remote rule add checks conditions without changing membership; rule del skips detection', (t) => {
  const manifest = { agents, skill: [entry('one')], 'agents-md': [{ name: 'one' }],
    'sync-rules': { auto: [], learn: [{ type_name: 'skill:one' }, { type_name: 'agents-md:one' }] } };
  const root = repository(t, manifest, { 'agents-md/one.md': 'Rule\n' });
  const options = managed(root), f = harness();
  options.env.CODEX_HOME = join(root, 'codex'); options.env.COPILOT_HOME = join(root, 'copilot');
  options.fetchFragment = () => 'Rule'; options.platform = 'linux';
  f.run(['--add', 'rule:learn'], options);
  assert.equal(f.calls.length, 0); assert.deepEqual(remoteManifest(options), manifest);
  options.platform = 'win32';
  f.run(['--add', 'rule:learn'], options);
  assert.ok(f.calls.some((args) => args[0] === 'add'));
  assert.deepEqual(remoteManifest(options), manifest);
  assert.match(readFileSync(join(root, 'codex', 'AGENTS.md'), 'utf8'), /Rule/);
  options.platform = 'linux'; f.dependencies.checkSkills = () => assert.fail('del must skip testing');
  f.run(['--del', 'rule:learn'], options);
  assert.deepEqual(remoteManifest(options), { ...manifest, skill: [], 'agents-md': [],
    'sync-rules': { auto: [], learn: [] }, deleted: [{ type_name: 'skill:one', source: 'example/skills' }, { type_name: 'agents-md:one' }] });
});

test('remote fragment add validates content before publishing and preserves rule assignments', (t) => {
  const root = repository(t, { agents, skill: [] }, { 'agents-md/one.md': 'Rule\n' });
  const options = managed(root), f = harness();
  options.env.CODEX_HOME = join(root, 'codex'); options.env.COPILOT_HOME = join(root, 'copilot');
  options.fetchFragment = () => '';
  assert.throws(() => f.run(['--add', 'agents-md:one'], options), /为空/);
  assert.deepEqual(remoteManifest(options), { agents, skill: [] });
  options.fetchFragment = () => 'Rule';
  f.run(['--add', 'agents-md:one'], options);
  assert.deepEqual(remoteManifest(options)['sync-rules'], { auto: [{ type_name: 'agents-md:one' }] });
  f.run(['--auto_sync', 'false', 'agents-md:one'], options);
  f.run(['--add', 'agents-md:one'], options);
  assert.deepEqual(remoteManifest(options)['sync-rules'], { auto: [] });
  assert.equal(f.calls.length, 0);
});
