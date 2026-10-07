---
name: paper-read
description: 定位或下载论文 PDF、用 MinerU 解析为 Markdown、按类型输出结构化解读，并把笔记写回 Zotero 子笔记。当用户说「读一下 X」「解析我库里那篇 X」「下载 X 这篇文章」「把这篇文献总结一下」「记一下笔记」时使用。只是要把论文存进 Zotero 而不读，用 paper-add。
---

# 读论文

`.${harness}`为此skill所在的harness路径

拿到 PDF 的本地绝对路径 → MinerU 解析成 Markdown 缓存到 `~/.mineru/` → 读缓存 → 结构化解读。

论文在库里、不在库里、需要现下，都走这个技能。

## 环境

| 项 | 值 |
|---|---|
| Zotero 数据目录 | `C:\Users\ShuttleMan\Zotero` |
| 链接附件基准目录（LABD） | `C:\Users\ShuttleMan\OneDrive\附件\Zotero` |
| MCP 模式 | web（`ZOTERO_LOCAL=false`），userID 15719290 |
| Zotero 桌面端本地 API | `http://127.0.0.1:23119/api/users/0`（只读，用来确认同步） |
| Python | `C:\Users\ShuttleMan\miniconda3\python.exe` |
| MinerU 缓存根目录 | `~/.mineru/` |

LABD 与 ZotMoov `dst_dir` 同值。配置真值在
`C:\Users\ShuttleMan\AppData\Roaming\Zotero\Zotero\Profiles\rmgu60eo.default\prefs.js`
（`baseAttachmentPath` / `zotmoov.dst_dir` / `dataDir` / `sync.storage.enabled`），
脚本每次运行都从这里读，不要在别处写死路径。

Zotero 凭据依次从环境变量、当前 skill 根目录的 `key.env`、`~\.claude.json` 的 Zotero MCP 配置补齐。运行 **zotero-init** 会自动为当前 harness 实际使用的 paper skill 创建或更新 `key.env`，保留其中的 `MINERU_API_KEY`；同步覆盖后可重新运行恢复。

## ⚠️ 入库的硬约束

**本机 Zotero 关掉了文件同步**（`extensions.zotero.sync.storage.enabled = false`）。

后果链条：用 web API（也就是 `zotero_add_item` 带 PDF）新增论文时，PDF 字节只进
Zotero **云端**存储；桌面端因为文件同步是关的，永远不会把字节拉到
`storage\<KEY>\`；本地没有文件，**ZotMoov 就没有东西可搬**，附件于是永远卡在
`imported_file`。之后按 `dataDir\storage\<KEY>\<filename>` 拼路径必然指向不存在的目录 —— 这就是
AReaL、From Self-Evolving Synthetic Data 两篇读不出来的原因。

所以：

- **绝不要**让 `zotero_add_item` 上传 PDF。非用它不可时一律带 `attach_mode='none'`，只建父条目。
- PDF 由我们自己下载、自己放进 LABD，再建 `linked_file` 附件（web API 接受
  `linkMode: "linked_file"` + `path: "attachments:<文件名>"`，桌面端约 15 秒同步下来）。
  这样产出的形态和 ZotMoov 亲手搬完全一致，且不占云端存储配额。
- 新论文入库整条流程由 **paper-add** 技能的 `zotero_add.py` 一条命令完成；手上已经有
  PDF、只差挂到某个已有条目上，用 `zotero_link.py add`。都不要手搓 curl。

## 流程

### 1. 找条目

```
zotero_search_items(query="SPADE")        # 短查询，"作者 年份" 或单个关键词
zotero_semantic_search(query="...")       # 按主题找时用这个
```

查询要短。这是子串匹配，加词只会让结果变少。搜出多条同名条目时传数组一次查完：

```
zotero_get_item_children(item_key=["N9YDDF9V", "P9R4WBVQ"])
```

### 2. 拿 PDF 路径

**一条命令，不要自己拼路径**：

```bash
"C:/Users/ShuttleMan/miniconda3/python.exe" \
  ~/.${harness}/skills/paper-read/scripts/zotero_link.py resolve <条目key或附件key>
```

传父条目 key 即可（自动挑 PDF 附件）。最后一行打印绝对路径，就用它。

脚本行为：

- `linked_file` 且文件在位 → 直接返回路径（约 3 秒）
- `imported_*` 且本地没文件 → **自动修复**：从云端取回字节、按 ZotMoov 命名规则
  （`Fu 等 - 2025 - 标题.pdf`）放进 LABD、删掉旧的 imported 附件（回收云端配额）、
  建新的 `linked_file` 附件、等桌面端同步
- `linked_file` 但文件被手动挪走 → 报错并要求人工确认，不擅自乱动

HTML / EPUB 附件也能 resolve，但跳过第 4 步，直接用 `Read` 读。

### 3. 库里没有这篇：下载 + 入库

先问用户要不要存进 Zotero。**只读一次不入库**的话，下到临时目录直接跳到第 4 步就行。

要入库 —— **交给 paper-add 技能**，一条命令连元数据带 PDF 一起搞定，最后打印
LABD 里的绝对路径，拿去解析：

```bash
"C:/Users/ShuttleMan/miniconda3/python.exe" \
  ~/.${harness}/skills/paper-add/scripts/zotero_add.py 2505.24298 --collection autoEvolve
