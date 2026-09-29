# 同步与清理

以下示例通过 `--home` 将当前工作目录作为内容根目录；省略该参数时使用用户主目录。

同步直接从 GitHub 获取 skill，在用户主目录 `~/temp` 准备源码，再覆盖目标目录。dryrun 环境检查仅适用于自有来源，第三方 skill 完成源码结构校验后直接应用。普通同步中环境检查失败只警告，仍应用内容；追加 `--dryrun` 则只检查，失败返回非零。临时内容删除失败会报告具体路径并继续；下载、结构校验及正式内容的写入或删除错误仍会中止对应操作。

同步先创建或更新本地配置，再清理实际存在的过期 skill 和 sysprompt、下载源码。规则命中时新增或更新其 skill 和 agents-md；最后删除仅属于未命中规则的已安装内容，保留其他命中规则需要的内容和规则外内容。每个来源在本次执行中下载一次，所有规则和指令片段共用该副本，结束后统一清理。下载标题即时输出，每个来源完成后输出一行。

命令行以一级编号显示公共阶段和 `自动配置: <rule_name>`，每项配置内的检查和应用使用 `n1.n2` 子编号，从 1 开始。实际清理的过期项显示 `[过期]`，规则清理显示 `[删除]`，安装和片段应用显示 `[新增]` 或 `[更新]`；`[未命中]` 列出具体条件。

同步末尾仅在有内容时显示“本次未应用的 rule”和“未安装的独立skill”（不属于任何生效 rule 且未安装）；规则成员以本机覆盖后的清单为准，安装状态仅检查当前处理的 home 下 `.agents/skills`、`.codex/skills`、`.copilot/skills`。未命中、失败或成员为空的规则视为未应用；`--dryrun` 不应用规则。普通同步开头保存配置并保留本机覆盖，后续步骤失败时已完成的配置更新仍保留。

## Windows PowerShell

```powershell
$env:HTTP_PROXY = 'http://127.0.0.1:7890'
$env:HTTPS_PROXY = 'http://127.0.0.1:7890'
$env:ALL_PROXY = 'http://127.0.0.1:7890'
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --home `"$($PWD.Path)`""
```

## Linux / macOS

```sh
export http_proxy=http://127.0.0.1:7890
export https_proxy=http://127.0.0.1:7890
export all_proxy=http://127.0.0.1:7890
curl -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --home "$PWD"
```

## 清理本项目内容

先预览：

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/clean.mjs | node --input-type=module - --dryrun"
```

确认后执行：

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/clean.mjs | node --input-type=module -"
```

同时清理用户主目录和当前目录：

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/clean.mjs | node --input-type=module - --home `"$($PWD.Path)`""
```

Linux / macOS 使用同样参数：

```sh
curl -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/clean.mjs | node --input-type=module - --home "$PWD" --dryrun
```

`clean.mjs` 始终处理用户主目录，`--home` 是**额外清理目录**，不是替代：

- 删除各根目录下 `.agents/skills`、`.codex/skills`、`.copilot/skills` 中，远程清单活动项及 `deleted` 项的同名 skill，忽略来源标记和本机开关。
- 检查各根目录本身及 `.agents`、`.codex`、`.copilot` 中的 `AGENTS.md`、`CLAUDE.md`、`copilot-instructions.md`，仅删除所有 eh 标记块，保留文件和其他正文。
- 保留其他 skills、本机设置、锁文件和远程清单。清理不是关闭同步；再次运行 sync 会重新安装生效规则中的内容。

`--dryrun` 只预览，不删除或写入。失败显示具体路径，已完成的清理不回滚。完整管理说明见 [harness-manage](skills/harness-manage/SKILL.md)。
