---
name: skill-manage
description: 使用远程 sync.mjs 管理个人 skill、设置全局 agents、调整远程或本机自动同步开关、查看状态和检查运行环境。
---

# Skill 管理

需要 Node.js ≥22.20.0、npm/npx、Git 和 curl。所有 skill 共用一份 agents 设置，默认包含 `codex`、`claude-code`、`github-copilot`，可手动增删。

Windows PowerShell：通过 `cmd /d /c` 传递原始字节，避免 PowerShell 5.1 管道转码损坏 UTF-8 脚本。

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module -"
```

Linux / macOS：

```sh
curl -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module -
```

默认同步开启 `auto_sync` 的 skill，并检查环境。本机 `~/.everything-harness/skills.json` 中的开关优先，没有本机记录就跟随远程。所有操作都用上面的远程命令，在 node 参数末尾追加选项（Windows 放在外层双引号内）：

- `--update`：覆盖更新。
- `--add owner/repo skill-name`：先安装并检查环境，成功后加入远程清单。
- `--del skill-name`：先删除本机安装，成功后从远程清单移除。
- `--auto_sync false skill-name`：关闭远程自动同步；换成 `true` 即开启。只改开关，不安装或删除。
- `--local --add skill-name`：只在本机安装，环境检查成功后保存本机 `auto_sync=true`。
- `--local --del skill-name`：只在本机删除，成功后保存本机 `auto_sync=false`，下次同步不会装回。
- `--local --auto_sync false skill-name`：只改本机开关，保留当前安装；也支持 `true`。
- `--add_agents codex` / `--del_agents claude-code`：增删远程全局目标，可一次传多个名称。
- `--local --add_agents codex` / `--local --del_agents claude-code`：只改本机全局目标。
- `--list`：查看远程、本机和生效 agents，以及每个 skill 的开关，未覆盖时显示“跟随远程”。
- `--dryrun`：检查开启自动同步的 skill 环境，按报错补齐配置后重试。

不带 `--local` 的 skill 增删、agents 增删和开关修改会自动 commit / push，需要 Git 提交身份和该仓库的 GitHub 写入权限。带 `--local` 只保存本机设置，不操作 Git。失败后按提示修复，再运行同一条命令。

skill 增加、删除均使用生效的全局 agents，开关按整个 skill 生效。本机 add 只接收已在远程清单中的名称。

agents 增删只保存配置，下次同步生效，已有安装保留。本机首次修改从当前生效列表增删，保存后整份列表覆盖远程；移除本机 `skills.json` 顶层 `agents` 字段即可恢复跟随远程。空列表会暂停同步、更新和 dryrun，skill add/del 会提示先添加 agent。Codex 和 Copilot 共用 skills 目录，内容可能对两者都可见。

例如，增加一个 skill：

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --add owner/repo skill-name"
```

只在本机删除一个 skill：

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --local --del skill-name"
```

从默认三个目标中，只为本机保留 Codex：

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --local --del_agents claude-code github-copilot"
```

更新所有开启自动同步的 skill：

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --update"
```
