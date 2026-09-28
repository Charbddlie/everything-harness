import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';

export const OWN_SOURCE = 'Charbddlie/everything-harness';
export const MANIFEST_URL = `https://raw.githubusercontent.com/${OWN_SOURCE}/main/skills.json`;
export const AGENTS = new Map([['claude-code', 'Claude Code'], ['codex', 'Codex'], ['github-copilot', 'GitHub Copilot']]);
const SHARED_AGENTS = ['codex', 'github-copilot'];
const USAGE = `node sync.mjs [--update | --dryrun | --list] [--agents <agent> ...]
node sync.mjs --add <owner/repo> <skill> ... [--agents <agent> ...]
node sync.mjs --del <skill> ... [--agents <agent> ...]`;

function check(condition, message) { if (!condition) throw new Error(message); }

function agentList(value) {
  check(Array.isArray(value) && value.length && value.every((agent) => AGENTS.has(agent)), `agents 仅支持非空列表：${[...AGENTS.keys()].join(', ')}`);
  check(new Set(value).size === value.length, '重复 agent');
  return value;
}

function skillName(name) {
  check(typeof name === 'string' && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name), `无效 skill 名：${name}`);
}

function sourceName(source) {
  check(typeof source === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/i.test(source)
    && !['.', '..'].includes(source.split('/')[1]) && !source.toLowerCase().endsWith('.git'), `无效来源：${source}；请使用 GitHub owner/repo。`);
}

export function parseArgs(args) {
  const options = { mode: 'sync', agents: undefined, names: [], help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--agents' && options.agents === undefined) {
      const agents = [];
      while (i + 1 < args.length && !args[i + 1].startsWith('-')) agents.push(args[++i]);
      options.agents = agentList(agents);
    } else if (['--add', '--del', '--list', '--update', '--dryrun'].includes(arg) && options.mode === 'sync') {
      options.mode = arg.slice(2);
      if (arg === '--add' || arg === '--del') {
        const values = [];
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) values.push(args[++i]);
        if (arg === '--add') { options.source = values.shift(); sourceName(options.source); }
        check(values.length > 0, `${arg} 需要明确的 skill 名称。`);
        values.forEach(skillName);
        check(new Set(values).size === values.length, '重复 skill 名');
        options.names = values;
      }
    } else throw new Error(`未知、重复或互斥参数：${arg}\n用法：${USAGE}`);
  }
  return options;
}

function objectKeys(value, keys, label) {
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key)), `${label} 格式错误或包含未知字段。`);
}

export function validateManifest(value) {
  objectKeys(value, ['skills'], '清单');
  check(Array.isArray(value.skills), 'skills 必须是数组。');
  const names = new Set();
  for (const entry of value.skills) {
    objectKeys(entry, ['source', 'name', 'agents'], 'skill');
    sourceName(entry.source); skillName(entry.name); agentList(entry.agents);
    check(!names.has(entry.name), `重复 skill 名：${entry.name}`);
    names.add(entry.name);
  }
  return value;
}

function parseJson(text, label) {
  try { return JSON.parse(text); } catch { throw new Error(`${label} 未返回有效 JSON。`); }
}

function installedSkills(text) {
  const entries = parseJson(text, 'skills list');
  check(Array.isArray(entries), 'skills list 应返回数组。');
  const result = new Map();
  for (const entry of entries) {
    check(entry && typeof entry.name === 'string' && entry.scope === 'global' && typeof entry.path === 'string'
      && Array.isArray(entry.agents) && entry.agents.every((agent) => typeof agent === 'string')
      && (entry.source === null || typeof entry.source === 'string')
      && (entry.sourceType === null || typeof entry.sourceType === 'string'), 'skills list 返回了无法识别的记录。');
    check(!result.has(entry.name), `skills list 返回重复记录：${entry.name}`);
    result.set(entry.name, entry);
  }
  return result;
}

function selectSkills(manifest, agents) {
  return manifest.skills.map((entry) => ({ ...entry, agents: entry.agents.filter((agent) => !agents || agents.includes(agent)) }))
    .filter((entry) => entry.agents.length);
}

function sameSource(entry, source) {
  return entry.sourceType === 'github' && entry.source?.toLowerCase() === source.toLowerCase();
}

function checkSources(entries, installed) {
  for (const entry of entries) {
    const current = installed.get(entry.name);
    if (current && !(current.source === null && current.sourceType === null)) {
      check(sameSource(current, entry.source), `来源冲突：${entry.name} 已记录为 ${current.source} (${current.sourceType})，清单要求 ${entry.source}。`);
    }
  }
}

