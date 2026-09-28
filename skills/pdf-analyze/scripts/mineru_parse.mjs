#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { crc32, inflateRawSync } from 'node:zlib';

const API_BASE = 'https://mineru.net/api/v4';
const CURL = process.platform === 'win32' ? 'curl.exe' : 'curl';
const FAILED = new Set(['failed', 'error', 'canceled', 'cancelled', 'timeout']);

export function getApiKey(env = process.env) {
  const key = env.MINERU_API_KEY?.trim();
  if (!key) throw new Error('环境变量缺少MINERU_API_KEY');
  return key;
}

export function environmentIssues({ env = process.env, version = process.versions.node, probe = spawnSync } = {}) {
  const errors = [];
  const [major, minor] = version.split('.').map(Number);
  if (!(major > 22 || (major === 22 && minor >= 20))) errors.push('需要 Node.js ≥22.20.0');
  try { getApiKey(env); } catch (error) { errors.push(error.message); }
  const curl = probe(CURL, ['--version'], { env, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (curl.error || curl.status !== 0) errors.push('找不到可用的 curl，请安装并加入 PATH');
  return errors;
}

function curl(args, { input, timeout = 60, secret = '' } = {}) {
  const result = spawnSync(CURL, ['-q', '-fsS', '--connect-timeout', '20', '--max-time', String(timeout), ...args], {
    input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: (timeout + 5) * 1000,
  });
  if (result.error || result.status !== 0) {
    let detail = result.error?.message ?? result.stderr.trim();
    if (secret) detail = detail.replaceAll(secret, '[redacted]');
    throw new Error(`curl 请求失败：${detail || `退出码 ${result.status}`}`);
  }
  return result.stdout;
}

export function requestJson(method, url, key, payload) {
  // Credentials go through stdin, never argv or a temporary file.
  const config = [`header = ${JSON.stringify(`Authorization: Bearer ${key}`)}`, 'header = "Accept: application/json"'];
  if (payload !== undefined) config.push('header = "Content-Type: application/json"', `data = ${JSON.stringify(JSON.stringify(payload))}`);
  const body = curl(['--request', method, '--config', '-', '--url', url], { input: config.join('\n'), secret: key });
  let result;
  try { result = JSON.parse(body); } catch { throw new Error('MinerU 返回了无效 JSON'); }
  if (result.code !== undefined && result.code !== 0 && result.code !== '0') {
    throw new Error(`MinerU 请求失败：${String(result.msg ?? result.message ?? result.code).replaceAll(key, '[redacted]')}`);
  }
  return result;
}

function findFirst(data, names) {
  if (!data || typeof data !== 'object') return undefined;
  for (const [key, value] of Object.entries(data)) if (names.includes(key)) return value;
  for (const value of Object.values(data)) {
    const found = findFirst(value, names);
    if (found !== undefined) return found;
  }
}

const httpUrl = (value) => typeof value === 'string' && /^https?:\/\//.test(value);

export function resultZipUrl(result) {
  const value = findFirst(result?.data?.extract_result?.[0] ?? result?.data ?? result, ['full_zip_url', 'zip_url', 'result_zip_url']);
  return httpUrl(value) ? value : undefined;
}

export async function pollResult(key, batchId, { timeout = 900, interval = 10, request = requestJson, wait = sleep, now = Date.now } = {}) {
  const deadline = now() + timeout * 1000;
  while (now() < deadline) {
    const result = request('GET', `${API_BASE}/extract-results/batch/${encodeURIComponent(batchId)}`, key);
    const entry = result?.data?.extract_result?.[0] ?? result?.data ?? result;
    const status = String(findFirst(entry, ['state', 'status']) ?? '').toLowerCase();
    if (FAILED.has(status)) throw new Error(`MinerU 解析失败：${String(entry.err_msg ?? entry.message ?? status).replaceAll(key, '[redacted]')}`);
    if (resultZipUrl(result)) return result;
    console.error(`等待 MinerU 解析结果：${batchId}...`);
    await wait(Math.max(0, Math.min(interval * 1000, deadline - now())));
  }
  throw new Error(`等待 MinerU 解析超时：${batchId}`);
}

export function hasCachedParse(folder) {
  if (!existsSync(folder)) return false;
  const metadata = new Set(['upload-task.json', 'extract-results.json', 'mineru-metadata.json']);
  return readdirSync(folder, { withFileTypes: true }).some((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return hasCachedParse(path);
    return entry.isFile() && /\.(md|txt|json)$/i.test(entry.name) && !metadata.has(entry.name) && statSync(path).size > 0;
  });
}

// Ordinary ZIP files: validate the full directory before writing. ZIP64 and
// unusual compression methods fail explicitly instead of silently truncating.
export function extractZip(zipPath, outputDir) {
  if (statSync(zipPath).size > 512 * 1024 * 1024) throw new Error('ZIP 文件超过 512 MiB，无法解压');
  const archive = readFileSync(zipPath);
  const invalid = (message) => { throw new Error(`无效或不安全的 ZIP：${message}`); };
  let end = archive.length - 22;
  const lower = Math.max(0, end - 65535);
  while (end >= lower && (archive.readUInt32LE(end) !== 0x06054b50 || end + 22 + archive.readUInt16LE(end + 20) !== archive.length)) end--;
  if (end < lower) invalid('缺少目录');
  const count = archive.readUInt16LE(end + 10);
  const centralStart = archive.readUInt32LE(end + 16);
  if (archive.readUInt16LE(end + 4) || archive.readUInt16LE(end + 6) || archive.readUInt16LE(end + 8) !== count
    || count === 65535 || centralStart + archive.readUInt32LE(end + 12) !== end) invalid('不支持多卷或 ZIP64 格式');
  let cursor = centralStart;
  let totalSize = 0;
  const entries = [];
  const paths = new Set();
  const root = resolve(outputDir);
  const assertNoLink = (path) => {
    for (let part = path; ; part = dirname(part)) {
      try { if (lstatSync(part).isSymbolicLink()) invalid(`目标路径包含链接：${part}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (dirname(part) === part) break;
    }
  };
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50) invalid('目录损坏');
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const checksum = archive.readUInt32LE(cursor + 16);
    const compressed = archive.readUInt32LE(cursor + 20);
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const next = cursor + 46 + nameLength + archive.readUInt16LE(cursor + 30) + archive.readUInt16LE(cursor + 32);
    if (next > end) invalid('文件名超出目录');
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const mode = archive.readUInt32LE(cursor + 38) >>> 16;
    const offset = archive.readUInt32LE(cursor + 42);
    const pieces = name.replace(/\/$/, '').split('/');
    if (!name || name.includes('\\') || name.includes(':') || /[\x00-\x1f]/.test(name)
      || pieces.some((piece) => !piece || piece === '.' || piece === '..' || /[. ]$/.test(piece)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(piece))) invalid(`路径 ${name}`);
    const path = resolve(root, ...pieces);
    const pathKey = process.platform === 'win32' ? path.toLowerCase() : path;
    if (!path.startsWith(root + sep) || paths.has(pathKey)) invalid(`重复或越界路径 ${name}`);
    paths.add(pathKey);
    assertNoLink(path);
    if ((mode & 0xf000) === 0xa000 || (flags & 1) || ![0, 8].includes(method)) invalid(`不支持的文件类型 ${name}`);
    totalSize += size;
    if (size > 256 * 1024 * 1024 || totalSize > 1024 * 1024 * 1024) invalid('解压内容过大');
    if (offset + 30 > centralStart || archive.readUInt32LE(offset) !== 0x04034b50) invalid('文件头损坏');
    const localNameLength = archive.readUInt16LE(offset + 26);
    const start = offset + 30 + localNameLength + archive.readUInt16LE(offset + 28);
    if (start + compressed > centralStart || archive.readUInt16LE(offset + 8) !== method
      || !archive.subarray(offset + 30, offset + 30 + localNameLength).equals(archive.subarray(cursor + 46, cursor + 46 + nameLength))) invalid('文件头不一致');
    entries.push({ path, directory: name.endsWith('/'), start, compressed, size, checksum, method });
    cursor = next;
  }
  if (cursor !== end) invalid('目录长度不匹配');
  for (const entry of entries) {
    const compressed = archive.subarray(entry.start, entry.start + entry.compressed);
    const content = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size) });
    if (content.length !== entry.size || crc32(content) !== entry.checksum) invalid('文件校验失败');
    entry.content = content;
  }
  for (const entry of entries) {
    mkdirSync(entry.directory ? entry.path : dirname(entry.path), { recursive: true });
    if (!entry.directory) writeFileSync(entry.path, entry.content);
  }
}

export function parseOptions(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, force: { type: 'boolean' },
    'output-root': { type: 'string' }, language: { type: 'string' },
    'no-ocr': { type: 'boolean' }, 'disable-formula': { type: 'boolean' }, 'disable-table': { type: 'boolean' },
    'model-version': { type: 'string', default: 'vlm' },
    timeout: { type: 'string', default: '900' }, 'poll-interval': { type: 'string', default: '10' },
  } });
  if (!values.help && positionals.length !== 1) throw new Error('用法：node mineru_parse.mjs <file.pdf> [--force] [--output-root <dir>]');
  for (const name of ['timeout', 'poll-interval']) {
    if (!/^\d+$/.test(values[name]) || Number(values[name]) <= 0) throw new Error(`${name} 必须是正整数秒数`);
  }
  return { ...values, pdf: positionals[0] };
}

const expandPath = (path) => resolve(/^~[\\/]/.test(path) ? join(homedir(), path.slice(2)) : path);

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const options = parseOptions(args);
  if (options.help) {
    console.log('用法：node mineru_parse.mjs <file.pdf> [--force] [--output-root <dir>] [--language ch] [--no-ocr] [--disable-formula] [--disable-table] [--model-version vlm] [--timeout 900] [--poll-interval 10]');
    return;
  }
  const pdf = expandPath(options.pdf);
  if (!existsSync(pdf) || !statSync(pdf).isFile() || extname(pdf).toLowerCase() !== '.pdf') throw new Error(`PDF 文件不存在或扩展名错误：${pdf}`);
  const stem = basename(pdf, extname(pdf));
  if (['.', '..'].includes(stem)) throw new Error('PDF 文件名不能使用 . 或 .. 作为主名');
  const output = join(options['output-root'] ? expandPath(options['output-root']) : join(dirname(pdf), '.mineru'), stem);
  if (!options.force && hasCachedParse(output)) { console.log(`Using cached MinerU output: ${output}`); return; }
  const key = getApiKey();
  const request = dependencies.request ?? requestJson;
  const transfer = dependencies.transfer ?? curl;
  const payload = {
    files: [{ name: basename(pdf), is_ocr: !options['no-ocr'] }],
    enable_formula: !options['disable-formula'], enable_table: !options['disable-table'],
    model_version: options['model-version'], ...(options.language && { language: options.language }),
  };
  const task = request('POST', `${API_BASE}/file-urls/batch`, key, payload);
  const batchId = findFirst(task, ['batch_id', 'batchId']);
  const uploadUrl = task?.data?.file_urls?.[0];
  if (!batchId || !httpUrl(uploadUrl)) throw new Error('MinerU 响应缺少 batch_id 或上传 URL');
  mkdirSync(output, { recursive: true });
  const writeJson = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
  writeJson('upload-task.json', task);
  writeJson('mineru-metadata.json', { pdf, batch_id: batchId, created_at: new Date().toISOString() });
  transfer(['--upload-file', pdf, '--header', 'Content-Type:', '--url', uploadUrl], { timeout: 300 });
  const result = await pollResult(key, batchId, { timeout: Number(options.timeout), interval: Number(options['poll-interval']), request });
  writeJson('extract-results.json', result);
  const archive = join(output, 'mineru-result.zip');
  transfer(['--location', '--output', archive, '--url', resultZipUrl(result)], { timeout: 300 });
  extractZip(archive, output);
  console.log(`MinerU output: ${output}`);
}

if (import.meta.main) {
  try { await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
