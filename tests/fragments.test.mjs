import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { instructionPaths, parseArgs, renderFragments, sync, validateFragments, validateManifest } from '../sync.mjs';

const fragment = (name) => ({ name });
const block = (name, content) => `<!-- eh:${name}:start -->\n${content}\n<!-- eh:${name}:end -->`;
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'eh-fragments-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = { agents: ['codex', 'github-copilot'], skill: [], 'agents-md': [fragment('one'), fragment('two'), fragment('disabled')], 'sync-rules': { auto: [{ type_name: 'agents-md:one' }, { type_name: 'agents-md:two' }] } };
  const content = { one: 'First rule', two: 'Second rule', disabled: 'Optional rule' };
  const logs = [], reads = [];
  const dependencies = {
    stateDir: join(root, 'state'), homeDir: root, env: {},
    fetchManifest: () => JSON.stringify(manifest),
    fetchFragment: (name) => { reads.push(name); return content[name]; },
    runSkills: () => assert.fail('No skill CLI needed for fragments'),
    runGit: () => assert.fail('No Git needed for local operations'),
    log: (message) => logs.push(message),
  };
  return { root, manifest, content, logs, reads, dependencies,
    targets: instructionPaths(manifest.agents, dependencies),
    settings: join(dependencies.stateDir, 'harness.json'),
    run: (args = []) => sync(args, dependencies) };
}

test('first sync creates both targets and empty local overrides; repeat overwrites local body edits', (t) => {
  const f = fixture(t);
  f.run();
  assert.deepEqual(JSON.parse(readFileSync(f.settings)), { 'sync-rules': {} });
  for (const path of f.targets) {
    assert.equal(readFileSync(path, 'utf8'), `${block('one', f.content.one)}\n\n${block('two', f.content.two)}\n`);
    put(path, `Personal prefix\n${block('one', 'LOCAL EDIT')}\n${block('two', 'STALE')}\nPersonal suffix`);
  }
  f.content.one = 'New remote rule';
  f.run();
  for (const path of f.targets) {
    const expected = `Personal prefix\n${block('one', 'New remote rule')}\n${block('two', f.content.two)}\nPersonal suffix`;
    assert.equal(readFileSync(path, 'utf8'), expected);
    f.run();
    assert.equal(readFileSync(path, 'utf8'), expected);
  }
  assert.ok(!f.reads.includes('disabled'));
});

test('global target override controls fragments and empty targets skip content downloads', (t) => {
  const f = fixture(t);
  put(join(f.dependencies.stateDir, 'harness.json'), '{"agents":["codex"],"sync-rules":{}}');
  f.run();
  assert.ok(existsSync(f.targets[0]));
  assert.ok(!existsSync(f.targets[1]));
  f.reads.length = 0;
  put(join(f.dependencies.stateDir, 'harness.json'), '{"agents":[],"sync-rules":{}}');
  f.run();
  assert.deepEqual(f.reads, []);
});

test('dryrun validates selected bodies and target markers without initializing or writing', (t) => {
  const f = fixture(t);
  put(f.targets[0], 'Personal content');
  f.run(['--dryrun']);
  assert.equal(readFileSync(f.targets[0], 'utf8'), 'Personal content');
  assert.ok(!existsSync(f.targets[1]));
  assert.ok(!existsSync(f.settings));
  assert.deepEqual(f.reads, ['one', 'two']);
  f.content.two = '';
  assert.throws(() => f.run(['--dryrun']), /失败/);
});

test('download or target validation failures happen before skill installation or instruction writes', (t) => {
  const f = fixture(t);
  f.manifest.skill.push({ name: 'some-skill', source: 'example/skills' });
  f.targets.forEach((path) => put(path, 'Personal content'));
  f.dependencies.fetchFragment = () => { throw new Error('download failed'); };
  assert.throws(() => f.run(), /失败/);
  f.dependencies.fetchFragment = (name) => f.content[name];
  put(f.targets[1], '<!-- eh:one:start -->\nBroken');
  assert.throws(() => f.run(), /失败/);
  assert.equal(readFileSync(f.targets[0], 'utf8'), 'Personal content');
  assert.ok(!existsSync(f.settings));
});

test('malformed, nested and duplicate markers fail; remote bodies cannot introduce markers', () => {
  const fragments = [{ name: 'one', content: 'New content' }];
  for (const text of ['<!-- eh:one:start -->', '<!-- eh:one:end -->',
    '<!-- eh:one:start --> <!-- eh:two:end -->',
    `<!-- eh:one:start --> ${block('two', 'nested')} <!-- eh:one:end -->`,
    block('one', 'a') + block('one', 'b'), '<!-- eh:bad mark -->']) {
    assert.throws(() => renderFragments(text, fragments), /标记/);
  }
  assert.throws(() => renderFragments('', [{ name: 'one', content: block('two', 'nested') }]), /保留标记/);
});

