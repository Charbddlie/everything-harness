import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AGENTS, changeManifest, parseArgs, runCommand, runDryruns, sync, validateManifest } from '../sync.mjs';

const agents = [...AGENTS.keys()];
const entry = (name, targets = agents, source = 'example/skills') => ({ name, source, agents: targets });
const catalog = { skills: [entry('one'), entry('two')] };
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
      fetchManifest: () => { events.push('fetch'); return JSON.stringify(manifest); },
      log: (text) => logs.push(text),
      runDryruns: (entries) => { events.push('dryrun'); dryrun?.(entries); },
      runSkills: (args) => {
        calls.push(args); events.push(args[0]);
        if (failure?.(args)) throw new Error('fixture failure');
        if (args[0] === 'list') return JSON.stringify(installed);
        if (args[0] === 'remove') { const index = installed.findIndex((item) => item.name === args[1]); if (index >= 0) installed.splice(index, 1); return ''; }
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

test('first installation, repeated skip, and dryrun on every selected skill', () => {
  const fixture = harness(); fixture.run();
  assert.deepEqual(fixture.calls[1], ['add', 'example/skills', '--skill', 'one', 'two', '--agent', ...agents, '-g', '--yes', '--json']);
  fixture.run();
  assert.equal(fixture.calls.filter((args) => args[0] === 'add').length, 1);
  assert.equal(fixture.events.filter((event) => event === 'dryrun').length, 2);
  assert.equal(fixture.events.filter((event) => event === 'fetch').length, 2);
});

test('missing agents and per-skill target filters', () => {
  const fixture = harness({ installed: [record('one', ['codex']), record('two', ['claude-code', 'github-copilot'])] });
  fixture.run();
  assert.deepEqual(fixture.calls[1], ['add', 'example/skills', '--skill', 'one', '--agent', 'claude-code', 'github-copilot', '-g', '--yes', '--json']);
  assert.deepEqual(fixture.calls[2], ['add', 'example/skills', '--skill', 'two', '--agent', 'codex', '-g', '--yes', '--json']);
  const filtered = harness({ manifest: { skills: [entry('one', ['claude-code']), entry('two', ['codex'])] } });
  filtered.run(['--update', '--agents', 'codex']);
  assert.deepEqual(filtered.calls[1], ['add', 'example/skills', '--skill', 'two', '--agent', 'codex', '-g', '--yes', '--json']);
});

test('shared paths cover undetected Codex and Copilot apps', () => {
  const shared = join(tmpdir(), 'shared');
  const fixture = harness({ installed: ['one', 'two'].map((name) => ({ ...record(name, []), path: join(shared, name) })) });
  fixture.run(['--agents', 'codex', 'github-copilot'], { sharedSkillsDir: shared });
  assert.equal(fixture.calls.length, 1);
});

test('update is scoped, source conflicts are checked before installs, untracked records are adopted', () => {
  const fixture = harness({ installed: [record('one'), record('two'), record('other', agents, 'different/repo')] });
  fixture.run(['--update', '--agents', 'codex']); assert.equal(fixture.calls.length, 2);
  assert.ok(!fixture.calls[1].includes('other'));
  const conflict = harness({ installed: [record('two', agents, 'other/repo')] });
  assert.throws(() => conflict.run(), /来源冲突/); assert.equal(conflict.calls.length, 1);
  const legacy = harness({ installed: [record('one', agents, null, null), record('two', agents, 'EXAMPLE/Skills')] });
  legacy.run(); assert.deepEqual(legacy.calls[1].slice(2, 4), ['--skill', 'one']);
});

test('invalid manifests and arguments fail before install', () => {
  for (const manifest of [null, [], {}, { skills: 'bad' }, { skills: [entry('one'), entry('one')] },
    { skills: [entry('*')] }, { skills: [entry('one', [])] }, { skills: [entry('one', ['claude'])] },
    ...['a/..', 'a/b/tree/main', 'a/b;whoami', 'https://github.com/a/b', '-a/b', 'a/b.git'].map((source) => ({ skills: [entry('one', agents, source)] }))]) {
    const fixture = harness({ manifest }); assert.throws(() => fixture.run()); assert.equal(fixture.calls.length, 0);
  }
  for (const args of [['--add'], ['--del'], ['--agents'], ['--agents', 'codex', 'codex'], ['--update', '--add', 'a/b', 'one'], ['--wat'], ['--list', '--del', 'one']]) {
    assert.throws(() => parseArgs(args));
  }
  assert.deepEqual(validateManifest({ skills: [] }), { skills: [] });
});

test('CLI errors and incomplete add results cannot publish success', () => {
  const failed = harness({ failure: (args) => args[0] === 'add' });
  assert.throws(() => failed.run(), /example\/skills.*失败/);
  assert.ok(!failed.events.includes('dryrun'));
  for (const result of [[], {}, [{ name: 'one', status: 'failed' }]]) assert.throws(() => harness({ result }).run());
  assert.throws(() => runCommand(process.execPath, ['-e', 'process.exit(7)']), /退出码 7/);
  assert.throws(() => runCommand('no-such-everything-harness-command', []), /无法执行/);
});

test('list always reads the remote manifest and supports agent filtering; dryrun never installs', (t) => {
  const root = repository(t), fixture = harness();
  fixture.run(['--list', '--agents', 'codex'], { cwd: root });
  assert.equal(fixture.calls.length, 0); assert.ok(fixture.logs.at(-1).includes('codex'));
  assert.ok(!fixture.logs.at(-1).includes('claude-code'));
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
  assert.ok(logs.includes('missing-one')); assert.ok(logs.includes('missing-two'));
  const path = join(root, 'own'); mkdirSync(join(path, 'scripts'), { recursive: true });
  writeFileSync(join(path, 'scripts', 'helper.mjs'), '');
  assert.throws(() => runDryruns([entry('own', agents, 'Charbddlie/everything-harness')], new Map([['own', { path }]]), { log() {} }), /环境检查失败/);
});

function repository(t, manifest = { skills: [entry('one', ['codex'])] }) {
  const base = temporary(t), root = join(base, 'local'), remote = join(base, 'remote.git'); mkdirSync(root);
  runCommand('git', ['init', '--bare', '--initial-branch=main', remote]);
  const git = (args) => runCommand('git', args, { cwd: root });
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Skill Test']); git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'core.hooksPath', join(base, 'no-hooks')]); git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'skills.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(root, 'sync.mjs'), '// test repository\n');
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

const remoteManifest = (options) => JSON.parse(runCommand('git', ['--git-dir', options.repositoryUrl, 'show', 'main:skills.json']));

test('remote add and del prepare their own checkout, operate locally first, commit only manifest, and push', (t) => {
  const root = repository(t), fixture = harness({ installed: [record('one', ['codex'])] });
  const options = managed(root);
  const git = (args) => runCommand('git', args, { cwd: root });
  writeFileSync(join(root, 'unrelated.txt'), 'keep staged'); git(['add', 'unrelated.txt']);
  const before = readFileSync(join(root, 'skills.json'), 'utf8');
  fixture.dependencies.runDryruns = () => { fixture.events.push('dryrun'); assert.equal(remoteManifest(options).skills.length, 1); };
  options.runGit = (command, args, execution) => { fixture.events.push(`git:${args[0]}`); return runCommand(command, args, execution); };
  fixture.run(['--add', 'third/repo', 'two', '--agents', 'codex'], options);
  assert.ok(fixture.events.indexOf('add') < fixture.events.indexOf('dryrun'));
  assert.ok(fixture.events.indexOf('dryrun') < fixture.events.indexOf('git:commit'));
  assert.ok(fixture.events.indexOf('git:commit') < fixture.events.indexOf('git:push'));
  assert.equal(runCommand('git', ['--git-dir', options.repositoryUrl, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'main']).trim(), 'skills.json');
  assert.equal(git(['diff', '--cached', '--name-only']).trim(), 'unrelated.txt');
  assert.equal(readFileSync(join(root, 'skills.json'), 'utf8'), before);
  assert.deepEqual(remoteManifest(options).skills.map((item) => item.name), ['one', 'two']);
  assert.deepEqual(readdirSync(options.tempDir), []);
  fixture.events.length = 0;
  fixture.run(['--del', 'two', '--agents', 'codex'], options);
  assert.ok(fixture.events.indexOf('remove') < fixture.events.indexOf('git:commit'));
  assert.deepEqual(remoteManifest(options).skills.map((item) => item.name), ['one']);
  assert.deepEqual(readdirSync(options.tempDir), []);
});

test('failed installs, dryruns and removals do not change the Git manifest', (t) => {
  const root = repository(t), before = readFileSync(join(root, 'skills.json'), 'utf8');
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
    assert.throws(() => fixture.run(['--add', 'third/repo', 'two', '--agents', 'codex'], { ...options,
      runGit(command, args, execution) { if (args[0] === failed) throw new Error('fixture failure'); return runCommand(command, args, execution); },
    }), /操作副本已保留：[\s\S]*重新运行同一条命令/);
    assert.equal(remoteManifest(options).skills.length, 1);
  }
  const saved = readdirSync(options.tempDir);
  assert.equal(saved.length, 2);
  assert.ok(saved.every((folder) => JSON.parse(readFileSync(join(options.tempDir, folder, 'skills.json'))).skills.length === 2));
  fixture.run(['--add', 'third/repo', 'two', '--agents', 'codex'], options);
  assert.equal(remoteManifest(options).skills.length, 2);
  assert.equal(fixture.calls.filter((args) => args[0] === 'add').length, 1);
});

