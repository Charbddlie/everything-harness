import assert from 'node:assert/strict';
import fs, { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { copySkill, sync } from '../sync.mjs';

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
    target: (agent) => join(home, agent, 'skills', 'one'),
    run: (args = []) => sync(args, dependencies) };
}

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

test('default and explicit homes install into agent directories and remove legacy copies after installation', (t) => {
  const f = fixture(t);
  f.manifest['agents-md'] = [{ name: 'base' }];
  f.manifest['sync-rules'].auto.push({ type_name: 'agents-md:base' });
  f.dependencies.fetchFragment = () => 'Instructions';
  for (const home of [undefined, '~', f.home, join(f.root, 'custom')]) {
    const root = home === undefined || home === '~' ? f.home : home;
    const legacy = join(root, '.agents', 'skills', 'one');
    put(join(legacy, 'SKILL.md'), 'Old copy');
    put(join(root, '.agents', 'skills', 'unmanaged', 'SKILL.md'), 'Keep');
    const args = home === undefined ? [] : ['--home', home];
    f.run([...args, '--dryrun']);
    assert.equal(readFileSync(join(legacy, 'SKILL.md'), 'utf8'), 'Old copy');
    const download = f.dependencies.fetchRepository;
    f.dependencies.fetchRepository = () => { throw new Error('Download failed'); };
    assert.throws(() => f.run(args), /Download failed/);
    assert.equal(readFileSync(join(legacy, 'SKILL.md'), 'utf8'), 'Old copy');
    f.dependencies.fetchRepository = download;
    f.run(args);
    for (const agent of ['.codex', '.copilot']) assert.equal(readFileSync(join(root, agent, 'skills', 'one', 'SKILL.md'), 'utf8'), text);
    assert.ok(!existsSync(legacy));
    assert.equal(readFileSync(join(root, '.agents', 'skills', 'unmanaged', 'SKILL.md'), 'utf8'), 'Keep');
    assert.match(readFileSync(join(root, '.codex', 'AGENTS.md'), 'utf8'), /Instructions/);
    assert.match(readFileSync(join(root, '.copilot', 'copilot-instructions.md'), 'utf8'), /Instructions/);
  }
});

test('installation selects agents and deletion covers every old and current location', (t) => {
  const f = fixture(t), home = join(f.root, 'custom');
  const target = (agent) => join(home, agent, 'skills', 'one');
  f.run(['--home', home, '--local', '--del_agents', 'github-copilot']);
  f.run(['--home', home]);
  assert.equal(readFileSync(join(target('.codex'), 'SKILL.md'), 'utf8'), text);
  assert.ok(!existsSync(target('.copilot')) && !existsSync(target('.agents')));
  for (const agent of ['.agents', '.copilot']) put(join(target(agent), 'SKILL.md'), text);
  f.run(['--home', home, '--local', '--del', 'skill:one']);
  assert.ok(['.agents', '.codex', '.copilot'].every((agent) => !existsSync(target(agent))));
  assert.ok(!existsSync(f.home));

  const codex = join(f.root, 'custom-codex'), copilot = join(f.root, 'custom-copilot');
  f.dependencies.env = { CODEX_HOME: codex, COPILOT_HOME: copilot };
  f.manifest.agents = ['codex'];
  f.run();
  assert.equal(readFileSync(join(codex, 'skills', 'one', 'SKILL.md'), 'utf8'), text);
  assert.ok(!existsSync(join(f.home, '.agents')) && !existsSync(join(f.home, '.codex')) && !existsSync(copilot));
  f.manifest['agents-md'] = [{ name: 'base' }];
  const directories = [codex, copilot, ...['.agents', '.codex', '.copilot'].map((name) => join(f.home, name))];
  const instructions = [f.home, ...directories].flatMap((directory) => ['AGENTS.md', 'CLAUDE.md', 'copilot-instructions.md'].map((name) => join(directory, name)));
  for (const directory of directories) {
    put(join(directory, 'skills', 'one', 'SKILL.md'), text);
    put(join(directory, 'skills', 'unmanaged', 'SKILL.md'), 'Keep');
  }
  for (const path of instructions) put(path, 'Personal\n<!-- eh:base:start -->\nOld rule\n<!-- eh:base:end -->\n');
  f.run(['--local', '--del', 'skill:one', 'agents-md:base']);
  for (const directory of directories) {
    assert.ok(!existsSync(join(directory, 'skills', 'one')));
    assert.equal(readFileSync(join(directory, 'skills', 'unmanaged', 'SKILL.md'), 'utf8'), 'Keep');
  }
  for (const path of instructions) assert.equal(readFileSync(path, 'utf8'), 'Personal\n\n');
});

test('existing parent directory links are preserved', (t) => {
  const f = fixture(t), home = join(f.root, 'custom'), shared = join(f.root, 'linked-skills');
  mkdirSync(shared, { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  const link = join(home, '.codex', 'skills');
  symlinkSync(shared, link, process.platform === 'win32' ? 'junction' : 'dir');
  f.run(['--home', home]);
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(realpathSync(link), realpathSync(shared));
  assert.equal(readFileSync(join(link, 'one', 'SKILL.md'), 'utf8'), text);
});
