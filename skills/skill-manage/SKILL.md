---
name: skill-manage
description: 使用远程 sync.mjs 同步、增加、删除、更新或列出个人 skill，检查 skill 的运行环境。
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

默认补齐清单中的 skill，并运行环境检查。在命令末尾追加：

- `--update`：覆盖更新。
- `--add owner/repo skill-name`：先安装并检查环境，成功后加入远程清单。
- `--del skill-name`：先删除本机安装，成功后从远程清单移除。
- `--agents codex`：只处理 Codex；也支持 `claude-code`、`github-copilot`，可列出多个。
- `--list`：查看清单。
- `--dryrun`：只检查已安装 skill 的环境，按报错补齐配置后重试。

增加、删除会自动提交并推送仓库清单，不需要手动操作 Git；电脑须已配置 Git 提交身份和该仓库的 GitHub 写入权限。失败后按提示修复，再运行同一条命令。

`--add`、`--del`、`--list` 都能搭配 `--agents`。省略时，增加会选择全部三个 agents，删除会移除该 skill 的全部关联。Codex 和 Copilot 共用安装目录，删除共享 skill 时一起选择两者。

例如，只给 Codex 增加一个 skill：

```powershell
curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --add owner/repo skill-name --agents codex
```

删除一个 skill：

```powershell
curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --del skill-name
```

只更新 Codex：

```powershell
curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --update --agents codex
```