test('dirty user checkouts do not affect remote management; shared agent deletion is explicit', (t) => {
  const root = repository(t), fixture = harness(), options = managed(root);
  writeFileSync(join(root, 'skills.json'), JSON.stringify(catalog));
  fixture.run(['--add', 'third/repo', 'two'], { ...options, cwd: root });
  assert.equal(readFileSync(join(root, 'skills.json'), 'utf8'), JSON.stringify(catalog));
  assert.deepEqual(remoteManifest(options).skills.map((item) => item.name), ['one', 'two']);
  assert.throws(() => changeManifest(catalog, parseArgs(['--del', 'one', '--agents', 'codex'])), /共用安装目录/);
  const { next } = changeManifest(catalog, parseArgs(['--del', 'one', '--agents', 'claude-code']));
  assert.deepEqual(next.skills[0].agents, ['codex', 'github-copilot']);
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
  assert.equal(remoteManifest(options).skills.length, 0);
  assert.equal(fixture.calls.filter((args) => args[0] === 'remove').length, 1);
});

test('a concurrent remote edit rejects push; retry preserves it and applies the requested addition', (t) => {
  const root = repository(t), options = managed(root), fixture = harness();
  fixture.dependencies.runDryruns = () => {
    writeFileSync(join(root, 'skills.json'), JSON.stringify({ skills: [entry('one', ['codex']), entry('concurrent')] }, null, 2) + '\n');
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
