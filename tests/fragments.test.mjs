import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { instructionPaths, parseArgs, renderFragments, sync, validateFragments, validateManifest } from '../sync.mjs';

const fragment = (name, auto_sync = true) => ({ name, auto_sync });
const block = (name, content) => `<!-- eh:${name}:start -->\n${content}\n<!-- eh:${name}:end -->`;
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'eh-fragments-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = { agents: ['codex', 'github-copilot'], skills: [], fragments: [fragment('one'), fragment('two'), fragment('disabled', false)] };
  const content = { one: 'First rule', two: 'Second rule', disabled: 'Optional rule' };
  const logs = [], reads = [];
  const dependencies = {
    stateDir: join(root, 'state'), homeDir: root, env: {},
    fetchManifest: () => JSON.stringify(manifest),
    fetchFragment: (name) => { reads.push(name); return content[name]; },
    runSkills: () => assert.fail('No skill CLI needed for fragments'),
    runGit: () => assert.fail('No Git needed for local operations'),
    log: (message) => logs.push(message),
  };
  return { root, manifest, content, logs, reads, dependencies,
    targets: instructionPaths(manifest.agents, dependencies),
    settings: join(dependencies.stateDir, 'harness.json'),
    run: (args = []) => sync(args, dependencies) };
}

test('first sync creates both targets and empty local overrides; repeat overwrites local body edits', (t) => {
  const f = fixture(t);
  f.run();
  assert.deepEqual(JSON.parse(readFileSync(f.settings)), { skills: [], fragments: [] });
  for (const path of f.targets) {
    assert.equal(readFileSync(path, 'utf8'), `${block('one', f.content.one)}\n\n${block('two', f.content.two)}\n`);
    put(path, `Personal prefix\n${block('one', 'LOCAL EDIT')}\n${block('two', 'STALE')}\nPersonal suffix`);
  }
  f.content.one = 'New remote rule';
  f.run();
  for (const path of f.targets) {
    const expected = `Personal prefix\n${block('one', 'New remote rule')}\n${block('two', f.content.two)}\nPersonal suffix`;
    assert.equal(readFileSync(path, 'utf8'), expected);
    f.run();
    assert.equal(readFileSync(path, 'utf8'), expected);
  }
  assert.ok(!f.reads.includes('disabled'));
});

test('local switches override remote defaults; disabled and unlisted blocks remain untouched', (t) => {
  const f = fixture(t);
  const original = `${block('one', 'Frozen local rule')}\n${block('unlisted', 'Unlisted rule')}\n`;
  f.targets.forEach((path) => put(path, original));
  const local = { skills: [], fragments: [fragment('one', false), fragment('disabled', true)] };
  put(f.settings, JSON.stringify(local));
  f.run();
  assert.deepEqual(JSON.parse(readFileSync(f.settings)), local);
  assert.deepEqual(f.reads, ['two', 'disabled']);
  for (const path of f.targets) {
    const result = readFileSync(path, 'utf8');
    assert.ok(result.startsWith(original));
    assert.ok(result.includes(block('disabled', 'Optional rule')));
  }
});

test('local auto_sync changes only requested switches; unknown names leave settings intact', (t) => {
  const f = fixture(t);
  f.run(['--local', '--fragments', '--auto_sync', 'false', 'one']);
  assert.deepEqual(JSON.parse(readFileSync(f.settings)), { skills: [], fragments: [fragment('one', false)] });
  assert.ok(f.targets.every((path) => !existsSync(path)));
  assert.deepEqual(f.reads, []);
  f.run(['--fragments', '--auto_sync', 'true', 'disabled', '--local']);
  const before = readFileSync(f.settings, 'utf8');
  assert.throws(() => f.run(['--local', '--fragments', '--auto_sync', 'false', 'disabled', 'unknown']), /不存在片段/);
  assert.equal(readFileSync(f.settings, 'utf8'), before);
  f.run();
  assert.ok(!readFileSync(f.targets[0], 'utf8').includes('eh:one:'));
  assert.ok(readFileSync(f.targets[0], 'utf8').includes('eh:disabled:'));
});

