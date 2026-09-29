import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';

export const OWN_SOURCE = 'Charbddlie/everything-harness';
export const MANIFEST_URL = `https://raw.githubusercontent.com/${OWN_SOURCE}/main/harness.json`;
export const AGENTS = new Map([['codex', 'Codex'], ['github-copilot', 'GitHub Copilot']]);
const USAGE = `node sync.mjs [--dryrun | --list]
node sync.mjs [--local] --add <type>:<name>
node sync.mjs [--local] --add <owner>/<repo> skill:<name>
node sync.mjs [--local] --del <type>:<name> ...
node sync.mjs [--local] --auto_sync <true|false> <type>:<name> ...
node sync.mjs [--local] --add_agents <agent> ...
node sync.mjs [--local] --del_agents <agent> ...
type: skill | agents-md | rule
所有模式支持 --home <目录>，默认用户主目录（~）。
--add 接收一个或两个参数；自有 skill 单参数默认来源为 ${OWN_SOURCE}。`;

function check(condition, message) { if (!condition) throw new Error(message); }

function skillName(name) {
  check(typeof name === 'string' && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name), `无效 skill 名：${name}`);
}

export function typedName(value, { rule = false } = {}) {
  check(typeof value === 'string' && /^(skill|agents-md|rule):[^:]+$/.test(value), `无效名称：${value}；请使用 type:name。`);
  const [type, name] = value.split(':');
  check(type !== 'rule' || rule, '规则成员和删除记录只能使用 skill: 或 agents-md: 前缀。');
  skillName(name);
  return { type, name };
}

const deletedEntries = (manifest, type) => (manifest.deleted ?? []).map(({ type_name, ...entry }) => ({ ...entry, ...typedName(type_name) }))
  .filter((entry) => entry.type === type).map((entry) => ({ ...entry, deleted: true }));

export const RULE_CHECKS = {
  explicit: ({ explicit }) => explicit === true,
  windows: ({ platform }) => platform === 'win32',
};

function ruleCallback(checks) {
  return (context) => {
    let passed = true;
    for (const name of checks) {
      const result = RULE_CHECKS[name](context);
      context.log(`检测 ${name}：${result ? '通过' : '未通过'}`);
      passed = result && passed;
    }
    return passed;
  };
}

export const RULE_CALLBACKS = new Map([
  ['auto', ruleCallback([])],
  ['win', ruleCallback(['windows'])],
  ['learn', ruleCallback(['windows', 'explicit'])],
]);

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
    if (arg === '--home') {
      check(!Object.hasOwn(options, 'home'), '--home 不能重复指定。');
      const value = args[++i];
      check(typeof value === 'string' && value.trim() && !value.startsWith('-') && !value.includes('\0'), `${arg} 需要有效的目录参数。`);
      options.home = value;
      continue;
    }
    if (['--add', '--del', '--list', '--dryrun', '--auto_sync', '--add_agents', '--del_agents'].includes(arg) && options.mode === 'sync') {
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
    if (options.mode === 'add') {
      check(values.length === 1 || values.length === 2, '--add 需要一个 type:name，或 owner/repo 与 type:name 两个参数。');
      if (values.length === 2) { options.source = values.shift(); sourceName(options.source); }
    }
    if (options.mode === 'auto_sync') {
      const value = values.shift();
      check(value === 'true' || value === 'false', '--auto_sync 需要 true 或 false。');
      options.autoSync = value === 'true';
    }
    check(values.length > 0, `--${options.mode} 需要明确的 type:name。`);
    options.targets = values.map((value) => typedName(value, { rule: true }));
    check(new Set(values).size === values.length, '重复 type:name');
    if (options.mode === 'add') {
      check(!options.source || options.targets[0].type === 'skill', '两个参数的 --add 仅用于 skill；agents-md 和 rule 使用单参数。');
      if (options.targets[0].type === 'skill') options.source ??= OWN_SOURCE;
    }
    check(options.mode !== 'auto_sync' || options.targets.every(({ type }) => type !== 'rule'), '--auto_sync 使用内容名称；规则通过 --add/--del rule:<name> 操作。');
    options.names = values;
  }
  return options;
}

