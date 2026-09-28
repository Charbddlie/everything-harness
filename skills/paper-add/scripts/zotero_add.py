#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
zotero_add.py — 一条命令把一篇论文入库，产出形态和 ZotMoov 亲手搬完全一致。

为什么需要它
------------
本机 Zotero 关掉了文件同步 (extensions.zotero.sync.storage.enabled = false)。
走 zotero-mcp 的 `zotero_add_item` 让它上传 PDF 时，字节只进 Zotero 云端；桌面端
不会把字节拉到 storage\\<KEY>\\，于是附件永远卡在 imported_file，本地根本没有文件。
下次读这篇论文时按路径去找必然扑空，得先跑一遍 repair 把它救回来。

这个脚本从源头绕开那条路：元数据自己抓、PDF 自己下、文件自己放进 LABD、附件直接
建成 linked_file。全程不碰云端存储，入库即可读。

用法
----
  python zotero_add.py <arxiv_id|arxiv_url|doi|doi_url> [选项]

  --collection NAME   放进某个分类（可重复；接受分类名或 8 位 key）
  --tag TAG           打标签（可重复）
  --pdf PATH          用本地这份 PDF，不去网上下（move 进 LABD，原文件会消失）
  --no-pdf            只建父条目，不要附件
  --name FILE.pdf     自定义 LABD 里的文件名（默认按 ZotMoov 规则生成）
  --force             即使库里已有同名/同 DOI 条目也照样新建
  --json              stdout 输出 JSON（否则最后一行是 PDF 绝对路径）

