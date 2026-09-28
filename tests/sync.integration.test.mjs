import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createSkillsRunner, runCommand, runDryruns, sync } from '../sync.mjs';

test('real npx skills shared installation and repeated overwrite in an isolated profile', {
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
  for (const name of ['CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME',
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
  const pdfEntry = { name: 'pdf-analyze', source: 'Charbddlie/everything-harness' };
  const pdfInstalled = new Map([['pdf-analyze', first[0]]]);
  const noKey = { ...env }; delete noKey.MINERU_API_KEY;
  assert.throws(() => runDryruns([pdfEntry], pdfInstalled, { env: noKey, log: (message) => t.diagnostic(message) }), /环境检查失败/);
  runDryruns([pdfEntry], pdfInstalled, { env: { ...env, MINERU_API_KEY: 'dryrun-fixture' }, log: (message) => t.diagnostic(message) });

  // Keep real CLI clone/source handling, but serve the repository from a small
  // local Git fixture so upstream downloads cannot dominate the test.
  const fixtureSkill = join(source, 'skills', 'pdf');
  mkdirSync(fixtureSkill);
  writeFileSync(join(fixtureSkill, 'SKILL.md'), '---\nname: pdf\ndescription: Isolated installation test fixture.\n---\n\n# PDF fixture\n');
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = join(profile, '.gitconfig');
  const git = (args) => runCommand('git', args, { env, cwd: source });
  git(['config', '--file', env.GIT_CONFIG_GLOBAL, `url.${pathToFileURL(source).href}.insteadOf`, 'https://github.com/integration-fixture/skills.git']);
  git(['init', '--quiet']);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(['add', '.']);
  git(['-c', 'user.name=Skill Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'Fixture']);
  const catalog = {
    agents: ['codex', 'github-copilot'],
    skills: [{ source: 'integration-fixture/skills', name: 'pdf', auto_sync: true }],
  };
  const calls = [];
  const dependencies = {
    stateDir: join(profile, '.everything-harness'),
    sharedSkillsDir: join(profile, '.agents', 'skills'),
    fetchManifest: () => JSON.stringify(catalog),
    runSkills: (args) => { calls.push(args); return runSkills(args); },
    log: (message) => t.diagnostic(message),
  };
  sync([], dependencies);
  assert.deepEqual(calls.find((args) => args[0] === 'add').slice(5, 7), ['codex', 'github-copilot']);
  const sharedPath = join(profile, '.agents', 'skills', 'pdf');
  for (const path of [join(profile, '.agents', 'skills'), sharedPath]) {
    assert.equal(lstatSync(path).isSymbolicLink(), false);
    assert.equal(lstatSync(path).isDirectory(), true);
  }
  assert.equal(existsSync(join(env.CODEX_HOME, 'skills', 'pdf')), false);
  assert.equal(existsSync(join(profile, '.copilot', 'skills', 'pdf')), false);
  // Publish a new source revision and verify normal sync replaces stale files.
  writeFileSync(join(fixtureSkill, 'SKILL.md'), '---\nname: pdf\ndescription: Updated installation fixture.\n---\n\nVersion two\n');
  git(['add', '.']);
  git(['-c', 'user.name=Skill Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'Update fixture']);
  writeFileSync(join(sharedPath, 'stale.txt'), 'local stale file');
  // Model installed apps so list and removal exercise shared ownership.
  mkdirSync(env.CODEX_HOME, { recursive: true });
  mkdirSync(join(profile, '.copilot'), { recursive: true });
  sync([], dependencies);
  assert.deepEqual(calls.at(-1), ['add', catalog.skills[0].source, '--skill', 'pdf', '--agent', ...catalog.agents, '-g', '--yes', '--json']);
  assert.match(readFileSync(join(sharedPath, 'SKILL.md'), 'utf8'), /Version two/);
  assert.equal(lstatSync(sharedPath).isSymbolicLink(), false);
  assert.equal(existsSync(join(sharedPath, 'stale.txt')), false);
  const addCount = calls.filter((args) => args[0] === 'add').length;
  assert.equal(addCount, 2);
  sync([], dependencies);
  assert.equal(calls.filter((args) => args[0] === 'add').length, addCount + 1);
  const installed = JSON.parse(runSkills(['list', '-g', '--json']));
  const remote = installed.find((entry) => entry.name === 'pdf');
  assert.equal(remote.source.toLowerCase(), catalog.skills[0].source.toLowerCase());
  assert.equal(remote.sourceType, 'github');
  assert.deepEqual(remote.agents.slice().sort(), ['Codex', 'GitHub Copilot']);
  assert.equal(installed.some((entry) => entry.name === 'pdf-analyze'), true);
  const beforeAgentChange = calls.length;
  sync(['--local', '--del_agents', 'github-copilot'], dependencies);
  assert.equal(calls.length, beforeAgentChange);
  sync([], dependencies);
  assert.deepEqual(calls.at(-1), ['add', catalog.skills[0].source, '--skill', 'pdf', '--agent', 'codex', '-g', '--yes', '--json']);
  const beforeDelete = readFileSync(join(dependencies.stateDir, 'skills.json'), 'utf8');
  assert.throws(() => sync(['--local', '--del', 'pdf'], dependencies), /目标安装仍存在/);
  assert.equal(readFileSync(join(dependencies.stateDir, 'skills.json'), 'utf8'), beforeDelete);
  sync(['--local', '--add_agents', 'github-copilot'], dependencies);
  sync(['--local', '--del', 'pdf'], dependencies);
  assert.equal(JSON.parse(runSkills(['list', '-g', '--json'])).some((entry) => entry.name === 'pdf'), false);
  const afterDelete = calls.filter((args) => args[0] === 'add').length;
  sync([], dependencies);
  assert.equal(calls.filter((args) => args[0] === 'add').length, afterDelete);
  sync(['--local', '--add', 'pdf'], dependencies);
  assert.equal(JSON.parse(readFileSync(join(dependencies.stateDir, 'skills.json'))).skills[0].auto_sync, true);
  assert.equal(JSON.parse(runSkills(['list', '-g', '--json'])).some((entry) => entry.name === 'pdf'), true);
  runSkills(['remove', 'pdf-analyze', '-g', '--yes', '--agent', 'codex', 'github-copilot']);
  assert.equal(JSON.parse(runSkills(['list', '-g', '--json'])).some((entry) => entry.name === 'pdf-analyze'), false);
});
