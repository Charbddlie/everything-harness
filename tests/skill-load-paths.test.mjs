import assert from 'node:assert/strict';
import fs, { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { copySkill, sync, writeAtomic } from '../sync.mjs';

const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const text = '---\nname: one\ndescription: Test skill.\n---\nVersion one\n';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'eh-load-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), source = join(root, 'source');
  const entry = { name: 'one', source: 'example/repo' };
  put(join(source, 'SKILL.md'), text);
  const manifest = { agents: ['codex', 'github-copilot'], skill: [entry], 'sync-rules': { auto: [{ type_name: 'skill:one' }] } };
  const dependencies = {
    homeDir: home, tempDir: root, env: {}, log() {}, fetchManifest: () => JSON.stringify(manifest),
    fetchRepository: (source, path) => put(join(path, 'skills', 'one', 'SKILL.md'), text),
  };
  return { root, home, source, entry, manifest, dependencies,
    shared: join(home, '.agents', 'skills', 'one'),
    target: (agent) => join(home, agent, 'skills', 'one'),
    run: (args = []) => sync(args, dependencies) };
}

test('copy prepares a complete replacement, removes stale files and records the source', (t) => {
  const f = fixture(t), target = join(f.root, 'installed', 'one');
  put(join(f.source, 'scripts', 'run.mjs'), 'console.log("one");');
  put(join(f.source, '.git', 'config'), 'not skill content');
  put(join(target, 'stale.txt'), 'stale');
  copySkill(f.entry, f.source, target);
  assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), text);
  assert.ok(existsSync(join(target, 'scripts', 'run.mjs')));
  assert.ok(!existsSync(join(target, 'stale.txt')));
  assert.ok(!existsSync(join(target, '.git')));
  assert.deepEqual(JSON.parse(readFileSync(join(target, '.eh-source.json'))), { source: 'example/repo' });
});

test('failed replacement restores the existing directory', (t) => {
  const f = fixture(t), target = join(f.root, 'installed', 'one');
  put(join(target, 'SKILL.md'), 'Keep');
  const originalRename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (from.endsWith('.tmp') && to === target) throw new Error('rename denied');
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => copySkill(f.entry, f.source, target), /rename denied/);
    assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), 'Keep');
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test('failure to delete a replacement backup only warns after installing new content', (t) => {
  const f = fixture(t), target = join(f.root, 'installed', 'one'), logs = [];
  put(join(target, 'SKILL.md'), 'Old content');
  const originalRemove = fs.rmSync;
  let blocked;
  const mock = t.mock.method(fs, 'rmSync', (path, options) => {
    if (path.endsWith('.bak')) { blocked = path; throw new Error('EPERM fixture'); }
    return originalRemove(path, options);
  });
  syncBuiltinESMExports();
  try {
    assert.doesNotThrow(() => copySkill(f.entry, f.source, target, (line) => logs.push(line)));
    assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), text);
    assert.ok(logs.some((line) => line.includes(blocked) && line.includes('继续执行')));
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test('a blocked atomic-write temporary file does not mask the write error', (t) => {
  const f = fixture(t), target = join(f.root, 'settings.json'), logs = [];
  put(target, 'Keep');
  const primary = new Error('rename denied');
  let temporary;
  const rename = t.mock.method(fs, 'renameSync', (from) => { temporary = from; throw primary; });
  const originalRemove = fs.rmSync;
  const remove = t.mock.method(fs, 'rmSync', (path, options) => {
    if (path === temporary) throw new Error('EPERM fixture');
    return originalRemove(path, options);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => writeAtomic(target, 'New', (line) => logs.push(line)), (error) => error === primary);
    assert.equal(readFileSync(target, 'utf8'), 'Keep');
    assert.ok(logs.some((line) => line.includes(temporary) && line.includes('EPERM')));
  } finally { rename.mock.restore(); remove.mock.restore(); syncBuiltinESMExports(); }
});

test('replacing a directory link leaves its previous target intact', (t) => {
  const f = fixture(t), target = join(f.root, 'linked');
  symlinkSync(f.source, target, process.platform === 'win32' ? 'junction' : 'dir');
  copySkill(f.entry, f.source, target);
  assert.ok(!lstatSync(target).isSymbolicLink());
  assert.equal(readFileSync(join(f.source, 'SKILL.md'), 'utf8'), text);
});

test('user home only gets shared skills while both agents receive instruction fragments', (t) => {
  const f = fixture(t);
  f.manifest['agents-md'] = [{ name: 'base' }];
  f.manifest['sync-rules'].auto.push({ type_name: 'agents-md:base' });
  f.dependencies.fetchFragment = () => 'Instructions';
  for (const home of ['~', f.home]) {
    f.run(['--home', home]);
    assert.ok(existsSync(join(f.shared, 'SKILL.md')));
    assert.ok(!existsSync(f.target('.codex')));
    assert.ok(!existsSync(f.target('.copilot')));
    assert.match(readFileSync(join(f.home, '.codex', 'AGENTS.md'), 'utf8'), /Instructions/);
    assert.match(readFileSync(join(f.home, '.copilot', 'copilot-instructions.md'), 'utf8'), /Instructions/);
  }
});

test('custom home copies selected endpoints and scoped deletion preserves other agents', (t) => {
  const f = fixture(t), home = join(f.root, 'custom');
  const target = (agent) => join(home, agent, 'skills', 'one');
  f.run(['--home', home]);
  for (const agent of ['.agents', '.codex', '.copilot']) {
    assert.ok(!lstatSync(target(agent)).isSymbolicLink());
    assert.equal(readFileSync(join(target(agent), 'SKILL.md'), 'utf8'), text);
  }
  f.run(['--home', home, '--local', '--del_agents', 'github-copilot']);
  f.run(['--home', home, '--local', '--del', 'skill:one']);
  assert.ok(!existsSync(target('.codex')));
  assert.ok(existsSync(target('.copilot')));
  assert.ok(existsSync(target('.agents')));
  f.run(['--home', home, '--local', '--add_agents', 'github-copilot']);
  f.run(['--home', home, '--local', '--del', 'skill:one']);
  assert.ok(['.agents', '.codex', '.copilot'].every((agent) => !existsSync(target(agent))));
  assert.ok(!existsSync(f.home));
});

test('shared user-home deletion requires all supported agents', (t) => {
  const f = fixture(t); f.run();
  f.run(['--local', '--del_agents', 'github-copilot']);
  assert.throws(() => f.run(['--local', '--del', 'skill:one']), /共享/);
  assert.ok(existsSync(f.shared));
  f.run(['--local', '--add_agents', 'github-copilot']);
  f.run(['--local', '--del', 'skill:one']);
  assert.ok(!existsSync(f.shared));
});

test('existing parent directory links are preserved', (t) => {
  const f = fixture(t), home = join(f.root, 'custom'), shared = join(home, '.agents', 'skills');
  mkdirSync(shared, { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  const link = join(home, '.codex', 'skills');
  symlinkSync(shared, link, process.platform === 'win32' ? 'junction' : 'dir');
  f.run(['--home', home]);
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(realpathSync(link), realpathSync(shared));
  assert.equal(readFileSync(join(link, 'one', 'SKILL.md'), 'utf8'), text);
});
