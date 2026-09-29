---
name: harness-manage
description: 管理 eh（everything-harness）的 skill、AGENTS.md 片段和同步规则；确认当前 session 的 skill 目录后，使用远程 sync.mjs 安装、删除、检测环境及设置全局 agents。
---

# Harness 管理

`eh` 是 `everything-harness` 的简称。源码在本仓库维护，发布流程为：修改源码 → commit / push → 远程 sync → 单向覆盖本机内容。用户要求先审阅或暂缓发布时，保留改动等待确认。

执行安装、删除或配置修改前，先明确范围：带 `--local` 操作本机安装与规则覆盖；省略时修改远程清单并 commit / push。范围不明确时先询问。“本地的 skill”也可能指待发布源码，需要确认具体范围。

## 确认当前 session 的同步位置

执行同步指令前，先确认当前 session 实际使用的 skill 目录，再生成命令：

1. 以当前 session 的 skill 清单、加载路径或实际读取的 `SKILL.md` 路径为依据。优先检查本 skill 的安装位置；仓库中的 `skills/` 源码、当前工作目录和内置 `.system` 技能目录不能单独作为同步位置的依据。
2. 展开目录别名并检查软链接，确认安装目录与实际文件的对应关系。从 `<根目录>/.agents/skills/<skill>/SKILL.md` 推导同步根目录；agent 目录下的 skill 链接应追溯到共享安装位置。
3. 将同步根目录与用户主目录 `~` 比较，比较时规范化路径并处理软链接。根目录为用户主目录时可省略 `--home`；根目录为其他位置时，所有同步、增删、预检及重试指令都必须携带 `--home "<已确认的绝对根目录>"`。
4. 用户明确指定目标位置时采用用户指定值；session 中存在多个安装根目录，或路径结构无法对应 `--home` 时，先确认目标再执行。

例如，当前 session 从 `/work/demo/.agents/skills/harness-manage/SKILL.md` 加载本 skill，则同步命令为：

```sh
curl -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --home "/work/demo"
```

