---
name: skill-manage
description: 使用远程 sync.mjs 管理个人 skill、调整远程或本机自动同步开关、查看状态和检查运行环境。
---

# Skill 管理

需要 Node.js ≥22.20.0、npm/npx、Git 和 curl。

Windows PowerShell：

```powershell
curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module -
```

Linux / macOS：

```sh
curl -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module -
```

默认同步开启 `auto_sync` 的 skill，并检查环境。本机 `~/.everything-harness/skill.json` 中的开关优先，没有本机记录就跟随远程。所有操作都用上面的远程命令，在末尾追加参数：

- `--update`：覆盖更新。
- `--add owner/repo skill-name`：先安装并检查环境，成功后加入远程清单。
- `--del skill-name`：先删除本机安装，成功后从远程清单移除。
- `--auto_sync false skill-name`：关闭远程自动同步；换成 `true` 即开启。只改开关，不安装或删除。
- `--local --add skill-name`：只在本机安装，环境检查成功后保存本机 `auto_sync=true`。
- `--local --del skill-name`：只在本机删除，成功后保存本机 `auto_sync=false`，下次同步不会装回。
- `--local --auto_sync false skill-name`：只改本机开关，保留当前安装；也支持 `true`。
- `--agents codex`：只处理 Codex；也支持 `claude-code`、`github-copilot`，可列出多个。
- `--list`：同时查看远程开关、本机覆盖和生效状态，未覆盖时显示“跟随远程”。
- `--dryrun`：检查开启自动同步的 skill 环境，按报错补齐配置后重试。

不带 `--local` 的增加、删除和开关修改会自动 commit / push，需要 Git 提交身份和该仓库的 GitHub 写入权限。带 `--local` 只保存本机设置，不操作 Git。失败后按提示修复，再运行同一条命令。

远程 `--add`、`--del` 和 `--list` 支持 `--agents`。本机 add/del 使用清单中的全部 agents；它们和 `--auto_sync` 按整个 skill 生效，不接受 `--agents`。本机 add 只接收已在远程清单中的名称。Codex 和 Copilot 共用安装目录，远程删除共享 skill 时一起选择两者。

例如，只给 Codex 增加一个 skill：

```powershell
curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --add owner/repo skill-name --agents codex
```

只在本机删除一个 skill：

```powershell
curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --local --del skill-name
```

只更新 Codex：

```powershell
curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --update --agents codex
```
