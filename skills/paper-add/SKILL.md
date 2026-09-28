---
name: paper-add
description: 把论文存进 Zotero —— 抓元数据、下 PDF、建成 ZotMoov 风格的 linked_file 附件，入库即可读。当用户说「把 X 加到 zotero」「存一下这篇论文」「这篇入库」「收藏这个 arxiv」「批量加几篇文献」时使用。
---

# 加文献进 Zotero

安装后用本 skill 的 `dryrun.mjs` 检查 conda base Python、Zotero 附件目录和 API 凭据；不联网、不修改文献库。保留现有 Python 脚本，使用标准库，无需安装额外包。命令中的 `~/.claude/skills/paper-add` 应替换为当前加载的 skill 目录（Codex / Copilot 通常在 `~/.agents/skills/paper-add`）。

一条命令搞定：**元数据 → PDF → LABD → linked_file 附件**。

```bash
"C:/Users/ShuttleMan/miniconda3/python.exe" \
  ~/.claude/skills/paper-add/scripts/zotero_add.py <来源> [--collection 分类] [--tag 标签]
```

`<来源>` 可以是 arXiv id（`2608.27287`）、arXiv 链接（abs / pdf 都行）、DOI，或 doi.org 链接。
最后一行打印 PDF 绝对路径，直接接 paper-read 的 `mineru_parse.py` 就能读。

## ⚠️ 不要用 zotero_add_item 传 PDF

本机 Zotero **关掉了文件同步**（`extensions.zotero.sync.storage.enabled = false`）。

让 MCP 的 `zotero_add_item` 上传 PDF，字节只进 Zotero **云端**；桌面端不会把它拉到
`storage\<KEY>\`，本地于是根本没有文件，附件永远卡在 `imported_file`。下次读这篇
论文按路径去找必然扑空，得先跑一遍 repair 才救得回来 —— DataMaster 那次就是这么坏的。

`zotero_add.py` 从源头绕开这条路：PDF 自己下、自己放进 LABD、附件直接建成
`linked_file`，全程不碰云端存储。建完还会回查一次确认 `linkMode` 和文件都对，
不对就报错，不会留下指向空气的附件。

**所以入库一律走这个脚本。** `zotero_add_item` 只在需要从 ISBN / BibTeX / 网页这类
脚本不认的来源建条目时才用，且必须带 `attach_mode='none'`，PDF 事后用
paper-read 的 `zotero_link.py add <pdf> --parent <key>` 挂上去。

## 选项

| 选项 | 作用 |
|---|---|
| `--collection NAME` | 放进分类，可重复。传分类名或 8 位 key；名字不认识会报错并列出现有分类 |
| `--tag TAG` | 打标签，可重复 |
| `--pdf PATH` | 用本地这份 PDF，不联网下（**move 进 LABD，原文件会消失**） |
| `--no-pdf` | 只建父条目，不要附件 |
| `--name FILE.pdf` | 自定义 LABD 里的文件名，默认按 ZotMoov 规则生成 |
| `--force` | 库里已有同一篇也照样新建 |
| `--json` | stdout 输出 JSON（含 itemKey / attachmentKey / path） |

现有分类：`autoEvolve` `hallu` `agent` `LLM` `harness` `TechReport` `其他` `归档`（下有若干子类）。
不确定放哪就问用户，别自己塞进「其他」。

## 行为细节

- **查重默认开着**：按 DOI / arXiv id / 标题在库里找，撞上就报错退出并给出已有条目的
  key，不会静默存两份。确实要重复存才加 `--force`。
- **文件名复刻 ZotMoov**：`Hu 等 - 2026 - Astar Learning to Propose....pdf`，
  撞名自动加 ` 1`。
- **PDF 会校验**：开头不是 `%PDF-` 或体积小于 10 KB 就拒绝落库 —— 挡住把登录墙
  和反爬页面当论文存进去。
- **元数据来源**：arXiv 走 arXiv API（`preprint` 条目，带 repository / archiveID / DOI）；
  DOI 走 CrossRef（按 type 映射成 journalArticle / conferencePaper / …），
  字段按官方 item template 填，不会因为多塞字段被整条拒掉。
- `10.48550/arXiv.xxxx` 会自动识别成 arXiv —— 这个 DOI 在 CrossRef 查不到。

## 批量

一篇一条命令，串起来跑就行：

```bash
for id in 2608.27287 2605.10906 2505.24298; do
  "C:/Users/ShuttleMan/miniconda3/python.exe" \
    ~/.claude/skills/paper-add/scripts/zotero_add.py "$id" --collection autoEvolve
done
```

任何一篇失败（查重撞上、PDF 下不来）只影响它自己，其余照常。

## 排查

| 症状 | 处理 |
|---|---|
| `没有可用的开放 PDF 直链` | CrossRef 没给开放直链。自己找一份下下来用 `--pdf` 传，或先 `--no-pdf` 建条目 |
| `下回来的不是 PDF` | 出版商挡爬虫。同上，手动下载后 `--pdf` |
| `arXiv 上查不到` | id 写错了，或论文还没放出来 |
| `库里已经有了` | 正常的查重拦截。要读它用 paper-read 的 `zotero_link.py resolve <key>` |
| `没有叫「X」的分类` | 分类名打错，报错信息里列了全部现有分类 |
| 附件 `linkMode` 不是 `linked_file` | 脚本会直接报错。说明有人绕过脚本用了 MCP 上传，按上面那条硬约束处理 |

配置真值（LABD、dataDir）在
`C:\Users\ShuttleMan\AppData\Roaming\Zotero\Zotero\Profiles\rmgu60eo.default\prefs.js`，
脚本每次运行都从这里读。API key 从 `~/.claude.json` 的 zotero MCP 配置里取。
两处都不要在别处写死。

读论文、解析 PDF、写笔记回库 → 用 **paper-read** 技能。
