import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';

export const OWN_SOURCE = 'Charbddlie/everything-harness';
export const MANIFEST_URL = `https://raw.githubusercontent.com/${OWN_SOURCE}/main/skills.json`;
export const AGENTS = new Map([['claude-code', 'Claude Code'], ['codex', 'Codex'], ['github-copilot', 'GitHub Copilot']]);
const SHARED_AGENTS = ['codex', 'github-copilot'];
const USAGE = `node sync.mjs [--update | --dryrun | --list]
node sync.mjs --add <owner/repo> <skill> ...
node sync.mjs --del <skill> ...
node sync.mjs --auto_sync <true|false> <skill> ...
node sync.mjs [--local] --add_agents <agent> ...
node sync.mjs [--local] --del_agents <agent> ...
node sync.mjs --local --add <skill> ...
node sync.mjs --local --del <skill> ...
node sync.mjs --local --auto_sync <true|false> <skill> ...`;

function check(condition, message) { if (!condition) throw new Error(message); }

function skillName(name) {
  check(typeof name === 'string' && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name), `无效 skill 名：${name}`);
}

function sourceName(source) {
  check(typeof source === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/i.test(source)
    && !['.', '..'].includes(source.split('/')[1]) && !source.toLowerCase().endsWith('.git'), `无效来源：${source}；请使用 GitHub owner/repo。`);
}

function agentNames(agents) {
  check(Array.isArray(agents), 'agents 必须是数组。');
  for (const agent of agents) check(AGENTS.has(agent), `无效 agent：${agent}；可选：${[...AGENTS.keys()].join(', ')}。`);
  check(new Set(agents).size === agents.length, '重复 agent 名');
}

const agentMode = (mode) => mode === 'add_agents' || mode === 'del_agents';
const skillOperation = (mode) => mode === 'add' || mode === 'del';

function changeAgents(agents, options) {
  return options.mode === 'add_agents' ? [...new Set([...agents, ...options.names])]
    : agents.filter((agent) => !options.names.includes(agent));
}

export function parseArgs(args) {
  const options = { mode: 'sync', names: [], help: false, local: false };
  const values = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--local' && !options.local) { options.local = true; continue; }
    if (['--add', '--del', '--list', '--update', '--dryrun', '--auto_sync', '--add_agents', '--del_agents'].includes(arg) && options.mode === 'sync') {
      options.mode = arg.slice(2);
      if (['--add', '--del', '--auto_sync', '--add_agents', '--del_agents'].includes(arg)) {
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) values.push(args[++i]);
      }
    } else throw new Error(`未知、重复或互斥参数：${arg}\n用法：${USAGE}`);
  }
  if (agentMode(options.mode)) {
    check(values.length > 0, `--${options.mode} 需要明确的 agent 名称。`);
    agentNames(values);
    options.names = values;
  } else if (['add', 'del', 'auto_sync'].includes(options.mode)) {
    if (options.mode === 'add' && !options.local) { options.source = values.shift(); sourceName(options.source); }
    if (options.mode === 'auto_sync') {
      const value = values.shift();
      check(value === 'true' || value === 'false', '--auto_sync 需要 true 或 false。');
      options.autoSync = value === 'true';
    }
    check(values.length > 0, `--${options.mode} 需要明确的 skill 名称。`);
    values.forEach(skillName);
    check(new Set(values).size === values.length, '重复 skill 名');
    options.names = values;
  }
  return options;
}

function objectKeys(value, keys, label) {
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key)), `${label} 格式错误或包含未知字段。`);
}

export function validateManifest(value, { local = false } = {}) {
  objectKeys(value, ['agents', 'skills'], '清单');
  if (!local || Object.hasOwn(value, 'agents')) agentNames(value.agents);
  check(Array.isArray(value.skills), 'skills 必须是数组。');
  const names = new Set();
  for (const entry of value.skills) {
    objectKeys(entry, ['source', 'name', 'auto_sync'], 'skill');
    sourceName(entry.source); skillName(entry.name);
    check(typeof entry.auto_sync === 'boolean', `${entry.name} 的 auto_sync 必须是 true 或 false。`);
    check(!names.has(entry.name), `重复 skill 名：${entry.name}`);
    names.add(entry.name);
  }
  return value;
}

const stateDirectory = (dependencies) => dependencies.stateDir ?? join(homedir(), '.everything-harness');

function readLocalSettings(dependencies) {
  const path = join(stateDirectory(dependencies), 'skills.json');
  const text = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const settings = text === null ? { skills: [] } : parseJson(text, path);
  // Older local overrides may contain agent selections; keep their sync choices.
  if (Array.isArray(settings?.skills)) {
    for (const entry of settings.skills) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) delete entry.agents;
    }
  }
  validateManifest(settings, { local: true });
  return { path, text, settings };
}