function hasAgent(entry, agent, sharedSkillsDir) {
  // The CLI can omit undetected Codex/Copilot apps from list's display names.
  return entry && (entry.agents.includes(AGENTS.get(agent))
    || (SHARED_AGENTS.includes(agent) && relative(sharedSkillsDir, dirname(entry.path)) === ''));
}

function installationJobs(entries, installed, update, sharedSkillsDir) {
  checkSources(entries, installed);
  const jobs = new Map();
  for (const entry of entries) {
    const current = installed.get(entry.name);
    const agents = update || !current?.source ? entry.agents : entry.agents.filter((agent) => !hasAgent(current, agent, sharedSkillsDir));
    if (!agents.length) continue;
    const key = `${entry.source.toLowerCase()}:${agents.join(',')}`;
    if (!jobs.has(key)) jobs.set(key, { source: entry.source, names: [], agents });
    jobs.get(key).names.push(entry.name);
  }
  return [...jobs.values()];
}

export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    ...options, shell: false,
  });
  if (result.error) throw new Error(`无法执行 ${command}：${result.error.message}`);
  check(result.status === 0, `${command} 执行失败（${result.signal ?? `退出码 ${result.status}`}）${result.stderr ? `：${result.stderr.trim()}` : ''}`);
  return result.stdout ?? '';
}

export function npxCommand(platform = process.platform, env = process.env, executable = process.execPath) {
  if (platform !== 'win32') return { command: 'npx', prefix: [] };
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  for (const directory of [...pathValue.split(delimiter), dirname(executable)].filter(Boolean)) {
    for (const file of [join(directory, 'node_modules', 'npm', 'bin', 'npx-cli.js'), join(directory, 'npx')]) {
      if (!existsSync(file)) continue;
      const resolved = realpathSync(file);
      if (resolved.endsWith('npx-cli.js')) return { command: executable, prefix: [resolved] };
    }
  }
  throw new Error('找不到 npm 的 npx-cli.js；请安装 Node.js ≥22.20.0（含 npm/npx）并加入 PATH。');
}

export function createSkillsRunner({ env = process.env, cwd = process.cwd() } = {}) {
  const { command, prefix } = npxCommand(process.platform, env);
  return (args) => runCommand(command, [...prefix, '--yes', 'skills', ...args], { env, cwd });
}

function fetchManifest() {
  return runCommand(process.platform === 'win32' ? 'curl.exe' : 'curl', ['-fsSL', '--connect-timeout', '20', '--max-time', '120', MANIFEST_URL]);
}