export function homeDependencies(home, dependencies = {}) {
  if (home === undefined) return dependencies;
  const baseEnv = dependencies.env ?? process.env;
  const originalHome = dependencies.homeDir ?? homedir();
  const expanded = home === '~' ? originalHome : /^~[/\\]/.test(home) ? join(originalHome, home.slice(2)) : home;
  const homeDir = resolve(dependencies.cwd ?? process.cwd(), expanded);
  check(!existsSync(homeDir) || statSync(homeDir).isDirectory(), `--home 必须是目录：${homeDir}`);
  const env = { ...baseEnv };
  // Scope the override to installation/check subprocesses. Git publication
  // retains the caller's identity and authentication environment.
  for (const key of Object.keys(env)) {
    if (['HOME', 'USERPROFILE', 'CODEX_HOME', 'COPILOT_HOME', 'XDG_STATE_HOME'].includes(key.toUpperCase())) delete env[key];
  }
  Object.assign(env, {
    HOME: homeDir, USERPROFILE: homeDir,
    CODEX_HOME: join(homeDir, '.codex'), COPILOT_HOME: join(homeDir, '.copilot'),
  });
  return { ...dependencies, env, gitEnv: dependencies.gitEnv ?? baseEnv, homeDir,
    stateDir: join(homeDir, '.everything-harness'), sharedSkillsDir: join(homeDir, '.agents', 'skills') };
}

function objectKeys(value, keys, label) {
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key)), `${label} 格式错误或包含未知字段。`);
}

export function validateManifest(value, { local = false } = {}) {
  objectKeys(value, local ? ['agents', 'sync-rules'] : ['agents', 'skill', 'agents-md', 'sync-rules', 'deleted'], '清单');
  if (!local || Object.hasOwn(value, 'agents')) agentNames(value.agents);
  if (local) { validateRules(Object.hasOwn(value, 'sync-rules') ? value['sync-rules'] : {}); return value; }
  check(Array.isArray(value.skill), 'skill 必须是数组。');
  const names = new Set();
  for (const entry of value.skill) {
    objectKeys(entry, ['source', 'name'], 'skill');
    sourceName(entry.source); skillName(entry.name);
    check(!names.has(entry.name), `重复 skill 名：${entry.name}`);
    names.add(entry.name);
  }
  if (Object.hasOwn(value, 'agents-md')) validateFragments({ 'agents-md': value['agents-md'] });
  if (Object.hasOwn(value, 'deleted')) {
    check(Array.isArray(value.deleted), 'deleted 必须是对象数组。');
    const deletedNames = new Set();
    for (const target of value.deleted) {
      objectKeys(target, ['type_name', 'source'], 'deleted');
      const { type, name } = typedName(target.type_name);
      if (type === 'skill') sourceName(target.source);
      else check(!Object.hasOwn(target, 'source'), 'agents-md 删除记录无需 source。');
      check(!deletedNames.has(target.type_name), `重复 deleted 名称：${target.type_name}`);
      deletedNames.add(target.type_name);
      check(!(value[type] ?? []).some((entry) => entry.name === name), `${target.type_name} 同时存在于活动清单和 deleted。`);
    }
  }
  validateRules(Object.hasOwn(value, 'sync-rules') ? value['sync-rules'] : {}, value);
  return value;
}

function validateRules(rules, manifest) {
  objectKeys(rules, [...RULE_CALLBACKS.keys()], 'sync-rules（每条规则必须有对应回调）');
  for (const [rule, members] of Object.entries(rules)) {
    check(Array.isArray(members), `sync-rules.${rule} 必须是数组。`);
    const seen = new Set();
    for (const member of members) {
      objectKeys(member, ['type_name'], `rule:${rule} 成员`);
      const { type, name } = typedName(member.type_name);
      check(!seen.has(member.type_name), `rule:${rule} 重复成员：${member.type_name}`);
      seen.add(member.type_name);
      if (manifest) check((manifest[type] ?? []).some((entry) => entry.name === name), `rule:${rule} 引用了不存在或已删除的条目：${member.type_name}`);
    }
  }
}

const stateDirectory = (dependencies) => dependencies.stateDir ?? join(dependencies.homeDir ?? homedir(), '.everything-harness');

function migrateFragmentKey(value) {
  if (value && Object.hasOwn(value, 'fragments')) {
    check(!Object.hasOwn(value, 'agents-md'), '本机配置同时包含 fragments 和 agents-md，请合并到 agents-md 后重试。');
    value['agents-md'] = value.fragments;
    delete value.fragments;
  }
  return value;
}

