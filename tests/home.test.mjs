import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    sharedSkillsDir: join(original, 'skills'), fetchManifest: () => JSON.stringify(manifest), fetchFragment: () => 'Rule', log() {} };
  return { root, destination, original, env, manifest, dependencies };
}

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
