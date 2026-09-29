import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import test from 'node:test';
import { exposeSkill, homeDependencies, sync } from '../sync.mjs';

const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'eh-load-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const source = join(home, '.agents', 'skills', 'one');
  const dirs = [join(home, '.codex', 'skills'), join(home, '.copilot', 'skills')];
  put(join(source, 'SKILL.md'), 'Version one');
  put(join(source, 'scripts', 'run.mjs'), 'console.log("one");');
  return { root, home, source, dirs, result: { name: 'one', path: source, mode: 'copy' } };
}

test('copy mode creates independent native directories and only replaces selected skills and agents', (t) => {
  const f = fixture(t);
  exposeSkill(f.result, f.dirs, { log() {} });
  for (const dir of f.dirs) {
    assert.ok(!lstatSync(join(dir, 'one')).isSymbolicLink());
    assert.equal(readFileSync(join(dir, 'one', 'SKILL.md'), 'utf8'), 'Version one');
    assert.ok(existsSync(join(dir, 'one', 'scripts', 'run.mjs')));
    put(join(dir, 'one', 'stale.txt'), 'stale');
    put(join(dir, 'unmanaged', 'SKILL.md'), 'keep');
  }
  put(join(f.source, 'SKILL.md'), 'Version two');
  exposeSkill(f.result, [f.dirs[0]], { log() {} });
  assert.equal(readFileSync(join(f.dirs[0], 'one', 'SKILL.md'), 'utf8'), 'Version two');
  assert.ok(!existsSync(join(f.dirs[0], 'one', 'stale.txt')));
  assert.equal(readFileSync(join(f.dirs[1], 'one', 'SKILL.md'), 'utf8'), 'Version one');
  assert.ok(existsSync(join(f.dirs[1], 'one', 'stale.txt')));
  assert.ok(f.dirs.every((dir) => readFileSync(join(dir, 'unmanaged', 'SKILL.md'), 'utf8') === 'keep'));
  const moved = join(f.root, 'moved'); renameSync(f.home, moved);
  assert.equal(readFileSync(join(moved, '.codex', 'skills', 'one', 'SKILL.md'), 'utf8'), 'Version two');
});

test('symlink mode uses relative links that survive moving the whole home', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  exposeSkill({ ...f.result, mode: 'symlink' }, f.dirs, { log() {} });
  for (const dir of f.dirs) {
    const target = join(dir, 'one');
    assert.ok(lstatSync(target).isSymbolicLink());
    assert.ok(!isAbsolute(readlinkSync(target)));
    assert.equal(realpathSync(target), realpathSync(f.source));
  }
  const moved = join(f.root, 'moved'); renameSync(f.home, moved);
  put(join(moved, '.agents', 'skills', 'one', 'SKILL.md'), 'Moved');
  for (const dir of ['.codex', '.copilot']) assert.equal(readFileSync(join(moved, dir, 'skills', 'one', 'SKILL.md'), 'utf8'), 'Moved');
});

test('symlink creation failure falls back to copy and reports the fallback', (t) => {
  const f = fixture(t), logs = [];
  exposeSkill({ ...f.result, mode: 'symlink' }, f.dirs, { log: (line) => logs.push(line), link() { throw new Error('EPERM'); } });
  assert.equal(logs.filter((line) => line.includes('回退复制')).length, 2);
  assert.ok(f.dirs.every((dir) => !lstatSync(join(dir, 'one')).isSymbolicLink()));
  assert.ok(f.dirs.every((dir) => readFileSync(join(dir, 'one', 'SKILL.md'), 'utf8') === 'Version one'));
});

test('copy mode replaces an old symlink without changing its previous target', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t), outside = join(f.root, 'outside');
  put(join(outside, 'SKILL.md'), 'Keep outside');
  mkdirSync(f.dirs[0], { recursive: true }); symlinkSync(outside, join(f.dirs[0], 'one'), 'dir');
  exposeSkill(f.result, [f.dirs[0]], { log() {} });
  assert.equal(readFileSync(join(outside, 'SKILL.md'), 'utf8'), 'Keep outside');
  assert.ok(!lstatSync(join(f.dirs[0], 'one')).isSymbolicLink());
  exposeSkill({ ...f.result, mode: 'symlink' }, f.dirs, { log() {} });
  exposeSkill(f.result, f.dirs, { log() {} });
  assert.ok(f.dirs.every((dir) => !lstatSync(join(dir, 'one')).isSymbolicLink()));
});

test('missing CLI mode fails before replacing existing native content', (t) => {
  const f = fixture(t); put(join(f.dirs[0], 'one', 'SKILL.md'), 'Keep');
  assert.throws(() => exposeSkill({ ...f.result, mode: undefined }, f.dirs), /mode/);
  assert.equal(readFileSync(join(f.dirs[0], 'one', 'SKILL.md'), 'utf8'), 'Keep');
});

