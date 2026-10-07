---
name: zotero-init
description: 引导用户完成 Zotero 与 Codex、GitHub Copilot CLI、Claude Code 的接入——ZotMoov 插件安装、附件目录设置、zotero-mcp 独立 conda 环境安装、MCP 注册，并自动为 paper skill 配置 key.env。当用户提到「配置 Zotero」「接 Zotero」「zotero mcp」「zotmoov」「附件目录」「文献库连不上」时使用。
---

# Zotero 接入初始化

把用户的 Zotero 库接到 Codex、GitHub Copilot CLI 或 Claude Code，分两块：**ZotMoov**（让附件落到人类可读的固定目录，agent 可以直接读取）+ **zotero-mcp**（元数据检索与写操作）。Paper 脚本通过各自 skill 内的 `key.env` 使用 Zotero Web API。

**核心原则：先探测，再动手。** 每一步都可能已经做过了。不要让用户重复操作已完成的步骤——先跑第 0 步，再按缺什么补什么。GUI 步骤无法自动化，必须让用户手动点；其余全部由你代劳。

## 第 0 步：探测现状

一次性跑完，再决定后面做什么：

先根据当前会话身份确定正在使用的 harness（Codex、GitHub Copilot CLI 或 Claude Code），再通过当前 session 的 skill 清单和实际 `SKILL.md` 路径确认它使用的 skill 安装目录。本次只配置当前 harness；客户端配置尊重 `CODEX_HOME`、`COPILOT_HOME` 或显式配置目录。以下表格列的是默认用户级位置。

| 客户端 | MCP 配置 | 注册检查 |
|---|---|---|
| Codex | `~\.codex\config.toml` 的 `mcp_servers.zotero` | `codex mcp list` |
| GitHub Copilot CLI | `~\.copilot\mcp-config.json` 的 `mcpServers.zotero` | `copilot mcp list`，或会话内 `/mcp` |
| Claude Code | `~\.claude.json` 的 `mcpServers.zotero` | `claude mcp list` |

检查当前 harness 实际使用的 `paper-add`、`paper-read` 是否有 `key.env`，只报告所需键是否齐全。凭据可从进程环境变量、这些 skill 的 `key.env`、当前 harness 的 Zotero MCP `env` 中复用；冲突时先确认要使用的文库。检查配置时隐藏密钥值。

```bash
# Zotero profile（prefs.js 在 profile 里，不在数据目录里）
P=$(ls -d /c/Users/$USERNAME/AppData/Roaming/Zotero/Zotero/Profiles/*.default* 2>/dev/null | head -1)
echo "profile: $P"

# 关键 pref
grep -iE "zotmoov|baseAttachmentPath|dataDir|localAPI|spellcheckDefault" "$P/prefs.js"

# Zotero 进程是否在跑（决定能否直接写 prefs.js）
tasklist //FI "IMAGENAME eq zotero.exe" | grep -i zotero || echo "Zotero 未运行"

# 已装插件
ls "$P/extensions"

# 本地 API 是否通（200=通，403=没开权限，000=Zotero 没运行）
curl -s -m 8 -o /dev/null -w "local API: %{http_code}\n" "http://localhost:23119/api/users/0/items?limit=1"

```

对照读数：

| pref / 检查项 | 含义 |
|---|---|
| `extensions.zotmoov.dst_dir` | ZotMoov 的目标目录。**存在即插件已装好并配好** |
| `extensions.zotero.baseAttachmentPath` | 链接附件基准目录（LABD）。应与 `dst_dir` 一致 |
| `extensions.zotero.httpServer.localAPI.enabled` | 本地 API 开关 |
| `extensions.zotero.dataDir` | Zotero 数据目录（`storage/` 在这里，文件名是不可读的 8 位 key） |
| `layout.spellcheckDefault` | 笔记编辑器拼写检查。缺失 = 默认 `1`（开着），见下节 |
| `zotmoov@wileyy.com.xpi` 在 extensions 里 | 插件已安装 |

**注意**：`prefs.js` 只在 Zotero 退出时落盘，可能滞后于界面上的实际设置。读数与用户描述冲突时，以 `curl` 实测为准。**绝不要在 Zotero 运行时写 `prefs.js`**——会被覆盖，且可能损坏配置。pref 改动默认全部走 GUI，唯一例外是下面这节（且必须先确认进程已退出）。

## 顺手做：关掉笔记编辑器的拼写检查

