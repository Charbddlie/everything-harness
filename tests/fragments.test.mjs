import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { clean } from '../clean.mjs';
import { instructionPaths, sync } from '../sync.mjs';

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
    fetchRepository: () => assert.fail('No skill source needed for fragments'),
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
  assert.deepEqual(JSON.parse(readFileSync(f.settings)), { 'sync-rules': {} });
});

test('sync and clean share marker validation, preview and link-preserving cleanup with distinct scopes', async (t) => {
  const f = fixture(t);
  f.manifest.skill = [];
  f.manifest['sync-rules'].auto = [];
  f.manifest.deleted = [{ type_name: 'agents-md:old' }];
  const actual = join(f.root, 'instructions.md');
  const original = `Personal\n${block('old', 'Remove')}\n${block('unmanaged', 'Keep')}\n`;
  put(actual, original);
  for (const target of f.targets) {
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(actual, target);
  }
  put(actual, '<!-- eh:old:start -->\nBroken');
  assert.throws(() => f.run(), /缺少结束标记/);
  await assert.rejects(clean([], f.dependencies), /缺少结束标记/);
  put(actual, original);
  f.run(['--dryrun']);
  await clean(['--dryrun'], f.dependencies);
  assert.equal(readFileSync(actual, 'utf8'), original);
  f.run();
  assert.equal(readFileSync(actual, 'utf8'), `Personal\n\n${block('unmanaged', 'Keep')}\n`);
  await clean([], f.dependencies);
  assert.equal(readFileSync(actual, 'utf8'), 'Personal\n\n\n');
  assert.ok(f.targets.every((target) => lstatSync(target).isSymbolicLink()));
});
