import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { sync } from '../sync.mjs';

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
    fetchManifest: () => JSON.stringify(manifest), fetchFragment: () => 'Rule', log() {} };
  return { root, destination, original, env, manifest, dependencies };
}

test('sync, local add and del, and migration all use the selected home', (t) => {
  const f = fixture(t);
  const state = join(f.destination, '.everything-harness'); mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'agents-md.json'), JSON.stringify({ fragments: [{ name: 'one', auto_sync: false }] }));
  sync(['--home', f.destination], f.dependencies);
  const settings = join(state, 'harness.json');
  assert.deepEqual(JSON.parse(readFileSync(settings)), { 'sync-rules': { auto: [] } });
  sync(['--add', 'agents-md:one', '--home', f.destination], f.dependencies);
  const targets = [join(f.destination, '.codex', 'AGENTS.md'), join(f.destination, '.copilot', 'copilot-instructions.md')];
  assert.ok(targets.every((path) => readFileSync(path, 'utf8').includes('Rule')));
  sync(['--home', f.destination, '--del', 'agents-md:one'], f.dependencies);
  assert.ok(targets.every((path) => !readFileSync(path, 'utf8').includes('eh:one:')));
  assert.ok(!existsSync(f.original));
});

test('harness names load configured paths for synchronization, agent removal and cleanup', (t) => {
  const f = fixture(t), definitions = JSON.parse(readFileSync(new URL('../harnesses.json', import.meta.url)));
  definitions.workbench = { 'skill-dir': 'tools/packages', 'agents-md': 'notes/workbench.md' };
  definitions.codex['skill-dir'] = 'adapters/codex/packages';
  definitions.codex['agents-md'] = 'notes/codex.md';
  f.manifest.agents = ['codex'];
  f.manifest.skill = [{ name: 'one', source: 'example/repo' }];
  f.manifest['sync-rules'].auto.push({ type_name: 'skill:one' });
  let reads = 0, downloads = 0;
  f.dependencies.fetchHarnesses = () => { reads++; return JSON.stringify(definitions); };
  f.dependencies.fetchRepository = (source, path) => {
    downloads++;
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'SKILL.md'), '---\nname: one\ndescription: Fixture\n---\nContent');
  };
  const run = (...args) => sync(['--home', f.destination, ...args], f.dependencies);
  run('--add', 'agent:workbench');
  assert.equal(reads, 1); assert.equal(downloads, 1);
  const settings = join(f.destination, '.everything-harness', 'harness.json');
  assert.deepEqual(JSON.parse(readFileSync(settings)).agents, ['codex', 'workbench']);
  for (const name of ['codex', 'workbench']) {
    assert.match(readFileSync(join(f.destination, definitions[name]['skill-dir'], 'one', 'SKILL.md'), 'utf8'), /Content/);
    assert.match(readFileSync(join(f.destination, definitions[name]['agents-md']), 'utf8'), /Rule/);
  }
  assert.ok(!existsSync(join(f.destination, '.codex', 'skills')));
  assert.ok(!existsSync(join(f.destination, '.agents')));
  run('--del', 'agent:workbench');
  assert.ok(!existsSync(join(f.destination, 'tools', 'packages', 'one')));
  assert.equal(readFileSync(join(f.destination, 'notes', 'workbench.md'), 'utf8').trim(), '');
  assert.ok(existsSync(join(f.destination, definitions.codex['skill-dir'], 'one')));
  assert.match(readFileSync(join(f.destination, definitions.codex['agents-md']), 'utf8'), /Rule/);
  const unknown = join(f.destination, 'tools', 'packages', 'unmanaged', 'SKILL.md');
  mkdirSync(dirname(unknown), { recursive: true }); writeFileSync(unknown, 'Keep');
  const before = readFileSync(settings, 'utf8');
  run('--clean', '--dryrun');
  assert.equal(readFileSync(settings, 'utf8'), before);
  run('--clean');
  assert.ok(!existsSync(dirname(settings)));
  assert.ok(!existsSync(join(f.destination, definitions.codex['skill-dir'], 'one')));
  assert.equal(readFileSync(join(f.destination, definitions.codex['agents-md']), 'utf8').trim(), '');
  assert.equal(readFileSync(unknown, 'utf8'), 'Keep');
  assert.ok(!existsSync(f.original));
});
