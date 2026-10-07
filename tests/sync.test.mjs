import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { OWN_SOURCE, encodeOutput, findSkill, sync } from '../sync.mjs';

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
    installed: (name) => join(home, '.codex', 'skills', name),
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
    assert.equal(readFileSync(join(f.installed(name), 'checked.txt'), 'utf8'), 'checked');
    put(join(f.installed(name), 'stale.txt'), 'stale');
  }
  put(join(f.installed('unmanaged'), 'SKILL.md'), 'Keep');
  const lock = join(f.home, '.agents', '.skill-lock.json');
  put(lock, 'Keep lock');
  f.run();
  assert.equal(f.downloads.length, 2);
  assert.ok(!existsSync(join(f.installed('one'), 'stale.txt')));
  assert.equal(readFileSync(join(f.installed('unmanaged'), 'SKILL.md'), 'utf8'), 'Keep');
  assert.equal(readFileSync(lock, 'utf8'), 'Keep lock');
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
  assert.match(readFileSync(join(f.installed('two'), 'SKILL.md'), 'utf8'), /Version 2/);
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
  assert.deepEqual(JSON.parse(readFileSync(f.settings)), { 'sync-rules': {} });
  assert.deepEqual(readdirSync(f.tempDir), []);
  f.dependencies.fetchRepository = download;
  f.run();
  assert.deepEqual(f.downloads, ['example/skills']);
  assert.ok(existsSync(f.installed('one')) && existsSync(f.installed('two')));
});

test('source conflict blocks downloads, replacement and deletion', (t) => {
  const f = fixture(t);
  put(join(f.installed('one'), 'SKILL.md'), 'Keep');
  put(join(f.installed('one'), '.eh-source.json'), '{"source":"other/repo"}');
  assert.throws(() => f.run(), /来源冲突/);
  assert.throws(() => f.run(['--del', 'skill:one']), /来源冲突/);
  assert.equal(f.downloads.length, 0);
  assert.equal(readFileSync(join(f.installed('one'), 'SKILL.md'), 'utf8'), 'Keep');
  assert.deepEqual(JSON.parse(readFileSync(f.settings)), { 'sync-rules': {} });
});

test('failed skill checks preserve content in dryrun but only warn during sync and local add', (t) => {
  const f = fixture(t);
  f.manifest.skill.forEach((entry) => { entry.source = OWN_SOURCE; });
  f.run();
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
  for (const name of ['one', 'two']) assert.match(readFileSync(join(f.installed(name), 'SKILL.md'), 'utf8'), /Version one/);
  assert.equal(readFileSync(f.settings, 'utf8'), before);
  assert.ok(!existsSync(join(f.home, '.codex', 'AGENTS.md')));
  f.run();
  for (const name of ['one', 'two']) assert.match(readFileSync(join(f.installed(name), 'SKILL.md'), 'utf8'), /Version two/);
  assert.ok(f.logs.some((line) => line.startsWith('[警告] 2 个 skill')));
  assert.match(readFileSync(join(f.home, '.codex', 'AGENTS.md'), 'utf8'), /Instructions/);
  put(f.settings, '{"sync-rules":{"auto":[]}}');
  f.run(['--add', 'skill:one']);
  assert.ok(JSON.parse(readFileSync(f.settings))['sync-rules'].auto.some(({ type_name }) => type_name === 'skill:one'));
});

test('invalid skill structure still blocks normal synchronization', (t) => {
  const f = fixture(t); f.run();
  f.dependencies.fetchRepository = (source, path) => put(join(path, 'skills', 'one', 'SKILL.md'), 'Invalid metadata');
  assert.throws(() => f.run(), /SKILL.md/);
  assert.match(readFileSync(join(f.installed('one'), 'SKILL.md'), 'utf8'), /Version one/);
});