function readCatalog(dependencies) {
  const manifest = validateManifest(parseJson((dependencies.fetchManifest ?? fetchManifest)(), '远程清单'));
  return { manifest, local: readLocalSettings(dependencies) };
}

function enabledSkill(entry, local) {
  return local.settings.skills.find((item) => item.name === entry.name)?.auto_sync ?? entry.auto_sync;
}

const effectiveAgents = (manifest, local) => local.settings.agents ?? manifest.agents;

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, text, { flag: 'wx' }); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}

function initializeLocalSettings(local) {
  if (local.text === null) {
    mkdirSync(dirname(local.path), { recursive: true });
    try { writeFileSync(local.path, JSON.stringify(local.settings, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('本机设置刚被其他进程创建，请重新同步。');
      throw error;
    }
  }
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

function installationJobs(entries, installed, update, sharedSkillsDir, targets) {
  checkSources(entries, installed);
  const jobs = new Map();
  for (const entry of entries) {
    const current = installed.get(entry.name);
    const agents = update || !current?.source ? targets : targets.filter((agent) => !hasAgent(current, agent, sharedSkillsDir));
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
  return fetchText(MANIFEST_URL);
}

function fetchText(url) {
  return runCommand(process.platform === 'win32' ? 'curl.exe' : 'curl', ['-fsSL', '--connect-timeout', '20', '--max-time', '120', url]);
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

function install(entries, { runSkills, installed, update = false, sharedSkillsDir, agents, log }) {
  const jobs = installationJobs(entries, installed, update, sharedSkillsDir, agents);
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

function remove(entries, context) {
  checkSources(entries, context.installed);
  for (const entry of entries) {
    if (!context.agents.some((agent) => hasAgent(context.installed.get(entry.name), agent, context.sharedSkillsDir))) {
      context.log(`${entry.name} 的目标安装已不存在，继续更新设置。`);
      continue;
    }
    context.log(`删除本机安装：${entry.name} → ${context.agents.join(', ')}`);
    try {
      const output = context.runSkills(['remove', entry.name, '-g', '--yes', '--agent', ...context.agents]);
      if (output.trim()) context.log(output.trim());
    } catch (error) { throw new Error(`${entry.source} / ${entry.name} 删除失败：${error.message}`); }
  }
  const remaining = installedSkills(context.runSkills(['list', '-g', '--json']));
  for (const entry of entries) {
    check(!context.agents.some((agent) => hasAgent(remaining.get(entry.name), agent, context.sharedSkillsDir)),
      `${entry.name} 的目标安装仍存在（可能由其他 agent 共享），未修改设置或创建 commit。`);
  }
}

function listCatalog(manifest, local, log) {
  const entries = manifest.skills;
  const display = (agents) => agents.length ? agents.join(', ') : '无';
  log(`远程清单：${MANIFEST_URL}\n本机设置：${local.path}\n远程 agents：${display(manifest.agents)}\n本机 agents：${local.settings.agents ? display(local.settings.agents) : '跟随远程'}\n生效 agents：${display(effectiveAgents(manifest, local))}`);
  log('skill\t来源\t远程 auto_sync\t本机 auto_sync\t生效 auto_sync');
  log(entries.length ? entries.map((entry) => {
    const override = local.settings.skills.find((item) => item.name === entry.name);
    return `${entry.name}\t${entry.source}\t${entry.auto_sync}\t${override ? override.auto_sync : '跟随远程'}\t${enabledSkill(entry, local)}`;
  }).join('\n') : '没有匹配的 skill。');
}

function manageLocal(options, dependencies, log) {
  const { manifest, local } = readCatalog(dependencies);
  const entries = agentMode(options.mode) ? [] : options.names.map((name) => {
    const entry = manifest.skills.find((item) => item.name === name);
    check(entry, `远程清单中不存在 skill：${name}。请先用远程 --add 添加到仓库清单。`);
    return entry;
  });
  if (skillOperation(options.mode)) {
    const context = makeContext(dependencies, log, effectiveAgents(manifest, local));
    if (options.mode === 'add') {
      install(entries, context);
      (dependencies.runDryruns ?? runDryruns)(entries, context.installed, { log, env: dependencies.env });
    } else remove(entries, context);
  }
  check(readLocalSettings(dependencies).text === local.text, '操作期间本机设置已被修改；本机操作已完成，请重新运行同一条命令。');
  if (agentMode(options.mode)) local.settings.agents = changeAgents(effectiveAgents(manifest, local), options);
  for (const entry of entries) {
    local.settings.skills = local.settings.skills.filter((item) => item.name !== entry.name);
    local.settings.skills.push({ ...entry, auto_sync: options.mode === 'auto_sync' ? options.autoSync : options.mode === 'add' });
  }
  if (!agentMode(options.mode)) local.settings.skills.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  writeAtomic(local.path, JSON.stringify(local.settings, null, 2) + '\n');
  log(`本机设置已保存：${local.path}（${options.names.join(', ')}）`);
  if (agentMode(options.mode)) log('agents 设置将在下次同步时生效；已有安装保留。');
}

export function changeManifest(manifest, options) {
  const next = structuredClone(manifest);
  const affected = [];
  if (agentMode(options.mode)) {
    next.agents = changeAgents(next.agents, options);
    return { next: validateManifest(next), affected };
  }
  for (const name of options.names) {
    let entry = next.skills.find((skill) => skill.name === name);
    if (options.mode === 'add') {
      check(!entry || entry.source.toLowerCase() === options.source.toLowerCase(), `来源冲突：${name}`);
      if (!entry) { entry = { name, source: options.source, auto_sync: true }; next.skills.push(entry); }
      affected.push(entry);
    } else if (options.mode === 'auto_sync') {
      check(entry, `清单中不存在 skill：${name}`);
      entry.auto_sync = options.autoSync;
      affected.push(entry);
    } else {
      check(entry, `清单中不存在 skill：${name}`);
      affected.push(entry);
      next.skills = next.skills.filter((skill) => skill.name !== name);
    }
  }
  next.skills.sort((a, b) => a.name.localeCompare(b.name, 'en'));
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
  if (skillOperation(options.mode)) {
    const context = makeContext(dependencies, log, effectiveAgents(manifest, readLocalSettings(dependencies)));
    checkSources(affected, context.installed);
    if (options.mode === 'add') {
      install(affected, context);
      (dependencies.runDryruns ?? runDryruns)(affected, context.installed, { log, env: dependencies.env });
    } else remove(affected, context);
  }
  const text = JSON.stringify(next, null, 2) + '\n';
  if (JSON.stringify(next) === JSON.stringify(manifest)) { log('清单无变化，无需 commit / push。'); return; }
  onWrite();
  writeFileSync(join(root, 'skills.json'), text);
  try {
    const action = options.mode === 'auto_sync' ? `Set auto_sync=${options.autoSync} for` : ['add', 'add_agents'].includes(options.mode) ? 'Add' : 'Remove';
    git(['commit', '--only', '-m', `${action} ${agentMode(options.mode) ? 'agents' : 'skills'}: ${options.names.join(', ')}`, '--', 'skills.json']);
  } catch (error) { throw new Error(`Git commit 失败；清单改动已保留：${error.message}`); }
  const errors = [];
  let pushed = false;
  for (const source of sources) {
    try { git(['push', source, 'HEAD:refs/heads/main']); pushed = true; break; }
    catch (error) { errors.push(error.message); }
  }
  check(pushed, `commit 已完成，push 失败；本地提交已保留。\n${errors.join('\n')}`);
  log('清单 commit 和 push 已完成。');
  if (agentMode(options.mode)) log('agents 设置将在下次同步时生效；已有安装保留，本机 agents 覆盖仍优先。');
}

function makeContext(dependencies, log, agents) {
  check(agents.length > 0, '生效 agents 为空；请先用 --add_agents 设置目标，或加 --local 修改本机目标。');
  const runSkills = dependencies.runSkills ?? createSkillsRunner({ env: dependencies.env, cwd: dependencies.cwd });
  return { runSkills, installed: installedSkills(runSkills(['list', '-g', '--json'])),
    sharedSkillsDir: dependencies.sharedSkillsDir ?? join(homedir(), '.agents', 'skills'), agents, log };
}

export function sync(args, dependencies = {}) {
  const options = parseArgs(args);
  const log = dependencies.log ?? console.log;
  if (options.help) { log(`用法：${USAGE}\n--add / --del：先操作本机，成功后提交并推送仓库清单。\n--auto_sync：只修改开关；--add_agents / --del_agents：只修改全局目标，下次同步生效，不卸载。\n--local：只修改本机设置，不操作 Git。\n--list：显示远程、本机和生效开关及 agents；--dryrun：检查开启自动同步的 skill 环境。\n支持的 agent：${[...AGENTS.keys()].join(', ')}`); return; }
  const [major, minor] = process.versions.node.split('.').map(Number);
  check(major > 22 || (major === 22 && minor >= 20), '需要 Node.js ≥22.20.0。');
  if (['add', 'del', 'auto_sync'].includes(options.mode) || agentMode(options.mode)) {
    return options.local ? manageLocal(options, dependencies, log) : manageManifest(options, dependencies, log);
  }
  const { manifest, local } = readCatalog(dependencies);
  let entries = manifest.skills;
  if (options.mode === 'list') {
    listCatalog(manifest, local, log);
    return;
  }
  if (options.mode === 'sync' || options.mode === 'update') {
    initializeLocalSettings(local);
  }
  entries = entries.filter((entry) => enabledSkill(entry, local));
  if (!entries.length) { log('没有匹配的 skill，无需安装或检查。'); return; }
  const agents = effectiveAgents(manifest, local);
  if (!agents.length) { log('生效 agents 为空，无需安装或检查。'); return; }
  const context = makeContext(dependencies, log, agents);
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