test('removing a local override resumes following remote switches', (t) => {
  const f = fixture(t);
  put(f.settings, JSON.stringify({ skills: [], fragments: [fragment('one', false)] }));
  f.run();
  assert.ok(!readFileSync(f.targets[0], 'utf8').includes('eh:one:'));
  put(f.settings, '{"skills":[],"fragments":[]}');
  f.run();
  assert.ok(readFileSync(f.targets[0], 'utf8').includes('eh:one:'));
});

test('global target override controls fragments and empty targets skip content downloads', (t) => {
  const f = fixture(t);
  put(join(f.dependencies.stateDir, 'harness.json'), '{"agents":["codex"],"skills":[]}');
  f.run();
  assert.ok(existsSync(f.targets[0]));
  assert.ok(!existsSync(f.targets[1]));
  f.reads.length = 0;
  put(join(f.dependencies.stateDir, 'harness.json'), '{"agents":[],"skills":[]}');
  f.run();
  assert.deepEqual(f.reads, []);
});

test('list reports remote, local and effective switches without reading content or writing files', (t) => {
  const f = fixture(t);
  put(f.settings, JSON.stringify({ skills: [], fragments: [fragment('one', false)] }));
  f.run(['--list']);
  assert.ok(f.logs.includes('one\ttrue\tfalse\tfalse\t正常'));
  assert.ok(f.logs.includes('two\ttrue\t跟随远程\ttrue\t正常'));
  assert.deepEqual(f.reads, []);
  assert.ok(f.targets.every((path) => !existsSync(path)));
});

test('dryrun validates selected bodies and target markers without initializing or writing', (t) => {
  const f = fixture(t);
  put(f.targets[0], 'Personal content');
  f.run(['--dryrun']);
  assert.equal(readFileSync(f.targets[0], 'utf8'), 'Personal content');
  assert.ok(!existsSync(f.targets[1]));
  assert.ok(!existsSync(f.settings));
  assert.deepEqual(f.reads, ['one', 'two']);
  f.content.two = '';
  assert.throws(() => f.run(['--dryrun']), /为空/);
});

test('download or target validation failures happen before skill installation or instruction writes', (t) => {
  const f = fixture(t);
  f.manifest.skills.push({ name: 'some-skill', source: 'example/skills', auto_sync: true });
  f.targets.forEach((path) => put(path, 'Personal content'));
  f.dependencies.fetchFragment = () => { throw new Error('download failed'); };
  assert.throws(() => f.run(), /download failed/);
  f.dependencies.fetchFragment = (name) => f.content[name];
  put(f.targets[1], '<!-- eh:one:start -->\nBroken');
  assert.throws(() => f.run(), /缺少结束标记/);
  assert.equal(readFileSync(f.targets[0], 'utf8'), 'Personal content');
  assert.ok(!existsSync(f.settings));
});

test('invalid remote and local manifests reject duplicate names, paths and non-boolean switches', (t) => {
  for (const value of [null, {}, { fragments: null }, { fragments: [fragment('../escape')] },
    { fragments: [fragment('one'), fragment('one')] }, { fragments: [fragment('one', 'true')] },
    { fragments: [{ ...fragment('one'), path: '/elsewhere' }] }]) {
    assert.throws(() => validateFragments(value));
  }
  const f = fixture(t);
  put(f.settings, '{"skills":[],"fragments":[{"name":"one","auto_sync":"true"}]}');
  assert.throws(() => f.run(), /必须是 true 或 false/);
  assert.deepEqual(f.reads, []);
});

test('malformed, nested and duplicate markers fail; remote bodies cannot introduce markers', () => {
  const fragments = [{ name: 'one', content: 'New content' }];
  for (const text of ['<!-- eh:one:start -->', '<!-- eh:one:end -->',
    '<!-- eh:one:start --> <!-- eh:two:end -->',
    `<!-- eh:one:start --> ${block('two', 'nested')} <!-- eh:one:end -->`,
    block('one', 'a') + block('one', 'b'), '<!-- eh:bad mark -->']) {
    assert.throws(() => renderFragments(text, fragments), /标记/);
  }
  assert.throws(() => renderFragments('', [{ name: 'one', content: block('two', 'nested') }]), /保留标记/);
});

