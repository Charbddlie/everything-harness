---
name: harness-manage
description: 管理 eh 的本机同步范围与 harness 目标；确认 session 的安装根目录后，使用 sync.mjs 启停 skill、片段、规则和 agent 同步，检查或清理安装。当用户提到“更新skill”, “同步eh”时触发。
---

# Harness 管理

`eh` 指 everything-harness。源码发布到 GitHub 后，由 `sync.mjs` 单向覆盖安装。需要 Node.js ≥22.20.0、Git 和 curl；运行时直接下载、检查和复制目录。

## 确认范围

执行前从当前 session 的 skill 清单、实际 `SKILL.md` 路径和 agent 环境变量确定同步根目录。`.agents/skills`、`.codex/skills`、`.copilot/skills` 的所属根目录才是内容 home，源码仓库的 `skills` 不能作为安装位置的依据。

- 根目录为用户主目录时可省略 `--home`；其他位置必须传入 `--home "<绝对目录>"`。
- `--add`、`--del` 管理本机同步选择；内容、来源和规则定义由仓库的 `harness.json` 维护。
- 用户未明确目标位置时，先确认再操作。

## 入口

Windows PowerShell：

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module -"
```

Linux / macOS：

```sh
curl -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module -
```

在 node 参数末尾追加操作；Windows 放在外层双引号内。当前目录已确认为内容根目录时，可使用：

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --home `"$($PWD.Path)`""
```

## 操作

| 参数 | 行为 |
| --- | --- |
| 无参数 | 按清单顺序执行同步规则 |
| `--list` | 显示远程内容、本机覆盖、agents 和删除项 |
| `--dryrun` | 只下载并检查；失败返回非零，不修改正式安装、片段和配置 |
| `--clean` | 清理本机项目内容及整个 `.everything-harness` 配置目录；可加 `--dryrun` 预览 |
| `--add skill:NAME` | 将清单中的 skill 加入本机同步范围并同步 |
| `--add agents-md:NAME` | 将清单中的片段加入本机同步范围并同步 |
| `--add rule:NAME` | 恢复规则全部远程成员，保存显式启用状态并同步 |
| `--add agent:NAME` | 启用 harness 并同步，如 `agent:codex`、`agent:copilot` |
| `--del skill:NAME` / `--del agents-md:NAME` | 停止对应内容的同步，清理其本机安装 |
| `--del rule:NAME` | 停用规则，清理该规则独有的已安装成员 |
| `--del agent:NAME` | 停用 harness，清理该目标中的项目内容 |

`--add`、`--del` 接收一个或多个 `type:name`，可混合内容、规则和 agent。所有模式支持 `--home`。Skill 来源直接读取清单，成员仍受所属规则条件约束。删除内容、规则或 agent 时保留其他同步目标仍需要的内容。

## 路径与覆盖

`harnesses.json` 以名称为键，`skill-dir` 指定 skill 目录，`agents-md` 指定指令文件，两个路径都相对 home。脚本通过名称读取对应定义；本地运行读取脚本旁边的 JSON，远程管道运行读取远程 main 定义。

可选 `home-env` 指定 harness 根目录环境变量，对应默认 `skill-dir` 的父目录；`aliases` 兼容旧名称。当前提供 codex 和 copilot，copilot 兼容 github-copilot。新增 harness 时在 JSON 中定义路径，再用 `--add agent:NAME` 启用。

Skill 正文安装到生效 agents 的 `<home>/.codex/skills/<name>`、`<home>/.copilot/skills/<name>`，用户主目录和自定义 home 使用相同布局。省略 `--home` 时尊重 `CODEX_HOME`、`COPILOT_HOME`。对应 skill 安装成功后清理旧 `.agents/skills` 副本，下载或安装失败时旧副本保留。

指令片段始终按生效 agents 写入 `<home>/.codex/AGENTS.md`、`<home>/.copilot/copilot-instructions.md`。省略 home 时尊重 `CODEX_HOME`、`COPILOT_HOME`；显式 home 优先。保留 `<!-- eh:NAME:start -->` / `<!-- eh:NAME:end -->` 之外的正文。

Skill 每次同步完整覆盖，清理目标内的过时文件，保留清单外内容。`.eh-source.json` 保存来源，来源冲突时停止；无标记的同名目录按清单选中覆盖或删除，其他工具的锁文件保留。删除选中 skill 时检查当前 home 的 `.agents`、`.codex`、`.copilot` 及环境变量指定位置。片段清理覆盖这些目录及 home 根目录中的 `AGENTS.md`、`CLAUDE.md`、`copilot-instructions.md`，保留其他正文。

## 规则与检查

`harness.json` 的 `skill` 记录包含 `name`、`source`，`agents-md` 记录包含 `name`。`sync-rules` 将规则映射到 `[{"type_name":"skill:NAME"}]` 或片段成员。

| 规则 | 条件 |
| --- | --- |
| `auto` | 无额外条件 |
| `win` | Windows |
| `learn` | Windows 且已通过 `--add rule:learn` 显式启用 |

普通同步先创建或更新本地配置、清理实际存在的过期 skill 和 sysprompt，再检测规则并统一下载所需来源。命中规则时检查并新增或更新其 skill 和 agents-md；最后清理仅属于未命中规则的已安装内容。多个规则共用的内容只要仍被命中规则需要就保留，规则外内容也保留。每个来源在单次执行中下载一次，各规则共用副本，指令片段从自有仓库副本读取，结束后统一清理。自有来源读取 main，第三方读取默认分支；第三方可使用仓库根目录或嵌套的 skill 目录，重复名称报错。

普通同步依次显示“创建/更新本地配置”“清理 skill 和 sysprompt”“下载源码”。下载标题即时输出，每个来源完成后输出一行。`自动配置: <rule_name>` 使用一级编号，配置内的检查和应用使用 `n1.n2` 子编号，每项配置从 1 开始。清理信息仅针对实际存在的内容：过期项显示 `[过期]`，规则清理显示 `[删除]`；应用时显示 `[新增]` 或 `[更新]`，`[未命中]` 列出具体条件。

同步以“完成”步骤收尾，按需列出“本次未应用的 rule”和“未安装的独立skill”。独立 skill 指远程规则及本机生效规则均未包含的 skill，安装状态按 harness 定义检查。未命中、失败、成员为空的规则及 `--dryrun` 中的规则均未应用。本机空数组会覆盖远程规则，界面会提示成员为空；`--add rule:auto` 可恢复 auto 的远程成员并立即应用。普通同步开头保存配置并保留本机覆盖，后续步骤失败时已完成的配置更新仍保留。

dryrun 环境检查仅适用于自有来源，自有 skill 包含脚本时必须提供 `dryrun.mjs`。第三方 skill 完成源码结构校验后直接应用。检查只验证环境与配置，不上传文件或调用业务、计费 API。普通同步和 add 中，环境检查未通过只报告警告，仍应用内容并保存设置；显式 `--dryrun` 检查源码结构和自有 skill 环境，保留正式安装，检查失败返回非零。

临时源码位于用户主目录的 `~/temp`，不随 `--home` 改变。临时目录、写入暂存文件或替换备份删除失败时，报告具体失败路径和残留位置，继续后续步骤；不会覆盖此前的操作错误。下载、结构校验、复制和正式内容删除失败仍中止对应操作。

## 本机配置

本机 `<home>/.everything-harness/harness.json` 首次保存 `{"sync-rules":{}}`，可包含 `agents` 和 `enabled-rules`。本机每个规则完整覆盖同名远程规则；移除对应键即跟随远程。`enabled-rules` 记录显式启用的规则，使 learn 的启用状态持续生效；调整成员不会自动显式启用规则。空 agents 暂停安装。远程 `deleted` 项优先清理，清单中的活动内容才能加入同步。

## 清理本机内容

先预览，再去掉 `--dryrun` 执行：

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --clean --dryrun"
```

额外清理已确认的内容根目录：

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --clean --home `"$($PWD.Path)`" --dryrun"
```

Linux / macOS：

```sh
curl -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --clean --home "$PWD" --dryrun
```

`--clean` 读取清单后仅执行本机清理，`--home` 是额外目标，始终同时清理用户主目录。它删除两处 `.agents/skills`、`.codex/skills`、`.copilot/skills` 及用户 agent 环境变量指定位置中，远程活动项和删除项的所有同名 skill，不受来源标记或本机开关限制。

指令清理覆盖各根目录及上述三个子目录中的 `AGENTS.md`、`CLAUDE.md`、`copilot-instructions.md`，移除所有 eh 标记块，保留文件和其他正文。删除各清理根目录中的整个 `.everything-harness`，包括本机设置和旧配置；保留其他 skills、外部锁文件和远程清单。再次同步从远程默认设置初始化。删除失败会报告具体路径并返回非零，已完成操作保留。