Zotero 笔记编辑器用的是 Firefox 那套拼写检查，词典里没有 LLM、rubric、GRPO、MCP 这类词，写方法笔记时满屏红线。用户基本都会被烦到，主动帮他关掉。

**触发时机不固定**：整个流程里任何一步，只要探测到 Zotero 进程没在跑，就顺手把这件事做了，做完告诉用户一声，不用专门问。

```bash
P=$(ls -d /c/Users/$USERNAME/AppData/Roaming/Zotero/Zotero/Profiles/*.default* 2>/dev/null | head -1)

# 前置硬条件：进程必须不在。有输出就停手，别写。
tasklist //FI "IMAGENAME eq zotero.exe" | grep -qi zotero && echo "Zotero 在跑，跳过" && exit

cp "$P/prefs.js" "$P/prefs.js.bak"
grep -v 'layout.spellcheckDefault' "$P/prefs.js" > "$P/prefs.js.tmp"
echo 'user_pref("layout.spellcheckDefault", 0);' >> "$P/prefs.js.tmp"
mv "$P/prefs.js.tmp" "$P/prefs.js"
```

先 `grep -v` 再追加，是为了避免重复写入时留下两条同名 pref。备份留一份，改坏了能回滚。

取值：`0` 全局关闭，`1` 仅多行文本框（默认值，笔记编辑器正好中招），`2` 所有输入框。

**Zotero 正开着的话别硬写**，让用户自己点，四步：设置 → 高级 → 配置编辑器 → 搜 `layout.spellcheckDefault` 改成 `0`，然后重启 Zotero。

## 第 1 步：ZotMoov（若 `dst_dir` 缺失）

ZotMoov 把附件从 `storage/ABCD1234/xxx.pdf` 搬到 `<你的目录>/Cao 等 - 2026 - Qwen3-Coder Technical Report.pdf`，并在 Zotero 里改成链接。这样 agent 可以按作者、年份和标题定位 PDF。

告诉用户手动做（这几步没法自动化）：