```

**绝不要**让 `zotero_add_item` 上传 PDF（原因见下面那条硬约束）。只有在来源是
ISBN / BibTeX / 网页这类 `zotero_add.py` 不认的情况下才用它，且必须带
`attach_mode='none'`，PDF 事后用 `zotero_link.py add <pdf> --parent <父条目key>` 挂上去。

### 4. 解析 PDF

脚本自带缓存判断：解析过就秒回，没解析过调 MinerU（单篇约 1–3 分钟）。

```bash
"C:/Users/ShuttleMan/miniconda3/python.exe" \
  ~/.${harness}/skills/paper-read/scripts/mineru_parse.py "<PDF 绝对路径>"
```

优先读环境变量 `MINERU_API_KEY`，也支持当前 skill 目录中的本机 `key.env`（不随仓库分发，覆盖更新可能清除，推荐环境变量）。调 MinerU Precision API
（`vlm` 模型，开公式与表格识别），结果解压进 `~/.mineru/<目录名>/`，
结尾打印该目录绝对路径 —— **用打印出来的路径，不要自己拼**。

常用参数：`--force`（忽略缓存重解析）、`--language ch`、`--output-root DIR`。

### 5. 读

读 `~/.mineru/<目录名>/full.md`：全文 Markdown，公式为 LaTeX、表格为 HTML、图片在同目录 `images/`。

同目录另有 `layout.json`（版面）和 `*_content_list.json`（结构化块序列），
需要定位章节或图表时按需读，不要把整个目录灌进上下文。

### 6. 论文分析

先判断这篇属于内容类（综述）还是方法类（含一个 framework）。

内容类：正常总结内容。

方法类：只呈现主要方法，不呈现实验结果、不谈意义、不做原理分析 —— 这些用户会自己问。

- 先阐述方法里有哪些对象，比如多个 LLM、人类、外部信息源
- 再逐步阐述每一步是什么对象做了什么事、产出什么

呈现完，告诉用户有问题可以讨论；用户陈述的结论性语句，经你确认后可整理成笔记存储。

### 7. 记笔记

**用户说「记一下笔记」= 写入该论文的 Zotero 子笔记，不用再问存哪里。**

写之前先等用户给出他自己的总结。用户的总结是笔记的主体，**优先记**；
你在第 6 步呈现的方法主干和追问澄清的细节作为补充，围着用户的总结组织。
用户没给总结就直说「你先说说你的理解，我照着记」，不要自作主张先写一版。

- `zotero_manage_note(action='create', item_key=<父条目>, ...)` — 建子笔记
- `zotero_create_annotation(attachment_key=..., page=..., text=...)` — PDF 高亮，传**附件 key**
- `zotero_update_item(item_key=..., add_tags=[...])` — 打标签

注意：修复过的条目附件 key 会变（旧的 imported 附件被删了），高亮要用
`zotero_get_item_children` 重新取当前的附件 key。

如果你觉得用户的总结有明显错误之处（提到了未使用的技术或者技术的应用环节出错），逐条指出并提供一个最简单的修改，让用户选择审批，用户审批之后再写入，比如：

- 用户：这篇文章用了聚类去统计数据再使用
- 你发现没有使用聚类
- 提供一个审批给用户：我发现了以下问题，需要我改正吗
  - 使用了「聚类」，实际上并没有使用，改成：这篇文章每次采样一条数据
- 用户进行审批，接收或不接受
- 保存内容

### 笔记怎么组织

用户的总结**会省略大量细节，那是高层理解，不是错误**。判据只有一条：有没有事实性错误。

- **没有事实性错误 → 原样保留**，不要因为「不够精确」「漏了门控项」就去补全或改写
- **有事实性错误 → 提修正方案让用户审批**，接受了才改，不接受就保留用户原话

细节补充一律放笔记的**后续部分**，不要塞进用户总结里稀释它。笔记结构：

```
1. 用户的总结（主体，逐字保留，只改经审批的事实错误）
2. 方法主干（第 6 步呈现的对象与流程）
3. 追问澄清的细节（讨论中问出来的机制、公式、参数）
4. 开放问题（论文没讲清楚、或讨论中提出的疑问）
```

## 排查

| 症状 | 原因 / 处理 |
|---|---|
| 路径不存在，`linkMode` 是 `imported_file` | 就是上面那条硬约束。跑 `zotero_link.py repair <key>` |
| `repair` 报「云端也没有文件」 | 附件是空壳，重新下载 PDF 后用 `add --parent` |
| `linked_file` 但文件不在 | 文件被手动挪走或 OneDrive 没同步下来，先问用户 |
| 路径打印成乱码 | 脚本已强制 UTF-8 输出；若仍乱码，检查是不是绕过脚本自己拼的路径 |
| `zotero_add_item` 报 DOI not found | arXiv DOI 不在 CrossRef，改用 abs 页 URL + `source_type="url"` |