成功时最后一行打印 PDF 绝对路径，可直接喂给 paper-read 的 mineru_parse.py。
"""

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

# LABD 路径里有中文（...\OneDrive\附件\Zotero），Windows 控制台默认 GBK 会打成乱码，
# 下游拿到的路径就打不开了。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

PREFS = os.path.expandvars(r"%APPDATA%\Zotero\Zotero\Profiles\rmgu60eo.default\prefs.js")
CLAUDE_JSON = os.path.expanduser(r"~\.claude.json")
KEY_ENV = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, "key.env")

API = "https://api.zotero.org"
LOCAL_API = "http://127.0.0.1:23119/api/users/0"
ARXIV_API = "http://export.arxiv.org/api/query"
CROSSREF_API = "https://api.crossref.org/works/"
UA = "paper-add/1.0 (Zotero linked_file importer)"

ATOM = "{http://www.w3.org/2005/Atom}"
ARXIV_NS = "{http://arxiv.org/schemas/atom}"

CROSSREF_TYPE = {
    "journal-article": "journalArticle",
    "proceedings-article": "conferencePaper",
    "posted-content": "preprint",
    "book-chapter": "bookSection",
    "book": "book",
    "monograph": "book",
    "report": "report",
    "dissertation": "thesis",
}


def die(msg, code=1):
    sys.stderr.write("[zotero_add] %s\n" % msg)
    sys.exit(code)


def log(msg):
    sys.stderr.write("[zotero_add] %s\n" % msg)


# --------------------------------------------------------------------------- 配置

def read_prefs(path=PREFS):
    """路径配置的真值在 prefs.js，不要在脚本里写死。"""
    out = {}
    if not os.path.exists(path):
        return out
    pat = re.compile(r'user_pref\("([^"]+)",\s*(.*?)\);\s*$')
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            m = pat.match(line.strip())
            if not m:
                continue
            key, raw = m.group(1), m.group(2).strip()
            if raw.startswith('"') and raw.endswith('"'):
                try:
                    raw = json.loads(raw)
                except ValueError:
                    raw = raw[1:-1].replace("\\\\", "\\")
            elif raw in ("true", "false"):
                raw = raw == "true"
            out[key] = raw
    return out


def load_credentials():
    """API key / library id：优先 env，其次 key.env，最后 ~/.claude.json 里的 MCP 配置。"""
    key = os.environ.get("ZOTERO_API_KEY")
    lib = os.environ.get("ZOTERO_LIBRARY_ID")

    env_path = os.path.normpath(KEY_ENV)
    if (not key or not lib) and os.path.exists(env_path):
        with open(env_path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() == "ZOTERO_API_KEY" and not key:
                    key = v.strip()
                elif k.strip() == "ZOTERO_LIBRARY_ID" and not lib:
                    lib = v.strip()

    if (not key or not lib) and os.path.exists(CLAUDE_JSON):
        try:
            with open(CLAUDE_JSON, encoding="utf-8") as fh:
                cfg = json.load(fh)
            env = cfg.get("mcpServers", {}).get("zotero", {}).get("env", {})
            key = key or env.get("ZOTERO_API_KEY")
            lib = lib or env.get("ZOTERO_LIBRARY_ID")
        except (ValueError, OSError):
            pass

    if not key or not lib:
        die("找不到 ZOTERO_API_KEY / ZOTERO_LIBRARY_ID，设成环境变量或写进 key.env。")
    return key, lib


class Ctx(object):
    def __init__(self):
        prefs = read_prefs()
        self.labd = prefs.get("extensions.zotero.baseAttachmentPath")
        if not self.labd:
            die("prefs.js 里没有 extensions.zotero.baseAttachmentPath，"
                "先在 Zotero 设置里配好链接附件基准目录。")
        if not os.path.isdir(self.labd):
            die("链接附件基准目录不存在：%s" % self.labd)
        self.api_key, self.library = load_credentials()
        self._collections = None

    def url(self, path):
        return "%s/users/%s%s" % (API, self.library, path)


# --------------------------------------------------------------------------- HTTP

def request(url, method="GET", data=None, headers=None, api_key=None, raw=False):
    hdrs = {"Zotero-API-Version": "3", "User-Agent": UA}
    if api_key:
        hdrs["Zotero-API-Key"] = api_key
    if data is not None:
        hdrs["Content-Type"] = "application/json"
        data = json.dumps(data).encode("utf-8")
    hdrs.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = resp.read()
            if raw:
                return resp.status, body, dict(resp.headers)
            text = body.decode("utf-8") if body else ""
            parsed = json.loads(text) if text.strip() else None
            return resp.status, parsed, dict(resp.headers)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        die("HTTP %s %s -> %s %s" % (method, url, exc.code, detail))
    except urllib.error.URLError as exc:
        die("网络错误 %s: %s" % (url, exc.reason))


def fetch_text(url, accept=None):
    hdrs = {"User-Agent": UA}
    if accept:
        hdrs["Accept"] = accept
    req = urllib.request.Request(url, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        die("抓元数据失败 %s -> HTTP %s" % (url, exc.code))
    except urllib.error.URLError as exc:
        die("抓元数据失败 %s: %s" % (url, exc.reason))


def download_pdf(url, dest):
    """下 PDF 并校验确实是 PDF —— 挡住把 HTML 拦截页当论文存进去。"""
    hdrs = {"User-Agent": "Mozilla/5.0 (compatible; %s)" % UA,
            "Accept": "application/pdf,*/*"}
    req = urllib.request.Request(url, headers=hdrs)
    tmp = dest + ".part"
    try:
        with urllib.request.urlopen(req, timeout=300) as resp, open(tmp, "wb") as fh:
            shutil.copyfileobj(resp, fh)
    except urllib.error.HTTPError as exc:
        _rm(tmp)
        die("下载失败 %s -> HTTP %s" % (url, exc.code))
    except urllib.error.URLError as exc:
        _rm(tmp)
        die("下载失败 %s: %s" % (url, exc.reason))

    with open(tmp, "rb") as fh:
        head = fh.read(5)
    size = os.path.getsize(tmp)
    if head != b"%PDF-":
        _rm(tmp)
        die("下回来的不是 PDF（开头是 %r）：%s\n"
            "  多半是登录墙或反爬页面，用 --pdf 传一份本地 PDF。" % (head, url))
    if size < 10240:
        _rm(tmp)
        die("PDF 只有 %d 字节，明显不对：%s" % (size, url))
    os.replace(tmp, dest)
    return size


def _rm(path):
    if os.path.exists(path):
        os.remove(path)


# --------------------------------------------------------------------------- 识别来源

def parse_source(src):
    """认出 arXiv id / arXiv 链接 / DOI / doi.org 链接，返回 ('arxiv'|'doi', 值)。"""
    s = (src or "").strip()
    if not s:
        die("没给来源。")

    m = re.search(r"arxiv\.org/(?:abs|pdf|html)/([0-9]{4}\.[0-9]{4,5})", s, re.I)
    if m:
        return "arxiv", m.group(1)
    m = re.match(r"(?:arxiv:)?\s*([0-9]{4}\.[0-9]{4,5})(?:v\d+)?$", s, re.I)
    if m:
        return "arxiv", m.group(1)
    # 10.48550/arXiv.xxxx 是 arXiv 自己铸的 DOI，CrossRef 查不到，得走 arXiv API
    m = re.search(r"10\.48550/arxiv\.([0-9]{4}\.[0-9]{4,5})", s, re.I)
    if m:
        return "arxiv", m.group(1)
    m = re.search(r"(10\.\d{4,9}/[^\s\"'<>]+)", s)
    if m:
        return "doi", m.group(1).rstrip(".,;)")
    # 旧式 arXiv id，例如 cs/0701001
    m = re.search(r"arxiv\.org/(?:abs|pdf)/([a-z\-]+(?:\.[A-Z]{2})?/\d{7})", s, re.I)
    if m:
        return "arxiv", m.group(1)
    die("看不懂的来源：%s\n  支持 arXiv id/链接、DOI、doi.org 链接。" % src)


def split_name(full):
    """'Jinxin Hu' -> ('Jinxin', 'Hu')；'Hu, Jinxin' 也认。"""
    full = re.sub(r"\s+", " ", (full or "").strip())
    if not full:
        return "", "Unknown"
    if "," in full:
        last, _, first = full.partition(",")
        return first.strip(), last.strip()
    parts = full.split(" ")
    if len(parts) == 1:
        return "", parts[0]
    return " ".join(parts[:-1]), parts[-1]


def strip_tags(text):
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = (text.replace("&lt;", "<").replace("&gt;", ">")
                .replace("&amp;", "&").replace("&quot;", '"'))
    return re.sub(r"\s+", " ", text).strip()


# --------------------------------------------------------------------------- 元数据

def meta_from_arxiv(arxiv_id):
    url = "%s?%s" % (ARXIV_API, urllib.parse.urlencode(
        {"id_list": arxiv_id, "max_results": 1}))
    root = ET.fromstring(fetch_text(url))
    entry = root.find(ATOM + "entry")
    if entry is None or entry.find(ATOM + "title") is None:
        die("arXiv 上查不到 %s" % arxiv_id)

    title = re.sub(r"\s+", " ", (entry.findtext(ATOM + "title") or "").strip())
    if title.lower() == "error":
        die("arXiv 上查不到 %s" % arxiv_id)

    published = (entry.findtext(ATOM + "published") or "")[:10]
    authors = [split_name(a.findtext(ATOM + "name"))
               for a in entry.findall(ATOM + "author")]
    doi = entry.findtext(ARXIV_NS + "doi") or ("10.48550/arXiv.%s" % arxiv_id)

    # arXiv 返回的 id 带版本号，落库时去掉，方便查重
    canonical = re.sub(r"v\d+$", "", arxiv_id)
    return {
        "itemType": "preprint",
        "title": title,
        "creators": authors,
        "abstractNote": re.sub(r"\s+", " ",
                               (entry.findtext(ATOM + "summary") or "").strip()),
        "date": published,
        "repository": "arXiv",
        "archiveID": "arXiv:%s" % canonical,
        "DOI": doi,
        "url": "https://arxiv.org/abs/%s" % canonical,
        "_pdf_url": "https://arxiv.org/pdf/%s" % canonical,
        "_ident": "arXiv:%s" % canonical,
    }


def meta_from_crossref(doi):
    url = CROSSREF_API + urllib.parse.quote(doi, safe="")
    try:
        payload = json.loads(fetch_text(url, accept="application/json"))
    except ValueError:
        die("CrossRef 返回的不是 JSON：%s" % doi)
    msg = payload.get("message") or {}
    if not msg.get("title"):
        die("CrossRef 上查不到 %s" % doi)

    parts = ((msg.get("issued") or {}).get("date-parts") or [[]])[0]
    date = "-".join("%02d" % p if i else str(p) for i, p in enumerate(parts)) if parts else ""

    creators = []
    for a in msg.get("author") or []:
        if a.get("family"):
            creators.append((a.get("given", ""), a["family"]))
        elif a.get("name"):
            creators.append(split_name(a["name"]))

    itype = CROSSREF_TYPE.get(msg.get("type", ""), "journalArticle")
    container = (msg.get("container-title") or [""])[0]
    meta = {
        "itemType": itype,
        "title": strip_tags((msg.get("title") or [""])[0]),
        "creators": creators,
        "abstractNote": strip_tags(msg.get("abstract", "")),
        "date": date,
        "DOI": msg.get("DOI", doi),
        "url": msg.get("URL", "https://doi.org/%s" % doi),
        "volume": msg.get("volume", ""),
        "issue": msg.get("issue", ""),
        "pages": msg.get("page", ""),
        "publisher": msg.get("publisher", ""),
        "ISSN": (msg.get("ISSN") or [""])[0],
        "ISBN": (msg.get("ISBN") or [""])[0],
        "language": msg.get("language", ""),
        "_ident": "doi:%s" % msg.get("DOI", doi),
    }
    if itype == "journalArticle":
        meta["publicationTitle"] = container
    elif itype == "conferencePaper":
        meta["proceedingsTitle"] = container
        meta["conferenceName"] = container
    elif itype == "bookSection":
        meta["bookTitle"] = container
    elif itype == "preprint":
        meta["repository"] = container or msg.get("publisher", "")

    # CrossRef 有时直接给开放的 PDF 直链
    for link in msg.get("link") or []:
        if link.get("content-type") == "application/pdf":
            meta["_pdf_url"] = link.get("URL")
            break
    return meta


# --------------------------------------------------------------------------- 查重

def norm_title(t):
    return re.sub(r"[^a-z0-9]+", "", (t or "").lower())


def find_existing(ctx, meta):
    """按 DOI / arXiv id / 标题找库里已有的同一篇。"""
    words = re.findall(r"[A-Za-z0-9]+", meta["title"])[:6]
    if not words:
        return None
    q = urllib.parse.urlencode({
        "q": " ".join(words), "qmode": "titleCreatorYear",
        "itemType": "-attachment", "limit": 25,
    })
    _, body, _ = request(ctx.url("/items?%s" % q), api_key=ctx.api_key)
    target_title = norm_title(meta["title"])
    target_doi = (meta.get("DOI") or "").lower()
    target_arxiv = (meta.get("archiveID") or "").lower()

    for it in body or []:
        d = it.get("data", {})
        if d.get("itemType") in ("attachment", "note"):
            continue
        if norm_title(d.get("title")) == target_title:
            return it
        if target_doi and (d.get("DOI") or "").lower() == target_doi:
            return it
        if target_arxiv:
            blob = " ".join([d.get("archiveID") or "", d.get("extra") or "",
                             d.get("url") or ""]).lower()
            if target_arxiv in blob:
                return it
    return None


# --------------------------------------------------------------------------- 建条目

def resolve_collections(ctx, names):
    """分类名或 8 位 key 都能传。名字不认识就直接报错，不静默丢掉。"""
    if not names:
        return []
    if ctx._collections is None:
        _, body, _ = request(ctx.url("/collections?limit=100"), api_key=ctx.api_key)
        ctx._collections = {c["data"]["name"].strip().lower(): c["data"]["key"]
                            for c in body or []}
    out = []
    for n in names:
        n = n.strip()
        if re.match(r"^[A-Z0-9]{8}$", n) and n.lower() not in ctx._collections:
            out.append(n)
            continue
        key = ctx._collections.get(n.lower())
        if not key:
            die("没有叫「%s」的分类。现有：%s"
                % (n, "、".join(sorted(ctx._collections))))
        out.append(key)
    return out


def item_template(ctx, item_type):
    _, body, _ = request("%s/items/new?itemType=%s" % (API, item_type),
                         api_key=ctx.api_key)
    if not body:
        die("拿不到 %s 的字段模板。" % item_type)
    return body


def create_parent(ctx, meta, collections, tags):
    """按官方模板填字段 —— 塞模板里没有的字段 Zotero 会整条拒掉。"""
    payload = item_template(ctx, meta["itemType"])
    for k, v in meta.items():
        if k.startswith("_") or k in ("itemType", "creators"):
            continue
        if k in payload and v:
            payload[k] = v
    payload["creators"] = [
        {"creatorType": "author", "firstName": f, "lastName": l}
        for f, l in meta["creators"]
    ]
    payload["collections"] = collections
    payload["tags"] = [{"tag": t} for t in tags]

    _, body, _ = request(ctx.url("/items"), method="POST", data=[payload],
                         api_key=ctx.api_key)
    ok = (body or {}).get("successful", {})
    if "0" not in ok:
        die("建条目失败：%s" % json.dumps(body, ensure_ascii=False)[:500])
    return ok["0"]["key"]


# --------------------------------------------------------------------------- 附件

def sanitize(text, limit=120):
    text = re.sub(r"[\\/:*?\"<>|\r\n\t]", "", text or "")
    text = re.sub(r"\s+", " ", text).strip().rstrip(". ")
    return text[:limit].strip()


def zotmoov_name(meta, ext=".pdf"):
    """复刻 ZotMoov 的命名：`Hu 等 - 2026 - Title.pdf`。"""
    creators = meta.get("creators") or []
    if creators:
        who = creators[0][1] or "Unknown"
        if len(creators) > 1:
            who += " 等"
    else:
        who = "Unknown"
    m = re.search(r"(1[89]\d{2}|20\d{2}|21\d{2})", meta.get("date", "") or "")
    year = m.group(1) if m else "n.d."
    return "%s - %s - %s%s" % (sanitize(who, 60), year,
                               sanitize(meta.get("title") or "Untitled"), ext)


def unique_path(directory, filename):
    """撞名加 ` 1` / ` 2`，和 ZotMoov 行为一致。"""
    base, ext = os.path.splitext(filename)
    candidate = os.path.join(directory, filename)
    n = 1
    while os.path.exists(candidate):
        candidate = os.path.join(directory, "%s %d%s" % (base, n, ext))
        n += 1
    return candidate


def create_linked_attachment(ctx, parent_key, filename, content_type="application/pdf"):
    payload = [{
        "itemType": "attachment",
        "linkMode": "linked_file",
        "parentItem": parent_key,
        "title": filename,
        "path": "attachments:%s" % filename,
        "contentType": content_type,
    }]
    _, body, _ = request(ctx.url("/items"), method="POST", data=payload,
                         api_key=ctx.api_key)
    ok = (body or {}).get("successful", {})
    if "0" not in ok:
        die("建 linked_file 附件失败：%s" % json.dumps(body, ensure_ascii=False)[:400])
    return ok["0"]["key"]


def verify_attachment(ctx, att_key, dest):
    """入库即可读是这个脚本存在的唯一理由，所以真的去查一遍。"""
    _, body, _ = request(ctx.url("/items/%s" % att_key), api_key=ctx.api_key)
    mode = (body or {}).get("data", {}).get("linkMode")
    if mode != "linked_file":
        die("附件 %s 的 linkMode 是 %s，不是 linked_file —— 这条路又被绕回去了。"
            % (att_key, mode))
    if not os.path.exists(dest):
        die("附件记录建好了，但文件不在 %s" % dest)


def wait_for_local_sync(key, timeout=60):
    """等桌面端把新记录同步下来，确认 Zotero 界面里点得开。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            req = urllib.request.Request("%s/items/%s" % (LOCAL_API, key))
            with urllib.request.urlopen(req, timeout=8) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(5)
    return False


