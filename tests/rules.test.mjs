import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { AGENTS, OWN_SOURCE, RULE_CALLBACKS, RULE_CHECKS, changeManifest, checkSkills, parseArgs, sync, validateManifest } from '../sync.mjs';

const member = (type_name) => ({ type_name });
const skill = (name, source = OWN_SOURCE) => ({ name, source });
const block = (name, body) => `<!-- eh:${name}:start -->\n${body}\n<!-- eh:${name}:end -->`;
const put = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };

function fixture(t, manifest = {
  agents: ['codex', 'github-copilot'],
  skill: [skill('core'), skill('paper'), skill('zotero'), skill('unused')],
  'agents-md': [{ name: 'base' }, { name: 'win-dir' }],
  'sync-rules': { auto: [member('skill:core'), member('agents-md:base')], win: [member('agents-md:win-dir')], learn: [member('skill:paper'), member('skill:zotero')] },
}) {
  const root = mkdtempSync(join(tmpdir(), 'eh-rules-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [], events = [], logs = [], installed = new Map();
  const settings = join(root, 'state', 'harness.json');
  const target = join(root, '.codex', 'AGENTS.md');
  const dependencies = {
    stateDir: dirname(settings), homeDir: root, env: {}, platform: 'linux',
    fetchManifest: () => JSON.stringify(manifest),
    fetchFragment: (name) => { events.push(`body:${name}`); return `Body ${name}`; },
    log: (message) => { logs.push(message); events.push(message); },
    checkSkills: (entries) => { for (const entry of entries) events.push(`test:${entry.name}`); },
    runSkills: (args) => {
      calls.push(args);
      if (args[0] === 'list') return JSON.stringify([...installed.values()]);
      if (args[0] === 'remove') { events.push(`del:${args[1]}`); installed.delete(args[1]); return ''; }
      const names = args.slice(args.indexOf('--skill') + 1, args.indexOf('--agent'));
      const agents = args.slice(args.indexOf('--agent') + 1, args.indexOf('-g')).map((name) => AGENTS.get(name));
      return JSON.stringify(names.map((name) => {
        events.push(`add:${name}`);
        const record = { name, source: args[1], sourceType: 'github', scope: 'global', path: join(root, 'installed', name), agents };
        installed.set(name, record);
        return { ...record, status: 'installed' };
      }));
    },
    runGit: () => assert.fail('Local operations must not use Git'),
  };
  return { root, manifest, installed, calls, events, logs, settings, target, dependencies,
    read: () => JSON.parse(readFileSync(settings, 'utf8')),
    run: (args = []) => sync(args, dependencies) };
}

test('add accepts exactly one typed name or a source plus a typed skill name', () => {
  for (const prefix of [[], ['--local']]) {
    assert.equal(parseArgs([...prefix, '--add', 'skill:paper-read']).source, OWN_SOURCE);
    assert.equal(parseArgs([...prefix, '--add', 'other/repo', 'skill:paper-read']).source, 'other/repo');
    for (const name of ['agents-md:win-dir', 'rule:learn']) assert.equal(parseArgs([...prefix, '--add', name]).source, undefined);
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

test('checked-in rules assign paper and Zotero to learn and win-dir to win', () => {
  const manifest = validateManifest(JSON.parse(readFileSync(new URL('../harness.json', import.meta.url))));
  assert.deepEqual(manifest['sync-rules'].learn, ['paper-add', 'paper-read', 'zotero-init'].map((name) => member(`skill:${name}`)));
  assert.deepEqual(manifest['sync-rules'].win, [member('agents-md:win-dir')]);
  assert.ok(manifest['sync-rules'].auto.some(({ type_name }) => type_name === 'skill:skill-manage'));
  assert.ok([...manifest.skill, ...manifest['agents-md']].every((entry) => !Object.hasOwn(entry, 'auto_sync')));
});

for (const platform of ['linux', 'darwin', 'win32']) {
  test(`ordinary sync invokes all callbacks on ${platform} and never implicitly enables learn`, (t) => {
    const f = fixture(t); f.dependencies.platform = platform; f.run();
    assert.deepEqual(f.events.filter((event) => event.startsWith('规则回调：')), ['规则回调：rule:auto', '规则回调：rule:win', '规则回调：rule:learn']);
    assert.deepEqual([...f.installed.keys()], ['core']);
    assert.ok(f.events.includes('test:core'));
    assert.ok(!f.events.includes('test:paper'));
    assert.equal(readFileSync(f.target, 'utf8').includes('eh:win-dir:'), platform === 'win32');
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
  f.dependencies.checkSkills = () => assert.fail('Deletion must not test skills');
  f.run(['--local', '--del', 'rule:learn']);
  assert.equal(f.installed.size, 0);
  assert.deepEqual(f.read()['sync-rules'].learn, []);
  assert.ok(!f.events.some((event) => event.startsWith('规则回调')));
  assert.ok(!f.events.some((event) => event.startsWith('检测 ')));
  f.dependencies.platform = 'win32'; f.dependencies.checkSkills = () => {};
  f.run(['--local', '--add', 'rule:learn']);
  assert.equal(f.installed.size, 2);
  assert.equal(f.manifest['sync-rules'].learn.length, 2);
});

test('a failed skill test leaves the entire group and local settings untouched', (t) => {
  const f = fixture(t); f.dependencies.platform = 'win32';
  put(f.settings, '{"sync-rules":{}}');
  f.dependencies.checkSkills = (entries) => {
    assert.deepEqual(entries.map(({ name }) => name), ['paper', 'zotero']);
    throw new Error('skill test failed');
  };
  assert.throws(() => f.run(['--local', '--add', 'rule:learn']), /skill test failed/);
  assert.ok(!f.calls.some((args) => args[0] === 'add'));
  assert.equal(readFileSync(f.settings, 'utf8'), '{"sync-rules":{}}');
});

test('sync continues through all rules after a failure and reports the aggregate', (t) => {
  const f = fixture(t); f.dependencies.platform = 'win32';
  f.dependencies.checkSkills = (entries) => { if (entries.length) throw new Error('core failure'); };
  assert.throws(() => f.run(), /auto: core failure/);
  assert.ok(f.events.includes('规则回调：rule:learn'));
  assert.ok(readFileSync(f.target, 'utf8').includes('eh:win-dir:'));
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
    createCheckRunner: ({ cwd }) => {
      paths.push(cwd);
      return (args) => {
        assert.ok(!args.includes('-g'));
        return JSON.stringify(args.slice(args.indexOf('--skill') + 1, args.indexOf('--agent')).map((name) => {
          const path = join(cwd, '.agents', 'skills', name);
          put(join(path, 'dryrun.mjs'), `console.error('failure-${name}'); process.exitCode = 1;`);
          return { name, status: 'installed', scope: 'project', path, agents: ['Codex'] };
        }));
      };
    },
  };
  assert.throws(() => checkSkills([skill('paper'), skill('zotero')], ['codex'], dependencies, (line) => logs.push(line)), /2 个 skill/);
  assert.ok(logs.some((line) => line.includes('failure-paper')));
  assert.ok(logs.some((line) => line.includes('failure-zotero')));
  assert.ok(paths.every((path) => !existsSync(path)));
  assert.deepEqual(readdirSync(f.root), []);
});

test('source conflicts, test failures and concurrent settings edits preserve local configuration', (t) => {
  const f = fixture(t);
  f.run(['--local', '--add', 'skill:core']);
  f.installed.get('core').source = 'other/repo';
  const original = readFileSync(f.settings, 'utf8');
  f.events.length = 0;
  assert.throws(() => f.run(['--local', '--del', 'rule:auto']), /来源冲突/);
  assert.equal(readFileSync(f.settings, 'utf8'), original);
  assert.ok(!f.events.some((event) => event.startsWith('test:') || event.startsWith('del:')));
  f.installed.get('core').source = OWN_SOURCE;
  const concurrent = '{"agents":["codex"],"sync-rules":{}}';
  f.dependencies.checkSkills = () => put(f.settings, concurrent);
  assert.throws(() => f.run(['--local', '--add', 'skill:core']), /操作期间本机设置已被修改/);
  assert.equal(readFileSync(f.settings, 'utf8'), concurrent);
});
