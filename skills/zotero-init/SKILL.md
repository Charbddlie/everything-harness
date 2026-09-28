---
name: zotero-init
description: 引导用户完成 Zotero 与 Claude Code 的完整打通——ZotMoov 插件安装、附件目录与链接基准目录设置、zotero-mcp 独立 conda 环境安装、本地/Web API 选择与 MCP 注册。当用户提到「配置 Zotero」「接 Zotero」「zotero mcp」「zotmoov」「附件目录」「文献库连不上」时使用。
---

# Zotero 接入初始化

把用户的 Zotero 库接到 Claude Code，分两块：**ZotMoov**（让附件落到人类可读的固定目录，Claude 才能直接读 PDF）+ **zotero-mcp**（元数据检索与写操作）。

**核心原则：先探测，再动手。** 每一步都可能已经做过了。不要让用户重复操作已完成的步骤——先跑第 0 步，再按缺什么补什么。GUI 步骤无法自动化，必须让用户手动点；其余全部由你代劳。

## 第 0 步：探测现状

一次性跑完，再决定后面做什么：

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

# MCP 是否已注册
claude mcp list 2>&1 | grep -i zotero
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

ZotMoov 把附件从 `storage/ABCD1234/xxx.pdf` 搬到 `<你的目录>/Cao 等 - 2026 - Qwen3-Coder Technical Report.pdf`，并在 Zotero 里改成链接。这样 Claude Code 能用 Read 直接读 PDF，路径还自带作者年份标题。

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

```bash
claude mcp add zotero --scope user \
  --env ZOTERO_LOCAL=true \
  -- "C:/Users/$USERNAME/miniconda3/envs/zotero-mcp/Scripts/zotero-mcp.exe"
```

Web API 则改为：

```bash
claude mcp add zotero --scope user \
  --env ZOTERO_LOCAL=false \
  --env ZOTERO_API_KEY=<KEY> \
  --env ZOTERO_LIBRARY_ID=<ID> \
  --env ZOTERO_LIBRARY_TYPE=user \
  -- "C:/Users/$USERNAME/miniconda3/envs/zotero-mcp/Scripts/zotero-mcp.exe"
```

要点：

- **必须写 exe 绝对路径**。conda 环境的 `Scripts` 不在 PATH 上，写 `zotero-mcp` 会找不到。
- `--scope user` 写进 `~/.claude.json`，所有项目可用。
- 重复注册要先 `claude mcp remove zotero --scope user`。
- 用了 Web API 就提醒一句：key 明文存在 `~/.claude.json` 里，如果那文件会同步/分享出去，记得去 settings/keys 撤销重发。

## 第 6 步：验收

```bash
claude mcp list 2>&1 | grep -i zotero   # 期望 ✔ Connected
```

`✔ Connected` 只说明进程能起来，**不代表能读到数据**。必须再实测一次真实查询：

```bash
# 本地
curl -s "http://localhost:23119/api/users/0/items/top?limit=2" | head -c 300

# Web
curl -s -H "Zotero-API-Key: <KEY>" "https://api.zotero.org/users/<ID>/items/top?limit=2" | head -c 300
```

能看到真实标题才算通。

最后告诉用户：**MCP 不会热加载，要新开一个 Claude Code 会话**才能用。然后给几个可以直接说的例子：

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