function migrateSkillKey(value) {
  if (value && Object.hasOwn(value, 'skills')) {
    check(!Object.hasOwn(value, 'skill'), '本机配置同时包含 skills 和 skill，请合并到 skill 后重试。');
    value.skill = value.skills;
    delete value.skills;
  }
}

function readLocalSettings(dependencies, manifest) {
  const path = join(stateDirectory(dependencies), 'harness.json');
  const text = existsSync(path) ? readFileSync(path, 'utf8') : null;
  let settings;
  if (text === null) {
    const oldSkills = join(stateDirectory(dependencies), 'skills.json');
    const oldFragments = join(stateDirectory(dependencies), 'agents-md.json');
    settings = existsSync(oldSkills) ? parseJson(readFileSync(oldSkills, 'utf8'), oldSkills) : { skill: [] };
    if (existsSync(oldFragments)) {
      const fragments = migrateFragmentKey(parseJson(readFileSync(oldFragments, 'utf8'), oldFragments));
      objectKeys(fragments, ['agents-md'], '旧片段清单');
      settings['agents-md'] = fragments['agents-md'];
    }
  } else settings = parseJson(text, path);
  const before = JSON.stringify(settings);
  migrateFragmentKey(settings);
  migrateSkillKey(settings);
  for (const type of ['skill', 'agents-md']) {
    if (!settings || !Object.hasOwn(settings, type)) continue;
    check(!Object.hasOwn(settings, 'sync-rules'), '旧开关与 sync-rules 同时存在，请先合并到 sync-rules。');
  }
  if (settings && (Object.hasOwn(settings, 'skill') || Object.hasOwn(settings, 'agents-md'))) {
    const overrides = [];
    for (const type of ['skill', 'agents-md']) {
      if (!Object.hasOwn(settings, type)) continue;
      check(Array.isArray(settings[type]), `${type} 必须是数组。`);
      const seen = new Set();
      for (const entry of settings[type]) {
        objectKeys(entry, type === 'skill' ? ['name', 'source', 'auto_sync', 'agents'] : ['name', 'auto_sync'], '旧本机开关');
        skillName(entry.name);
        if (type === 'skill') sourceName(entry.source);
        check(typeof entry.auto_sync === 'boolean', `${entry.name} 的 auto_sync 必须是 true 或 false。`);
        check(!seen.has(entry.name), `重复名称：${entry.name}`); seen.add(entry.name);
        overrides.push({ type_name: `${type}:${entry.name}`, enabled: entry.auto_sync });
      }
      delete settings[type];
    }
    settings['sync-rules'] ??= {};
    for (const { type_name, enabled } of overrides) setMembership(settings['sync-rules'], manifest['sync-rules'] ?? {}, type_name, enabled);
  }
  validateManifest(settings, { local: true });
  return { path, text, settings, migrated: before !== JSON.stringify(settings) };
}

function readCatalog(dependencies) {
  const manifest = validateManifest(parseJson((dependencies.fetchManifest ?? fetchManifest)(), '远程清单'));
  return { manifest, local: readLocalSettings(dependencies, manifest) };
}

function setMembership(overrides, defaults, type_name, enabled) {
  const effective = { ...defaults, ...overrides };
  const groups = Object.keys(defaults).filter((rule) => defaults[rule].some((item) => item.type_name === type_name));
  const selected = enabled ? (groups.length ? groups : ['auto']) : Object.keys(effective);
  for (const rule of selected) {
    if (enabled && (effective[rule] ?? []).some((item) => item.type_name === type_name)) continue;
    const members = (effective[rule] ?? []).filter((item) => item.type_name !== type_name);
    if (enabled) members.push({ type_name });
    if (JSON.stringify(members) !== JSON.stringify(effective[rule] ?? [])) overrides[rule] = members;
  }
}

const effectiveAgents = (manifest, local) => local.settings.agents ?? manifest.agents;

export function validateFragments(value) {
  objectKeys(value, ['agents-md'], '片段清单');
  check(Array.isArray(value['agents-md']), 'agents-md 必须是数组。');
  const names = new Set();
  for (const entry of value['agents-md']) {
    objectKeys(entry, ['name'], '片段');
    skillName(entry.name);
    check(!names.has(entry.name), `重复片段名：${entry.name}`);
    names.add(entry.name);
  }
  return value;
}

