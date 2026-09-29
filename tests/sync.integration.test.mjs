import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { OWN_SOURCE, checkSkills, runCommand, sync } from '../sync.mjs';

const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const skillText = (name, version) => `---\nname: ${name}\ndescription: Integration fixture.\n---\n${version}\n`;

test('real Git source fetch, dryrun, overwrite and deletion stay inside the selected home', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'eh-git-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, 'repository'), home = join(root, 'profile');
  mkdirSync(repository);
  const config = join(root, '.gitconfig');
  const env = { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: join(root, 'xdg'), GIT_CONFIG_NOSYSTEM: '1' };
  const git = (args) => runCommand('git', args, { cwd: repository, env });
  git(['config', '--file', config, 'commit.gpgsign', 'false']);
  git(['config', '--file', config, 'core.hooksPath', join(root, 'no-hooks')]);
  git(['config', '--file', config, `url.${pathToFileURL(repository).href}.insteadOf`, 'https://github.com/fixture/skills.git']);
  git(['init', '--quiet']);
  git(['config', 'user.name', 'Skill Test']); git(['config', 'user.email', 'test@example.invalid']);
  const source = join(repository, 'skills', '.curated', 'one');
  put(join(source, 'SKILL.md'), skillText('one', 'Version one'));
  put(join(source, 'dryrun.mjs'), 'console.log("Environment OK");');
  git(['add', '.']); git(['commit', '--quiet', '-m', 'Initial']);
  const manifest = { agents: ['codex', 'github-copilot'], skill: [{ name: 'one', source: 'fixture/skills' }],
    'sync-rules': { auto: [{ type_name: 'skill:one' }] } };
  const logs = [], dependencies = { env, tempDir: root, fetchManifest: () => JSON.stringify(manifest), log: (line) => logs.push(line) };
  const run = (args = []) => sync(['--home', home, ...args], dependencies);
  run(['--dryrun']);
  assert.ok(!existsSync(home));
  run();
  assert.ok(logs.some((line) => line === '[one] 跳过：第三方 skill'));
  for (const agent of ['.codex', '.copilot']) {
    assert.match(readFileSync(join(home, agent, 'skills', 'one', 'SKILL.md'), 'utf8'), /Version one/);
    put(join(home, agent, 'skills', 'one', 'stale.txt'), 'stale');
  }
  put(join(source, 'SKILL.md'), skillText('one', 'Version two'));
  git(['add', '.']); git(['commit', '--quiet', '-m', 'Update']);
  run();
  for (const agent of ['.codex', '.copilot']) {
    assert.match(readFileSync(join(home, agent, 'skills', 'one', 'SKILL.md'), 'utf8'), /Version two/);
    assert.ok(!existsSync(join(home, agent, 'skills', 'one', 'stale.txt')));
  }
  put(join(source, 'dryrun.mjs'), 'console.error("Missing fixture setting"); process.exitCode=1;');
  put(join(source, 'SKILL.md'), skillText('one', 'Version three'));
  git(['add', '.']); git(['commit', '--quiet', '-m', 'Add unused third-party check']);
  run(['--dryrun']);
  assert.match(readFileSync(join(home, '.codex', 'skills', 'one', 'SKILL.md'), 'utf8'), /Version two/);
  run();
  assert.match(readFileSync(join(home, '.codex', 'skills', 'one', 'SKILL.md'), 'utf8'), /Version three/);
  assert.ok(!logs.some((line) => line.includes('Missing fixture setting')));
  run(['--local', '--del', 'skill:one']);
  assert.ok(['.codex', '.copilot'].every((agent) => !existsSync(join(home, agent, 'skills', 'one'))));
  assert.ok(!readdirSync(root).some((name) => name.startsWith('eh-check-')));
});

test('GitHub source preflight without package-manager installation', {
  skip: process.env.SKILLS_INTEGRATION !== '1', timeout: 180_000,
}, (t) => {
  checkSkills(['copilot-api', 'harness-manage'].map((name) => ({ name, source: OWN_SOURCE })),
    ['codex', 'github-copilot'], {}, (line) => t.diagnostic(line));
});