test('replacement preserves surrounding CRLF, literal dollar signs and disabled blocks', () => {
  const original = `Intro\r\n${block('one', 'Old')}\r\n${block('frozen', 'Keep')}\r\nEnd`;
  const body = 'Price $5; literal $& and $1; equation $$x^2$$';
  assert.equal(renderFragments(original, [{ name: 'one', content: body }]),
    `Intro\r\n${block('one', body)}\r\n${block('frozen', 'Keep')}\r\nEnd`);
});

test('instruction paths honor Codex and Copilot overrides', () => {
  assert.deepEqual(instructionPaths(['codex', 'github-copilot'], {
    env: { CODEX_HOME: '/custom/codex', COPILOT_HOME: '/custom/copilot' }, homeDir: '/profile',
  }), [join('/custom/codex', 'AGENTS.md'), join('/custom/copilot', 'copilot-instructions.md')]);
});

test('existing instruction file symlink is preserved', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  const actual = join(f.root, 'actual.md');
  put(actual, 'Personal content\n');
  mkdirSync(dirname(f.targets[0]), { recursive: true });
  symlinkSync(actual, f.targets[0]);
  f.run();
  assert.ok(lstatSync(f.targets[0]).isSymbolicLink());
  assert.ok(readFileSync(actual, 'utf8').includes(block('one', f.content.one)));
});