export function runDryruns(entries, installed, { log = console.log, env = process.env } = {}) {
  const errors = [];
  for (const entry of entries) {
    try {
      const path = installed.get(entry.name)?.path;
      const script = path && join(path, 'dryrun.mjs');
      if (!script || !existsSync(script)) {
        if (!path || (entry.source.toLowerCase() === OWN_SOURCE.toLowerCase() && containsScripts(path))) {
          errors.push(`${entry.name}：${path ? '包含脚本但缺少 dryrun.mjs，请更新此 skill' : '尚未安装，无法检查环境'}`);
        } else log(`[dryrun] ${entry.name}：无检查脚本，跳过。`);
        continue;
      }
      log(`[dryrun] ${entry.name}`);
      const result = spawnSync(process.execPath, [script], { cwd: path, env, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
      if (result.stdout?.trim()) log(result.stdout.trim());
      if (result.stderr?.trim()) log(result.stderr.trim());
      if (result.error || result.status !== 0) errors.push(`${entry.name}：${result.error?.message ?? `dryrun 退出码 ${result.status}`}`);
    } catch (error) { errors.push(`${entry.name}：${error.message}`); }
  }
  for (const error of errors) log(`[dryrun] 失败：${error}`);
  check(!errors.length, `${errors.length} 个 skill 环境检查失败；已安装内容保留，修复后运行 --dryrun。`);
}

export function containsScripts(path) {
  return readdirSync(path, { withFileTypes: true }).some((entry) => {
    if (entry.name === 'dryrun.mjs' || entry.name.startsWith('.')) return false;
    if (entry.isDirectory()) return containsScripts(join(path, entry.name));
    return entry.isFile() && /\.(mjs|cjs|js|py|sh|ps1|cmd|bat)$/i.test(entry.name);
  });
}

function install(entries, { runSkills, installed, update = false, sharedSkillsDir, log }) {
  const jobs = installationJobs(entries, installed, update, sharedSkillsDir);
  for (const job of jobs) {
    const label = `${job.source} / ${job.names.join(', ')} → ${job.agents.join(', ')}`;
    log(`${update ? '更新' : '安装'}：${label}`);
    try {
      const results = parseJson(runSkills(['add', job.source, '--skill', ...job.names, '--agent', ...job.agents, '-g', '--yes', '--json']), 'skills add');
      check(Array.isArray(results), 'skills add 应返回数组。');
      for (const name of job.names) {
        const result = results.find((item) => item?.name === name);
        check(result?.status === 'installed' && result.scope === 'global' && typeof result.path === 'string'
          && Array.isArray(result.agents) && job.agents.every((agent) => result.agents.includes(AGENTS.get(agent))),
        `${name} 未完成安装：${result?.error ?? result?.status ?? '缺少安装结果'}`);
        installed.set(name, { ...result, source: job.source, sourceType: 'github' });
      }
    } catch (error) { throw new Error(`${label} 失败：${error.message}`); }
  }
  return jobs.length;
}

export function changeManifest(manifest, options) {
  const next = structuredClone(manifest);
  const affected = [];
  for (const name of options.names) {
    let entry = next.skills.find((skill) => skill.name === name);
    if (options.mode === 'add') {
      check(!entry || entry.source.toLowerCase() === options.source.toLowerCase(), `来源冲突：${name}`);
      if (!entry) { entry = { name, source: options.source, agents: [] }; next.skills.push(entry); }
      const agents = options.agents ?? [...AGENTS.keys()];
      affected.push({ ...entry, agents });
      entry.agents = [...AGENTS.keys()].filter((agent) => agents.includes(agent) || entry.agents.includes(agent));
    } else {
      check(entry, `清单中不存在 skill：${name}`);
      const agents = entry.agents.filter((agent) => !options.agents || options.agents.includes(agent));
      const remaining = entry.agents.filter((agent) => !agents.includes(agent));
      check(!(agents.some((agent) => SHARED_AGENTS.includes(agent)) && remaining.some((agent) => SHARED_AGENTS.includes(agent))),
        `${name} 的 Codex / Copilot 共用安装目录，无法单独卸载；请同时选择 --agents codex github-copilot。`);
      if (agents.length) affected.push({ ...entry, agents });
      entry.agents = remaining;
    }
  }
  next.skills = next.skills.filter((entry) => entry.agents.length).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return { next: validateManifest(next), affected };
}

function manageManifest(options, dependencies, log) {
  const root = mkdtempSync(join(dependencies.tempDir ?? tmpdir(), 'skill-manage-'));
  const baseEnv = dependencies.env ?? process.env;
  const env = { ...baseEnv, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND: baseEnv.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' };
  const git = (args) => (dependencies.runGit ?? runCommand)('git', args, { cwd: root, env, timeout: 120_000 });
  let keep = false;
  try {
    log('正在准备远程清单…');
    // A fresh checkout isolates publication from any user working tree.
    git(['init', '--quiet', '-b', 'main']);
    const sources = dependencies.repositoryUrl ? [dependencies.repositoryUrl]
      : [`https://github.com/${OWN_SOURCE}.git`, `git@github.com:${OWN_SOURCE}.git`];
    const errors = [];
    let fetched = false;
    for (const source of sources) {
      try {
        git(['fetch', '--quiet', '--depth=1', source, 'refs/heads/main']);
        git(['remote', 'add', 'origin', source]);
        fetched = true;
        break;
      } catch (error) { errors.push(error.message); }
    }
    check(fetched, `无法读取远程仓库，请检查网络和 GitHub 认证后重试。\n${errors.join('\n')}`);
    git(['checkout', '--quiet', '-B', 'main', 'FETCH_HEAD']);
    // Fail before changing local skills when a commit cannot identify its author.
    git(['var', 'GIT_AUTHOR_IDENT']);
    git(['var', 'GIT_COMMITTER_IDENT']);
    const before = readFileSync(join(root, 'skills.json'), 'utf8');
    applyManifestChange(options, dependencies, log, root, git, before, sources, () => { keep = true; });
    keep = false;
  } catch (error) {
    throw new Error(`${error.message}${keep ? `\n操作副本已保留：${root}` : ''}\n修复问题后重新运行同一条命令，脚本会自动重新读取清单并处理 Git。`);
  } finally {
    if (!keep) rmSync(root, { recursive: true, force: true });
  }
}

function applyManifestChange(options, dependencies, log, root, git, before, sources, onWrite) {
  const manifest = validateManifest(parseJson(before, '远程清单'));
  const { next, affected } = changeManifest(manifest, options);
  if (!affected.length) { log('清单中没有匹配的 agent，无需操作。'); return; }
  const context = makeContext(dependencies, log);
  checkSources(affected, context.installed);
  if (options.mode === 'add') {
    install(affected, context);
    (dependencies.runDryruns ?? runDryruns)(affected, context.installed, { log, env: dependencies.env });
  } else {
    for (const entry of affected) {
      if (!entry.agents.some((agent) => hasAgent(context.installed.get(entry.name), agent, context.sharedSkillsDir))) {
        log(`${entry.name} 的目标安装已不存在，继续更新清单。`);
        continue;
      }
      const agents = entry.agents.some((agent) => SHARED_AGENTS.includes(agent))
        ? [...new Set([...entry.agents, ...SHARED_AGENTS])] : entry.agents;
      log(`删除本机安装：${entry.name} → ${agents.join(', ')}`);
      const output = context.runSkills(['remove', entry.name, '-g', '--yes', '--agent', ...agents]);
      if (output.trim()) log(output.trim());
    }
    const remaining = installedSkills(context.runSkills(['list', '-g', '--json']));
    for (const entry of affected) {
      check(!entry.agents.some((agent) => hasAgent(remaining.get(entry.name), agent, context.sharedSkillsDir)),
        `${entry.name} 的目标安装仍存在（可能由其他 agent 共享），未修改清单或创建 commit。`);
    }
  }
  const text = JSON.stringify(next, null, 2) + '\n';
  if (text === before) { log('本机操作完成，清单无变化，无需 commit / push。'); return; }
  onWrite();
  writeFileSync(join(root, 'skills.json'), text);
  try {
    git(['commit', '--only', '-m', `${options.mode === 'add' ? 'Add' : 'Remove'} skills: ${options.names.join(', ')}`, '--', 'skills.json']);
  } catch (error) { throw new Error(`本机操作完成，Git commit 失败；清单改动已保留：${error.message}`); }
  const errors = [];
  let pushed = false;
  for (const source of sources) {
    try { git(['push', source, 'HEAD:refs/heads/main']); pushed = true; break; }
    catch (error) { errors.push(error.message); }
  }
  check(pushed, `本机操作和 commit 已完成，push 失败；本地提交已保留。\n${errors.join('\n')}`);
  log('本机操作、清单 commit 和 push 已完成。');
}

function makeContext(dependencies, log) {
  const runSkills = dependencies.runSkills ?? createSkillsRunner({ env: dependencies.env, cwd: dependencies.cwd });
  return { runSkills, installed: installedSkills(runSkills(['list', '-g', '--json'])),
    sharedSkillsDir: dependencies.sharedSkillsDir ?? join(homedir(), '.agents', 'skills'), log };
}

export function sync(args, dependencies = {}) {
  const options = parseArgs(args);
  const log = dependencies.log ?? console.log;
  if (options.help) { log(`用法：${USAGE}\n--add / --del：先操作本机，成功后提交并推送仓库清单。\n--list：列出清单；--dryrun：只检查已安装 skill 的环境。`); return; }
  const [major, minor] = process.versions.node.split('.').map(Number);
  check(major > 22 || (major === 22 && minor >= 20), '需要 Node.js ≥22.20.0。');
  if (options.mode === 'add' || options.mode === 'del') return manageManifest(options, dependencies, log);
  const manifest = validateManifest(parseJson((dependencies.fetchManifest ?? fetchManifest)(), '远程清单'));
  const entries = selectSkills(manifest, options.agents);
  if (options.mode === 'list') {
    log(`远程清单：${MANIFEST_URL}`);
    log(entries.length ? entries.map((entry) => `${entry.name}\t${entry.source}\t${entry.agents.join(', ')}`).join('\n') : '没有匹配的 skill。');
    return;
  }
  if (!entries.length) { log('没有匹配的 skill，无需安装或检查。'); return; }
  const context = makeContext(dependencies, log);
  checkSources(entries, context.installed);
  let jobs = 0;
  if (options.mode !== 'dryrun') jobs = install(entries, { ...context, update: options.mode === 'update' });
  (dependencies.runDryruns ?? runDryruns)(entries, context.installed, { log, env: dependencies.env });
  log(options.mode === 'dryrun' ? '环境检查完成。' : jobs ? '同步和环境检查完成。' : '均已安装，环境检查完成。');
}

if (import.meta.main) {
  try { sync(process.argv.slice(2)); }
  catch (error) { console.error(`操作失败：${error.message}`); process.exitCode = 1; }
}