需要 Node.js ≥22.20.0、npm/npx、Git 和 curl。面向用户统一使用远程入口：

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module -"
```

Linux / macOS：

```sh
curl -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module -
```

在 node 参数末尾追加操作及已确认位置所需的 `--home`，Windows 放在外层双引号内。

## 指定内容根目录

`--home <目录>` 指定本次同步的根目录，默认用户主目录 `~`。传入后，skill、指令和本机配置分别使用该目录下的 `.agents`、`.codex`、`.copilot`、`.everything-harness`；显式目录优先于 `CODEX_HOME`、`COPILOT_HOME`。相对路径按启动目录解析，安装和检查子进程使用同一主目录。Git 发布沿用原环境的提交身份与认证。

当已确认当前工作目录就是同步根目录时，可使用以下写法自动将所在文件夹传给 `--home`；其他位置使用已确认的绝对根目录。

Linux / macOS：

```sh
curl -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --home "$PWD"
```

Windows PowerShell：

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --home `"$($PWD.Path)`""
```

这里的所在文件夹是运行命令时的工作目录。`--home` 可与 `--local`、`--add`、`--del`、`--list`、`--dryrun` 等模式组合；目录选择只对本次命令生效。

## 添加参数

`--add` 只接收一个或两个参数：

- 一个参数：`--add <type>:<name>`。类型支持 `skill`、`agents-md`、`rule`。自有 skill 默认来源为 `Charbddlie/everything-harness`。
- 两个参数：`--add <owner>/<repo> skill:<name>`。第一个参数是 GitHub 来源，第二个参数是完整类型名称。其他来源的 skill 使用此形式。
- 片段和规则使用单参数。批量添加通过 `rule:<name>` 的成员列表完成。

例如：

```text
--add skill:harness-manage
--add owner/repo skill:example
--add agents-md:win-dev
--add rule:learn
--local --add rule:learn
```

自有 skill 使用单参数即可；本机添加也遵循相同参数规则。本机 add 的内容必须已存在于远程活动清单。远程新增自有内容时，先发布 `skills/<name>/` 或 `agents-md/<name>.md` 正文，再运行 add。

## 清单与规则

远程 `harness.json` 包含：

- `agents`：全局目标，支持 `codex`、`github-copilot`，默认两者。
- `skill`：活动 skill，记录 `name`、`source`。
- `agents-md`：活动片段，记录 `name`，正文来源固定为 eh。
- `sync-rules`：规则名到成员列表的对象，每个成员为 `{"type_name":"skill:NAME"}` 或 `{"type_name":"agents-md:NAME"}`。
- `deleted`：独立删除记录。Skill 保存 `type_name`、`source`，片段仅保存 `type_name`。

同步条件统一由规则回调管理：

| 规则 | 条件 | 当前成员 |
| --- | --- | --- |
| `auto` | 无额外条件 | copilot-api、harness-manage 与通用片段 |
| `win` | Windows | win-dev |
| `learn` | Windows 且通过 add 显式调用 | paper-add、paper-read、zotero-init |

规则回调在 `sync.mjs` 注册，复用 Windows 和显式调用检测函数。规则成员只引用活动 skill 或片段，不能嵌套规则。

普通 sync 按清单顺序逐条执行规则的 add，标记为非显式调用。检测顺序为：规则回调 → 检测函数 → 本批所有 skill 的 `dryrun.mjs` → 批量安装。条件未满足时跳过该规则，已有安装保留。

测试前通过 `npx skills` 在临时项目准备源码，测试全部通过后才覆盖正式安装并写入片段；临时项目随后清理。测试失败时保留本批正式安装和原配置，继续检查后续规则并汇总错误。Skill 测试仅检查环境与配置，业务操作、用户文件上传和计费 API 调用排除在检查范围外。纯说明 skill 可没有 dryrun；自有 skill 包含脚本时必须提供 dryrun，第三方存在此入口时同样执行。

## 删除与配置

- `--del skill:NAME`、`--del agents-md:NAME`：删除指定内容，可一次传多个名称。
- `--del rule:learn`：展开该规则的全部远程成员，直接删除；跳过规则条件与 skill 测试，保留来源和片段标记校验。
- 带 `--local` 时，删除本机安装并从本机生效规则移除成员，远程正文与清单保留。
- 省略 `--local` 时，从活动数组和所有规则移除成员，将删除记录放入 `deleted`；对应自有 skill 目录或片段文件与清单一起提交并推送。第三方来源仓库保持不变。
- `--add_agents codex` / `--del_agents github-copilot` 调整全局目标，支持多个 agent；加 `--local` 设置本机覆盖。下次同步生效，已有安装保留。
- `--auto_sync true|false type:name` 保留为兼容入口，通过 `sync-rules` 调整成员。true 恢复远程所属规则，未分组内容加入 auto；false 从生效规则移除。此操作只改配置。
- `--list` 展示内容来源、规则成员、本机覆盖、全局目标和删除记录。
- `--dryrun` 以普通 sync 的非显式上下文运行规则检测与 skill 测试，预告删除，保留个人安装和配置。

过时项由 eh 的 `deleted` 清单识别。`skills list` 提供本机安装和来源信息，`skills remove` 执行卸载。已记录来源发生冲突时停止清理。删除记录优先于本机规则覆盖并长期保留；已删除名称只能重试 del，改名需创建新名称。

## 本机覆盖与迁移

本机 `~/.everything-harness/harness.json` 首次创建为 `{"sync-rules":{}}`，可另有顶层 `agents`。本机每条规则整份覆盖同名远程成员列表；移除本机对应规则键即可恢复跟随远程。正文、来源与删除记录始终取远程。

显式 `--local --add rule:NAME` 使用远程完整成员列表，成功后恢复该组本机成员；后续普通 sync 仍检查规则条件，因此 learn 保持显式调用要求。本机 del rule 删除整组并移除本机生效成员。

旧 `skills` / `skill`、`fragments` / `agents-md` 中的 `auto_sync` 迁为规则成员覆盖：true 优先沿用远程所属规则，未分组内容进入 auto；false 从生效规则移除。新文件缺失时迁入旧 `skills.json`、`agents-md.json`，保留原文件作备份，忽略旧 skill 级 agents。新文件存在后以新文件为准。列表和预检只读取迁移结果，同步或本机操作成功后保存新配置。新旧字段有歧义时先合并再重试。

空 agents 暂停 sync 和预检，显式安装、删除需先设置目标。Codex 与 Copilot 共用 `~/.agents/skills` 的一份实体，目录与锁文件由 skills 管理。片段按 `<!-- eh:NAME:start -->` / `<!-- eh:NAME:end -->` 原位覆盖，保留标记外内容、未选中块和目标文件软链接。

远程管理在临时副本中完成 Git 操作，保持用户工作区原状。失败时保留已完成的本机操作；commit / push 失败保留操作副本并提示重试。删除后的源码可从 Git 历史恢复。发布源码时只迁入说明、脚本和必要资源，凭据、缓存和本机配置放在安装目录之外。