test('fragment CLI modifier requires an explicit switch operation', () => {
  assert.equal(parseArgs(['--fragments', '--auto_sync', 'false', 'one', '--local']).fragments, true);
  for (const args of [['--fragments'], ['--fragments', '--add', 'a/b', 'one'],
    ['--fragments', '--auto_sync', 'maybe', 'one'], ['--fragments', '--auto_sync', 'true', '../escape']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('checked-in fragments are all enabled and can render together', () => {
  const manifest = validateManifest(JSON.parse(readFileSync(new URL('../harness.json', import.meta.url))));
  assert.deepEqual(manifest.fragments.map((entry) => entry.name), ['dev-directory', 'formula-display', 'simple-dev']);
  assert.ok(manifest.fragments.every((entry) => entry.auto_sync));
  const contents = manifest.fragments.map(({ name }) => ({ name,
    content: readFileSync(new URL(`../agents-md/${name}.md`, import.meta.url), 'utf8') }));
  const rendered = renderFragments('', contents);
  assert.equal(renderFragments(rendered, contents), rendered);
});

test('skills and fragments both sync before dryrun; installed content remains after a dryrun failure', (t) => {
  const f = fixture(t), calls = [];
  f.manifest.skills.push({ name: 'one', source: 'example/skills', auto_sync: true });
  f.dependencies.runSkills = (args) => {
    calls.push(args);
    if (args[0] === 'list') return '[]';
    return JSON.stringify([{ name: 'one', status: 'installed', scope: 'global',
      path: join(f.root, 'installed', 'one'), agents: ['Codex', 'GitHub Copilot'] }]);
  };
  f.dependencies.runDryruns = () => {
    assert.ok(f.targets.every((path) => readFileSync(path, 'utf8').includes('First rule')));
    throw new Error('fixture dryrun failure');
  };
  assert.throws(() => f.run(), /fixture dryrun failure/);
  assert.equal(calls[1][0], 'add');
  assert.deepEqual(JSON.parse(readFileSync(f.settings)), { skills: [], fragments: [] });
});

test('renamed fragment removes the old block before adding the new one, overriding local switches', (t) => {
  const f = fixture(t);
  f.manifest.fragments = [{ ...fragment('old', false), deleted: true }, fragment('one')];
  put(f.settings, JSON.stringify({ skills: [], fragments: [fragment('old', true)] }));
  const original = `Intro\n${block('old', 'Local edits')}\n${block('unmanaged', 'Keep')}\nEnd`;
  f.targets.forEach((path) => put(path, original));
  f.run(['--dryrun']);
  assert.ok(f.logs.some((line) => line.includes('片段已标记删除：old')));
  assert.equal(readFileSync(f.targets[0], 'utf8'), original);
  f.run();
  for (const path of f.targets) {
    const result = readFileSync(path, 'utf8');
    assert.ok(!result.includes('eh:old:'));
    assert.ok(result.startsWith(`Intro\n\n${block('unmanaged', 'Keep')}\nEnd`));
    assert.ok(result.includes(block('one', f.content.one)));
    f.run();
    assert.equal(readFileSync(path, 'utf8'), result);
  }
  assert.ok(!f.reads.includes('old'));
  assert.equal(f.manifest.fragments[0].deleted, true);
});

test('fragment deletion with no replacement never creates empty instruction files', (t) => {
  const f = fixture(t);
  f.manifest.fragments = [{ ...fragment('old', true), deleted: true }];
  f.run();
  assert.ok(f.targets.every((path) => !existsSync(path)));
  assert.deepEqual(f.reads, []);
  put(f.targets[0], block('old', 'Remove'));
  f.run();
  assert.equal(readFileSync(f.targets[0], 'utf8'), '');
});

test('local fragment deletion removes the block and saves only its switch alongside skill choices', (t) => {
  const f = fixture(t);
  const skill = { name: 'legacy', source: 'example/skills', auto_sync: false };
  put(f.settings, JSON.stringify({ agents: ['codex'], skills: [skill], fragments: [fragment('two', false)] }));
  f.targets.forEach((path) => put(path, `Intro\n${block('one', 'Remove')}\nEnd`));
  f.run(['--local', '--fragments', '--del', 'one']);
  assert.equal(readFileSync(f.targets[0], 'utf8'), 'Intro\n\nEnd');
  assert.ok(readFileSync(f.targets[1], 'utf8').includes('eh:one:'));
  assert.deepEqual(JSON.parse(readFileSync(f.settings)), {
    agents: ['codex'], skills: [skill], fragments: [fragment('one', false), fragment('two', false)],
  });
  assert.equal(f.manifest.fragments[0].deleted, undefined);
  assert.deepEqual(f.reads, []);
});

test('migration combines legacy local files once, preserving overrides and leaving originals as backup', (t) => {
  const f = fixture(t);
  const skill = { name: 'legacy', source: 'example/skills', auto_sync: false, agents: ['codex'] };
  const legacySkills = join(f.dependencies.stateDir, 'skills.json');
  const legacyFragments = join(f.dependencies.stateDir, 'agents-md.json');
  const oldSkillsText = JSON.stringify({ agents: ['codex'], skills: [skill] });
  const oldFragmentsText = JSON.stringify({ fragments: [fragment('one', false)] });
  put(legacySkills, oldSkillsText);
  put(legacyFragments, oldFragmentsText);
  f.run(['--list']);
  f.run(['--dryrun']);
  assert.ok(!existsSync(f.settings));
  f.run();
  assert.deepEqual(JSON.parse(readFileSync(f.settings)), {
    agents: ['codex'], skills: [{ name: 'legacy', source: 'example/skills', auto_sync: false }],
    fragments: [fragment('one', false)],
  });
  assert.equal(readFileSync(legacySkills, 'utf8'), oldSkillsText);
  assert.equal(readFileSync(legacyFragments, 'utf8'), oldFragmentsText);
  assert.ok(!readFileSync(f.targets[0], 'utf8').includes('eh:one:'));
  assert.ok(!existsSync(f.targets[1]));
  put(legacySkills, '{invalid old data');
  put(legacyFragments, '{invalid old data');
  f.run(['--local', '--fragments', '--auto_sync', 'true', 'one']);
  f.run();
  assert.ok(readFileSync(f.targets[0], 'utf8').includes('eh:one:'));
});

test('fragment records reject source, per-fragment agents and invalid deletion flags', () => {
  for (const extra of [{ source: 'example/repo' }, { agents: ['codex'] }, { deleted: 'true' }]) {
    assert.throws(() => validateManifest({ agents: ['codex'], skills: [], fragments: [{ ...fragment('one'), ...extra }] }));
  }
  assert.throws(() => validateManifest({ skills: [], fragments: [{ ...fragment('one'), deleted: false }] }, { local: true }));
});

test('checked-in old skills are tombstones with removed source and active replacement fragments', () => {
  const manifest = validateManifest(JSON.parse(readFileSync(new URL('../harness.json', import.meta.url))));
  for (const name of ['dev-directory', 'formula-display']) {
    assert.equal(manifest.skills.find((item) => item.name === name).deleted, true);
    assert.equal(manifest.fragments.find((item) => item.name === name).auto_sync, true);
    assert.ok(!existsSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url)));
  }
});