test('replacement preserves surrounding CRLF, literal dollar signs and disabled blocks', () => {
  const original = `Intro\r\n${block('one', 'Old')}\r\n${block('frozen', 'Keep')}\r\nEnd`;
  const body = 'Price $5; literal $& and $1; equation $$x^2$$';
  assert.equal(renderFragments(original, [{ name: 'one', content: body }]),
    `Intro\r\n${block('one', body)}\r\n${block('frozen', 'Keep')}\r\nEnd`);
});

test('instruction paths honor Codex and Copilot overrides', () => {
  assert.deepEqual(instructionPaths(['codex', 'github-copilot'], {
    env: { CODEX_HOME: '/custom/codex', COPILOT_HOME: '/custom/copilot' }, homeDir: '/profile',
  }), [join('/custom/codex', 'AGENTS.md'), join('/custom/copilot', 'copilot-instructions.md')]);
});

test('existing instruction file symlink is preserved', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  const actual = join(f.root, 'actual.md');
  put(actual, 'Personal content\n');
  mkdirSync(dirname(f.targets[0]), { recursive: true });
  symlinkSync(actual, f.targets[0]);
  f.run();
  assert.ok(lstatSync(f.targets[0]).isSymbolicLink());
  assert.ok(readFileSync(actual, 'utf8').includes(block('one', f.content.one)));
});

test('fragment CLI requires typed names and rejects the old modifier', () => {
  assert.deepEqual(parseArgs(['--auto_sync', 'false', 'agents-md:one', '--local']).targets, [{ type: 'agents-md', name: 'one' }]);
  for (const args of [['--fragments'], ['--add', 'a/b', 'agents-md:one'],
    ['--auto_sync', 'maybe', 'agents-md:one'], ['--auto_sync', 'true', '../escape']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('renamed fragment removes the old block before adding the new one, overriding local switches', (t) => {
  const f = fixture(t);
  f.manifest['agents-md'] = [fragment('one')];
  f.manifest['sync-rules'].auto = [{ type_name: 'agents-md:one' }];
  f.manifest.deleted = [{ type_name: 'agents-md:old' }];
  put(f.settings, JSON.stringify({ 'sync-rules': { auto: [{ type_name: 'agents-md:old' }, { type_name: 'agents-md:one' }] } }));
  const original = `Intro\n${block('old', 'Local edits')}\n${block('unmanaged', 'Keep')}\nEnd`;
  f.targets.forEach((path) => put(path, original));
  f.run(['--dryrun']);
  assert.ok(f.logs.some((line) => line.includes('片段已标记删除：old')));
  assert.equal(readFileSync(f.targets[0], 'utf8'), original);
  f.run();
  for (const path of f.targets) {
    const result = readFileSync(path, 'utf8');
    assert.ok(!result.includes('eh:old:'));
    assert.ok(result.startsWith(`Intro\n\n${block('unmanaged', 'Keep')}\nEnd`));
    assert.ok(result.includes(block('one', f.content.one)));
    f.run();
    assert.equal(readFileSync(path, 'utf8'), result);
  }
  assert.ok(!f.reads.includes('old'));
  assert.deepEqual(f.manifest.deleted, [{ type_name: 'agents-md:old' }]);
});

test('fragment deletion with no replacement never creates empty instruction files', (t) => {
  const f = fixture(t);
  f.manifest['agents-md'] = [];
  f.manifest['sync-rules'].auto = [];
  f.manifest.deleted = [{ type_name: 'agents-md:old' }];
  f.run();
  assert.ok(f.targets.every((path) => !existsSync(path)));
  assert.deepEqual(f.reads, []);
  put(f.targets[0], block('old', 'Remove'));
  f.run();
  assert.equal(readFileSync(f.targets[0], 'utf8'), '');
});

test('fragment records reject source, per-fragment agents and invalid deletion flags', () => {
  for (const extra of [{ source: 'example/repo' }, { agents: ['codex'] }, { deleted: 'true' }]) {
    assert.throws(() => validateManifest({ agents: ['codex'], skill: [], 'agents-md': [{ ...fragment('one'), ...extra }] }));
  }
  assert.throws(() => validateManifest({ skill: [], 'agents-md': [{ ...fragment('one'), deleted: false }] }, { local: true }));
});

test('checked-in old skills are tombstones with removed source', () => {
  const manifest = validateManifest(JSON.parse(readFileSync(new URL('../harness.json', import.meta.url))));
  for (const name of ['dev-directory', 'formula-display', 'simple-doc']) {
    assert.deepEqual(manifest.deleted.find((item) => item.type_name === `skill:${name}`), {
      type_name: `skill:${name}`, source: 'Charbddlie/everything-harness',
    });
    assert.ok(!manifest.skill.some((item) => item.name === name));
    if (name !== 'dev-directory') assert.ok(manifest['sync-rules'].auto.some((item) => item.type_name === `agents-md:${name}`));
    assert.ok(!existsSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url)));
  }
});
