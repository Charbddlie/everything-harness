import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createSkillsRunner, runCommand, runDryruns, sync } from '../sync.mjs';

test('real npx skills discovery, global installation, missing agents and update in an isolated profile', {
  skip: process.env.SKILLS_INTEGRATION !== '1',
  timeout: 240_000,
}, (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), 'everything-harness-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const profile = join(sandbox, 'profile');
  mkdirSync(profile);
  const env = { ...process.env };
  // Override only child-process environment; never touch the user's profile.
  for (const name of ['HOME', 'USERPROFILE']) env[name] = profile;
  for (const name of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME',
    'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'APPDATA', 'LOCALAPPDATA', 'FLATPAK_XDG_CONFIG_HOME',
    'VIBE_HOME', 'HERMES_HOME', 'AUTOHAND_HOME', 'GROK_HOME', 'SARVAM_HOME']) {
    env[name] = join(profile, name.toLowerCase());
  }
  env.npm_config_cache = resolve('.tmp/npm-cache');
  env.DISABLE_TELEMETRY = '1';
  env.DO_NOT_TRACK = '1';
  const reportedHome = runCommand(process.execPath, ['-e', 'console.log(require("node:os").homedir())'], { env }).trim();
  assert.equal(reportedHome, profile);
  const runSkills = createSkillsRunner({ env, cwd: sandbox });
  assert.deepEqual(JSON.parse(runSkills(['list', '-g', '--json'])), []);

  // Discover the actual migrated skill using a disposable copy.
  const source = join(sandbox, 'fixture');
  const skill = join(source, 'skills', 'pdf-analyze');
  mkdirSync(skill, { recursive: true });
  const skillText = readFileSync(new URL('../skills/pdf-analyze/SKILL.md', import.meta.url), 'utf8');
  cpSync(new URL('../skills/pdf-analyze/scripts/', import.meta.url), join(skill, 'scripts'), { recursive: true });
  cpSync(new URL('../skills/pdf-analyze/dryrun.mjs', import.meta.url), join(skill, 'dryrun.mjs'));
  writeFileSync(join(skill, 'SKILL.md'), `${skillText}\nVersion one\n`);
  const installArgs = ['add', source, '--skill', 'pdf-analyze', '--agent', 'codex', '-g', '--yes', '--json'];
  const first = JSON.parse(runSkills(installArgs));
  assert.equal(first[0].status, 'installed');
  assert.deepEqual(first[0].agents, ['Codex']);
  assert.equal(readFileSync(join(first[0].path, 'SKILL.md'), 'utf8').includes('Version one'), true);
  writeFileSync(join(skill, 'SKILL.md'), `${skillText}\nVersion two\n`);
  runSkills(installArgs);
  assert.match(readFileSync(join(first[0].path, 'SKILL.md'), 'utf8'), /Version two/);
  const pdfEntry = { name: 'pdf-analyze', source: 'Charbddlie/everything-harness', agents: ['codex'] };
  const pdfInstalled = new Map([['pdf-analyze', first[0]]]);
  const noKey = { ...env }; delete noKey.MINERU_API_KEY;
  assert.throws(() => runDryruns([pdfEntry], pdfInstalled, { env: noKey, log: (message) => t.diagnostic(message) }), /环境检查失败/);
  runDryruns([pdfEntry], pdfInstalled, { env: { ...env, MINERU_API_KEY: 'dryrun-fixture' }, log: (message) => t.diagnostic(message) });

  // Exercise the synchronizer with a real GitHub source and real list/add JSON.
  const catalog = {
    skills: [{ source: 'anthropics/skills', name: 'pdf', agents: ['claude-code', 'codex', 'github-copilot'] }],
  };
  const calls = [];
  const dependencies = {
    sharedSkillsDir: join(profile, '.agents', 'skills'),
    fetchManifest: () => JSON.stringify(catalog),
    runSkills: (args) => { calls.push(args); return runSkills(args); },
    log: (message) => t.diagnostic(message),
  };
  sync(['--agents', 'codex'], dependencies);
  sync([], dependencies); // Claude is missing; Codex/Copilot share content
  const addCount = calls.filter((args) => args[0] === 'add').length;
  assert.equal(addCount, 2);
  sync([], dependencies);
  assert.equal(calls.filter((args) => args[0] === 'add').length, addCount);
  sync(['--update', '--agents', 'codex'], dependencies);
  assert.equal(calls.filter((args) => args[0] === 'add').length, addCount + 1);
  const installed = JSON.parse(runSkills(['list', '-g', '--json']));
  const remote = installed.find((entry) => entry.name === 'pdf');
  assert.equal(remote.source.toLowerCase(), catalog.skills[0].source.toLowerCase());
  assert.equal(remote.sourceType, 'github');
  assert.equal(remote.agents.includes('Claude Code'), true);
  assert.equal(installed.some((entry) => entry.name === 'pdf-analyze'), true);
  runSkills(['remove', 'pdf-analyze', '-g', '--yes', '--agent', 'codex', 'github-copilot']);
  assert.equal(JSON.parse(runSkills(['list', '-g', '--json'])).some((entry) => entry.name === 'pdf-analyze'), false);
});
