import assert from 'node:assert/strict';
import fs, { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { clean } from '../clean.mjs';

const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const block = '<!-- eh:custom-rule:start -->\nManaged\n<!-- eh:custom-rule:end -->';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'eh-clean-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'user'), selected = join(root, 'selected'), logs = [];
  const manifest = { agents: ['codex'], skill: [{ name: 'active', source: 'example/skills' }],
    deleted: [{ type_name: 'skill:removed', source: 'example/skills' }, { type_name: 'agents-md:old-rule' }] };
  const dependencies = { homeDir: home, cwd: root, log: (line) => logs.push(line), fetchManifest: () => JSON.stringify(manifest) };
  return { root, home, selected, logs, manifest, dependencies, run: (args = []) => clean(args, dependencies) };
}

test('clean covers both roots, every supported directory, active and deleted names, but preserves other content', async (t) => {
  const f = fixture(t), originals = new Map();
  for (const root of [f.home, f.selected]) {
    for (const directory of ['.agents', '.codex', '.copilot']) {
      for (const name of ['active', 'removed', 'unmanaged']) {
        put(join(root, directory, 'skills', name, 'SKILL.md'), 'content');
        put(join(root, directory, 'skills', name, '.eh-source.json'), '{"source":"unrelated/repo"}');
      }
    }
    for (const directory of [root, ...['.agents', '.codex', '.copilot'].map((name) => join(root, name))]) {
      for (const name of ['AGENTS.md', 'CLAUDE.md', 'copilot-instructions.md']) {
        const path = join(directory, name);
        originals.set(path, `Before\r\n${block}\nAfter\n`);
        put(path, originals.get(path));
      }
    }
    put(join(root, '.everything-harness', 'harness.json'), '{"agents":[]}');
    put(join(root, '.agents', '.skill-lock.json'), 'Keep lock');
  }
  await f.run(['--home', f.selected, '--dryrun']);
  for (const [path, original] of originals) assert.equal(readFileSync(path, 'utf8'), original);
  assert.ok(existsSync(join(f.home, '.agents', 'skills', 'active')));
  await f.run(['--home', f.selected]);
  for (const root of [f.home, f.selected]) {
    for (const directory of ['.agents', '.codex', '.copilot']) {
      for (const name of ['active', 'removed']) assert.ok(!existsSync(join(root, directory, 'skills', name)));
      assert.ok(existsSync(join(root, directory, 'skills', 'unmanaged', 'SKILL.md')));
    }
    assert.equal(readFileSync(join(root, '.everything-harness', 'harness.json'), 'utf8'), '{"agents":[]}');
    assert.equal(readFileSync(join(root, '.agents', '.skill-lock.json'), 'utf8'), 'Keep lock');
  }
  for (const [path] of originals) assert.equal(readFileSync(path, 'utf8'), 'Before\r\n\nAfter\n');
  await f.run(['--home', f.selected]);
  assert.match(f.logs.at(-1), /0 个 skill 路径，0 个指令文件/);
});

test('malformed markers or manifest abort before any deletion', async (t) => {
  const f = fixture(t), skill = join(f.home, '.agents', 'skills', 'active', 'SKILL.md');
  put(skill, 'Keep');
  put(join(f.selected, 'AGENTS.md'), '<!-- eh:broken:start -->\nKeep');
  await assert.rejects(f.run(['--home', f.selected]), /缺少结束标记/);
  assert.ok(existsSync(skill));
  f.manifest.skill[0].name = '../escape';
  await assert.rejects(f.run(), /无效 skill/);
  assert.ok(existsSync(skill));
});

test('skill links are removed without deleting their targets and instruction links are preserved', async (t) => {
  const f = fixture(t), outside = join(f.root, 'outside');
  put(join(outside, 'SKILL.md'), 'Keep');
  const skills = join(f.home, '.agents', 'skills'); mkdirSync(skills, { recursive: true });
  symlinkSync(outside, join(skills, 'active'), process.platform === 'win32' ? 'junction' : 'dir');
  await f.run();
  assert.ok(!existsSync(join(skills, 'active')));
  assert.ok(existsSync(join(outside, 'SKILL.md')));
  if (process.platform !== 'win32') {
    put(join(outside, 'instructions.md'), `Keep\n${block}`);
    symlinkSync(join(outside, 'instructions.md'), join(f.home, 'AGENTS.md'));
    await f.run();
    assert.ok(lstatSync(join(f.home, 'AGENTS.md')).isSymbolicLink());
    assert.equal(readFileSync(join(outside, 'instructions.md'), 'utf8'), 'Keep\n');
  }
});

test('a blocked deletion is reported while other selected paths are cleaned', async (t) => {
  const f = fixture(t), blocked = join(f.home, '.agents', 'skills', 'active', 'SKILL.md');
  put(blocked, 'Keep');
  const other = join(f.home, '.codex', 'skills', 'removed');
  put(join(other, 'SKILL.md'), 'Remove');
  const remove = fs.rmSync;
  const mock = t.mock.method(fs, 'rmSync', (path, options) => {
    if (path === blocked) throw new Error('EPERM fixture');
    return remove(path, options);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.run(), (error) => error.message.includes(blocked) && error.message.includes('EPERM fixture'));
    assert.ok(existsSync(blocked));
    assert.ok(!existsSync(other));
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});