export function instructionPaths(agents, { env = process.env, homeDir = homedir() } = {}) {
  const paths = {
    codex: join(env.CODEX_HOME || join(homeDir, '.codex'), 'AGENTS.md'),
    'github-copilot': join(env.COPILOT_HOME || join(homeDir, '.copilot'), 'copilot-instructions.md'),
  };
  return agents.map((agent) => paths[agent]);
}

export function renderFragments(original, fragments) {
  const markers = [...original.matchAll(/<!-- eh:([a-z0-9-]+):(start|end) -->/g)];
  check(markers.length === (original.match(/<!-- eh:/g) ?? []).length, 'eh 片段标记格式错误，请修复后重试。');
  const names = new Set();
  let opened = null;
  for (const marker of markers) {
    const [, name, kind] = marker;
    if (kind === 'start') {
      check(!opened && !names.has(name), `eh 片段标记嵌套或重复：${name}`);
      names.add(name); opened = name;
    } else {
      check(opened === name, `eh 片段结束标记不匹配：${name}`);
      opened = null;
    }
  }
  check(!opened, `eh 片段缺少结束标记：${opened}`);
  const replacements = new Map(fragments.map(({ name, content, deleted }) => {
    skillName(name);
    if (deleted) return [name, ''];
    check(typeof content === 'string' && content.trim() && !content.includes('<!-- eh:'), `片段 ${name} 为空或包含 eh 保留标记。`);
    return [name, `<!-- eh:${name}:start -->\n${content.trim()}\n<!-- eh:${name}:end -->`];
  }));
  let result = original.replace(/<!-- eh:([a-z0-9-]+):start -->[\s\S]*?<!-- eh:\1:end -->/g, (block, name) => {
    const replacement = replacements.get(name);
    replacements.delete(name);
    return replacement ?? block;
  });
  for (const block of replacements.values()) {
    if (!block) continue;
    result += `${result && !result.endsWith('\n') ? '\n' : ''}${result ? '\n' : ''}${block}\n`;
  }
  return result;
}

function prepareFragments(catalog, agents, dependencies) {
  const entries = [...deletedEntries(catalog.manifest, 'agents-md'),
    ...(catalog.manifest['agents-md'] ?? [])];
  if (!entries.length || !agents.length) return [];
  const fragments = entries.map(({ name, deleted }) => deleted ? { name, deleted } : { name, content: (dependencies.fetchFragment ??
    ((name) => fetchText(`https://raw.githubusercontent.com/${OWN_SOURCE}/main/agents-md/${name}.md`)))(name) });
  // Read and validate every target before replacing any managed content.
  return instructionPaths(agents, dependencies).map((target) => {
    const path = existsSync(target) ? realpathSync(target) : target;
    const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
    return { path, original, content: renderFragments(original, fragments),
      names: entries.filter((entry) => !entry.deleted).map((entry) => entry.name),
      deleted: entries.filter((entry) => entry.deleted).map((entry) => entry.name) };
  });
}

function applyFragments(writes, dryrun, log) {
  for (const { path, original, content, names, deleted } of writes) {
    if (deleted.length) log(`片段已标记删除：${deleted.join(', ')}；${dryrun ? '同步时将清理' : '正在清理'} ${path}`);
    if (!dryrun && content !== original) writeAtomic(path, content);
    if (names.length) log(`片段${dryrun ? '检查通过' : '覆盖同步'}：${names.join(', ')} → ${path}`);
  }
}

function listCatalog(manifest, local, log) {
  const display = (agents) => agents.length ? agents.join(', ') : '无';
  log(`远程清单：${MANIFEST_URL}\n本机设置：${local.path}\n远程 agents：${display(manifest.agents)}\n本机 agents：${local.settings.agents ? display(local.settings.agents) : '跟随远程'}\n生效 agents：${display(effectiveAgents(manifest, local))}`);
  for (const type of ['skill', 'agents-md']) {
    for (const entry of manifest[type] ?? []) log(`${type}:${entry.name}\t${entry.source ?? OWN_SOURCE}`);
  }
  const rules = effectiveRules(manifest, local);
  for (const [name, members] of Object.entries(rules)) {
    log(`rule:${name}\t${Object.hasOwn(local.settings['sync-rules'] ?? {}, name) ? '本机覆盖' : '跟随远程'}\t${members.map((item) => item.type_name).join(', ')}`);
  }
  for (const entry of manifest.deleted ?? []) log(`${entry.type_name}\t${entry.source ?? OWN_SOURCE}\t已删除（同步时清理）`);
}

