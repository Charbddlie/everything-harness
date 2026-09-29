import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const DIRECTORIES = ['.agents', '.codex', '.copilot'];
const INSTRUCTIONS = ['AGENTS.md', 'CLAUDE.md', 'copilot-instructions.md'];

async function loadRuntime() {
  if (!import.meta.main || process.argv[1] !== '-') return import('./sync.mjs');
  const source = execFileSync(process.platform === 'win32' ? 'curl.exe' : 'curl',
    ['-fsSL', '--connect-timeout', '20', '--max-time', '120',
      'https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs'],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

export async function clean(args, dependencies = {}) {
  let home, dryrun = false, help = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dryrun' && !dryrun) dryrun = true;
    else if (args[i] === '--help' || args[i] === '-h') help = true;
    else if (args[i] === '--home' && home === undefined) {
      home = args[++i];
      if (!home?.trim() || home.startsWith('-') || home.includes('\0')) throw new Error('--home 需要有效目录。');
    } else throw new Error(`未知或重复参数：${args[i]}`);
  }
  const log = dependencies.log ?? console.log;
  if (help) {
    log('用法：node clean.mjs [--home <目录>] [--dryrun]\n始终清理用户主目录；--home 额外清理指定目录。\n删除清单中活动及已删除的同名 skill，移除指令文件中的 eh 标记块；保留其他内容和本机配置。');
    return;
  }
  const userHome = resolve(dependencies.homeDir ?? homedir()), roots = [userHome];
  if (home !== undefined) {
    const expanded = home === '~' ? userHome : /^~[/\\]/.test(home) ? join(userHome, home.slice(2)) : home;
    const path = resolve(dependencies.cwd ?? process.cwd(), expanded);
    if (relative(userHome, path) !== '') roots.push(path);
  }
  for (const root of roots) {
    if (existsSync(root) && !statSync(root).isDirectory()) throw new Error(`清理根目录不是目录：${root}`);
  }
  const { fetchManifest, validateManifest, renderFragments, removeDirectory, writeAtomic } = await loadRuntime();
  const manifest = validateManifest(JSON.parse((dependencies.fetchManifest ?? fetchManifest)()));
  const names = new Set([...manifest.skill.map(({ name }) => name),
    ...(manifest.deleted ?? []).filter(({ type_name }) => type_name.startsWith('skill:')).map(({ type_name }) => type_name.slice(6))]);
  const paths = [], writes = new Map();
  for (const root of roots) {
    for (const directory of DIRECTORIES) for (const name of names) {
      const path = join(root, directory, 'skills', name);
      if (lstatSync(path, { throwIfNoEntry: false })) paths.push(path);
    }
    for (const directory of [root, ...DIRECTORIES.map((name) => join(root, name))]) for (const name of INSTRUCTIONS) {
      const target = join(directory, name);
      if (!existsSync(target)) continue;
      const path = realpathSync(target);
      if (writes.has(path)) continue;
      const original = readFileSync(path, 'utf8');
      const blocks = [...original.matchAll(/<!-- eh:([a-z0-9-]+):start -->/g)].map((match) => ({ name: match[1], deleted: true }));
      const content = renderFragments(original, blocks);
      if (content !== original) writes.set(path, content);
    }
  }
  const failures = [];
  for (const path of paths) {
    log(`${dryrun ? '将删除' : '删除'} skill：${path}`);
    if (!dryrun) {
      try { removeDirectory(path); }
      catch (error) { failures.push(error.message); log(error.message); }
    }
  }
  for (const [path, content] of writes) {
    log(`${dryrun ? '将移除' : '移除'} eh 标记块：${path}`);
    if (!dryrun) {
      try { writeAtomic(path, content, log); }
      catch (error) { const message = `${path} 写入失败：${error.message}`; failures.push(message); log(message); }
    }
  }
  if (failures.length) throw new Error(`清理失败；已完成操作保留：\n${failures.join('\n')}`);
  log(`${dryrun ? '预览' : '清理'}完成：${paths.length} 个 skill 路径，${writes.size} 个指令文件。`);
}

if (import.meta.main) {
  try { await clean(process.argv.slice(2)); }
  catch (error) { console.error(`操作失败：${error.message}`); process.exitCode = 1; }
}
