import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const OWN_SOURCE = 'Charbddlie/everything-harness';
export const MANIFEST_URL = `https://raw.githubusercontent.com/${OWN_SOURCE}/main/harness.json`;
export const HARNESSES_URL = `https://raw.githubusercontent.com/${OWN_SOURCE}/main/harnesses.json`;
const USAGE = `node sync.mjs [--dryrun | --list]
node sync.mjs --clean [--dryrun]
node sync.mjs --add <type>:<name> ...
node sync.mjs --del <type>:<name> ...
type: skill | agents-md | rule | agent
所有模式支持 --home <目录>，默认用户主目录（~）。
--clean 清理本机项目内容及 .everything-harness 配置目录，始终处理用户主目录，--home 增加清理目标；--clean --dryrun 预览清理。
--add 启用本机同步并立即同步；--del 停止本机同步并清理对应安装。
agent:codex、agent:copilot 选择同步目标；内容和规则由远程 harness.json 定义。`;

function check(condition, message) { if (!condition) throw new Error(message); }

let gbkCharacters;

export function encodeOutput(text, platform = process.platform) {
  if (platform !== 'win32') return Buffer.from(text, 'utf8');
  if (!gbkCharacters) {
    // Node provides a GBK decoder; invert its two-byte table for console output.
    gbkCharacters = new Map([['€', 0x80]]);
    const decoder = new TextDecoder('gbk'), pair = new Uint8Array(2);
    for (let lead = 0x81; lead <= 0xfe; lead++) for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      pair[0] = lead; pair[1] = trail;
      const character = decoder.decode(pair);
      if (character.length === 1 && character !== '\ufffd') gbkCharacters.set(character, (lead << 8) | trail);
    }
  }
  const bytes = Buffer.alloc(text.length * 2);
  let offset = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    const encoded = code < 0x80 ? code : gbkCharacters.get(character) ?? 0x3f;
    if (encoded > 0xff) bytes[offset++] = encoded >> 8;
    bytes[offset++] = encoded & 0xff;
  }
  return bytes.subarray(0, offset);
}

function writeOutput(line, fd = process.stdout.fd) {
  writeFileSync(fd, encodeOutput(`${line}\n`));
}

export function createProgressLogger(write = writeOutput) {
  let step = 0, substep = 0;
  return (message, { stage = false, substage = false, status } = {}) => {
    if (stage) {
      if (substage) write(`\n  ${step}.${++substep} ${message}`);
      else {
        step++;
        substep = 0;
        write(`${step > 1 ? '\n' : ''}${step}. ${message}`);
      }
      return;
    }
    const prefix = message.match(/^\[(警告|失败|跳过|通过|完成|过期|删除|新增|更新|创建|未命中)\]\s*/);
    const label = status ?? prefix?.[1] ?? '信息';
    const content = prefix ? message.slice(prefix[0].length) : message;
    write(content.split(/\r?\n/).map((line) => `  [${label}] ${line}`).join('\n'));
  };
}

function skillName(name) {
  check(typeof name === 'string' && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name), `无效 skill 名：${name}`);
}

export function typedName(value, { rule = false, agent = false } = {}) {
  check(typeof value === 'string' && /^(skill|agents-md|rule|agent):[^:]+$/.test(value), `无效名称：${value}；请使用 type:name。`);
  const [type, name] = value.split(':');
  check((type !== 'rule' || rule) && (type !== 'agent' || agent), '规则成员和删除记录只能使用 skill: 或 agents-md: 前缀。');
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
      const reason = name === 'windows' ? `需要 Windows，当前为 ${context.platform}` : '需要通过 --add rule:learn 显式启用';
      if (!result) context.unmet?.push(reason);
      context.log(`检测 ${name}：${result ? '通过' : `未通过；${reason}`}`, { status: result ? '通过' : '未命中' });
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

function harnessName(name, harnesses) {
  const canonical = Object.hasOwn(harnesses, name) ? name
    : Object.keys(harnesses).find((key) => harnesses[key].aliases?.includes(name));
  check(canonical, `无效 agent：${name}；可选：${Object.keys(harnesses).join(', ')}。`);
  return canonical;
}

function agentNames(agents, harnesses) {
  check(Array.isArray(agents), 'agents 必须是数组。');
  const names = agents.map((name) => harnessName(name, harnesses));
  check(new Set(names).size === names.length, '重复 agent 名');
  return names;
}

const skillOperation = (mode) => mode === 'add' || mode === 'del';

export function parseArgs(args) {
  const options = { mode: 'sync', names: [], help: false };
  const values = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--home') {
      check(!Object.hasOwn(options, 'home'), '--home 不能重复指定。');
      const value = args[++i];
      check(typeof value === 'string' && value.trim() && !value.startsWith('-') && !value.includes('\0'), `${arg} 需要有效的目录参数。`);
      options.home = value;
      continue;
    }
    if (arg === '--clean' && ['sync', 'dryrun'].includes(options.mode)) {
      options.dryrun = options.mode === 'dryrun';
      options.mode = 'clean';
      continue;
    }
    if (arg === '--dryrun' && options.mode === 'clean' && !options.dryrun) {
      options.dryrun = true;
      continue;
    }
    if (['--add', '--del', '--list', '--dryrun'].includes(arg) && options.mode === 'sync') {
      options.mode = arg.slice(2);
      if (skillOperation(options.mode)) {
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) values.push(args[++i]);
      }
    } else throw new Error(`未知、重复或互斥参数：${arg}\n用法：${USAGE}`);
  }
  if (skillOperation(options.mode)) {
    check(values.length > 0, `--${options.mode} 需要明确的 type:name。`);
    options.targets = values.map((value) => typedName(value, { rule: true, agent: true }));
    check(new Set(options.targets.map(({ type, name }) => `${type}:${name}`)).size === values.length, '重复 type:name');
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
  const harnesses = dependencies.harnesses ?? readHarnesses();
  const homeVars = Object.values(harnesses).map((definition) => definition['home-env']).filter(Boolean);
  // Git source downloads retain the caller's authentication environment.
  for (const key of Object.keys(env)) {
    if (['HOME', 'USERPROFILE', 'XDG_STATE_HOME', ...homeVars].includes(key.toUpperCase())) delete env[key];
  }
  Object.assign(env, {
    HOME: homeDir, USERPROFILE: homeDir,
  });
  for (const definition of Object.values(harnesses)) {
    if (definition['home-env']) env[definition['home-env']] = resolve(homeDir, dirname(definition['skill-dir']));
  }
  return { ...dependencies, harnesses, env, gitEnv: dependencies.gitEnv ?? baseEnv, homeDir,
    stateDir: join(homeDir, '.everything-harness') };
}