function effectiveRules(manifest, local) {
  const active = new Set(['skill', 'agents-md'].flatMap((type) => (manifest[type] ?? []).map(({ name }) => `${type}:${name}`)));
  return Object.fromEntries(Object.entries({ ...manifest['sync-rules'], ...local.settings['sync-rules'] })
    .map(([rule, members]) => [rule, members.filter(({ type_name }) => active.has(type_name))]));
}

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
  } else if (local.migrated) {
    check(readFileSync(local.path, 'utf8') === local.text, '操作期间本机设置已被修改，请重新同步。');
    writeAtomic(local.path, JSON.stringify(local.settings, null, 2) + '\n');
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
    || relative(sharedSkillsDir, dirname(entry.path)) === '');
}

function installationJobs(entries, agents) {
  const jobs = new Map();
  for (const entry of entries) {
    const key = entry.source.toLowerCase();
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
        check(path, '尚未安装，无法检查环境');
        check(entry.source.toLowerCase() !== OWN_SOURCE.toLowerCase() || !containsScripts(path), '包含脚本但缺少 dryrun.mjs，请更新此 skill');
        log(`[${entry.name}] 跳过：无检查脚本`);
        continue;
      }
      const result = spawnSync(process.execPath, [script], { cwd: path, env, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
      if (result.error || result.status !== 0) {
        const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').split(/\r?\n/)
          .map((line) => line.trim().replace(`[${entry.name}] `, '').replace(/^失败[:：]\s*/, ''))
          .filter(Boolean).join('；');
        throw new Error(result.error?.message ?? (detail || `检查脚本退出：${result.signal ?? result.status}`));
      }
      log(`[${entry.name}] 通过`);
    } catch (error) {
      errors.push(entry.name);
      log(`[${entry.name}] 失败：${error.message.replace(/\r?\n/g, '；')}`);
    }
  }
  check(!errors.length, `${errors.length} 个 skill 环境检查失败；已安装内容保留，修复后运行 --dryrun。`);
}

export function containsScripts(path) {
  return readdirSync(path, { withFileTypes: true }).some((entry) => {
    if (entry.name === 'dryrun.mjs' || entry.name.startsWith('.')) return false;
    if (entry.isDirectory()) return containsScripts(join(path, entry.name));
    return entry.isFile() && /\.(mjs|cjs|js|py|sh|ps1|cmd|bat)$/i.test(entry.name);
  });
}