1. 到 [releases 页](https://github.com/wileyyugioh/zotmoov/releases/latest) 下载 `.xpi`（Firefox 用户需右键「链接另存为」，否则会被当成浏览器扩展装掉）
2. Zotero → **工具 → 插件** → 右上齿轮 → **Install Plugin From File** → 选那个 `.xpi`
3. 重启 Zotero

**装之前提醒用户**：先备份一下库。ZotMoov 是真的在移动文件。

要求 Zotero 7。

## 第 2 步：设目录

Zotero → **编辑 → 设置 → ZotMoov**：

| 设置项 | 建议值 | 理由 |
|---|---|---|
| Directory to Move Files To | 一个专用目录 | 别和其他程序共用，ZotMoov 会删空目录 |
| File Behavior | **Move**（默认） | Copy 只是备份，Zotero 不追踪 |
| Automatically Move/Copy Files When Added | 勾上 | 否则新加的文献还得手动搬 |
| Automatically Move to Subdirectory | 看用户偏好 | `{%c}` 按分类建子目录；想要扁平结构就别勾 |
| Automatically Delete External Linked Files | 勾上 | 从 Zotero 删除时一并清理硬盘，避免残留 |

然后 **编辑 → 设置 → 高级 → 文件和文件夹 → 链接附件基准目录**，**设成同一个目录**。

这一步容易被跳过，但很关键：LABD 让 Zotero 用相对路径存链接，换机器/换盘符不会全部失效。

两个坑要主动说：

- **群组库不支持链接附件**，所以 Move 只对个人库生效（Copy 不受限）。
- 目录若放在 OneDrive/Dropbox 里，去 **设置 → 同步** 关掉 **「同步我的文库中的附件文件」**，否则云盘和 Zotero 会打架，产生冲突副本。

配好后让用户全选文库 → 右键 → **ZotMoov** 批量搬一次存量附件。

验证：

```bash
ls "<用户的目录>" | head -5; ls "<用户的目录>" | wc -l
```

## 第 3 步：装 zotero-mcp（独立 conda 环境）

**必须建独立环境。** 装进 base 会把 `starlette` 升到 1.x，直接干掉 `fastapi`（要求 `<0.50`）和 `gradio`（要求 `<1.0`）。这个已经踩过一次。

```bash
CONDA=/c/Users/$USERNAME/miniconda3

# 建环境。--override-channels 是必须的：用户 .condarc 里的 tuna msys2/pro/free
# 频道已 404，不覆盖会卡在 "Collecting package metadata ... failed"
$CONDA/Scripts/conda.exe create -n zotero-mcp python=3.13 -y \
  --override-channels -c https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/main

# 装包（PyPI 包名是 zotero-mcp-server，命令行是 zotero-mcp）
$CONDA/envs/zotero-mcp/python.exe -m pip install zotero-mcp-server

$CONDA/envs/zotero-mcp/Scripts/zotero-mcp.exe version
```

可选：`pip install "zotero-mcp-server[semantic]"` 再跑 `zotero-mcp update-db` 建语义检索索引；`zotero-mcp install-skill` 装 CLI 包装器，把每次请求的 schema 开销从 ~13k token 降到 ~98。

**如果发现已经误装进 base**，清理步骤：卸掉 `zotero-mcp-server` 及其独有依赖（`pyzotero bibtexparser pdf-inspector markdownify unidecode feedparser feedparser-sgmllib fastmcp fastmcp-slim mcp cyclopts uncalled-for beartype griffelib rich-rst docstring-parser aiofile caio py-key-value-aio joserfc jsonref openapi-pydantic whenever sse-starlette httpx-sse authlib`），然后 `pip install "starlette<0.50"`，最后 `pip check` 确认无冲突。

## 第 4 步：选本地 API 还是 Web API

这是个真实的取舍，要让用户明确选：

| | 本地 API | Web API |
|---|---|---|
| 读什么 | 本机全部内容 | 已同步到云端的内容 |
| 写操作 | ❌ 只读 | ✅ 可加条目/改标签/建分类 |
| PDF 全文与标注 | 更完整、更快 | 受限 |
| 前提 | Zotero 必须开着 | 需要 API key |

**推荐先本地**，需要写操作时再切 Web——切换只是改 `ZOTERO_LOCAL` 一个字。

`paper-add` 和 `paper-read` 的 Zotero 脚本始终使用 Web API。需要使用这些脚本时，即使 MCP 选择本地模式，也要取得有个人库读写权限的 API key 和 library ID，供第 6 步写入 `key.env`。仅配置本地只读 MCP 且没有凭据时，明确告知 paper 脚本尚未就绪，取得凭据后再完成该步骤。

### 本地

Zotero → **编辑 → 设置 → 高级** → 勾选 **「允许此计算机上的其他应用程序与 Zotero 通信」**。

验证必须返回 200：

```bash
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:23119/api/users/0/items?limit=1"
```

403 = 开关没打开；000 = Zotero 没运行。

### Web

让用户去 [zotero.org/settings/keys](https://www.zotero.org/settings/keys) 建 key。**library ID 不用让用户去翻**，用 key 直接查：

```bash
curl -s "https://api.zotero.org/keys/<KEY>"   # 返回里的 userID 就是 library ID
```

顺便看返回里 `access.user.write` 是不是 `true`——不是的话写操作会失败，得回去重建 key。

## 第 5 步：注册 MCP

为第 0 步识别的当前 harness 注册。通过 `conda info --base` 和 `conda env list` 找到实际环境，使用 `zotero-mcp` 可执行文件的绝对路径。以下是 PowerShell 命令：

```powershell
$McpExe = '<zotero-mcp 环境>\Scripts\zotero-mcp.exe'
$McpEnv = @('--env', 'ZOTERO_LOCAL=true')
```

Web 模式先把已确认的凭据载入当前进程的 `ZOTERO_API_KEY`、`ZOTERO_LIBRARY_ID`，再将 `$McpEnv` 改为：

```powershell
$McpEnv = @(
  '--env', 'ZOTERO_LOCAL=false',
  '--env', "ZOTERO_API_KEY=$env:ZOTERO_API_KEY",
  '--env', "ZOTERO_LIBRARY_ID=$env:ZOTERO_LIBRARY_ID",
  '--env', 'ZOTERO_LIBRARY_TYPE=user'
)
```

根据当前 harness 只执行下面对应的一条命令，然后检查退出码：

```powershell
codex mcp add zotero @McpEnv -- $McpExe
copilot mcp add zotero @McpEnv -- $McpExe
claude mcp add zotero --scope user @McpEnv -- $McpExe
```

已有注册与预期一致时保留；需要修改时，仅更新当前 harness 配置中的 Zotero 条目，保留其他服务及设置。Claude CLI 重复添加前执行 `claude mcp remove zotero --scope user`。注册失败时报告原始错误。

若当前 Copilot 版本没有 `copilot mcp add`，直接合并写入生效的 `mcp-config.json`。本地模式条目如下，`command` 替换为真实绝对路径；Web 模式的 `env` 使用上面的四个环境变量：

```json
{
  "mcpServers": {
    "zotero": {
      "type": "local",
      "command": "C:\\path\\to\\zotero-mcp.exe",
      "args": [],
      "env": { "ZOTERO_LOCAL": "true" },
      "tools": ["*"]
    }
  }
}
```

配置格式参考：[Codex MCP](https://developers.openai.com/codex/mcp)、[Copilot CLI MCP](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)。

## 第 6 步：自动写入 paper skill 凭据

取得并验证凭据后，由 agent 自动执行；已有 MCP 注册也要补齐此步骤：

1. 使用第 0 步确认的路径，仅定位当前 harness 实际加载的 `paper-add`、`paper-read`。按各自的 `SKILL.md` 所在目录写入，同一真实目录只处理一次；当前 harness 使用共享 `.agents\skills` 时就写入该共享目录。范围以实际加载路径为准，不遍历其他 harness 的 skill 副本。尚未安装的 skill 明确报告，安装后再补写。
2. 在每个已安装 skill 的根目录创建或更新 `key.env`，使用 UTF-8 无 BOM，写入下面两个键的真实值（裸值，不加引号）。按键替换已有值，保留其他配置与注释，尤其是 `paper-read` 的 `MINERU_API_KEY`。
3. 回读确认两个键与本次凭据一致；失败时报告具体路径和错误。完成后仅报告写入路径及状态。

```dotenv
ZOTERO_API_KEY=<已验证的 API key>
ZOTERO_LIBRARY_ID=<对应的 userID>
```

这些文件位于本机安装目录，凭据留在本机；MCP 配置和 `key.env` 均含明文密钥，分享时应脱敏。Skill 同步覆盖可能清除 `key.env`，同步后在对应 harness 中重新运行本初始化流程，从该 harness 的 MCP 配置或环境变量恢复。

## 第 7 步：验收

按当前 harness 检查：Codex 使用 `codex mcp list` 和会话内 `/mcp`；Copilot 使用 `/mcp`；Claude 使用 `claude mcp list`。直接修改配置或通过外部 CLI 注册后，新开该客户端会话加载；Copilot 会话内 `/mcp add` 保存后立即生效。

列表中出现服务只说明配置存在。还要确认 MCP 已连接并执行一次真实的 Zotero 检索；空文库可用成功的空结果验收。API 可独立检查：

```bash
# 本地
curl -s "http://localhost:23119/api/users/0/items/top?limit=2" | head -c 300

# Web
curl -s -H "Zotero-API-Key: <KEY>" "https://api.zotero.org/users/<ID>/items/top?limit=2" | head -c 300
```

对每个已写入 `key.env` 的 paper skill，用 Python `runpy.run_path` 加载 `scripts\zotero_add.py` 或 `scripts\zotero_link.py`，只调用 `load_credentials()`，与本次凭据比较且不输出值。检查时在该子进程中移除 `ZOTERO_API_KEY`、`ZOTERO_LIBRARY_ID`，并将 `load_credentials.__globals__["CLAUDE_JSON"]` 指向临时目录下不存在的文件，确保凭据来自该 skill 的 `key.env`。加载失败或不一致时，修正后再验收。

最后报告当前 harness、连接状态、已写入的 `key.env` 路径和未完成项。可以直接说：

- 「搜一下我 Zotero 里关于 XX 的文献」
- 「把这篇 DOI 加进我的库：10.xxxx/xxxxx」
- 「读一下 XX 那篇的 PDF，总结方法部分」

## 故障速查

| 症状 | 原因 |
|---|---|
| local API 403 | 高级设置里的「允许其他应用通信」没勾 |
| local API 000 / 连接被拒 | Zotero 没运行 |
| MCP 显示 Failed | exe 路径写错，或写成了不在 PATH 的裸命令 |
| 能搜到条目但读不了 PDF | 附件还在 `storage/` 里没被 ZotMoov 搬走，或 LABD 没设 |
| 写操作报权限错 | 在用本地 API（只读），或 key 没有 write 权限 |
| 笔记里满屏红色波浪线 | 拼写检查默认开着，`layout.spellcheckDefault` 设 `0`，见「顺手做」一节 |
| conda create 卡住后 404 | `.condarc` 里 tuna 的 msys2/pro/free 频道已失效，加 `--override-channels -c .../pkgs/main` |
| base 环境 fastapi/gradio 挂了 | 误把 zotero-mcp 装进了 base，starlette 被升到 1.x，见第 3 步清理 |