function objectKeys(value, keys, label) {
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key)), `${label} 格式错误或包含未知字段。`);
}

export function validateManifest(value, { local = false, harnesses = readHarnesses() } = {}) {
  objectKeys(value, local ? ['agents', 'sync-rules', 'enabled-rules'] : ['agents', 'skill', 'agents-md', 'sync-rules', 'deleted'], '清单');
  if (!local || Object.hasOwn(value, 'agents')) value.agents = agentNames(value.agents, harnesses);
  if (local) {
    validateRules(Object.hasOwn(value, 'sync-rules') ? value['sync-rules'] : {});
    if (value['enabled-rules'] !== undefined) {
      check(Array.isArray(value['enabled-rules']) && value['enabled-rules'].every((name) => RULE_CALLBACKS.has(name)), 'enabled-rules 必须包含有效规则名称。');
      check(new Set(value['enabled-rules']).size === value['enabled-rules'].length, 'enabled-rules 包含重复规则。');
    }
    return value;
  }
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
  validateManifest(settings, { local: true, harnesses: dependencies.harnesses });
  return { path, text, settings };
}

function readCatalog(dependencies) {
  const manifest = validateManifest(parseJson((dependencies.fetchManifest ?? fetchManifest)(), '远程清单'), { harnesses: dependencies.harnesses });
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

function readHarnesses(dependencies = {}) {
  let definitions = dependencies.harnesses;
  if (!definitions) {
    const localFile = import.meta.url.startsWith('file:') && !(import.meta.main && process.argv[1] === '-')
      ? new URL('./harnesses.json', import.meta.url) : null;
    const text = dependencies.fetchHarnesses ? dependencies.fetchHarnesses()
      : localFile && existsSync(localFile) ? readFileSync(localFile, 'utf8') : fetchText(HARNESSES_URL);
    definitions = parseJson(text, 'harness 定义');
  }
  check(definitions && typeof definitions === 'object' && !Array.isArray(definitions), 'harness 定义必须是对象。');
  const names = new Set(Object.keys(definitions));
  for (const [name, definition] of Object.entries(definitions)) {
    skillName(name);
    objectKeys(definition, ['skill-dir', 'agents-md', 'home-env', 'aliases'], `harness:${name}`);
    for (const field of ['skill-dir', 'agents-md']) {
      const path = definition[field];
      check(typeof path === 'string' && path.trim() && path !== '.' && !isAbsolute(path)
        && !path.includes('\\0') && !path.split(/[/\\\\]/).includes('..'), `harness:${name} 的 ${field} 必须是 home 下的相对路径。`);
    }
    if (definition['home-env'] !== undefined) check(/^[A-Z][A-Z0-9_]*$/.test(definition['home-env']), `harness:${name} 的 home-env 无效。`);
    if (definition.aliases !== undefined) check(Array.isArray(definition.aliases), `harness:${name} 的 aliases 必须是数组。`);
    for (const alias of definition.aliases ?? []) {
      skillName(alias);
      check(!names.has(alias), `重复 harness 名称：${alias}`);
      names.add(alias);
    }
  }
  return definitions;
}

export function harnessPaths(name, dependencies = {}) {
  const definitions = dependencies.harnesses ?? readHarnesses(dependencies);
  const definition = definitions[harnessName(name, definitions)];
  const home = dependencies.homeDir ?? homedir(), env = dependencies.env ?? process.env;
  const override = definition['home-env'] && env[definition['home-env']];
  const path = (field) => override ? resolve(override, relative(dirname(definition['skill-dir']), definition[field]))
    : resolve(home, definition[field]);
  return { skillDir: path('skill-dir'), agentsMd: path('agents-md') };
}

export function instructionPaths(agents, dependencies = {}) {
  return agents.map((name) => harnessPaths(name, dependencies).agentsMd);
}

export function cleanupPaths(dependencies = {}, names, legacy = true) {
  const definitions = dependencies.harnesses ?? readHarnesses(dependencies);
  const scoped = { ...dependencies, harnesses: definitions };
  const home = dependencies.homeDir ?? homedir();
  const paths = (names ?? Object.keys(definitions)).flatMap((name) => [
    harnessPaths(name, scoped), harnessPaths(name, { ...scoped, env: {} }),
  ]);
  if (!legacy) return {
    skills: [...new Set(paths.map(({ skillDir }) => skillDir))],
    instructions: [...new Set(paths.map(({ agentsMd }) => agentsMd))],
  };
  const directories = [...new Set(paths.flatMap(({ skillDir, agentsMd }) => [dirname(skillDir), dirname(agentsMd)])
    .concat(legacy ? [home, join(home, '.agents')] : []))];
  const instructionNames = [...new Set(['AGENTS.md', 'CLAUDE.md', ...Object.values(definitions).map((definition) => basename(definition['agents-md']))])];
  return {
    skills: [...new Set(paths.map(({ skillDir }) => skillDir).concat(legacy ? [join(home, '.agents', 'skills')] : []))],
    instructions: [...new Set(paths.map(({ agentsMd }) => agentsMd).concat(directories.flatMap((directory) =>
      instructionNames.map((name) => join(directory, name)))))],
  };
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

export function prepareInstructionCleanup(targets, names) {
  const writes = new Map();
  for (const target of targets) {
    if (!existsSync(target)) continue;
    const path = realpathSync(target);
    if (writes.has(path)) continue;
    const original = readFileSync(path, 'utf8');
    const present = [...original.matchAll(/<!-- eh:([a-z0-9-]+):start -->/g)].map((match) => match[1]);
    const selected = names ? present.filter((name) => names.includes(name)) : present;
    const content = renderFragments(original, selected.map((name) => ({ name, deleted: true })));
    if (content !== original) writes.set(path, { content, names: selected });
  }
  return writes;
}

export function applyInstructionCleanup(writes, dryrun, log, status = '删除') {
  const failures = [];
  for (const [path, { content, names }] of writes) {
    if (!dryrun) {
      try { writeAtomic(path, content, log); }
      catch (error) {
        const message = `${path} 写入失败：${error.message}`;
        failures.push(message); log(message, { status: '失败' });
        continue;
      }
    }
    for (const name of names) log(`${dryrun ? '将移除 ' : ''}agents-md:${name} → ${path}`, { status });
  }
  return failures;
}

function prepareFragments(entries, agents, dependencies) {
  if (!entries.length || !agents.length) return [];
  const readFragment = dependencies.fetchFragment ?? ((name) => {
    const path = join(dependencies.getRepository(OWN_SOURCE), 'agents-md', `${name}.md`);
    check(lstatSync(dirname(path)).isDirectory() && lstatSync(path).isFile(), `片段源码不支持链接或特殊文件：${path}`);
    return readFileSync(path, 'utf8');
  });
  const fragments = entries.map(({ name }) => ({ name, content: readFragment(name) }));
  // Read and validate every target before replacing any managed content.
  return instructionPaths(agents, dependencies).map((target) => {
    const path = existsSync(target) ? realpathSync(target) : target;
    const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
    return { path, original, content: renderFragments(original, fragments), names: entries.map((entry) => entry.name) };
  });
}

function applyFragments(writes, dryrun, log) {
  if (writes.length) log(dryrun ? '检查指令片段' : '应用指令片段', { stage: true });
  for (const { path, original, content, names } of writes) {
    if (!dryrun && content !== original) writeAtomic(path, content, log);
    for (const name of names) {
      const status = original.includes(`<!-- eh:${name}:start -->`) ? '更新' : '新增';
      log(`${dryrun ? '将应用 ' : ''}agents-md:${name} → ${path}`, { status });
    }
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

function reportUnapplied(manifest, rules, appliedRules, dependencies, log) {
  const pendingRules = Object.keys(rules).filter((name) => !appliedRules.has(name));
  const members = new Set([...Object.values(manifest['sync-rules'] ?? {}), ...Object.values(rules)]
    .flatMap((entries) => entries.map(({ type_name }) => type_name)));
  const directories = Object.keys(dependencies.harnesses).map((name) => harnessPaths(name, dependencies).skillDir);
  const pendingSkills = manifest.skill.filter(({ name }) => !members.has(`skill:${name}`)
    && !directories.some((directory) => statSync(join(directory, name, 'SKILL.md'), { throwIfNoEntry: false })?.isFile()));
  if (pendingRules.length) log(`本次未应用的 rule：${pendingRules.map((name) => `rule:${name}`).join(', ')}`);
  if (pendingSkills.length) log(`未安装的独立skill：${pendingSkills.map(({ name }) => `skill:${name}`).join(', ')}`);
}

export function writeAtomic(path, text, log = createProgressLogger()) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, text, { flag: 'wx' }); renameSync(temporary, path); }
  finally { cleanupTemporary(temporary, log); }
}

function saveLocalSettings(local, log) {
  if (local.text === null) {
    mkdirSync(dirname(local.path), { recursive: true });
    try { writeFileSync(local.path, JSON.stringify(local.settings, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('本机设置刚被其他进程创建，请重新同步。');
      throw error;
    }
  } else {
    check(readFileSync(local.path, 'utf8') === local.text, '操作期间本机设置已被修改，请重新同步。');
    writeAtomic(local.path, JSON.stringify(local.settings, null, 2) + '\n', log);
  }
}

function parseJson(text, label) {
  try { return JSON.parse(text); } catch { throw new Error(`${label} 未返回有效 JSON。`); }
}

const SOURCE_FILE = '.eh-source.json';
const entryExists = (path) => Boolean(lstatSync(path, { throwIfNoEntry: false }));

function checkSources(entries, context) {
  for (const entry of entries) {
    for (const directory of context.skillDirs) {
      const file = join(directory, entry.name, SOURCE_FILE);
      if (!existsSync(file)) continue;
      const { source } = parseJson(readFileSync(file, 'utf8'), file);
      sourceName(source);
      check(source.toLowerCase() === entry.source.toLowerCase(), `来源冲突：${file} 已记录为 ${source}，清单要求 ${entry.source}。`);
    }
  }
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

export function fetchRepository(source, path, dependencies = {}) {
  sourceName(source);
  const env = { ...(dependencies.gitEnv ?? dependencies.env ?? process.env), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  runCommand('git', ['clone', '--quiet', '--depth=1', '--no-tags',
    ...(source.toLowerCase() === OWN_SOURCE.toLowerCase() ? ['--branch', 'main'] : []),
    '--', `https://github.com/${source}.git`, path], { env, timeout: 120_000 });
}

function skillMetadata(path) {
  const text = readFileSync(join(path, 'SKILL.md'), 'utf8');
  const header = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
  return {
    name: header.match(/^name:\s*['"]?([a-z0-9-]+)['"]?\s*$/m)?.[1],
    description: header.match(/^description:[ \t]*(\S.*)$/m)?.[1]?.replace(/^(['"])(.*)\1$/, '$2').trim(),
  };
}

export function findSkill(repository, entry) {
  const matches = [];
  const visit = (path) => {
    if (existsSync(join(path, 'SKILL.md'))) {
      if (skillMetadata(path).name === entry.name || basename(path) === entry.name) matches.push(path);
      return;
    }
    for (const item of readdirSync(path, { withFileTypes: true })) {
      if (item.isDirectory() && !['.git', 'node_modules', '.venv'].includes(item.name)) visit(join(path, item.name));
    }
  };
  if (entry.source.toLowerCase() === OWN_SOURCE.toLowerCase()) {
    const path = join(repository, 'skills', entry.name);
    if (existsSync(join(path, 'SKILL.md'))) matches.push(path);
  } else visit(repository);
  check(matches.length === 1, `${entry.source} / ${entry.name}：${matches.length ? '找到多个同名 skill' : '未找到 SKILL.md'}。`);
  const path = matches[0];
  const location = relative(realpathSync(repository), realpathSync(path));
  check(location.split(sep)[0] !== '..' && !isAbsolute(location),
    `skill 目录不能位于来源仓库之外：${path}`);
  const metadata = skillMetadata(path);
  check(metadata.name === entry.name && metadata.description, `${path} 的 SKILL.md 必须包含匹配的 name 和非空 description。`);
  const inspect = (directory) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (item.name === '.git') continue;
      const child = join(directory, item.name);
      check(!item.isSymbolicLink() && (item.isFile() || item.isDirectory()), `skill 不支持链接或特殊文件：${child}`);
      if (item.isDirectory()) inspect(child);
    }
  };
  check(!lstatSync(path).isSymbolicLink(), `skill 目录不能是链接：${path}`);
  inspect(path);
  return path;
}

export function fetchManifest() {
  return fetchText(MANIFEST_URL);
}

function fetchText(url) {
  return runCommand(process.platform === 'win32' ? 'curl.exe' : 'curl', ['-fsSL', '--connect-timeout', '20', '--max-time', '120', url]);
}

export function copySkill(entry, source, target, log = createProgressLogger()) {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`, backup = `${target}.${randomUUID()}.bak`;
  try {
    cpSync(source, temporary, { recursive: true, filter: (path) => basename(path) !== '.git' });
    writeFileSync(join(temporary, SOURCE_FILE), JSON.stringify({ source: entry.source }) + '\n');
    if (entryExists(target)) renameSync(target, backup);
    try { renameSync(temporary, target); }
    catch (error) {
      if (entryExists(backup)) renameSync(backup, target);
      throw error;
    }
    cleanupTemporary(backup, log);
  } finally { cleanupTemporary(temporary, log); }
}

function install(entries, prepared, context) {
  checkSources(entries, { ...context, skillDirs: [context.legacySkillsDir] });
  context.log('应用 skill 到目标目录', { stage: true });
  const directories = context.skillDirs;
  for (const entry of entries) {
    const written = new Set();
    for (const directory of directories) {
      mkdirSync(directory, { recursive: true });
      const target = join(realpathSync(directory), entry.name);
      if (written.has(target)) continue;
      const status = entryExists(target) ? '更新' : '新增';
      copySkill(entry, prepared.get(entry.name).path, target, context.log);
      written.add(target);
      context.log(`安装：${entry.source} / ${entry.name} → ${target}`, { status });
    }
    const legacy = join(context.legacySkillsDir, entry.name);
    if (entryExists(legacy) && (!existsSync(legacy) || !written.has(realpathSync(legacy)))) {
      const legacyContext = { ...context, skillDirs: [context.legacySkillsDir] };
      remove([entry], legacyContext);
    }
  }
}

function remove(entries, context, dryrun = false) {
  for (const entry of entries) {
    const targets = [...new Set(context.skillDirs.map((directory) => join(directory, entry.name)))];
    for (const target of targets) {
      if (!entryExists(target)) continue;
      if (!dryrun) removeDirectory(target);
      context.log(`${dryrun ? '将' : ''}删除本机安装：${entry.name} → ${target}`, { status: entry.deleted ? '过期' : '删除' });
    }
    if (!dryrun) check(targets.every((path) => !entryExists(path)), `${entry.name} 的目标安装仍存在，请检查对应目录。`);
  }
}

function contentEntries(manifest, members, deleted = false) {
  return members.map(({ type_name }) => {
    const { type, name } = typedName(type_name);
    const entry = (manifest[type] ?? []).find((entry) => entry.name === name)
      ?? (deleted ? deletedEntries(manifest, type).find((entry) => entry.name === name) : undefined);
    check(entry, `清单中不存在可同步内容：${type_name}`);
    return { ...entry, type };
  });
}

function manageLocal(options, dependencies, log) {
  const { manifest, local } = readCatalog(dependencies);
  const previous = effectiveRules(manifest, local);
  const previousAgents = effectiveAgents(manifest, local);
  const rules = local.settings['sync-rules'] ??= {};
  const affected = [], removedAgents = [];
  const enabled = options.mode === 'add';
  for (const { type, name } of options.targets) {
    if (type === 'agent') {
      const agents = local.settings.agents ?? [...previousAgents];
      local.settings.agents = enabled ? [...new Set([...agents, name])] : agents.filter((agent) => agent !== name);
      if (!enabled) removedAgents.push(name);
    } else if (type === 'rule') {
      check(Object.hasOwn(manifest['sync-rules'] ?? {}, name), `不存在规则：rule:${name}`);
      affected.push(...contentEntries(manifest, previous[name] ?? []));
      affected.push(...contentEntries(manifest, manifest['sync-rules'][name]));
      rules[name] = enabled ? structuredClone(manifest['sync-rules'][name]) : [];
      const explicitRules = local.settings['enabled-rules'] ?? [];
      local.settings['enabled-rules'] = enabled ? [...new Set([...explicitRules, name])] : explicitRules.filter((rule) => rule !== name);
    } else {
      affected.push(...contentEntries(manifest, [{ type_name: `${type}:${name}` }], !enabled));
      setMembership(rules, manifest['sync-rules'] ?? {}, `${type}:${name}`, enabled);
    }
  }
  validateManifest(local.settings, { local: true, harnesses: dependencies.harnesses });
  if (enabled) return syncCatalog({ mode: 'sync' }, dependencies, log, { manifest, local });

  log('更新本机同步设置', { stage: true });
  const retained = new Set(Object.values(effectiveRules(manifest, local)).flatMap((members) => members.map(({ type_name }) => type_name)));
  const entries = [...new Map(affected.filter(({ type, name }) => !retained.has(`${type}:${name}`))
    .map((entry) => [`${entry.type}:${entry.name}`, entry])).values()];
  const agents = effectiveAgents(manifest, local);
  if (entries.length) executePlans([{ entries }], { mode: 'del' }, agents, dependencies, log);
  if (removedAgents.length) {
    const cleanupTargets = cleanupPaths(dependencies, removedAgents, false);
    const retainedTargets = cleanupPaths(dependencies, agents, false);
    const location = (path) => existsSync(path) ? realpathSync(path) : resolve(path);
    for (const type of ['skills', 'instructions']) {
      const retained = new Set(retainedTargets[type].map(location));
      cleanupTargets[type] = cleanupTargets[type].filter((path) => !retained.has(location(path)));
    }
    const entries = ['skill', 'agents-md'].flatMap((type) => [
      ...(manifest[type] ?? []).map((entry) => ({ ...entry, type })), ...deletedEntries(manifest, type),
    ]);
    executePlans([{ entries }], { mode: 'del' }, agents, { ...dependencies, cleanupTargets }, log);
  }
  saveLocalSettings(local, log);
  log('完成', { stage: true });
  log(`本机同步设置已保存：${local.path}`, { status: '完成' });
}

function createTemporaryDirectory(prefix, dependencies) {
  const parent = dependencies.tempDir ?? join(homedir(), 'temp');
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, prefix));
}

export function removeDirectory(root) {
  let failedPath = root;
  const remove = (path) => {
    failedPath = path;
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (!entry) return;
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      for (const name of readdirSync(path)) remove(join(path, name));
    }
    failedPath = path;
    // Delete each entry separately: native recursive removal can report only the root.
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  };
  try { remove(root); }
  catch (error) {
    const message = `删除失败：${failedPath}；${error.message}`;
    throw new Error(message, { cause: error });
  }
}

function cleanupTemporary(path, log) {
  try { removeDirectory(path); return true; }
  catch (error) {
    log(`[警告] 临时内容清理失败，继续执行：${error.message}\n残留位置：${path}`);
    return false;
  }
}

function withRepositories(dependencies, log, action) {
  const repositories = new Map();
  let root;
  const cleanupRepositories = () => {
    if (!root) return;
    const path = root;
    root = undefined;
    log('清理临时目录', { stage: true });
    if (cleanupTemporary(path, log)) log(`已清理：${path}`, { status: '通过' });
  };
  const getRepository = (source) => {
    const key = source.toLowerCase();
    if (!repositories.has(key)) {
      root ??= createTemporaryDirectory('eh-check-', dependencies);
      const path = join(root, `source-${repositories.size}`);
      try {
        (dependencies.fetchRepository ?? fetchRepository)(source, path, dependencies);
        repositories.set(key, path);
        log(`下载完成：${source} → ${path}`, { status: '完成' });
      } catch (error) { repositories.set(key, error); }
    }
    const result = repositories.get(key);
    if (result instanceof Error) throw result;
    return result;
  };
  try { return action({ ...dependencies, getRepository, cleanupRepositories }); }
  finally { cleanupRepositories(); }
}

function downloadSources(entries, dependencies, log, tolerateFailure = false) {
  const sources = new Map();
  for (const entry of entries) {
    const source = entry.type === 'agents-md' ? (dependencies.fetchFragment ? null : OWN_SOURCE) : entry.source;
    if (source) sources.set(source.toLowerCase(), source);
  }
  for (const source of sources.values()) {
    try { dependencies.getRepository(source); }
    catch (error) {
      if (!tolerateFailure) throw error;
      log(`${source} 下载失败：${error.message}`, { status: '失败' });
    }
  }
}

function executePlans(plans, options, agents, dependencies, parentLog) {
  if (!skillOperation(options.mode)) return true;
  for (const { rule, entries, passed, error, unmet = [], localOverride = false } of plans) {
    const grouped = options.mode === 'add' && rule;
    if (grouped) parentLog(`自动配置: ${rule}`, { stage: true });
    const log = grouped ? (message, metadata = {}) => parentLog(message, { ...metadata, substage: true }) : parentLog;
    if (error) throw error;
    if (grouped) {
      if (!entries.length) log(`rule:${rule}：${localOverride ? '本机覆盖后' : '规则'}成员为空，本次没有选中要安装或更新的内容。`);
      const allowed = passed ?? RULE_CALLBACKS.get(rule)({ explicit: options.explicit !== false, platform: dependencies.platform ?? process.platform, log, unmet });
      if (!allowed) { log(`rule:${rule}：${unmet.join('；')}`, { status: '未命中' }); return false; }
    }
    if (!entries.length) continue;
    if (options.mode === 'add') check(agents.length > 0, '生效 agents 为空；请先设置目标。');
    const skills = entries.filter(({ type }) => type === 'skill');
    const fragments = entries.filter(({ type }) => type === 'agents-md');
    const context = skills.length ? makeContext(dependencies, log, agents, options.mode === 'del') : null;
    if (context) checkSources(skills, context);
    if (options.mode === 'add' && !dependencies.sourcesPrepared) {
      log('下载源码', { stage: true });
      downloadSources(entries, dependencies, log);
    }
    const names = fragments.map(({ name }) => name);
    const writes = options.mode === 'del'
      ? prepareInstructionCleanup(names.length ? (dependencies.cleanupTargets ?? cleanupPaths(dependencies)).instructions : [], names)
      : prepareFragments(fragments, agents, dependencies);
    if (options.mode === 'add') {
      if (skills.length) {
        log('校验 skill 源码结构', { stage: true });
        const prepared = new Map(skills.map((entry) => [entry.name, { path: findSkill(dependencies.getRepository(entry.source), entry) }]));
        if (!options.dryrun) install(skills, prepared, context);
      }
    } else {
      log('清理 skill 和 sysprompt', { stage: true });
      if (context) remove(skills, context, options.dryrun);
    }
    if (options.mode === 'del') {
      const failures = applyInstructionCleanup(writes, options.dryrun, log);
      check(!failures.length, `sysprompt 清理失败：${failures.join('\n')}`);
    } else applyFragments(writes, options.dryrun, log);
  }
  return true;
}


function makeContext(dependencies, log, agents, cleanup = false) {
  if (!cleanup) check(agents.length > 0, '生效 agents 为空；请先用 --add agent:codex 或 --add agent:copilot 设置目标。');
  return { skillDirs: cleanup ? (dependencies.cleanupTargets ?? cleanupPaths(dependencies)).skills : agents.map((agent) => harnessPaths(agent, dependencies).skillDir),
    legacySkillsDir: join(dependencies.homeDir ?? homedir(), '.agents', 'skills'), log };
}

function clean(options, dependencies, log) {
  const userHome = resolve(dependencies.homeDir ?? homedir()), roots = [userHome];
  if (options.home !== undefined) {
    const selected = homeDependencies(options.home, dependencies).homeDir;
    if (relative(userHome, selected) !== '') roots.push(selected);
  }
  for (const root of roots) {
    check(!existsSync(root) || statSync(root).isDirectory(), `清理根目录不是目录：${root}`);
  }
  log('读取清单', { stage: true });
  const manifest = validateManifest(parseJson((dependencies.fetchManifest ?? fetchManifest)(), '远程清单'), { harnesses: dependencies.harnesses });
  const names = new Set([...manifest.skill, ...deletedEntries(manifest, 'skill')].map(({ name }) => name));
  const paths = new Set(), instructions = [];
  for (const root of roots) {
    const targets = cleanupPaths({ harnesses: dependencies.harnesses, homeDir: root, env: root === userHome ? dependencies.env ?? process.env : {} });
    for (const directory of targets.skills) for (const name of names) {
      const path = join(directory, name);
      if (entryExists(path)) paths.add(path);
    }
    instructions.push(...targets.instructions);
  }
  const writes = prepareInstructionCleanup(instructions);
  const settings = roots.map((root) => join(root, '.everything-harness')).filter(entryExists);
  log('清理 skill 和 sysprompt', { stage: true });
  const failures = [];
  for (const path of paths) {
    try {
      if (!options.dryrun) removeDirectory(path);
      log(`${options.dryrun ? '将删除' : '删除'} skill：${path}`, { status: '删除' });
    } catch (error) { failures.push(error.message); log(error.message, { status: '失败' }); }
  }
  failures.push(...applyInstructionCleanup(writes, options.dryrun, log));
  log('清理本地配置', { stage: true });
  for (const path of settings) {
    try {
      if (!options.dryrun) removeDirectory(path);
      log(`${options.dryrun ? '将删除' : '删除'}配置目录：${path}`, { status: '删除' });
    } catch (error) { failures.push(error.message); log(error.message, { status: '失败' }); }
  }
  check(!failures.length, `清理失败；已完成操作保留：\n${failures.join('\n')}`);
  log('完成', { stage: true });
  log(`${options.dryrun ? '预览' : '清理'}完成：${paths.size} 个 skill 路径，${writes.size} 个指令文件，${settings.length} 个配置目录。`, { status: '完成' });
}

export function sync(args, dependencies = {}) {
  const options = parseArgs(args);
  const log = dependencies.log ?? (options.help || options.mode === 'list' ? writeOutput : createProgressLogger());
  if (options.help) {
    log(`用法：${USAGE}\n清单：远程 harness.json；本机 ~/.everything-harness/harness.json。\n规则 auto 无额外条件，win 要求 Windows，learn 要求 Windows 和本机显式启用。\n--list 显示清单和本机同步设置；--dryrun 预览并校验源码结构，保留正式安装与配置。`);
    return;
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  check(major > 22 || (major === 22 && minor >= 20), '需要 Node.js ≥22.20.0。');
  dependencies = { ...dependencies, harnesses: readHarnesses(dependencies) };
  for (const target of options.targets ?? []) {
    if (target.type === 'agent') target.name = harnessName(target.name, dependencies.harnesses);
  }
  check(new Set((options.targets ?? []).map(({ type, name }) => `${type}:${name}`)).size === (options.targets?.length ?? 0), '重复 type:name');
  if (options.mode === 'clean') return clean(options, dependencies, log);
  dependencies = homeDependencies(options.home, dependencies);
  return withRepositories(dependencies, log, (scoped) => skillOperation(options.mode)
    ? manageLocal(options, scoped, log) : syncCatalog(options, scoped, log));
}

function syncCatalog(options, dependencies, log, catalog) {
  const dryrun = options.mode === 'dryrun';
  if (options.mode !== 'list') {
    const existing = existsSync(join(stateDirectory(dependencies), 'harness.json'));
    log(`${dryrun ? '预览' : ''}${existing ? '更新' : '创建'}本地配置`, { stage: true });
  }
  const { manifest, local } = catalog ?? readCatalog(dependencies);
  if (options.mode === 'list') { listCatalog(manifest, local, log); return; }
  if (!dryrun) saveLocalSettings(local, log);
  log(`${dryrun ? '将保存配置' : '配置已保存'}：${local.path}`, { status: local.text === null ? '创建' : '更新' });
  const agents = effectiveAgents(manifest, local);
  const rules = effectiveRules(manifest, local), appliedRules = new Set();
  if (!agents.length) {
    log('生效 agents 为空，无需安装。', { status: '跳过' });
    log('完成', { stage: true });
    reportUnapplied(manifest, rules, appliedRules, dependencies, log);
    return;
  }
  const names = deletedEntries(manifest, 'agents-md').map(({ name }) => name);
  const writes = prepareInstructionCleanup(names.length ? cleanupPaths(dependencies).instructions : [], names);
  const deleted = deletedEntries(manifest, 'skill');
  const context = makeContext(dependencies, log, agents);
  const cleanupContext = makeContext(dependencies, log, agents, true);
  checkSources(deleted, cleanupContext);
  log('清理 skill 和 sysprompt', { stage: true });
  remove(deleted, cleanupContext, dryrun);
  const cleanupFailures = applyInstructionCleanup(writes, dryrun, log, '过期');
  check(!cleanupFailures.length, `sysprompt 清理失败：${cleanupFailures.join('\n')}`);
  log('下载源码', { stage: true });
  const plans = Object.entries(rules).map(([name, members]) => {
    const plan = { rule: name, entries: contentEntries(manifest, members), unmet: [],
      localOverride: Object.hasOwn(local.settings['sync-rules'] ?? {}, name) };
    try {
      plan.passed = RULE_CALLBACKS.get(name)({ explicit: local.settings['enabled-rules']?.includes(name) === true, platform: dependencies.platform ?? process.platform,
        log() {}, unmet: plan.unmet });
      if (plan.passed) checkSources(plan.entries.filter(({ type }) => type === 'skill'), context);
    } catch (error) { plan.error = error; }
    return plan;
  });
  downloadSources(plans.filter((plan) => plan.passed && !plan.error).flatMap(({ entries }) => entries), dependencies, log, true);
  dependencies = { ...dependencies, sourcesPrepared: true };
  const failures = [];
  for (const plan of plans) {
    const { rule: name, entries } = plan;
    try {
      const applied = executePlans([plan], { mode: 'add', dryrun }, agents, dependencies, log);
      if (applied && !dryrun && entries.length) appliedRules.add(name);
    }
    catch (error) { failures.push(`${name}: ${error.message}`); log(`[rule:${name}] 失败：${error.message}`, { status: '失败' }); }
  }
  const retained = new Set(plans.filter(({ passed }) => passed !== false)
    .flatMap(({ entries }) => entries.map(({ type, name }) => `${type}:${name}`)));
  const removals = [...new Map(plans.filter(({ passed }) => passed === false).flatMap(({ entries }) => entries)
    .filter(({ type, name }) => !retained.has(`${type}:${name}`)).map((entry) => [`${entry.type}:${entry.name}`, entry])).values()];
  if (removals.length) {
    try { executePlans([{ entries: removals }], { mode: 'del', dryrun }, agents, dependencies, log); }
    catch (error) { failures.push(`清理未命中规则：${error.message}`); log(error.message, { status: '失败' }); }
  }
  dependencies.cleanupRepositories();
  if (failures.length) {
    reportUnapplied(manifest, rules, appliedRules, dependencies, log);
    throw new Error(`规则检查或同步失败：${failures.join(', ')}；已完成操作保留，请修复后重试。`);
  }
  log('完成', { stage: true });
  log(dryrun ? '同步预览完成。' : '规则同步完成。', { status: '完成' });
  reportUnapplied(manifest, rules, appliedRules, dependencies, log);
}

if (import.meta.main) {
  try { sync(process.argv.slice(2)); }
  catch (error) { createProgressLogger((line) => writeOutput(line, process.stderr.fd))(`操作失败：${error.message}`, { status: '失败' }); process.exitCode = 1; }
}
