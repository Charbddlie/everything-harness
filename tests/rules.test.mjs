import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os, { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { OWN_SOURCE, checkSkills, sync } from '../sync.mjs';

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
      const add = message.match(/^安装：(\S+) \/ (\S+) →/), del = message.match(/^删除本机安装：(\S+) →/);
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

test('rule deletion bypasses callbacks and tests and local add restores the complete group', (t) => {
  const f = fixture(t);
  f.run(['--local', '--add', 'rule:learn']);
  assert.equal(f.installed.size, 0);
  assert.ok(!existsSync(f.settings));
  f.dependencies.platform = 'win32';
  f.run(['--local', '--add', 'rule:learn']);
  f.dependencies.platform = 'linux'; f.events.length = 0;
  f.dependencies.runDryruns = () => assert.fail('Deletion must not test skills');
  f.run(['--local', '--del', 'rule:learn']);
  assert.equal(f.installed.size, 0);
  assert.deepEqual(f.read()['sync-rules'].learn, []);
  assert.ok(!f.events.some((event) => event.startsWith('自动配置: ')));
  assert.ok(!f.events.some((event) => event.startsWith('检测 ')));
  f.dependencies.platform = 'win32'; f.dependencies.runDryruns = () => {};
  f.run(['--local', '--add', 'rule:learn']);
  assert.equal(f.installed.size, 2);
  assert.equal(f.manifest['sync-rules'].learn.length, 2);
});

test('sync saves configuration first, reports real changes and reconciles both content types after rules', (t) => {
  const f = fixture(t, {
    agents: ['codex', 'github-copilot'], skill: ['core', 'shared', 'windows', 'fresh', 'standalone'].map((name) => skill(name)),
    'agents-md': ['base', 'windows', 'fresh'].map((name) => ({ name })),
    deleted: [member('agents-md:old'), member('agents-md:absent'),
      { ...member('skill:old'), source: OWN_SOURCE }, { ...member('skill:absent'), source: OWN_SOURCE }],
    'sync-rules': {
      auto: ['skill:core', 'skill:shared', 'skill:fresh', 'agents-md:base', 'agents-md:fresh'].map(member),
      win: ['skill:windows', 'skill:shared', 'agents-md:windows', 'agents-md:base'].map(member), learn: [],
    },
  });
  for (const name of ['core', 'shared', 'windows', 'standalone', 'unmanaged', 'old']) f.seed(name);
  put(f.target, `Personal\n${block('base', 'Old base')}\n${block('windows', 'Old windows')}\n${block('old', 'Expired')}\n${block('unmanaged', 'Keep')}\n`);
  const records = [], originalLog = f.dependencies.log, download = f.dependencies.fetchRepository;
  f.dependencies.log = (message, metadata = {}) => { records.push({ message, ...metadata }); originalLog(message); };
  f.dependencies.fetchRepository = (source, path) => {
    assert.deepEqual(f.read(), { 'sync-rules': {} });
    assert.ok(f.installed.has('core') && f.installed.has('shared'));
    if (records[0].message === '创建本地配置') {
      assert.ok(f.installed.has('windows'));
      assert.ok(readFileSync(f.target, 'utf8').includes('eh:windows:'));
    }
    assert.ok(!f.installed.has('old'));
    assert.ok(!readFileSync(f.target, 'utf8').includes('eh:old:'));
    download(source, path);
  };
  f.run();
  assert.equal(records[0].message, '创建本地配置');
  const has = (status, fragment) => records.some((record) => record.status === status && record.message.includes(fragment));
  assert.ok(has('过期', 'old'));
  assert.ok(has('过期', 'agents-md:old'));
  assert.ok(has('更新', ' / core →') && has('更新', 'agents-md:base'));
  assert.ok(has('新增', ' / fresh →') && has('新增', 'agents-md:fresh'));
  assert.ok(has('删除', 'windows') && has('删除', 'agents-md:windows'));
  assert.ok(has('未命中', '需要 Windows，当前为 linux'));
  assert.ok(has('未命中', '需要显式调用 --add rule:learn'));
  assert.ok(records.findIndex(({ status }) => status === '删除') > records.findLastIndex(({ status }) => ['新增', '更新'].includes(status)));
  assert.ok(!records.some(({ message }) => /absent|待删除|无需删除|检测条件未满足/.test(message)));
  for (const name of ['core', 'shared', 'fresh', 'standalone', 'unmanaged']) assert.ok(f.installed.has(name));
  assert.ok(!f.installed.has('windows'));
  const body = readFileSync(f.target, 'utf8');
  assert.ok(body.includes('Personal') && body.includes(block('unmanaged', 'Keep')) && body.includes('eh:base:'));
  assert.ok(!body.includes('eh:windows:'));
  records.length = 0;
  f.run();
  assert.equal(records[0].message, '更新本地配置');
  assert.ok(!records.some(({ status }) => ['过期', '删除', '新增'].includes(status)));
  f.dependencies.platform = 'win32'; records.length = 0;
  f.run();
  assert.ok(has('新增', ' / windows →') && has('新增', 'agents-md:windows'));
});

test('dryrun preserves unmatched content and a failed matching rule keeps its shared content', (t) => {
  const f = fixture(t, {
    agents: ['codex', 'github-copilot'], skill: [skill('core'), skill('windows')],
    'agents-md': [{ name: 'base' }, { name: 'windows' }],
    'sync-rules': {
      auto: [member('skill:core'), member('agents-md:base')],
      win: ['skill:core', 'skill:windows', 'agents-md:base', 'agents-md:windows'].map(member),
    },
  });
  f.seed('core'); f.seed('windows');
  const original = `Personal\n${block('base', 'Keep base')}\n${block('windows', 'Remove windows')}\n`;
  put(f.target, original);
  f.run(['--dryrun']);
  assert.ok(!existsSync(f.settings));
  assert.ok(f.installed.has('core') && f.installed.has('windows'));
  assert.equal(readFileSync(f.target, 'utf8'), original);
  f.dependencies.fetchRepository = () => { throw new Error('network unavailable'); };
  assert.throws(() => f.run(), /network unavailable/);
  assert.ok(f.installed.has('core'));
  assert.ok(!f.installed.has('windows'));
  assert.equal(readFileSync(f.target, 'utf8'), `Personal\n${block('base', 'Keep base')}\n\n`);
  assert.ok(existsSync(f.settings));
});

test('empty local rules explain absent updates and preserve declared membership and installed content', (t) => {
  const f = fixture(t);
  const settings = { 'sync-rules': { auto: [], win: [], learn: [] } };
  put(f.settings, JSON.stringify(settings));
  f.seed('core');
  put(f.target, block('base', 'Existing instructions'));
  f.dependencies.fetchRepository = () => assert.fail('Empty rules require no source');
  f.run();
  assert.deepEqual(f.read(), settings);
  assert.ok(f.installed.has('core'));
  assert.equal(readFileSync(f.target, 'utf8'), block('base', 'Existing instructions'));
  assert.equal(f.calls.length, 0);
  for (const rule of ['auto', 'win', 'learn']) {
    const index = f.logs.indexOf(`自动配置: ${rule}`);
    assert.match(f.logs[index + 1], new RegExp(`rule:${rule}：本机覆盖后成员为空`));
  }
  assert.equal(f.logs.filter((line) => line.includes('需要 Windows，当前为 linux')).length, 2);
  assert.ok(f.logs.indexOf('完成') > f.logs.indexOf('自动配置: learn'));
  assert.deepEqual(f.logs.slice(-2), [
    '本次未应用的 rule：rule:auto, rule:win, rule:learn',
    '未安装的独立skill：skill:unused',
  ]);
});

test('sync summary checks the selected home rather than installations in the original home', (t) => {
  const f = fixture(t), home = join(f.root, 'other-home');
  f.seed('unused');
  f.run(['--home', home]);
  assert.equal(f.logs.at(-1), '未安装的独立skill：skill:unused');
  put(join(home, '.copilot', 'skills', 'unused', 'SKILL.md'), skillText('unused'));
  f.logs.length = 0;
  f.run(['--home', home]);
  assert.equal(f.logs.at(-1), '本次未应用的 rule：rule:win, rule:learn');
  assert.ok(!f.logs.some((line) => line.startsWith('未安装的独立skill：')));
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
      assert.ok(!error.message.includes('EPERM'));
      return true;
    });
    assert.ok(f.logs.some((line) => line.includes(`删除失败：${blocked}；`)));
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('temporary cleanup failure does not block fragments, later rules or local settings', (t) => {
  const f = fixture(t);
  f.dependencies.platform = 'win32';
  const originalRemove = fs.rmSync;
  let blocked;
  const mock = t.mock.method(fs, 'rmSync', (path, options) => {
    if (path.includes('eh-check-') && path.endsWith('SKILL.md')) {
      blocked = path;
      throw new Error('EPERM fixture');
    }
    return originalRemove(path, options);
  });
  syncBuiltinESMExports();
  try {
    assert.doesNotThrow(() => f.run());
    assert.ok(f.installed.has('core'));
    assert.ok(readFileSync(f.target, 'utf8').includes('eh:base:start'));
    assert.ok(readFileSync(f.target, 'utf8').includes('eh:win-dev:start'));
    assert.ok(f.events.includes('自动配置: learn'));
    assert.ok(existsSync(f.settings));
    assert.ok(f.logs.some((line) => line.includes(blocked) && line.includes('继续执行')));
    assert.equal(f.logs.at(-3), '规则同步和环境检查完成。');
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
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
