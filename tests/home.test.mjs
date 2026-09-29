import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { homeDependencies, parseArgs, runCommand, sync } from '../sync.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'eh-home-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const destination = join(root, 'custom home');
  const original = join(root, 'original');
  const env = { ...process.env, HOME: original, USERPROFILE: original,
    CODEX_HOME: join(original, 'codex'), COPILOT_HOME: join(original, 'copilot'), XDG_STATE_HOME: join(original, 'state'),
    HTTP_PROXY: 'http://127.0.0.1:7890', HTTPS_PROXY: 'http://127.0.0.1:7890', ALL_PROXY: 'http://127.0.0.1:7890' };
  const manifest = { agents: ['codex', 'github-copilot'], skill: [], 'agents-md': [{ name: 'one' }],
    'sync-rules': { auto: [{ type_name: 'agents-md:one' }] } };
  const dependencies = { env, homeDir: original, stateDir: join(original, 'state'), cwd: root,
    sharedSkillsDir: join(original, 'skills'), fetchManifest: () => JSON.stringify(manifest), fetchFragment: () => 'Rule', log() {} };
  return { root, destination, original, env, manifest, dependencies };
}

test('home accepts a directory in every option position and rejects path and invalid values', () => {
  for (const args of [['--home', 'a b'], ['--home', 'a b', '--list'], ['--list', '--home', 'a b'],
    ['--local', '--add', 'skill:one', '--home', 'a b'], ['--home', 'a b', '--add', 'a/b', 'skill:one']]) {
    assert.equal(parseArgs(args).home, 'a b');
  }
  for (const args of [['--home'], ['--home', ''], ['--home', '  '], ['--home', '--list'],
    ['--home', 'a', '--home', 'b'], ['--home', 'a\0b'], ['--path', 'a']]) assert.throws(() => parseArgs(args));
});

test('home overrides content paths and child home while preserving proxies, Git environment and the parent process', (t) => {
  const f = fixture(t), parent = { ...process.env }, originalEnv = { ...f.env };
  assert.equal(homeDependencies(undefined, f.dependencies), f.dependencies);
  const scoped = homeDependencies(f.destination, f.dependencies);
  assert.equal(scoped.homeDir, f.destination);
  assert.equal(scoped.stateDir, join(f.destination, '.everything-harness'));
  assert.equal(scoped.sharedSkillsDir, join(f.destination, '.agents', 'skills'));
  assert.deepEqual(scoped.skillLoadDirs, {
    codex: join(f.destination, '.codex', 'skills'), 'github-copilot': join(f.destination, '.copilot', 'skills'),
  });
  assert.equal(scoped.env.CODEX_HOME, join(f.destination, '.codex'));
  assert.equal(scoped.env.COPILOT_HOME, join(f.destination, '.copilot'));
  assert.equal(scoped.env.HOME, f.destination);
  assert.equal(scoped.env.USERPROFILE, f.destination);
  assert.equal(scoped.env.XDG_STATE_HOME, undefined);
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) assert.equal(scoped.env[key], f.env[key]);
  assert.equal(scoped.gitEnv, f.env);
  assert.deepEqual(f.env, originalEnv);
  assert.ok(JSON.stringify({ ...process.env }) === JSON.stringify(parent), 'Parent environment must remain unchanged');
  assert.equal(runCommand(process.execPath, ['-e', 'console.log(require("node:os").homedir())'], { env: scoped.env }).trim(), f.destination);
  assert.ok(!existsSync(f.destination));
});

test('home resolves relative and quoted tilde paths and rejects a file before fetching', (t) => {
  const f = fixture(t);
  assert.equal(homeDependencies('relative', f.dependencies).homeDir, resolve(f.root, 'relative'));
  assert.equal(homeDependencies('~', f.dependencies).homeDir, f.original);
  assert.equal(homeDependencies('~/work', f.dependencies).homeDir, join(f.original, 'work'));
  assert.equal(homeDependencies('~').homeDir, homedir());
  for (const home of ['~', f.original, join(f.original, '..', 'original')]) {
    assert.equal(homeDependencies(home, f.dependencies).skillLoadDirs, undefined);
  }
  if (process.platform === 'win32') assert.equal(homeDependencies(f.original.toUpperCase(), f.dependencies).skillLoadDirs, undefined);
  const file = join(f.root, 'file'); writeFileSync(file, 'keep');
  assert.throws(() => sync(['--home', file], { fetchManifest: () => assert.fail('Must validate home first') }), /必须是目录/);
  assert.equal(readFileSync(file, 'utf8'), 'keep');
});

test('sync, local add and del, and migration all use the selected home', (t) => {
  const f = fixture(t);
  const state = join(f.destination, '.everything-harness'); mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'agents-md.json'), JSON.stringify({ fragments: [{ name: 'one', auto_sync: false }] }));
  sync(['--home', f.destination], f.dependencies);
  const settings = join(state, 'harness.json');
  assert.deepEqual(JSON.parse(readFileSync(settings)), { 'sync-rules': { auto: [] } });
  sync(['--local', '--add', 'agents-md:one', '--home', f.destination], f.dependencies);
  const targets = [join(f.destination, '.codex', 'AGENTS.md'), join(f.destination, '.copilot', 'copilot-instructions.md')];
  assert.ok(targets.every((path) => readFileSync(path, 'utf8').includes('Rule')));
  sync(['--home', f.destination, '--local', '--del', 'agents-md:one'], f.dependencies);
  assert.ok(targets.every((path) => !readFileSync(path, 'utf8').includes('eh:one:')));
  assert.ok(!existsSync(f.original));
});

test('explicit user home still writes instruction fragments to both agent directories', (t) => {
  const f = fixture(t);
  for (const home of ['~', f.original]) {
    sync(['--home', home], f.dependencies);
    for (const path of [
      join(f.original, '.codex', 'AGENTS.md'),
      join(f.original, '.copilot', 'copilot-instructions.md'),
    ]) {
      const content = readFileSync(path, 'utf8');
      assert.ok(content.includes('Rule'));
      assert.equal(content.split('<!-- eh:one:start -->').length, 2);
    }
  }
  assert.ok(!existsSync(join(f.original, '.codex', 'skills')));
  assert.ok(!existsSync(join(f.original, '.copilot', 'skills')));
});

test('list and dryrun do not create the requested home', (t) => {
  const f = fixture(t);
  sync(['--home', f.destination, '--list'], f.dependencies);
  sync(['--home', f.destination, '--dryrun'], f.dependencies);
  assert.ok(!existsSync(f.destination));
  assert.ok(!existsSync(f.original));
});

test('skill preflight receives the selected home and unchanged proxy configuration', (t) => {
  const f = fixture(t);
  f.manifest.skill = [{ name: 'one', source: 'example/repo' }];
  f.manifest['sync-rules'].auto = [{ type_name: 'skill:one' }];
  let checked = false;
  sync(['--home', f.destination, '--dryrun'], { ...f.dependencies,
    checkSkills: (entries, agents, dependencies) => {
      checked = true;
      assert.equal(dependencies.env.HOME, f.destination);
      assert.equal(dependencies.env.HTTP_PROXY, 'http://127.0.0.1:7890');
      assert.equal(dependencies.gitEnv, f.env);
    },
  });
  assert.ok(checked);
  assert.ok(!existsSync(f.destination));
});
