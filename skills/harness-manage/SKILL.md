---
name: harness-manage
description: 管理 eh 的 skill、指令片段和同步规则；确认 session 的安装根目录后，使用远程 sync.mjs 同步、检查、增删内容及设置 agents。
---

# Harness 管理

`eh` 指 everything-harness。源码发布到 GitHub 后，由 `sync.mjs` 单向覆盖安装。需要 Node.js ≥22.20.0、Git 和 curl；运行时直接下载、检查和复制目录。

## 确认范围

执行前从当前 session 的 skill 清单、实际 `SKILL.md` 路径和 agent 环境变量确定同步根目录。`.agents/skills`、`.codex/skills`、`.copilot/skills` 的所属根目录才是内容 home，源码仓库的 `skills` 不能作为安装位置的依据。

- 根目录为用户主目录时可省略 `--home`；其他位置必须传入 `--home "<绝对目录>"`。
- 带 `--local` 只改本机；省略时，增删和设置操作会修改远程清单并 commit / push。
- 用户未明确目标位置或发布范围时，先确认再操作。

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
| `--add skill:NAME` | 添加自有 skill |
| `--add owner/repo skill:NAME` | 添加指定 GitHub 来源的 skill |
| `--add agents-md:NAME` | 添加自有指令片段 |
| `--add rule:NAME` | 显式执行规则的全部成员 |
| `--del type:NAME ...` | 删除 skill、片段或规则展开后的成员 |
| `--auto_sync true\|false type:NAME ...` | 调整规则成员，不安装或卸载 |
| `--add_agents AGENT ...` / `--del_agents AGENT ...` | 调整目标，下次同步生效 |

`--add` 接收一个类型名称，或来源与 skill 类型名称两个参数。所有模式支持 `--home`；增删和设置支持 `--local`。本机 add 的内容必须存在于远程清单；本机 add rule 恢复该规则的完整远程成员。

## 路径与覆盖

共享 skill 正文在 `<home>/.agents/skills/<name>`。显式 home 不同于用户主目录时，另为生效 agents 复制 `.codex/skills/<name>`、`.copilot/skills/<name>`。`home=~` 不额外创建 skill 副本，也不自动迁移已有入口。

指令片段始终按生效 agents 写入 `<home>/.codex/AGENTS.md`、`<home>/.copilot/copilot-instructions.md`。省略 home 时尊重 `CODEX_HOME`、`COPILOT_HOME`；显式 home 优先。保留 `<!-- eh:NAME:start -->` / `<!-- eh:NAME:end -->` 之外的正文。

Skill 每次同步完整覆盖，清理目标内的过时文件，保留未选中内容。`.eh-source.json` 保存来源，来源冲突时停止；无标记的同名目录按清单选中覆盖或删除，其他工具的锁文件不修改。自定义 home 删除时保留未选中 agent 的副本；用户主目录的共享正文须同时选择 Codex 和 Copilot 才能删除。

## 规则与检查

`harness.json` 的 `skill` 记录包含 `name`、`source`，`agents-md` 记录包含 `name`。`sync-rules` 将规则映射到 `[{"type_name":"skill:NAME"}]` 或片段成员。

| 规则 | 条件 |
| --- | --- |
| `auto` | 无额外条件 |
| `win` | Windows |
| `learn` | Windows 且显式 add |

普通同步先创建或更新本地配置、清理实际存在的过期 skill 和 sysprompt，再检测规则并统一下载所需来源。命中规则时检查并新增或更新其 skill 和 agents-md；最后清理仅属于未命中规则的已安装内容。多个规则共用的内容只要仍被命中规则需要就保留，规则外内容也保留。每个来源在单次执行中下载一次，各规则共用副本，指令片段从自有仓库副本读取；远程管理复用 Git 操作副本，结束后统一清理。自有来源读取 main，第三方读取默认分支；第三方可使用仓库根目录或嵌套的 skill 目录，重复名称报错。

普通同步依次显示“创建/更新本地配置”“清理 skill 和 sysprompt”“下载源码”。下载标题即时输出，每个来源完成后输出一行。`自动配置: <rule_name>` 使用一级编号，配置内的检查和应用使用 `n1.n2` 子编号，每项配置从 1 开始。清理信息仅针对实际存在的内容：过期项显示 `[过期]`，规则清理显示 `[删除]`；应用时显示 `[新增]` 或 `[更新]`，`[未命中]` 列出具体条件。

同步以“完成”步骤收尾，按需列出“本次未应用的 rule”和“未安装的独立skill”。独立 skill 指远程规则及本机生效规则均未包含的 skill，安装状态检查当前 home 下 `.agents/skills`、`.codex/skills`、`.copilot/skills`。未命中、失败、成员为空的规则及 `--dryrun` 中的规则均未应用。本机空数组会覆盖远程规则，界面会提示成员为空；`--local --add rule:auto` 可恢复 auto 的远程成员并立即应用。普通同步开头保存配置并保留本机覆盖，后续步骤失败时已完成的配置更新仍保留。

dryrun 环境检查仅适用于自有来源，自有 skill 包含脚本时必须提供 `dryrun.mjs`。第三方 skill 完成源码结构校验后直接应用。检查只验证环境与配置，不上传文件或调用业务、计费 API。普通同步和 add 中，环境检查未通过只报告警告，仍应用内容并保存设置；显式 `--dryrun` 检查源码结构和自有 skill 环境，保留正式安装，检查失败返回非零。

临时源码和 Git 操作副本位于用户主目录的 `~/temp`，不随 `--home` 改变。临时目录、写入暂存文件或替换备份删除失败时，报告具体失败路径和残留位置，继续后续步骤；不会覆盖此前的操作错误。下载、结构校验、复制和正式内容删除失败仍中止对应操作。

## 配置与发布

本机 `<home>/.everything-harness/harness.json` 首次保存 `{"sync-rules":{}}`，可增加 `agents`。本机每个规则完整覆盖同名远程规则；移除对应键即跟随远程。空 agents 暂停同步，关闭成员不卸载内容。

远程删除将内容移入 `deleted`，skill 保留来源，同时删除对应自有源码；第三方仓库不变。删除项优先于本机规则，长期保留且不能重新启用。远程变更在隔离副本中提交，不改用户工作区；commit / push 失败保留副本并提示重试。

## 清理本机内容

先预览，再去掉 `--dryrun` 执行：

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/clean.mjs | node --input-type=module - --dryrun"
```

额外清理已确认的内容根目录：

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/clean.mjs | node --input-type=module - --home `"$($PWD.Path)`" --dryrun"
```

Linux / macOS：

```sh
curl -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/clean.mjs | node --input-type=module - --home "$PWD" --dryrun
```

与 sync 不同，clean 的 `--home` 是额外目标，**始终同时清理用户主目录**。它删除两处 `.agents/skills`、`.codex/skills`、`.copilot/skills` 中远程活动项和删除项的所有同名 skill，不受来源标记或本机开关限制。

指令清理覆盖各根目录及上述三个子目录中的 `AGENTS.md`、`CLAUDE.md`、`copilot-instructions.md`，移除所有 eh 标记块，保留文件和其他正文。保留其他 skills、本机配置、锁文件和远程清单；再次同步会重新安装启用的内容。执行失败会显示路径，已完成操作不回滚。