test('sync, dryrun and local add execute only own-source checks', (t) => {
  const f = fixture(t);
  f.manifest.skill[0].source = OWN_SOURCE.toUpperCase();
  const ownMarker = join(f.root, 'own-ran'), thirdPartyMarker = join(f.root, 'third-party-ran');
  f.dependencies.fetchRepository = (source, path) => {
    for (const { name } of f.manifest.skill.filter((entry) => entry.source === source)) {
      const marker = name === 'one' ? ownMarker : thirdPartyMarker;
      put(join(path, 'skills', name, 'SKILL.md'), text(name));
      put(join(path, 'skills', name, 'dryrun.mjs'),
        `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, 'ran\\n'); ${name === 'two' ? 'process.exitCode = 1;' : ''}`);
    }
  };
  f.run(['--dryrun']);
  assert.ok(!existsSync(f.home));
  f.run();
  f.run(['--add', 'skill:two']);
  assert.equal(readFileSync(ownMarker, 'utf8'), 'ran\nran\nran\n');
  assert.ok(!existsSync(thirdPartyMarker));
  assert.ok(existsSync(join(f.installed('two'), 'dryrun.mjs')));
  assert.match(readFileSync(join(f.installed('two'), 'SKILL.md'), 'utf8'), /Version one/);
  assert.ok(f.logs.some((line) => line === '[two] 跳过：第三方 skill'));
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
  const outputDecoder = new TextDecoder(process.platform === 'win32' ? 'gbk' : 'utf-8');
  const errorDecoder = new TextDecoder(process.platform === 'win32' ? 'gbk' : 'utf-8');
  child.stderr.on('data', (chunk) => { errors += errorDecoder.decode(chunk, { stream: true }); });
  child.stdout.on('data', (chunk) => {
    pending += outputDecoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      const event = line.match(/3\. 下载源码|下载完成：[^ ]+/);
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
  assert.deepEqual(events, ['3. 下载源码', '下载完成：example/skills', '下载完成：other/skills']);
  assert.ok(!existsSync(f.home));
  assert.deepEqual(readdirSync(f.tempDir), []);
});

test('Windows console output uses GBK for help, listing, progress and errors while files stay UTF-8', (t) => {
  const f = fixture(t);
  assert.equal(encodeOutput('中文', 'win32').toString('hex'), 'd6d0cec4');
  assert.equal(encodeOutput('中文', 'linux').toString('hex'), 'e4b8ade69687');
  assert.equal(encodeOutput('😀', 'win32').toString(), '?');
  const module = new URL('../sync.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { sync } = await import(${JSON.stringify(module)});
    const dependencies = {
      homeDir: ${JSON.stringify(f.home)}, env: {},
      fetchManifest: () => JSON.stringify({
        agents: ['codex'], skill: [], 'agents-md': [{ name: 'base' }],
        'sync-rules': { auto: [{ type_name: 'agents-md:base' }] },
      }),
      fetchFragment: () => '中文指令',
    };
    sync(['--help'], dependencies);
    sync(['--list'], dependencies);
    sync([], dependencies);
  `]);
  assert.equal(result.status, 0, result.stderr.toString());
  const output = new TextDecoder('gbk').decode(result.stdout);
  for (const message of ['用法', '远程清单', '创建本地配置', '新增', '规则同步和环境检查完成']) assert.ok(output.includes(message));
  assert.ok(!output.includes('\ufffd'));
  assert.match(readFileSync(join(f.home, '.codex', 'AGENTS.md'), 'utf8'), /中文指令/);
  const error = spawnSync(process.execPath, [
    '--import', 'data:text/javascript,Object.defineProperty(process,"platform",{value:"win32"})',
    fileURLToPath(new URL('../sync.mjs', import.meta.url)), '--invalid',
  ]);
  assert.equal(error.status, 1);
  assert.match(new TextDecoder('gbk').decode(error.stderr), /操作失败：未知、重复或互斥参数/);
});

test('empty agent selection stores synchronization choices without installation until an agent is enabled', (t) => {
  const f = fixture(t);
  f.run(['--del', ...agents.map((name) => `agent:${name}`)]);
  f.run(); f.run(['--dryrun']);
  assert.equal(f.downloads.length, 0);
  f.run(['--del', 'skill:one']);
  f.run(['--add', 'skill:one']);
  assert.equal(f.downloads.length, 0);
  f.run(['--add', 'agent:codex']);
  f.run(); assert.ok(existsSync(f.installed('one')));
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
