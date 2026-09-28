---
name: skill-manage
description: 使用远程 sync.mjs 管理个人 skill、设置全局 agents、调整远程或本机自动同步开关、查看状态和检查运行环境。
---

# Skill 管理

执行增删或配置修改前，必须明确操作范围：仅本机（`--local`），还是远程清单（不带 `--local`，会 commit / push）。用户要求不明确时，先询问并等待确认，不能自行默认其中一种。“本地的 skill”可能指待上传的本机源码，不等于要求仅在本机安装或删除。

需要 Node.js ≥22.20.0、npm/npx、Git 和 curl。所有 skill 共用一份 agents 设置，默认包含 `codex`、`github-copilot`；`claude-code` 可手动添加。

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module -"
```

Linux / macOS：

```sh
curl -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module -
```

每次运行都通过 `skills add --copy` 覆盖安装开启 `auto_sync` 的 skill，并检查环境。安装使用实体 skill 目录，目录选择与锁文件由 `skills` 管理。已有父目录软链接需另行迁移。覆盖安装会替换本地修改，源码应在源仓库维护，凭据和本机配置应放在安装目录之外。

本机 `~/.everything-harness/skills.json` 中的开关优先，没有本机记录就跟随远程。所有操作都用上面的远程命令，在 node 参数末尾追加选项（Windows 放在外层双引号内）：

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
`--del` 不删除仓库中的 skill 源码；如果用户要求连远程源码一起删除，需明确该范围后再修改仓库。

agents 增删只保存配置，下次同步生效，已有安装保留。本机首次修改从当前生效列表增删，保存后整份列表覆盖远程；移除本机 `skills.json` 顶层 `agents` 字段即可恢复跟随远程。空列表会暂停同步和 dryrun，skill add/del 会提示先添加 agent。Codex 和 Copilot 共用 `~/.agents/skills`，内容可能对两者都可见。

例如，增加一个 skill：

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --add owner/repo skill-name"
```

只在本机删除一个 skill：

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --local --del skill-name"
```

从默认两个目标中，只为本机保留 Codex：

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --local --del_agents github-copilot"
```

修改用户自有 skill 时，先克隆源码仓库：`git clone git@github.com:Charbddlie/everything-harness.git`；已有本地仓库则复用。
在 `skills/<skill-name>/` 中修改内容；涉及脚本时同步维护 `dryrun.mjs`。
将本机 skill 发布到远程时，只迁入说明、脚本和必要资源，不提交 `key.env`、密钥、缓存或本机配置。先推送源码，再用 `--add Charbddlie/everything-harness skill-name` 安装并加入远程清单。
完成后提交并推送，再运行远程入口同步安装。
