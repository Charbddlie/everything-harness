import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { OWN_SOURCE, createProgressLogger, findSkill, parseArgs, runCommand, runDryruns, sync, validateManifest } from '../sync.mjs';

const agents = ['codex', 'github-copilot'];
const entry = (name, source = 'example/skills') => ({ name, source });
const member = (name) => ({ type_name: `skill:${name}` });
const text = (name, body = 'Version one') => `---\nname: ${name}\ndescription: Test fixture.\n---\n${body}\n`;
const put = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
function fixture(t, manifest = { agents, skill: [entry('one'), entry('two')], 'sync-rules': { auto: [member('one'), member('two')] } }) {
  const root = mkdtempSync(join(tmpdir(), 'eh-sync-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), tempDir = join(root, 'operations'); mkdirSync(tempDir);
  const logs = [], downloads = [];
  const dependencies = {
    homeDir: home, tempDir, env: {}, log: (line) => logs.push(line),
    fetchManifest: () => JSON.stringify(manifest),
    fetchFragment: () => 'Instructions',
    fetchRepository: (source, path) => {
      downloads.push(source);
      for (const name of ['one', 'two', 'new', 'renamed']) put(join(path, 'skills', name, 'SKILL.md'), text(name));
    },
  };
  return { root, home, tempDir, manifest, dependencies, logs, downloads,
    shared: (name) => join(home, '.agents', 'skills', name),
    settings: join(home, '.everything-harness', 'harness.json'),
    run: (args = []) => sync(args, dependencies) };
}

test('sync downloads each source once and installs exactly the checked content', (t) => {
  const f = fixture(t);
  f.dependencies.runDryruns = (entries, prepared) => {
    for (const { name } of entries) put(join(prepared.get(name).path, 'checked.txt'), 'checked');
  };
  f.run();
  assert.deepEqual(f.downloads, ['example/skills']);
  for (const { name } of f.manifest.skill) {
    assert.equal(readFileSync(join(f.shared(name), 'checked.txt'), 'utf8'), 'checked');
    put(join(f.shared(name), 'stale.txt'), 'stale');
  }
  put(join(f.shared('unmanaged'), 'SKILL.md'), 'Keep');
  f.run();
  assert.equal(f.downloads.length, 2);
  assert.ok(!existsSync(join(f.shared('one'), 'stale.txt')));
  assert.equal(readFileSync(join(f.shared('unmanaged'), 'SKILL.md'), 'utf8'), 'Keep');
  assert.deepEqual(readdirSync(f.tempDir), []);
  assert.deepEqual(JSON.parse(readFileSync(f.settings)), { 'sync-rules': {} });
});

test('all rules share downloaded repositories and read fragments from the same snapshot', (t) => {
  const f = fixture(t, {
    agents, skill: [entry('one', OWN_SOURCE), entry('two', OWN_SOURCE), entry('new'), entry('unused', 'unused/repo')],
    'agents-md': [{ name: 'base' }, { name: 'windows' }], deleted: [{ type_name: 'agents-md:old' }],
    'sync-rules': {
      auto: [member('one'), member('new'), { type_name: 'agents-md:base' }],
      win: [member('two'), { type_name: 'agents-md:windows' }], learn: [member('unused')],
    },
  });
  f.dependencies.platform = 'win32';
  delete f.dependencies.fetchFragment;
  const target = join(f.home, '.codex', 'AGENTS.md'), snapshots = [];
  put(target, 'Personal\n<!-- eh:old:start -->\nOld\n<!-- eh:old:end -->\n');
  let version = 1;
  f.dependencies.fetchRepository = (source, path) => {
    assert.ok(!readFileSync(target, 'utf8').includes('eh:old:'));
    f.downloads.push(source);
    for (const { name } of f.manifest.skill.filter((entry) => entry.source === source)) {
      put(join(path, 'skills', name, 'SKILL.md'), text(name, `Version ${version}`));
    }
    if (source === OWN_SOURCE) for (const name of ['base', 'windows']) put(join(path, 'agents-md', `${name}.md`), `${name} ${version}`);
  };
  f.dependencies.runDryruns = (entries, prepared) => {
    assert.deepEqual(f.downloads.slice(-2), [OWN_SOURCE, 'example/skills']);
    for (const entry of entries.filter(({ source }) => source === OWN_SOURCE)) snapshots.push(dirname(dirname(prepared.get(entry.name).path)));
  };
  f.run();
  assert.deepEqual(f.downloads, [OWN_SOURCE, 'example/skills']);
  assert.equal(snapshots[0], snapshots[1]);
  assert.equal(f.logs.filter((line) => line === '下载源码').length, 1);
  assert.match(readFileSync(target, 'utf8'), /Personal[\s\S]*base 1[\s\S]*windows 1/);
  version++;
  f.run();
  assert.deepEqual(f.downloads, [OWN_SOURCE, 'example/skills', OWN_SOURCE, 'example/skills']);
  assert.notEqual(snapshots[0], snapshots[2]);
  assert.match(readFileSync(join(f.shared('two'), 'SKILL.md'), 'utf8'), /Version 2/);
  assert.match(readFileSync(target, 'utf8'), /base 2[\s\S]*windows 2/);
  assert.deepEqual(readdirSync(f.tempDir), []);
});

test('a failed source is attempted once across rules and retried on the next invocation', (t) => {
  const f = fixture(t, { agents, skill: [entry('one'), entry('two')],
    'sync-rules': { auto: [member('one')], win: [member('two')] } });
  f.dependencies.platform = 'win32';
  const download = f.dependencies.fetchRepository;
  let attempts = 0;
  f.dependencies.fetchRepository = () => { attempts++; throw new Error('network unavailable'); };
  assert.throws(() => f.run(), /auto: network unavailable, win: network unavailable/);
  assert.equal(attempts, 1);
  assert.ok(!existsSync(f.settings));
  assert.deepEqual(readdirSync(f.tempDir), []);
  f.dependencies.fetchRepository = download;
  f.run();
  assert.deepEqual(f.downloads, ['example/skills']);
  assert.ok(existsSync(f.shared('one')) && existsSync(f.shared('two')));
});

test('source conflict blocks downloads, replacement and deletion', (t) => {
  const f = fixture(t);
  put(join(f.shared('one'), 'SKILL.md'), 'Keep');
  put(join(f.shared('one'), '.eh-source.json'), '{"source":"other/repo"}');
  assert.throws(() => f.run(), /来源冲突/);
  assert.throws(() => f.run(['--local', '--del', 'skill:one']), /来源冲突/);
  assert.equal(f.downloads.length, 0);
  assert.equal(readFileSync(join(f.shared('one'), 'SKILL.md'), 'utf8'), 'Keep');
  assert.ok(!existsSync(f.settings));
});

test('unmarked content is explicitly selected for replacement, other directories and locks are untouched', (t) => {
  const f = fixture(t);
  put(join(f.shared('one'), 'SKILL.md'), 'Selected content');
  const lock = join(f.home, '.agents', '.skill-lock.json');
  put(lock, '{"fixture":"keep"}');
  f.run();
  assert.match(readFileSync(join(f.shared('one'), 'SKILL.md'), 'utf8'), /Version one/);
  assert.equal(readFileSync(lock, 'utf8'), '{"fixture":"keep"}');
});

test('list and dryrun preserve installed content and settings', (t) => {
  const f = fixture(t);
  f.run(['--list']); assert.equal(f.downloads.length, 0);
  f.run(['--dryrun']); assert.equal(f.downloads.length, 1);
  assert.ok(!existsSync(f.home));
  f.run();
  const before = readFileSync(f.settings, 'utf8');
  put(join(f.shared('one'), 'local.txt'), 'Keep');
  f.run(['--dryrun']);
  assert.equal(readFileSync(f.settings, 'utf8'), before);
  assert.ok(existsSync(join(f.shared('one'), 'local.txt')));
});

test('failed skill checks preserve content in dryrun but only warn during sync and local add', (t) => {
  const f = fixture(t); f.run();
  f.manifest['agents-md'] = [{ name: 'base' }];
  f.manifest['sync-rules'].auto.push({ type_name: 'agents-md:base' });
  f.dependencies.fetchRepository = (source, path) => {
    for (const name of ['one', 'two']) {
      put(join(path, 'skills', name, 'SKILL.md'), text(name, 'Version two'));
      put(join(path, 'skills', name, 'dryrun.mjs'), `console.error('failure-${name}'); process.exitCode=1;`);
    }
  };
  const before = readFileSync(f.settings, 'utf8');
  assert.throws(() => f.run(['--dryrun']), /2 个 skill/);
  assert.ok(['one', 'two'].every((name) => f.logs.some((line) => line.includes(`failure-${name}`))));
  for (const name of ['one', 'two']) assert.match(readFileSync(join(f.shared(name), 'SKILL.md'), 'utf8'), /Version one/);
  assert.equal(readFileSync(f.settings, 'utf8'), before);
  assert.ok(!existsSync(join(f.home, '.codex', 'AGENTS.md')));
  f.run();
  for (const name of ['one', 'two']) assert.match(readFileSync(join(f.shared(name), 'SKILL.md'), 'utf8'), /Version two/);
  assert.ok(f.logs.some((line) => line.startsWith('[警告] 2 个 skill')));
  assert.match(readFileSync(join(f.home, '.codex', 'AGENTS.md'), 'utf8'), /Instructions/);
  put(f.settings, '{"sync-rules":{"auto":[]}}');
  f.run(['--local', '--add', 'example/skills', 'skill:one']);
  assert.ok(JSON.parse(readFileSync(f.settings))['sync-rules'].auto.some(({ type_name }) => type_name === 'skill:one'));
});

test('invalid skill structure still blocks normal synchronization', (t) => {
  const f = fixture(t); f.run();
  f.dependencies.fetchRepository = (source, path) => put(join(path, 'skills', 'one', 'SKILL.md'), 'Invalid metadata');
  assert.throws(() => f.run(), /SKILL.md/);
  assert.match(readFileSync(join(f.shared('one'), 'SKILL.md'), 'utf8'), /Version one/);
});

test('progress output numbers actual stages and labels warnings without hiding application', (t) => {
  const f = fixture(t);
  f.dependencies.log = createProgressLogger((line) => f.logs.push(line));
  f.dependencies.fetchRepository = (source, path) => {
    for (const name of ['one', 'two']) {
      put(join(path, 'skills', name, 'SKILL.md'), text(name));
      put(join(path, 'skills', name, 'dryrun.mjs'), 'console.error("Missing setting"); process.exitCode=1;');
    }
  };
  f.run();
  const stages = () => f.logs.map((line) => line.trim()).filter((line) => /^\d+\./.test(line));
  assert.deepEqual(stages(), [
    '1. 读取清单和本机设置', '2. 清理已删除的 skill', '3. 清理 sysprompt', '4. 下载源码',
    '5. 自动配置: auto', '5.1 检查 skill 环境', '5.2 应用 skill 到目标目录',
    '6. 清理临时目录', '7. 创建本地设置',
  ]);
  assert.ok(f.logs.some((line) => line.includes('[警告] [one] 失败')));
  assert.ok(f.logs.some((line) => line.includes('[通过] 覆盖安装')));
  assert.ok(f.logs.at(-1).startsWith('  [完成]'));
  assert.ok(!f.logs.some((line) => /本次未应用的 rule|未安装的独立skill/.test(line)));
  f.logs.length = 0;
  f.dependencies.log = createProgressLogger((line) => f.logs.push(line));
  assert.throws(() => f.run(['--dryrun']), /环境检查失败/);
  assert.deepEqual(stages(), [
    '1. 读取清单和本机设置', '2. 预览 skill 删除', '3. 清理 sysprompt', '4. 下载源码',
    '5. 自动配置: auto', '5.1 检查 skill 环境', '6. 清理临时目录',
  ]);
  assert.ok(f.logs.some((line) => line.includes('[失败] [one]')));
  assert.ok(!f.logs.some((line) => line.includes('应用 skill 到目标目录')));
});

test('automatic configuration resets subnumbering per rule and keeps later stages at the top level', (t) => {
  const f = fixture(t, {
    agents, skill: [entry('one'), entry('two')],
    'sync-rules': { auto: [member('one')], win: [member('two')], learn: [] },
  });
  f.dependencies.platform = 'win32';
  f.dependencies.log = createProgressLogger((line) => f.logs.push(line));
  f.run();
  const stages = () => f.logs.map((line) => line.trim()).filter((line) => /^\d+\./.test(line));
  assert.deepEqual(stages(), [
    '1. 读取清单和本机设置', '2. 清理已删除的 skill', '3. 清理 sysprompt', '4. 下载源码',
    '5. 自动配置: auto', '5.1 检查 skill 环境', '5.2 应用 skill 到目标目录',
    '6. 自动配置: win', '6.1 检查 skill 环境', '6.2 应用 skill 到目标目录',
    '7. 自动配置: learn', '8. 清理临时目录', '9. 创建本地设置',
  ]);
  assert.ok(f.logs.some((line) => line.includes('[跳过] 跳过 rule:learn')));
  f.logs.length = 0;
  f.dependencies.log = createProgressLogger((line) => f.logs.push(line));
  f.run(['--local', '--add', 'rule:win']);
  assert.deepEqual(stages(), [
    '1. 读取清单和本机设置', '2. 自动配置: win',
    '2.1 下载源码', '2.2 检查 skill 环境', '2.3 应用 skill 到目标目录',
    '3. 清理临时目录', '4. 保存本机设置',
  ]);
});

test('download failures preserve content and never report a completed sync', (t) => {
  const f = fixture(t); f.run();
  f.logs.length = 0;
  f.dependencies.fetchRepository = () => { throw new Error('network unavailable'); };
  assert.throws(() => f.run(), /network unavailable/);
  assert.ok(!f.logs.some((line) => line.startsWith('下载完成：example/skills')));
  assert.ok(!f.logs.includes('规则同步和环境检查完成。'));
  assert.match(readFileSync(join(f.shared('one'), 'SKILL.md'), 'utf8'), /Version one/);
});

test('piped output shows the heading first and each source after its download', { timeout: 10_000 }, async (t) => {
  const f = fixture(t);
  f.manifest.skill.push(entry('new', 'other/skills'));
  f.manifest['sync-rules'].auto.push(member('new'));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { mkdirSync, writeFileSync, readSync } from 'node:fs';
    import { join } from 'node:path';
    import { sync } from ${JSON.stringify(new URL('../sync.mjs', import.meta.url).href)};
    const finishDownload = () => {
      if (readSync(0, Buffer.alloc(1), 0, 1, null) !== 1) throw new Error('Missing download acknowledgement');
    };
    sync(['--dryrun'], {
      homeDir: ${JSON.stringify(f.home)}, tempDir: ${JSON.stringify(f.tempDir)}, env: {},
      fetchManifest() { return ${JSON.stringify(JSON.stringify(f.manifest))}; },
      fetchRepository(source, path) {
        finishDownload();
        for (const name of ['one', 'two', 'new']) {
          const directory = join(path, 'skills', name);
          mkdirSync(directory, { recursive: true });
          writeFileSync(join(directory, 'SKILL.md'), '---\\nname: ' + name + '\\ndescription: Test fixture.\\n---\\n');
        }
      },
    });
  `], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const events = [];
  let pending = '', errors = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { errors += chunk; });
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      const event = line.match(/4\. 下载源码|下载完成：[^ ]+/);
      if (!event) continue;
      events.push(event[0]);
      if (events.length <= 2) child.stdin.write('1');
    }
  });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  assert.equal(code, 0, errors);
  assert.deepEqual(events, ['4. 下载源码', '下载完成：example/skills', '下载完成：other/skills']);
  assert.ok(!existsSync(f.home));
  assert.deepEqual(readdirSync(f.tempDir), []);
});

test('tombstones delete before new installs, respect source conflicts and leave unmanaged content', (t) => {
  const f = fixture(t); f.run();
  f.manifest.deleted = [{ type_name: 'skill:one', source: 'example/skills' }];
  f.manifest.skill = [entry('renamed')];
  f.manifest['sync-rules'].auto = [member('renamed')];
  put(join(f.shared('unmanaged'), 'SKILL.md'), 'Keep');
  f.logs.length = 0; f.run();
  assert.ok(!existsSync(f.shared('one')));
  assert.ok(existsSync(f.shared('renamed')));
  assert.ok(existsSync(f.shared('unmanaged')));
  assert.ok(f.logs.findIndex((line) => line.startsWith('删除本机安装')) < f.logs.findIndex((line) => line.startsWith('覆盖安装')));
  f.run();
  assert.ok(!existsSync(f.shared('one')));
});

test('empty agent selection skips checks and prevents explicit content mutations', (t) => {
  const f = fixture(t);
  f.run(['--local', '--del_agents', ...agents]);
  f.run(); f.run(['--dryrun']);
  assert.equal(f.downloads.length, 0);
  for (const mode of ['--add', '--del']) assert.throws(() => f.run(['--local', mode, ...(mode === '--add' ? ['example/skills'] : []), 'skill:one']), /agents 为空/);
  f.run(['--local', '--add_agents', 'codex']);
  f.run(); assert.ok(existsSync(f.shared('one')));
});

test('invalid manifests and arguments fail before touching installations', (t) => {
  for (const manifest of [null, {}, { agents, skill: [entry('one'), entry('one')] }, { agents: ['unknown'], skill: [] },
    ...['../repo', 'a/..', 'a/b/tree/main', 'https://github.com/a/b'].map((source) => ({ agents, skill: [entry('one', source)] }))]) {
    const f = fixture(t, manifest); assert.throws(() => f.run()); assert.equal(f.downloads.length, 0);
  }
  for (const args of [['--add'], ['--del'], ['--update'], ['--list', '--del', 'skill:one']]) assert.throws(() => parseArgs(args));
  assert.throws(() => validateManifest({ agents, skill: [], deleted: [{ type_name: 'skill:one' }] }));
  assert.throws(() => runCommand(process.execPath, ['-e', 'process.exit(7)']), /退出码 7/);
});

test('source discovery supports root and nested skills, rejects ambiguity and invalid metadata', (t) => {
  const f = fixture(t), root = join(f.root, 'source');
  put(join(root, '.curated', 'one', 'SKILL.md'), text('one'));
  assert.equal(findSkill(root, entry('one')), join(root, '.curated', 'one'));
  put(join(root, 'other', 'SKILL.md'), text('one'));
  assert.throws(() => findSkill(root, entry('one')), /多个/);
  put(join(root, 'SKILL.md'), text('one'));
  assert.equal(findSkill(root, entry('one')), root);
  put(join(root, 'SKILL.md'), '---\nname: one\n---\n');
  assert.throws(() => findSkill(root, entry('one')), /description/);
  put(join(root, 'SKILL.md'), '---\nname: one\ndescription: ""\n---\n');
  assert.throws(() => findSkill(root, entry('one')), /description/);
});

test('skill source links cannot copy external files', (t) => {
  const f = fixture(t), root = join(f.root, 'source'), outside = join(f.root, 'outside');
  put(join(root, 'SKILL.md'), text('one'));
  put(join(outside, 'private.txt'), 'Keep outside');
  symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => findSkill(root, entry('one')), /不支持链接/);
  put(join(outside, 'one', 'SKILL.md'), text('one'));
  symlinkSync(outside, join(root, 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => findSkill(root, entry('one', OWN_SOURCE)), /仓库之外/);
});

test('own script-bearing skills require dryrun and every failure is reported', (t) => {
  const f = fixture(t), path = join(f.root, 'own'), logs = [];
  put(join(path, 'scripts', 'helper.mjs'), '');
  assert.throws(() => runDryruns([entry('own', OWN_SOURCE), entry('missing')], new Map([['own', { path }]]),
    { log: (line) => logs.push(line) }), /2 个 skill/);
  assert.ok(logs.some((line) => line.includes('缺少 dryrun')));
  assert.ok(logs.some((line) => line.includes('无法检查环境')));
});

function remoteFixture(t, manifest = { agents, skill: [entry('one', OWN_SOURCE)] }) {
  const f = fixture(t, manifest), repository = join(f.root, 'repository'), remote = join(f.root, 'remote.git');
  mkdirSync(repository);
  const env = { ...process.env, CODEX_HOME: join(f.home, '.codex'), COPILOT_HOME: join(f.home, '.copilot'),
    GIT_AUTHOR_NAME: 'Skill Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Skill Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: join(f.root, 'no-hooks') };
  const git = (args) => runCommand('git', args, { cwd: repository, env });
  git(['init', '--bare', '--quiet', remote]); git(['init', '--quiet']);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  put(join(repository, 'harness.json'), JSON.stringify(manifest) + '\n');
  put(join(repository, 'skills', 'one', 'SKILL.md'), text('one'));
  put(join(repository, 'skills', 'two', 'SKILL.md'), text('two'));
  put(join(repository, 'agents-md', 'base.md'), 'Instructions');
  git(['add', '.']); git(['commit', '--quiet', '-m', 'Initial']);
  git(['remote', 'add', 'origin', remote]); git(['push', '--quiet', '-u', 'origin', 'main']);
  Object.assign(f.dependencies, { env, repositoryUrl: remote });
  return { ...f, repository, git, remote,
    remoteManifest: () => JSON.parse(runCommand('git', ['--git-dir', remote, 'show', 'main:harness.json'])) };
}

test('remote own-skill and fragment additions reuse the publication checkout', (t) => {
  const f = remoteFixture(t);
  delete f.dependencies.fetchFragment;
  f.dependencies.fetchRepository = () => assert.fail('The publication checkout already contains the source');
  put(join(f.repository, 'agents-md', 'base.md'), 'Unpublished local edit');
  f.run(['--add', 'skill:two']);
  assert.match(readFileSync(join(f.shared('two'), 'SKILL.md'), 'utf8'), /Version one/);
  f.run(['--add', 'agents-md:base']);
  assert.match(readFileSync(join(f.home, '.codex', 'AGENTS.md'), 'utf8'), /Instructions/);
  assert.equal(readFileSync(join(f.repository, 'agents-md', 'base.md'), 'utf8'), 'Unpublished local edit');
  assert.ok(f.remoteManifest().skill.some(({ name }) => name === 'two'));
  assert.deepEqual(f.remoteManifest()['agents-md'], [{ name: 'base' }]);
  assert.deepEqual(readdirSync(f.tempDir), []);
});

test('remote add applies failed-check content before publishing without changing a dirty user checkout', (t) => {
  const f = remoteFixture(t), events = [];
  put(join(f.repository, 'unrelated.txt'), 'Keep'); f.git(['add', 'unrelated.txt']);
  f.dependencies.fetchRepository = (source, path) => {
    put(join(path, 'skills', 'two', 'SKILL.md'), text('two'));
    put(join(path, 'skills', 'two', 'dryrun.mjs'), 'console.error("missing test setting"); process.exitCode=1;');
  };
  f.dependencies.runDryruns = (...args) => {
    events.push('dryrun'); assert.equal(f.remoteManifest().skill.length, 1);
    return runDryruns(...args);
  };
  f.dependencies.runGit = (command, args, options) => {
    if (args[0] === 'commit') { events.push('commit'); assert.ok(existsSync(f.shared('two'))); }
    return runCommand(command, args, options);
  };
  f.run(['--add', 'example/skills', 'skill:two']);
  assert.deepEqual(events, ['dryrun', 'commit']);
  assert.ok(f.logs.some((line) => line.startsWith('[警告]')));
  assert.equal(f.remoteManifest().skill.length, 2);
  assert.equal(f.git(['diff', '--cached', '--name-only']).trim(), 'unrelated.txt');
  assert.equal(JSON.parse(readFileSync(join(f.repository, 'harness.json'))).skill.length, 1);
  assert.deepEqual(readdirSync(f.tempDir), []);
});

for (const target of ['skill:one', 'agents-md:base']) {
  test(`remote deletion publishes only the tombstone and selected source for ${target}`, (t) => {
    const f = remoteFixture(t, { agents, skill: [entry('one', OWN_SOURCE)], 'agents-md': [{ name: 'base' }] });
    f.run(['--del', target]);
    assert.ok(f.remoteManifest().deleted.some(({ type_name }) => type_name === target));
    const files = runCommand('git', ['--git-dir', f.remote, 'ls-tree', '-r', '--name-only', 'main']);
    const path = target.startsWith('skill:') ? 'skills/one/SKILL.md' : 'agents-md/base.md';
    assert.ok(!files.includes(path));
    assert.ok(existsSync(join(f.repository, path)));
    const before = f.git(['ls-remote', 'origin', 'refs/heads/main']);
    f.run(['--del', target]);
    assert.equal(f.git(['ls-remote', 'origin', 'refs/heads/main']), before);
  });
}

test('third-party deletion preserves same-named repository source', (t) => {
  const f = remoteFixture(t, { agents, skill: [entry('one')] });
  f.run(['--del', 'skill:one']);
  assert.ok(runCommand('git', ['--git-dir', f.remote, 'show', 'main:skills/one/SKILL.md']).includes('one'));
});

for (const failed of ['fetch', 'var', 'commit', 'push']) {
  test(`remote ${failed} failure preserves completed operations and allows retry`, (t) => {
    const f = remoteFixture(t);
    f.dependencies.runGit = (command, args, options) => {
      if (args[0] === failed) throw new Error(`fixture ${failed} failure`);
      return runCommand(command, args, options);
    };
    assert.throws(() => f.run(['--add', 'skill:two']), new RegExp(`fixture ${failed} failure`));
    assert.equal(f.remoteManifest().skill.length, 1);
    assert.equal(existsSync(f.shared('two')), ['commit', 'push'].includes(failed));
    const saved = readdirSync(f.tempDir);
    assert.equal(saved.length, ['commit', 'push'].includes(failed) ? 1 : 0);
    delete f.dependencies.runGit;
    f.run(['--add', 'skill:two']);
    assert.equal(f.remoteManifest().skill.length, 2);
  });
}

test('remote agents and switches publish without downloading or installing skills', (t) => {
  const f = remoteFixture(t);
  f.run(['--del_agents', 'codex']);
  assert.deepEqual(f.remoteManifest().agents, ['github-copilot']);
  f.run(['--auto_sync', 'true', 'skill:one']);
  assert.deepEqual(f.remoteManifest()['sync-rules'].auto, [member('one')]);
  assert.equal(f.downloads.length, 0);
});

test('file and piped entry points work with help without npm or downloads', () => {
  const script = fileURLToPath(new URL('../sync.mjs', import.meta.url));
  for (const [args, input] of [[[script, '--help']], [['--input-type=module', '-', '--help'], readFileSync(script, 'utf8')]]) {
    const result = spawnSync(process.execPath, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /用法/);
  }
  assert.equal(spawnSync(process.execPath, [script, '--invalid']).status, 1);
});