# --------------------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser(
        description="把一篇论文入库为 ZotMoov 风格的 linked_file 附件")
    ap.add_argument("source", help="arXiv id / arXiv 链接 / DOI / doi.org 链接")
    ap.add_argument("--collection", action="append", default=[],
                    help="分类名或 8 位 key（可重复）")
    ap.add_argument("--tag", action="append", default=[], help="标签（可重复）")
    ap.add_argument("--pdf", default=None, help="用本地 PDF，不联网下载（会被 move 走）")
    ap.add_argument("--no-pdf", action="store_true", help="只建父条目")
    ap.add_argument("--name", default=None, help="自定义 LABD 里的文件名")
    ap.add_argument("--force", action="store_true", help="库里已有也照样新建")
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="stdout 输出 JSON")
    args = ap.parse_args()

    ctx = Ctx()
    kind, ident = parse_source(args.source)
    log("来源：%s %s" % (kind, ident))

    meta = meta_from_arxiv(ident) if kind == "arxiv" else meta_from_crossref(ident)
    log("元数据：%s（%s，%d 位作者）"
        % (meta["title"], meta.get("date") or "无日期", len(meta["creators"])))

    if not args.force:
        dup = find_existing(ctx, meta)
        if dup:
            d = dup["data"]
            die("库里已经有了：%s（key=%s，%s）\n"
                "  要读它就跑 paper-read 的 `zotero_link.py resolve %s`；\n"
                "  确实要再存一份就加 --force。"
                % (d.get("title"), d.get("key"), d.get("itemType"), d.get("key")))

    collections = resolve_collections(ctx, args.collection)
    parent_key = create_parent(ctx, meta, collections, args.tag)
    log("父条目 key = %s (%s)" % (parent_key, meta["itemType"]))

    result = {"itemKey": parent_key, "title": meta["title"],
              "itemType": meta["itemType"], "collections": collections,
              "attachmentKey": None, "path": None}

    if args.no_pdf:
        wait_for_local_sync(parent_key)
        _emit(args, result)
        return

    # --- PDF：先落到 LABD，再建附件记录。顺序反了会出现指向空气的附件 ---
    dest = unique_path(ctx.labd, args.name or zotmoov_name(meta))
    if args.pdf:
        if not os.path.exists(args.pdf):
            die("找不到文件：%s" % args.pdf)
        with open(args.pdf, "rb") as fh:
            if fh.read(5) != b"%PDF-":
                die("%s 不是 PDF。" % args.pdf)
        shutil.move(args.pdf, dest)
        log("已放入 %s" % dest)
    else:
        pdf_url = meta.get("_pdf_url")
        if not pdf_url:
            die("没有可用的开放 PDF 直链（%s）。\n"
                "  自己找一份下下来，再用 --pdf 传进来；\n"
                "  或者先 --no-pdf 建条目，之后补附件。" % meta["_ident"])
        log("下载 %s ..." % pdf_url)
        tmp = os.path.join(tempfile.gettempdir(), "zotero_add_%d.pdf" % os.getpid())
        size = download_pdf(pdf_url, tmp)
        shutil.move(tmp, dest)
        log("已放入 %s (%.1f MB)" % (dest, size / 1048576.0))

    att_key = create_linked_attachment(ctx, parent_key, os.path.basename(dest))
    verify_attachment(ctx, att_key, dest)
    log("附件 key = %s (linked_file，已校验)" % att_key)

    if not wait_for_local_sync(att_key):
        log("桌面端还没同步下来，Zotero 界面里稍等一会儿就有了（不影响读）。")

    result["attachmentKey"] = att_key
    result["path"] = dest
    _emit(args, result)


def _emit(args, result):
    if args.as_json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(result["path"] or result["itemKey"])


if __name__ == "__main__":
    main()