test('existing parent links are preserved when they already expose shared content', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t); mkdirSync(dirname(f.dirs[0]), { recursive: true });
  symlinkSync(dirname(f.source), f.dirs[0], 'dir');
  exposeSkill(f.result, [f.dirs[0]], { log() {} });
  assert.ok(lstatSync(f.dirs[0]).isSymbolicLink());
  assert.equal(readFileSync(join(f.source, 'SKILL.md'), 'utf8'), 'Version one');
});

test('home-scoped deletion clears selected native endpoints while the CLI retains shared data for another agent', (t) => {
  const f = fixture(t); exposeSkill(f.result, f.dirs, { log() {} });
  const metadata = [{ name: 'one', path: f.source, scope: 'global', source: 'example/repo', sourceType: 'github', agents: ['Codex', 'GitHub Copilot'] }];
  const manifest = { agents: ['codex'], skill: [{ name: 'one', source: 'example/repo' }], 'sync-rules': { auto: [{ type_name: 'skill:one' }] } };
  let removed = false;
  const dependencies = { env: {}, fetchManifest: () => JSON.stringify(manifest), log() {},
    runSkills: (args) => {
      if (args[0] === 'list') return JSON.stringify(metadata);
      assert.deepEqual(args, ['remove', 'one', '-g', '--yes', '--agent', 'codex']); removed = true; return '';
    },
  };
  sync(['--home', f.home, '--local', '--del', 'skill:one'], dependencies);
  assert.ok(removed);
  assert.ok(!existsSync(join(f.dirs[0], 'one')));
  assert.ok(existsSync(join(f.dirs[1], 'one', 'SKILL.md')));
  assert.ok(existsSync(join(f.source, 'SKILL.md')));
  assert.deepEqual(JSON.parse(readFileSync(join(f.home, '.everything-harness', 'harness.json')))['sync-rules'].auto, []);
});

for (const mode of ['copy', 'symlink']) {
  test(`user home sync does not add ${mode} endpoints or replace existing ones`, (t) => {
    const f = fixture(t);
    const manifest = { agents: ['codex', 'github-copilot'], skill: [{ name: 'one', source: 'example/repo' }],
      'sync-rules': { auto: [{ type_name: 'skill:one' }] } };
    let installs = 0;
    const dependencies = {
      homeDir: f.home, env: {}, fetchManifest: () => JSON.stringify(manifest), log() {}, checkSkills() {},
      runSkills: (args) => {
        if (args[0] === 'list') return '[]';
        assert.equal(args[0], 'add');
        installs++;
        return JSON.stringify([{ ...f.result, mode, status: 'installed', scope: 'global', agents: ['Codex', 'GitHub Copilot'] }]);
      },
    };
    sync(['--home', '~'], dependencies);
    assert.equal(installs, 1);
    assert.ok(f.dirs.every((dir) => !existsSync(dir)));
    for (const dir of f.dirs) put(join(dir, 'one', 'SKILL.md'), 'Existing entry');
    sync(['--home', f.home], dependencies);
    assert.equal(installs, 2);
    assert.ok(f.dirs.every((dir) => readFileSync(join(dir, 'one', 'SKILL.md'), 'utf8') === 'Existing entry'));
    assert.equal(readFileSync(join(f.source, 'SKILL.md'), 'utf8'), 'Version one');
  });
}

test('source conflict and CLI failure preserve the native entries and local settings', (t) => {
  const f = fixture(t); exposeSkill(f.result, f.dirs, { log() {} });
  const manifest = { agents: ['codex'], skill: [{ name: 'one', source: 'example/repo' }] };
  const metadata = { name: 'one', path: f.source, scope: 'global', source: 'other/repo', sourceType: 'github', agents: ['Codex'] };
  const dependencies = { env: {}, fetchManifest: () => JSON.stringify(manifest), log() {},
    runSkills: (args) => args[0] === 'list' ? JSON.stringify([metadata]) : (() => { throw new Error('CLI failed'); })(),
  };
  assert.throws(() => sync(['--home', f.home, '--local', '--del', 'skill:one'], dependencies), /来源冲突/);
  metadata.source = 'example/repo';
  assert.throws(() => sync(['--home', f.home, '--local', '--del', 'skill:one'], dependencies), /CLI failed/);
  assert.ok(f.dirs.every((dir) => existsSync(join(dir, 'one', 'SKILL.md'))));
  assert.ok(!existsSync(join(f.home, '.everything-harness', 'harness.json')));
  assert.equal(homeDependencies(undefined, dependencies).skillLoadDirs, undefined);
});