function install(entries, { runSkills, installed, agents, log, scope = 'global' }) {
  checkSources(entries, installed);
  const jobs = installationJobs(entries, agents);
  for (const job of jobs) {
    const label = `${job.source} / ${job.names.join(', ')} → ${job.agents.join(', ')}`;
    log(`${scope === 'project' ? '临时准备源码' : '覆盖安装'}：${label}`);
    try {
      const results = parseJson(runSkills(['add', job.source, '--skill', ...job.names, '--agent', ...job.agents, ...(scope === 'global' ? ['-g'] : []), '--yes', '--json']), 'skills add');
      check(Array.isArray(results), 'skills add 应返回数组。');
      for (const name of job.names) {
        const result = results.find((item) => item?.name === name);
        check(result?.status === 'installed' && result.scope === scope && typeof result.path === 'string'
          && Array.isArray(result.agents) && job.agents.every((agent) => result.agents.includes(AGENTS.get(agent))),
        `${name} 未完成安装：${result?.error ?? result?.status ?? '缺少安装结果'}`);
        installed.set(name, { ...result, source: job.source, sourceType: 'github' });
      }
    } catch (error) { throw new Error(`${label} 失败：${error.message}`); }
  }
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

function resolvePlans(manifest, options) {
  const plans = [];
  for (const target of options.targets ?? []) {
    const rule = target.type === 'rule' ? target.name : null;
    if (rule) check(Object.hasOwn(manifest['sync-rules'] ?? {}, rule), `不存在规则：rule:${rule}`);
    const targets = rule ? (options.members ?? manifest['sync-rules'][rule]).map(({ type_name }) => typedName(type_name)) : [target];
    const entries = targets.map(({ type, name }) => {
      const tombstone = deletedEntries(manifest, type).find((entry) => entry.name === name);
      check(!tombstone || options.mode === 'del', `${type}:${name} 已标记删除，无法重新启用。`);
      let entry = tombstone ?? (manifest[type] ?? []).find((item) => item.name === name);
      if (options.mode === 'add') {
        if (type === 'skill' && !rule) {
          check(!entry || entry.source.toLowerCase() === options.source.toLowerCase(), `来源冲突：${type}:${name}`);
        }
        if (!entry && !options.local) entry = { name, ...(type === 'skill' ? { source: options.source } : {}) };
      }
      check(entry, `清单中不存在${type === 'skill' ? 'skill' : '片段'}：${type}:${name}`);
      return { ...entry, type };
    });
    plans.push({ rule, entries });
  }
  if (options.mode === 'del') return [{ rule: null, entries: [...new Map(plans.flatMap(({ entries }) => entries)
    .map((entry) => [`${entry.type}:${entry.name}`, entry])).values()] }];
  return plans;
}

function manageLocal(options, dependencies, log) {
  const { manifest, local } = readCatalog(dependencies);
  const plans = resolvePlans(manifest, options);
  if (!executePlans(plans, options, effectiveAgents(manifest, local), dependencies, log)) return;
  check(readLocalSettings(dependencies, manifest).text === local.text, '操作期间本机设置已被修改；本机操作已完成，请重新运行同一条命令。');
  if (agentMode(options.mode)) local.settings.agents = changeAgents(effectiveAgents(manifest, local), options);
  else {
    const rules = local.settings['sync-rules'] ??= {};
    for (const { rule, entries } of plans) {
      if (rule && options.mode === 'add') rules[rule] = structuredClone(manifest['sync-rules'][rule]);
      else for (const { type, name } of entries) {
        setMembership(rules, manifest['sync-rules'] ?? {}, `${type}:${name}`, options.mode === 'auto_sync' ? options.autoSync : options.mode === 'add');
      }
    }
  }
  validateManifest(local.settings, { local: true });
  writeAtomic(local.path, JSON.stringify(local.settings, null, 2) + '\n');
  log(`本机设置已保存：${local.path}（${options.names.join(', ')}）`);
}

export function changeManifest(manifest, options) {
  validateManifest(manifest);
  const next = structuredClone(manifest);
  const plans = resolvePlans(manifest, options);
  const affected = plans.flatMap(({ entries }) => entries);
  if (agentMode(options.mode)) next.agents = changeAgents(next.agents, options);
  else for (const { type, name, source } of affected) {
    const type_name = `${type}:${name}`;
    const records = next[type] ?? [];
    const entry = records.find((item) => item.name === name);
    if (options.mode === 'add') {
      if (!entry) {
        (next[type] ??= []).push({ name, ...(type === 'skill' ? { source } : {}) });
        setMembership(next['sync-rules'] ??= {}, {}, type_name, true);
      }
    } else if (options.mode === 'auto_sync') {
      const defaults = structuredClone(next['sync-rules'] ?? {});
      setMembership(next['sync-rules'] ??= {}, defaults, type_name, options.autoSync);
    } else {
      if (entry) {
        next[type] = records.filter((item) => item.name !== name);
        (next.deleted ??= []).push({ type_name, ...(type === 'skill' ? { source } : {}) });
      }
      for (const [rule, members] of Object.entries(next['sync-rules'] ?? {})) next['sync-rules'][rule] = members.filter((item) => item.type_name !== type_name);
    }
  }
  if (affected.some(({ type }) => type === 'skill')) next.skill.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return { next: validateManifest(next), affected, plans };
}

// Stage the selected source using the same CLI in a disposable project. Tests
// run before any global install so a failed batch leaves live content intact.
export function checkSkills(entries, agents, dependencies, log) {
  if (!entries.length) return;
  const root = mkdtempSync(join(dependencies.tempDir ?? tmpdir(), 'eh-check-'));
  try {
    const installed = new Map();
    const runSkills = (dependencies.createCheckRunner ?? createSkillsRunner)({ env: dependencies.env, cwd: root });
    install(entries, { runSkills, installed, agents, log, scope: 'project' });
    (dependencies.runDryruns ?? runDryruns)(entries, installed, { log, env: dependencies.env });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function executePlans(plans, options, agents, dependencies, log) {
  if (!skillOperation(options.mode)) return true;
  for (const { rule, entries } of plans) {
    if (options.mode === 'add' && rule) {
      log(`规则回调：rule:${rule}`);
      const passed = RULE_CALLBACKS.get(rule)({ explicit: options.explicit !== false, platform: dependencies.platform ?? process.platform, log });
      if (!passed) { log(`跳过 rule:${rule}：检测条件未满足。`); return false; }
    }
    if (!entries.length) continue;
    check(agents.length > 0, '生效 agents 为空；请先设置目标。');
    const skills = entries.filter(({ type }) => type === 'skill');
    const fragments = entries.filter(({ type }) => type === 'agents-md');
    const manifest = options.mode === 'del'
      ? { deleted: fragments.map(({ name }) => ({ type_name: `agents-md:${name}` })) }
      : { 'agents-md': fragments.map(({ name }) => ({ name })) };
    const writes = prepareFragments({ manifest }, agents, dependencies);
    const context = skills.length ? makeContext(dependencies, log, agents) : null;
    if (context) checkSources(skills, context.installed);
    if (options.mode === 'add') {
      (dependencies.checkSkills ?? checkSkills)(skills, agents, dependencies, log);
      if (context && !options.dryrun) install(skills, context);
    } else if (context) {
      for (const entry of skills) log(`skill 待删除：${entry.name}；${options.dryrun ? '同步时将自动删除' : '正在清理'}对应安装。`);
      if (!options.dryrun) remove(skills, context);
    }
    applyFragments(writes, options.dryrun, log);
  }
  return true;
}

function manageManifest(options, dependencies, log) {
  const root = mkdtempSync(join(dependencies.tempDir ?? tmpdir(), 'skill-manage-'));
  const baseEnv = dependencies.gitEnv ?? dependencies.env ?? process.env;
  const env = { ...baseEnv, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND: baseEnv.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' };
  const git = (args) => (dependencies.runGit ?? runCommand)('git', args, { cwd: root, env, timeout: 120_000 });
  let keep = false;
  try {
    log('正在准备远程清单…');
    // A fresh checkout isolates publication from any user working tree.
    git(['init', '--quiet']);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
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
    const before = readFileSync(join(root, 'harness.json'), 'utf8');
    applyManifestChange(options, dependencies, log, root, git, before, sources, () => { keep = true; });
    keep = false;
  } catch (error) {
    throw new Error(`${error.message}${keep ? `\n操作副本已保留：${root}` : ''}\n修复问题后重新运行同一条命令，脚本会自动重新读取清单并处理 Git。`);
  } finally {
    if (!keep) rmSync(root, { recursive: true, force: true });
  }
}

function applyManifestChange(options, dependencies, log, root, git, before, sources, onWrite) {
  const file = 'harness.json';
  const manifest = validateManifest(parseJson(before, '远程清单'));
  const { next, affected, plans } = changeManifest(manifest, options);
  if (!executePlans(plans, options, effectiveAgents(manifest, readLocalSettings(dependencies, manifest)), dependencies, log)) return;
  const text = JSON.stringify(next, null, 2) + '\n';
  const removedPaths = options.mode === 'del' ? affected
    .filter((entry) => entry.type === 'agents-md' || entry.source.toLowerCase() === OWN_SOURCE.toLowerCase())
    .map((entry) => entry.type === 'agents-md' ? `agents-md/${entry.name}.md` : `skills/${entry.name}`)
    .filter((path) => git(['ls-files', '--', path]).trim()) : [];
  if (JSON.stringify(next) === JSON.stringify(manifest) && !removedPaths.length) {
    log('清单及源码无变化，无需 commit / push。'); return;
  }
  onWrite();
  writeFileSync(join(root, file), text);
  try {
    if (removedPaths.length) git(['rm', '-r', '--', ...removedPaths]);
    const action = options.mode === 'auto_sync' ? `Set auto_sync=${options.autoSync} for` : ['add', 'add_agents'].includes(options.mode) ? 'Add' : 'Remove';
    git(['commit', '--only', '-m', `${action} ${options.names.join(', ')}`, '--', file, ...removedPaths]);
  } catch (error) { throw new Error(`源码清理或 Git commit 失败；操作副本及清单改动已保留：${error.message}`); }
  const errors = [];
  let pushed = false;
  for (const source of sources) {
    try { git(['push', source, 'HEAD:refs/heads/main']); pushed = true; break; }
    catch (error) { errors.push(error.message); }
  }
  check(pushed, `commit 已完成，push 失败；本地提交已保留。\n${errors.join('\n')}`);
  log('清单 commit 和 push 已完成。');
  if (removedPaths.length) log(`已删除仓库源码：${removedPaths.join(', ')}；可从 Git 历史恢复。`);
  if (agentMode(options.mode)) log('agents 设置将在下次同步时生效；已有安装保留，本机 agents 覆盖仍优先。');
}

function makeContext(dependencies, log, agents) {
  check(agents.length > 0, '生效 agents 为空；请先用 --add_agents 设置目标，或加 --local 修改本机目标。');
  const runSkills = dependencies.runSkills ?? createSkillsRunner({ env: dependencies.env, cwd: dependencies.cwd });
  return { runSkills, installed: installedSkills(runSkills(['list', '-g', '--json'])),
    sharedSkillsDir: dependencies.sharedSkillsDir ?? join(dependencies.homeDir ?? homedir(), '.agents', 'skills'), agents, log };
}

export function sync(args, dependencies = {}) {
  const options = parseArgs(args);
  const log = dependencies.log ?? console.log;
  if (options.help) {
    log(`用法：${USAGE}\n清单：远程 harness.json；本机 ~/.everything-harness/harness.json。\n--add 单参数使用 type:name；双参数为 owner/repo skill:name，自有 skill 默认来源为 ${OWN_SOURCE}。\n--local：仅本机安装和规则覆盖；省略时修改远程清单并 commit / push。\nrule:auto 无额外条件；rule:win 检测 Windows；rule:learn 检测 Windows 与显式调用。\n同步依次执行各规则的 add：规则回调 → 检测函数 → 全部 skill 测试 → 批量安装。del 跳过规则检测和 skill 测试。\n--auto_sync：兼容开关入口，通过 sync-rules 调整成员。\n--list 保持只读；--dryrun 检测规则和 skill 环境，保留本机安装。\n支持的 agent：${[...AGENTS.keys()].join(', ')}`);
    return;
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  check(major > 22 || (major === 22 && minor >= 20), '需要 Node.js ≥22.20.0。');
  dependencies = homeDependencies(options.home, dependencies);
  if (['add', 'del', 'auto_sync'].includes(options.mode) || agentMode(options.mode)) {
    return options.local ? manageLocal(options, dependencies, log) : manageManifest(options, dependencies, log);
  }
  const { manifest, local } = readCatalog(dependencies);
  if (options.mode === 'list') { listCatalog(manifest, local, log); return; }
  const agents = effectiveAgents(manifest, local);
  if (!agents.length) {
    if (options.mode === 'sync') initializeLocalSettings(local);
    log('生效 agents 为空，无需安装或检查。'); return;
  }
  const dryrun = options.mode === 'dryrun';
  const deleted = ['skill', 'agents-md'].flatMap((type) => deletedEntries(manifest, type));
  executePlans([{ rule: null, entries: deleted }], { mode: 'del', dryrun }, agents, dependencies, log);
  const failures = [];
  for (const [name, members] of Object.entries(effectiveRules(manifest, local))) {
    // Use the exact same add planner and executor as explicit rule invocation.
    const add = { ...parseArgs(['--local', '--add', `rule:${name}`]), explicit: false, dryrun, members };
    try { executePlans(resolvePlans({ ...manifest, 'sync-rules': { ...manifest['sync-rules'], [name]: members } }, add), add, agents, dependencies, log); }
    catch (error) { failures.push(`${name}: ${error.message}`); log(`[rule:${name}] 失败：${error.message}`); }
  }
  check(!failures.length, `规则检查或同步失败：${failures.join(', ')}；已完成操作保留，请修复后重试。`);
  if (!dryrun) initializeLocalSettings(local);
  log(dryrun ? '环境检查完成。' : '规则同步和环境检查完成。');
}

if (import.meta.main) {
  try { sync(process.argv.slice(2)); }
  catch (error) { console.error(`操作失败：${error.message}`); process.exitCode = 1; }
}
