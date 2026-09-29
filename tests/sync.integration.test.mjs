import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createSkillsRunner, homeDependencies, runCommand, runDryruns, sync } from '../sync.mjs';

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
    skill: [{ source: 'integration-fixture/skills', name: 'pdf' }],
    'sync-rules': { auto: [{ type_name: 'skill:pdf' }] },
  };
  const calls = [];
  const dependencies = {
    env, homeDir: profile,
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
  assert.deepEqual(calls.at(-1), ['add', catalog.skill[0].source, '--skill', 'pdf', '--agent', ...catalog.agents, '-g', '--yes', '--json']);
  assert.match(readFileSync(join(sharedPath, 'SKILL.md'), 'utf8'), /Version two/);
  assert.equal(lstatSync(sharedPath).isSymbolicLink(), false);
  assert.equal(existsSync(join(sharedPath, 'stale.txt')), false);
  const addCount = calls.filter((args) => args[0] === 'add').length;
  assert.equal(addCount, 2);
  sync([], dependencies);
  assert.equal(calls.filter((args) => args[0] === 'add').length, addCount + 1);
  const installed = JSON.parse(runSkills(['list', '-g', '--json']));
  const remote = installed.find((entry) => entry.name === 'pdf');
  assert.equal(remote.source.toLowerCase(), catalog.skill[0].source.toLowerCase());
  assert.equal(remote.sourceType, 'github');
  assert.deepEqual(remote.agents.slice().sort(), ['Codex', 'GitHub Copilot']);
  assert.equal(installed.some((entry) => entry.name === 'pdf-analyze'), true);
  const beforeAgentChange = calls.length;
  sync(['--local', '--del_agents', 'github-copilot'], dependencies);
  assert.equal(calls.length, beforeAgentChange);
  sync([], dependencies);
  assert.deepEqual(calls.at(-1), ['add', catalog.skill[0].source, '--skill', 'pdf', '--agent', 'codex', '-g', '--yes', '--json']);
  const beforeDelete = readFileSync(join(dependencies.stateDir, 'harness.json'), 'utf8');
  assert.throws(() => sync(['--local', '--del', 'skill:pdf'], dependencies), /目标安装仍存在/);
  assert.equal(readFileSync(join(dependencies.stateDir, 'harness.json'), 'utf8'), beforeDelete);
  sync(['--local', '--add_agents', 'github-copilot'], dependencies);
  sync(['--local', '--del', 'skill:pdf'], dependencies);
  assert.equal(JSON.parse(runSkills(['list', '-g', '--json'])).some((entry) => entry.name === 'pdf'), false);
  const afterDelete = calls.filter((args) => args[0] === 'add').length;
  sync([], dependencies);
  assert.equal(calls.filter((args) => args[0] === 'add').length, afterDelete);
  sync(['--local', '--add', 'integration-fixture/skills', 'skill:pdf'], dependencies);
  assert.deepEqual(JSON.parse(readFileSync(join(dependencies.stateDir, 'harness.json')))['sync-rules'].auto, [{ type_name: 'skill:pdf' }]);
  assert.equal(JSON.parse(runSkills(['list', '-g', '--json'])).some((entry) => entry.name === 'pdf'), true);

  // Exercise a rename through real CLI removal and installation with a local override on the old name.
  const renamed = join(source, 'skills', 'pdf-renamed');
  mkdirSync(renamed);
  writeFileSync(join(renamed, 'SKILL.md'), '---\nname: pdf-renamed\ndescription: Renamed test skill.\n---\n\nRenamed content\n');
  git(['add', '.']);
  git(['-c', 'user.name=Skill Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'Rename fixture']);
  catalog.deleted = [{ type_name: 'skill:pdf', source: catalog.skill[0].source }, { type_name: 'agents-md:old-rule' }];
  catalog.skill = [{ name: 'pdf-renamed', source: 'integration-fixture/skills' }];
  const instructions = join(env.CODEX_HOME, 'AGENTS.md');
  writeFileSync(instructions, 'Personal\n<!-- eh:old-rule:start -->\nOld\n<!-- eh:old-rule:end -->\n');
  catalog['agents-md'] = [{ name: 'new-rule' }];
  catalog['sync-rules'].auto = [{ type_name: 'skill:pdf-renamed' }, { type_name: 'agents-md:new-rule' }];
  // This profile overrides the complete auto rule; include the new members
  // while retaining an obsolete local reference to exercise tombstone priority.
  writeFileSync(join(dependencies.stateDir, 'harness.json'), JSON.stringify({
    'sync-rules': { auto: [{ type_name: 'skill:pdf' }, ...catalog['sync-rules'].auto] },
  }));
  dependencies.fetchFragment = () => '## New rule\nKeep it simple.';
  sync([], dependencies);
  const afterRename = JSON.parse(runSkills(['list', '-g', '--json']));
  assert.ok(!afterRename.some((entry) => entry.name === 'pdf'));
  assert.ok(afterRename.some((entry) => entry.name === 'pdf-renamed'));
  assert.ok(!existsSync(sharedPath));
  assert.match(readFileSync(join(profile, '.agents', 'skills', 'pdf-renamed', 'SKILL.md'), 'utf8'), /Renamed content/);
  assert.ok(!readFileSync(instructions, 'utf8').includes('eh:old-rule:'));
  assert.ok(readFileSync(instructions, 'utf8').startsWith('Personal\n'));
  assert.ok(readFileSync(instructions, 'utf8').includes('eh:new-rule:'));
  const removalCount = calls.filter((args) => args[0] === 'remove').length;
  sync([], dependencies);
  assert.equal(calls.filter((args) => args[0] === 'remove').length, removalCount);
  runSkills(['remove', 'pdf-analyze', '-g', '--yes', '--agent', 'codex', 'github-copilot']);
  assert.equal(JSON.parse(runSkills(['list', '-g', '--json'])).some((entry) => entry.name === 'pdf-analyze'), false);

  // The public home option must override inherited agent paths for the real
  // CLI, preflight subprocesses, shared lock and instruction/config writes.
  let selectedHome = join(sandbox, 'selected home');
  const originalInstructions = readFileSync(instructions, 'utf8');
  const originalSettings = readFileSync(join(dependencies.stateDir, 'harness.json'), 'utf8');
  // Git 2.25 does not honor GIT_CONFIG_GLOBAL. Keep the fixture-only URL
  // rewrite explicit across a HOME change without copying profile config.
  const rewrite = `url.${pathToFileURL(source).href}.insteadOf=https://github.com/integration-fixture/skills.git`;
  const selectedEnv = { ...env, GIT_CONFIG_PARAMETERS: `${env.GIT_CONFIG_PARAMETERS ?? ''} '${rewrite.replaceAll("'", "'\\''")}'`.trim() };
  const selectedDependencies = { env: selectedEnv, cwd: sandbox, fetchManifest: () => JSON.stringify(catalog),
    fetchFragment: dependencies.fetchFragment, log: (message) => t.diagnostic(message) };
  let selectedRunner = createSkillsRunner(homeDependencies(selectedHome, selectedDependencies));
  let installedMode;
  selectedDependencies.runSkills = (args) => {
    const result = selectedRunner(args);
    if (args[0] === 'add') installedMode = JSON.parse(result)[0].mode;
    return result;
  };
  assert.equal(runCommand('git', ['config', '--get', `url.${pathToFileURL(source).href}.insteadOf`],
    { env: homeDependencies(selectedHome, selectedDependencies).env, cwd: sandbox }).trim(), 'https://github.com/integration-fixture/skills.git');
  sync(['--home', selectedHome], selectedDependencies);
  assert.ok(existsSync(join(selectedHome, '.agents', 'skills', 'pdf-renamed', 'SKILL.md')));
  assert.ok(readFileSync(join(selectedHome, '.codex', 'AGENTS.md'), 'utf8').includes('eh:new-rule:'));
  assert.ok(readFileSync(join(selectedHome, '.copilot', 'copilot-instructions.md'), 'utf8').includes('eh:new-rule:'));
  assert.ok(existsSync(join(selectedHome, '.everything-harness', 'harness.json')));
  const nativeSkill = (agent) => join(selectedHome, agent, 'skills', 'pdf-renamed');
  assert.ok(['copy', 'symlink'].includes(installedMode));
  for (const agent of ['.codex', '.copilot']) {
    assert.equal(lstatSync(nativeSkill(agent)).isSymbolicLink(), installedMode === 'symlink');
    assert.match(readFileSync(join(nativeSkill(agent), 'SKILL.md'), 'utf8'), /Renamed content/);
    writeFileSync(join(nativeSkill(agent), 'stale.txt'), 'local stale file');
  }
  sync(['--home', selectedHome], selectedDependencies);
  assert.ok(['.codex', '.copilot'].every((agent) => !existsSync(join(nativeSkill(agent), 'stale.txt'))));
  assert.ok(JSON.parse(selectedRunner(['list', '-g', '--json'])).every((entry) => entry.path.startsWith(selectedHome)));

  // Removing one endpoint preserves the other agent and the CLI's source lock.
  sync(['--home', selectedHome, '--local', '--del_agents', 'github-copilot'], selectedDependencies);
  sync(['--home', selectedHome, '--local', '--del', 'skill:pdf-renamed'], selectedDependencies);
  assert.ok(!existsSync(nativeSkill('.codex')));
  assert.ok(existsSync(nativeSkill('.copilot')));
  assert.equal(JSON.parse(selectedRunner(['list', '-g', '--json'])).find((entry) => entry.name === 'pdf-renamed').source, 'integration-fixture/skills');
  sync(['--home', selectedHome, '--local', '--add_agents', 'github-copilot'], selectedDependencies);
  sync(['--home', selectedHome, '--local', '--add', 'rule:auto'], selectedDependencies);

  const movedHome = join(sandbox, 'moved home');
  renameSync(selectedHome, movedHome); selectedHome = movedHome;
  selectedRunner = createSkillsRunner(homeDependencies(selectedHome, selectedDependencies));
  for (const agent of ['.codex', '.copilot']) assert.match(readFileSync(join(nativeSkill(agent), 'SKILL.md'), 'utf8'), /Renamed content/);
  sync(['--home', selectedHome, '--local', '--del', 'rule:auto'], selectedDependencies);
  assert.ok(['.codex', '.copilot'].every((agent) => !existsSync(nativeSkill(agent))));
  assert.deepEqual(JSON.parse(selectedRunner(['list', '-g', '--json'])), []);
  assert.ok(JSON.parse(runSkills(['list', '-g', '--json'])).some((entry) => entry.name === 'pdf-renamed'));
  assert.equal(readFileSync(instructions, 'utf8'), originalInstructions);
  assert.equal(readFileSync(join(dependencies.stateDir, 'harness.json'), 'utf8'), originalSettings);
});
