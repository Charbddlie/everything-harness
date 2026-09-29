import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os, { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { OWN_SOURCE, RULE_CALLBACKS, RULE_CHECKS, changeManifest, checkSkills, parseArgs, sync, validateManifest } from '../sync.mjs';

const member = (type_name) => ({ type_name });
const skill = (name, source = OWN_SOURCE) => ({ name, source });
const block = (name, body) => `<!-- eh:${name}:start -->\n${body}\n<!-- eh:${name}:end -->`;
const put = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const skillText = (name) => `---\nname: ${name}\ndescription: Test skill.\n---\n`;

function fixture(t, manifest = {
  agents: ['codex', 'github-copilot'],
  skill: [skill('core'), skill('paper'), skill('zotero'), skill('unused')],
  'agents-md': [{ name: 'base' }, { name: 'win-dev' }],
  'sync-rules': { auto: [member('skill:core'), member('agents-md:base')], win: [member('agents-md:win-dev')], learn: [member('skill:paper'), member('skill:zotero')] },
}) {
  const root = mkdtempSync(join(tmpdir(), 'eh-rules-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [], events = [], logs = [];
  const shared = join(root, '.agents', 'skills');
  const seed = (name, source = OWN_SOURCE) => {
    put(join(shared, name, 'SKILL.md'), skillText(name));
    put(join(shared, name, '.eh-source.json'), JSON.stringify({ source }));
  };
  const settings = join(root, 'state', 'harness.json');
  const target = join(root, '.codex', 'AGENTS.md');
  const dependencies = {
    stateDir: dirname(settings), homeDir: root, tempDir: root, env: {}, platform: 'linux',
    fetchManifest: () => JSON.stringify(manifest),
    fetchFragment: (name) => { events.push(`body:${name}`); return `Body ${name}`; },
    log: (message) => {
      logs.push(message); events.push(message);
      const add = message.match(/^覆盖安装：(\S+) \/ (\S+) →/), del = message.match(/^删除本机安装：(\S+) →/);
      if (add) { calls.push(['add', add[1], add[2]]); events.push(`add:${add[2]}`); }
      if (del) { calls.push(['remove', del[1]]); events.push(`del:${del[1]}`); }
    },
    fetchRepository: (source, path) => {
      for (const { name } of manifest.skill.filter((entry) => entry.source === source)) {
        put(join(path, 'skills', name, 'SKILL.md'), skillText(name));
      }
    },
    runDryruns: (entries) => { for (const entry of entries) events.push(`test:${entry.name}`); },
    runGit: () => assert.fail('Local operations must not use Git'),
  };
  return { root, manifest, seed, calls, events, logs, settings, target, dependencies,
    get installed() {
      return new Map((existsSync(shared) ? readdirSync(shared) : []).map((name) => [name, { path: join(shared, name) }]));
    },
    read: () => JSON.parse(readFileSync(settings, 'utf8')),
    run: (args = []) => sync(args, dependencies) };
}

test('add accepts exactly one typed name or a source plus a typed skill name', () => {
  for (const prefix of [[], ['--local']]) {
    assert.equal(parseArgs([...prefix, '--add', 'skill:paper-read']).source, OWN_SOURCE);
    assert.equal(parseArgs([...prefix, '--add', 'other/repo', 'skill:paper-read']).source, 'other/repo');
    for (const name of ['agents-md:win-dev', 'rule:learn']) assert.equal(parseArgs([...prefix, '--add', name]).source, undefined);
    for (const args of [[], ['one'], ['skill:a', 'skill:b'], ['a/b', 'skill:a', 'skill:b'], ['a/b', 'rule:learn'], ['a/b', 'agents-md:one'], ['skill:../escape'], ['a/b', 'a']]) {
      assert.throws(() => parseArgs([...prefix, '--add', ...args]));
    }
  }
  assert.deepEqual(parseArgs(['--del', 'skill:a', 'agents-md:a', 'rule:learn']).targets,
    [{ type: 'skill', name: 'a' }, { type: 'agents-md', name: 'a' }, { type: 'rule', name: 'learn' }]);
});

test('catalog content rejects auto_sync and validates every rule reference and callback', () => {
  const base = { agents: ['codex'], skill: [skill('one')], 'agents-md': [{ name: 'one' }] };
  for (const rules of [null, [], { unknown: [] }, { auto: null }, { auto: ['skill:one'] },
    { auto: [member('skill:missing')] }, { auto: [member('rule:learn')] },
    { auto: [member('skill:one'), member('skill:one')] }, { win: [{ type_name: 'skill:one', extra: true }] }]) {
    assert.throws(() => validateManifest({ ...base, 'sync-rules': rules }));
  }
  for (const type of ['skill', 'agents-md']) {
    assert.throws(() => validateManifest({ ...base, [type]: base[type].map((entry) => ({ ...entry, auto_sync: true })) }), /未知字段/);
  }
  assert.doesNotThrow(() => validateManifest({ ...base, 'sync-rules': { auto: [member('skill:one'), member('agents-md:one')] } }));
  assert.throws(() => validateManifest({ ...base, deleted: [member('rule:auto')] }));
  assert.throws(() => validateManifest({ 'sync-rules': { learn: [member('rule:auto')] } }, { local: true }));
});

test('checked-in rules assign paper and Zotero to learn and win-dev to win', () => {
  const manifest = validateManifest(JSON.parse(readFileSync(new URL('../harness.json', import.meta.url))));
  assert.deepEqual(manifest['sync-rules'].learn, ['paper-add', 'paper-read', 'zotero-init'].map((name) => member(`skill:${name}`)));
  assert.deepEqual(manifest['sync-rules'].win, [member('agents-md:win-dev')]);
  assert.ok(manifest['sync-rules'].auto.some(({ type_name }) => type_name === 'skill:harness-manage'));
  assert.ok([...manifest.skill, ...manifest['agents-md']].every((entry) => !Object.hasOwn(entry, 'auto_sync')));
});

test('harness-manage replaces skill-manage and removes the old installation despite local membership', (t) => {
  const manifest = validateManifest(JSON.parse(readFileSync(new URL('../harness.json', import.meta.url))));
  assert.ok(manifest.skill.some(({ name }) => name === 'harness-manage'));
  assert.ok(!manifest.skill.some(({ name }) => name === 'skill-manage'));
  assert.deepEqual(manifest.deleted.find(({ type_name }) => type_name === 'skill:skill-manage'), {
    type_name: 'skill:skill-manage', source: OWN_SOURCE,
  });
  assert.ok(existsSync(new URL('../skills/harness-manage/SKILL.md', import.meta.url)));
  assert.ok(!existsSync(new URL('../skills/skill-manage/SKILL.md', import.meta.url)));
  const f = fixture(t, manifest);
  for (const name of ['skill-manage', 'unmanaged']) {
    f.seed(name);
  }
  put(f.settings, JSON.stringify({ 'sync-rules': { auto: [member('skill:skill-manage'), member('skill:harness-manage')] } }));
  f.run();
  assert.ok(!f.installed.has('skill-manage'));
  assert.ok(f.installed.has('harness-manage'));
  assert.ok(f.installed.has('unmanaged'));
  assert.ok(f.events.indexOf('del:skill-manage') < f.events.indexOf('add:harness-manage'));
  assert.ok(!f.events.includes('test:skill-manage'));
});

for (const platform of ['linux', 'win32']) {
  test(`win-dev rename cleans old win-dir blocks and follows the win rule on ${platform}`, (t) => {
    const manifest = JSON.parse(readFileSync(new URL('../harness.json', import.meta.url)));
    assert.ok(manifest.deleted.some(({ type_name }) => type_name === 'agents-md:win-dir'));
    assert.ok(!manifest['agents-md'].some(({ name }) => name === 'win-dir'));
    assert.ok(!existsSync(new URL('../agents-md/win-dir.md', import.meta.url)));
    const f = fixture(t, manifest);
    f.dependencies.platform = platform;
    const reads = [];
    f.dependencies.fetchFragment = (name) => {
      reads.push(name);
      return readFileSync(new URL(`../agents-md/${name}.md`, import.meta.url), 'utf8');
    };
    put(f.target, `Personal\n${block('win-dir', 'Old rule')}\n${block('unmanaged', 'Keep')}\n`);
    put(f.settings, JSON.stringify({ 'sync-rules': { auto: [member('agents-md:win-dir')] } }));
    f.run();
    const content = readFileSync(f.target, 'utf8');
    assert.ok(content.startsWith('Personal\n'));
    assert.ok(content.includes(block('unmanaged', 'Keep')));
    assert.ok(!content.includes('eh:win-dir:'));
    assert.ok(!reads.includes('win-dir'));
    assert.equal(content.includes('eh:win-dev:'), platform === 'win32');
    f.run();
    assert.equal(readFileSync(f.target, 'utf8'), content);
  });
}

for (const platform of ['linux', 'darwin', 'win32']) {
  test(`ordinary sync invokes all callbacks on ${platform} and never implicitly enables learn`, (t) => {
    const f = fixture(t); f.dependencies.platform = platform; f.run();
    assert.deepEqual(f.events.filter((event) => event.startsWith('规则回调：')), ['规则回调：rule:auto', '规则回调：rule:win', '规则回调：rule:learn']);
    assert.deepEqual([...f.installed.keys()], ['core']);
    assert.ok(f.events.includes('test:core'));
    assert.ok(!f.events.includes('test:paper'));
    assert.equal(readFileSync(f.target, 'utf8').includes('eh:win-dev:'), platform === 'win32');
    assert.deepEqual(f.read(), { 'sync-rules': {} });
  });
  test(`explicit learn add on ${platform} requires Windows and tests all members before adding`, (t) => {
    const f = fixture(t); f.dependencies.platform = platform;
    f.run(['--local', '--add', 'rule:learn']);
    if (platform !== 'win32') {
      assert.equal(f.calls.length, 0);
      assert.ok(!existsSync(f.settings));
      assert.ok(!f.events.some((event) => event.startsWith('test:')));
      return;
    }
    const expected = ['规则回调：rule:learn', '检测 windows：通过', '检测 explicit：通过', 'test:paper', 'test:zotero', 'add:paper', 'add:zotero'];
    const positions = expected.map((event) => f.events.indexOf(event));
    assert.ok(positions.every((position, i) => position >= 0 && (i === 0 || position > positions[i - 1])));
    assert.deepEqual([...f.installed.keys()], ['paper', 'zotero']);
    assert.deepEqual(f.read(), { 'sync-rules': { learn: f.manifest['sync-rules'].learn } });
    f.events.length = 0; f.run();
    assert.ok(!f.events.includes('test:paper'));
  });
}

test('standalone detectors and callbacks enforce both learn conditions', () => {
  assert.equal(RULE_CHECKS.explicit({ explicit: false }), false);
  assert.equal(RULE_CHECKS.windows({ platform: 'win32' }), true);
  for (const explicit of [false, true]) for (const platform of ['linux', 'win32']) {
    assert.equal(RULE_CALLBACKS.get('learn')({ explicit, platform, log() {} }), explicit && platform === 'win32');
  }
});

test('sync and explicit auto add use the same checks and installation calls', (t) => {
  const implicit = fixture(t), explicit = fixture(t);
  implicit.manifest['sync-rules'] = { auto: implicit.manifest['sync-rules'].auto };
  explicit.manifest['sync-rules'] = { auto: explicit.manifest['sync-rules'].auto };
  implicit.run(); explicit.run(['--local', '--add', 'rule:auto']);
  assert.deepEqual(implicit.calls, explicit.calls);
  const phases = (f) => f.events.filter((event) => /^(规则回调|检测 |test:|add:)/.test(event));
  assert.deepEqual(phases(implicit), phases(explicit));
});

test('rule deletion bypasses callbacks and tests and local add restores the complete group', (t) => {
  const f = fixture(t); f.dependencies.platform = 'win32';
  f.run(['--local', '--add', 'rule:learn']);
  f.dependencies.platform = 'linux'; f.events.length = 0;
  f.dependencies.runDryruns = () => assert.fail('Deletion must not test skills');
  f.run(['--local', '--del', 'rule:learn']);
  assert.equal(f.installed.size, 0);
  assert.deepEqual(f.read()['sync-rules'].learn, []);
  assert.ok(!f.events.some((event) => event.startsWith('规则回调')));
  assert.ok(!f.events.some((event) => event.startsWith('检测 ')));
  f.dependencies.platform = 'win32'; f.dependencies.runDryruns = () => {};
  f.run(['--local', '--add', 'rule:learn']);
  assert.equal(f.installed.size, 2);
  assert.equal(f.manifest['sync-rules'].learn.length, 2);
});

test('a preflight execution error leaves the entire group and local settings untouched', (t) => {
  const f = fixture(t); f.dependencies.platform = 'win32';
  put(f.settings, '{"sync-rules":{}}');
  f.dependencies.runDryruns = (entries) => {
    assert.deepEqual(entries.map(({ name }) => name), ['paper', 'zotero']);
    throw new Error('skill test failed');
  };
  assert.throws(() => f.run(['--local', '--add', 'rule:learn']), /skill test failed/);
  assert.ok(!f.calls.some((args) => args[0] === 'add'));
  assert.equal(readFileSync(f.settings, 'utf8'), '{"sync-rules":{}}');
});

test('sync continues through all rules after a failure and reports the aggregate', (t) => {
  const f = fixture(t); f.dependencies.platform = 'win32';
  f.dependencies.runDryruns = (entries) => { if (entries.length) throw new Error('core failure'); };
  assert.throws(() => f.run(), /auto: core failure/);
  assert.ok(f.events.includes('规则回调：rule:learn'));
  assert.ok(readFileSync(f.target, 'utf8').includes('eh:win-dev:'));
  assert.ok(!existsSync(f.settings));
});

test('list is read-only and dryrun follows rule conditions without installation', (t) => {
  const f = fixture(t); f.dependencies.platform = 'win32';
  f.run(['--list']);
  assert.equal(f.calls.length, 0);
  assert.ok(!f.events.some((event) => event.startsWith('规则回调')));
  f.run(['--dryrun']);
  assert.ok(f.events.includes('test:core'));
  assert.ok(!f.events.includes('test:paper'));
  assert.ok(!f.calls.some((args) => args[0] === 'add' || args[0] === 'remove'));
  assert.ok(!existsSync(f.settings));
  assert.ok(!existsSync(f.target));
});

test('local rule overrides replace membership, retain unrelated blocks and follow remote when removed', (t) => {
  const f = fixture(t);
  const original = `${block('base', 'Frozen')}\n${block('unlisted', 'Keep')}\n`;
  put(f.target, original);
  put(f.settings, JSON.stringify({ 'sync-rules': { auto: [member('skill:unused')] } }));
  f.run();
  assert.deepEqual([...f.installed.keys()], ['unused']);
  assert.equal(readFileSync(f.target, 'utf8'), original);
  put(f.settings, '{"sync-rules":{}}'); f.run();
  assert.ok(readFileSync(f.target, 'utf8').includes('Body base'));
  assert.ok(readFileSync(f.target, 'utf8').includes('Keep'));
});

test('legacy per-item overrides migrate into rule membership without bypassing learn conditions', (t) => {
  const f = fixture(t); f.dependencies.platform = 'win32';
  const original = JSON.stringify({ agents: ['codex'], skills: [
    { ...skill('core'), auto_sync: false, agents: ['github-copilot'] }, { ...skill('paper'), auto_sync: true },
  ], fragments: [{ name: 'base', auto_sync: false }] });
  put(f.settings, original);
  for (const args of [['--list'], ['--dryrun']]) { f.run(args); assert.equal(readFileSync(f.settings, 'utf8'), original); }
  f.run();
  assert.deepEqual(f.read(), { agents: ['codex'], 'sync-rules': { auto: [] } });
  assert.ok(!f.events.includes('test:paper'));
  assert.ok(!f.events.includes('test:core'));
});

test('legacy split files migrate once and remain backed up', (t) => {
  const f = fixture(t);
  const skillsPath = join(dirname(f.settings), 'skills.json'), fragmentsPath = join(dirname(f.settings), 'agents-md.json');
  const skillsText = JSON.stringify({ agents: ['codex'], skills: [{ ...skill('core'), auto_sync: false }] });
  const fragmentText = JSON.stringify({ fragments: [{ name: 'base', auto_sync: false }] });
  put(skillsPath, skillsText); put(fragmentsPath, fragmentText);
  f.run(['--list']); assert.ok(!existsSync(f.settings));
  f.run(); assert.deepEqual(f.read(), { agents: ['codex'], 'sync-rules': { auto: [] } });
  assert.equal(readFileSync(skillsPath, 'utf8'), skillsText);
  assert.equal(readFileSync(fragmentsPath, 'utf8'), fragmentText);
  put(skillsPath, 'invalid'); put(fragmentsPath, 'invalid'); f.run();
});

test('ambiguous or malformed legacy settings fail without side effects', (t) => {
  const f = fixture(t);
  for (const value of [
    { skills: [], skill: [] }, { fragments: [], 'agents-md': [] },
    { skill: [{ ...skill('core'), auto_sync: 'true' }] },
    { skill: [{ ...skill('core'), auto_sync: true }], 'sync-rules': {} },
    { skill: [], 'sync-rules': null },
    { 'sync-rules': { unknown: [] } }, { 'sync-rules': null },
  ]) {
    const original = JSON.stringify(value); put(f.settings, original);
    assert.throws(() => f.run());
    assert.equal(readFileSync(f.settings, 'utf8'), original);
    assert.equal(f.calls.length, 0);
  }
});

test('single-argument add infers own source; external sources require the two-argument form', (t) => {
  const f = fixture(t);
  f.run(['--local', '--add', 'skill:core']);
  assert.equal(f.calls.find((args) => args[0] === 'add')[1], OWN_SOURCE);
  f.manifest.skill.push(skill('external', 'other/repo'));
  assert.throws(() => f.run(['--local', '--add', 'skill:external']), /来源冲突/);
  f.run(['--local', '--add', 'other/repo', 'skill:external']);
  assert.ok(f.installed.has('external'));
  const base = { agents: ['codex'], skill: [] };
  const own = changeManifest(base, parseArgs(['--add', 'skill:new'])).next;
  assert.deepEqual(own.skill, [skill('new')]);
  assert.deepEqual(own['sync-rules'].auto, [member('skill:new')]);
  const external = changeManifest(base, parseArgs(['--add', 'other/repo', 'skill:new'])).next;
  assert.deepEqual(external.skill, [skill('new', 'other/repo')]);
});

test('unknown rules, deleted members and source conflicts stop before mutation', (t) => {
  const f = fixture(t);
  assert.throws(() => f.run(['--local', '--add', 'rule:missing']), /不存在规则/);
  f.manifest.deleted = [{ type_name: 'skill:old', source: OWN_SOURCE }];
  assert.throws(() => f.run(['--local', '--add', 'skill:old']), /已标记删除/);
  f.manifest['sync-rules'].learn.push(member('skill:old'));
  assert.throws(() => f.run(), /不存在或已删除/);
  assert.equal(f.calls.length, 0);
});

test('rule del removes active records and all rule references while preserving deletion sources', () => {
  const manifest = { agents: ['codex'], skill: [skill('one', 'other/repo')], 'agents-md': [{ name: 'one' }],
    'sync-rules': { auto: [member('skill:one')], learn: [member('skill:one'), member('agents-md:one')] } };
  const { next } = changeManifest(manifest, parseArgs(['--del', 'rule:learn']));
  assert.deepEqual(next.skill, []); assert.deepEqual(next['agents-md'], []);
  assert.deepEqual(next['sync-rules'], { auto: [], learn: [] });
  assert.deepEqual(next.deleted, [{ type_name: 'skill:one', source: 'other/repo' }, { type_name: 'agents-md:one' }]);
  assert.equal(manifest.skill.length, 1);
});

test('compatibility auto_sync changes membership without adding flags or installing', (t) => {
  const f = fixture(t);
  f.run(['--local', '--auto_sync', 'false', 'skill:core']);
  assert.deepEqual(f.read()['sync-rules'].auto, [member('agents-md:base')]);
  f.run(['--local', '--auto_sync', 'true', 'skill:core']);
  assert.ok(f.read()['sync-rules'].auto.some(({ type_name }) => type_name === 'skill:core'));
  assert.equal(f.calls.length, 0);
  assert.ok(!JSON.stringify(f.read()).includes('auto_sync'));
});

test('preflight stages source in a temporary project, tests all skills and cleans it on failure', (t) => {
  const f = fixture(t); const paths = [], logs = [];
  const dependencies = { env: {}, tempDir: f.root,
    fetchRepository: (source, repository) => {
      paths.push(dirname(repository));
      for (const name of ['paper', 'zotero']) {
        const path = join(repository, 'skills', name);
        put(join(path, 'SKILL.md'), skillText(name));
        put(join(path, 'dryrun.mjs'), `console.error('failure-${name}'); process.exitCode = 1;`);
      }
    },
  };
  assert.throws(() => checkSkills([skill('paper'), skill('zotero')], ['codex'], dependencies, (line) => logs.push(line)), /2 个 skill/);
  assert.ok(logs.some((line) => line.includes('failure-paper')));
  assert.ok(logs.some((line) => line.includes('failure-zotero')));
  assert.ok(paths.every((path) => !existsSync(path)));
  assert.deepEqual(readdirSync(f.root), []);
});

test('preflight uses user temp independently of content home and cleans up after a download failure', (t) => {
  const f = fixture(t);
  const mock = t.mock.method(os, 'homedir', () => f.root);
  syncBuiltinESMExports();
  let root;
  try {
    assert.throws(() => checkSkills([skill('core')], ['codex'], {
      homeDir: join(f.root, 'custom-home'),
      fetchRepository: (source, repository) => {
        root = dirname(repository);
        assert.equal(dirname(root), join(f.root, 'temp'));
        assert.ok(existsSync(root));
        throw new Error('fixture download failure');
      },
    }, () => {}), /fixture download failure/);
    assert.ok(!existsSync(root));
    assert.deepEqual(readdirSync(join(f.root, 'temp')), []);
    assert.ok(!existsSync(join(f.root, 'custom-home')));
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

for (const blockedType of ['file', 'directory']) for (const failCheck of [false, true]) {
  test(`preflight reports the exact blocked ${blockedType} and preserves check failure=${failCheck}`, (t) => {
    const f = fixture(t);
    let blocked, root;
    const primary = new Error('original dryrun failure');
    const cleanup = Object.assign(new Error('EPERM, Permission denied'), { code: 'EPERM' });
    const dependencies = {
      tempDir: f.root,
      fetchRepository: (source, repository) => {
        root = dirname(repository);
        const path = join(repository, 'skills', 'core');
        const file = join(path, 'SKILL.md');
        put(file, skillText('core'));
        blocked = blockedType === 'file' ? file : path;
      },
      runDryruns: () => { if (failCheck) throw primary; },
    };
    const originalRemove = fs.rmSync;
    const mock = t.mock.method(fs, 'rmSync', (path, options) => {
      if (path === blocked) {
        assert.equal(options.maxRetries, 3);
        assert.equal(options.retryDelay, 100);
        cleanup.path = root;
        throw cleanup;
      }
      return originalRemove(path, options);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => checkSkills([skill('core')], ['codex'], dependencies, () => {}), (error) => {
        assert.ok(error.message.includes(`删除失败：${blocked}；`));
        assert.ok(error.message.includes('EPERM'));
        if (failCheck) {
          assert.ok(error.message.includes(primary.message));
          assert.deepEqual(error.errors, [primary, cleanup]);
        } else assert.equal(error.cause, cleanup);
        return true;
      });
      assert.ok(existsSync(blocked));
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

test('preflight cleanup removes directory links without touching their targets', (t) => {
  const f = fixture(t);
  const target = join(f.root, 'outside');
  put(join(target, 'keep.txt'), 'keep');
  let root;
  checkSkills([skill('core')], ['codex'], {
    tempDir: f.root,
    fetchRepository: (source, repository) => {
      root = dirname(repository);
      symlinkSync(target, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      put(join(repository, 'skills', 'core', 'SKILL.md'), skillText('core'));
    },
    runDryruns: () => {},
  }, () => {});
  assert.ok(!existsSync(root));
  assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'keep');
});

test('remote checkout cleanup reports the blocked file without masking the Git error', (t) => {
  const f = fixture(t);
  let blocked;
  f.dependencies.tempDir = f.root;
  f.dependencies.runGit = (command, args, { cwd }) => {
    blocked = join(cwd, '.git', 'index.lock');
    put(blocked, 'fixture');
    throw new Error('original Git failure');
  };
  const originalRemove = fs.rmSync;
  const mock = t.mock.method(fs, 'rmSync', (path, options) => {
    if (path === blocked) throw Object.assign(new Error('EPERM, Permission denied'), { code: 'EPERM' });
    return originalRemove(path, options);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => f.run(['--add_agents', 'codex']), (error) => {
      assert.ok(error.message.includes('original Git failure'));
      assert.ok(error.message.includes('重新运行同一条命令'));
      assert.ok(error.message.includes(`删除失败：${blocked}；`));
      return true;
    });
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('source conflicts, test failures and concurrent settings edits preserve local configuration', (t) => {
  const f = fixture(t);
  f.run(['--local', '--add', 'skill:core']);
  put(join(f.installed.get('core').path, '.eh-source.json'), '{"source":"other/repo"}');
  const original = readFileSync(f.settings, 'utf8');
  f.events.length = 0;
  assert.throws(() => f.run(['--local', '--del', 'rule:auto']), /来源冲突/);
  assert.equal(readFileSync(f.settings, 'utf8'), original);
  assert.ok(!f.events.some((event) => event.startsWith('test:') || event.startsWith('del:')));
  put(join(f.installed.get('core').path, '.eh-source.json'), JSON.stringify({ source: OWN_SOURCE }));
  const concurrent = '{"agents":["codex"],"sync-rules":{}}';
  f.dependencies.runDryruns = () => put(f.settings, concurrent);
  assert.throws(() => f.run(['--local', '--add', 'skill:core']), /操作期间本机设置已被修改/);
  assert.equal(readFileSync(f.settings, 'utf8'), concurrent);
});
