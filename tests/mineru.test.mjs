import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { environmentIssues, extractZip, getApiKey, hasCachedParse, main } from '../skills/pdf-analyze/scripts/mineru_parse.mjs';

const skillDir = fileURLToPath(new URL('../skills/pdf-analyze/', import.meta.url));
const script = join(skillDir, 'scripts', 'mineru_parse.mjs');
function temporary(t) {
  const folder = mkdtempSync(join(tmpdir(), 'mineru-test-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}

function zip(files) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const path = Buffer.from(name), content = Buffer.from(text), data = deflateRawSync(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(content), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(path.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc32(content), 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(content.length, 24);
    entry.writeUInt16LE(path.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(local, path, data); central.push(entry, path); offset += local.length + path.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('dryrun aggregates missing requirements and never exposes a key', (t) => {
  const errors = environmentIssues({ env: {}, version: '20.0.0', probe: () => ({ status: 1 }) });
  assert.equal(errors.length, 3);
  assert.ok(errors.includes('环境变量缺少MINERU_API_KEY'));
  assert.equal(getApiKey({ MINERU_API_KEY: ' fixture ' }), 'fixture');
  const folder = temporary(t);
  const env = { ...process.env }; delete env.MINERU_API_KEY;
  const missing = spawnSync(process.execPath, [join(skillDir, 'dryrun.mjs')], { env, cwd: folder, encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr.trim(), '[pdf-analyze] 失败：环境变量缺少MINERU_API_KEY');
  assert.equal(missing.stdout, '');
  env.MINERU_API_KEY = 'secret-fixture-value';
  const good = spawnSync(process.execPath, [join(skillDir, 'dryrun.mjs')], { env, cwd: folder, encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.stdout.trim(), '[pdf-analyze] 通过');
  assert.equal(good.stderr, '');
  assert.equal((good.stdout + good.stderr).includes(env.MINERU_API_KEY), false);
  assert.deepEqual(readdirSync(folder), []);
});

test('cache reuse needs no key; missing/blank keys fail before output creation; metadata is not a cache', (t) => {
  const folder = temporary(t), pdf = join(folder, 'sample paper 中文.pdf');
  writeFileSync(pdf, '%PDF-1.4\n');
  const env = { ...process.env }; delete env.MINERU_API_KEY;
  for (const value of [undefined, '', '   ']) {
    if (value !== undefined) env.MINERU_API_KEY = value;
    const result = spawnSync(process.execPath, [script, pdf], { env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), '环境变量缺少MINERU_API_KEY');
    assert.equal(existsSync(join(folder, '.mineru')), false);
  }
  const cache = join(folder, '.mineru', 'sample paper 中文'); mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, 'upload-task.json'), '{}');
  assert.equal(hasCachedParse(cache), false);
  writeFileSync(join(cache, 'full.md'), 'cached');
  const cached = spawnSync(process.execPath, [script, pdf], { env, encoding: 'utf8' });
  assert.equal(cached.status, 0);
  assert.match(cached.stdout, /Using cached/);
  assert.equal(spawnSync(process.execPath, [script, pdf, '--force'], { env }).status, 1);
});

test('PDF workflow preserves request options, upload semantics, metadata and extracted output', async (t) => {
  const folder = temporary(t), pdf = join(folder, 'sample.pdf'); writeFileSync(pdf, '%PDF-1.4\n');
  const originalKey = process.env.MINERU_API_KEY; process.env.MINERU_API_KEY = 'fixture';
  t.after(() => { if (originalKey === undefined) delete process.env.MINERU_API_KEY; else process.env.MINERU_API_KEY = originalKey; });
  const requests = [], transfers = [];
  await main([pdf, '--language', 'ch', '--no-ocr', '--disable-table'], {
    request(method, url, key, payload) {
      requests.push({ method, url, key, payload });
      return method === 'POST' ? { data: { batch_id: 'test-batch', file_urls: ['https://upload.test/pdf'] } }
        : { data: { extract_result: [{ state: 'done', full_zip_url: 'https://download.test/result.zip' }] } };
    },
    transfer(args) {
      transfers.push(args);
      if (args.includes('--output')) writeFileSync(args[args.indexOf('--output') + 1], zip([['full.md', '# parsed'], ['images/a.txt', 'asset']]));
    },
  });
  assert.deepEqual(requests[0].payload, { files: [{ name: 'sample.pdf', is_ocr: false }], enable_formula: true, enable_table: false, model_version: 'vlm', language: 'ch' });
  assert.deepEqual(transfers[0], ['--upload-file', pdf, '--header', 'Content-Type:', '--url', 'https://upload.test/pdf']);
  assert.equal(readFileSync(join(folder, '.mineru/sample/full.md'), 'utf8'), '# parsed');
  assert.equal(JSON.parse(readFileSync(join(folder, '.mineru/sample/mineru-metadata.json'))).batch_id, 'test-batch');
});

test('ZIP rejects traversal, malformed data and corruption before writing any output', (t) => {
  const folder = temporary(t), archive = join(folder, 'result.zip');
  for (const name of ['../escape.md', '/absolute', 'a\\b', 'C:/escape', 'CON', 'trailing./x']) {
    writeFileSync(archive, zip([['safe.md', 'first'], [name, 'bad']]));
    assert.throws(() => extractZip(archive, join(folder, 'output')), /ZIP/);
    assert.equal(existsSync(join(folder, 'output')), false);
  }
  writeFileSync(archive, Buffer.from('not zip'));
  assert.throws(() => extractZip(archive, join(folder, 'output')), /ZIP/);
  const broken = zip([['full.md', 'text'], ['broken.md', 'bad']]);
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const central = broken.indexOf(signature, broken.indexOf(signature) + 1); broken[central + 16] ^= 1;
  writeFileSync(archive, broken);
  assert.throws(() => extractZip(archive, join(folder, 'output')), /校验/);
  assert.equal(existsSync(join(folder, 'output')), false);
});
