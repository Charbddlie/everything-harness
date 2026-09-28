#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
zotero_link.py — 把 Zotero 附件统一收敛成 "ZotMoov 风格的 linked_file"，
让附件的本地路径可预测、可复读。

背景
----
本机 Zotero 关掉了文件同步 (extensions.zotero.sync.storage.enabled = false)，
附件靠 ZotMoov 搬进 baseAttachmentPath(LABD) 后以 linked_file 形式存在。

但通过 Zotero **web API**（zotero-mcp 的 ZOTERO_LOCAL=false 模式）新增论文时，
PDF 字节只会进 Zotero **云端存储**，桌面端因为文件同步是关的，永远不会把字节
下载到 storage\\<KEY>\\；本地没有文件，ZotMoov 就没有东西可搬，附件于是永远卡在
imported_file 状态。此时按 dataDir\\storage\\<KEY>\\<filename> 拼出来的路径不存在。

这个脚本把这条路堵上：
  resolve  取某条目的本地 PDF 绝对路径；发现 imported_* 且本地缺文件就自动修复
  add      把一个本地 PDF 放进 LABD 并建 linked_file 附件（新论文入库走这条）
  repair   强制把某个 imported_* 附件转成 linked_file（顺带回收云端存储配额）

用法
----
  python zotero_link.py resolve <ITEM_KEY|ATTACHMENT_KEY>
  python zotero_link.py add <pdf路径> --parent <ITEM_KEY> [--name "自定义文件名.pdf"]
  python zotero_link.py repair <ITEM_KEY|ATTACHMENT_KEY>

成功时最后一行打印 PDF 的绝对路径，直接喂给 mineru_parse.py。
"""

import argparse
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# 路径里有中文（LABD 是 ...\OneDrive\附件\Zotero），Windows 控制台默认 GBK 会把它
# 打成乱码，下游拿到的路径就打不开了。强制 UTF-8 输出。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

PREFS = os.path.expandvars(
    r"%APPDATA%\Zotero\Zotero\Profiles\rmgu60eo.default\prefs.js"
)
CLAUDE_JSON = os.path.expanduser(r"~\.claude.json")
KEY_ENV = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, "key.env")
API = "https://api.zotero.org"
LOCAL_API = "http://127.0.0.1:23119/api/users/0"

PDF_EXT = {"application/pdf": ".pdf", "application/epub+zip": ".epub"}


# --------------------------------------------------------------------------- 配置

def read_prefs(path=PREFS):
    """从 prefs.js 里取 Zotero 的路径配置，避免把绝对路径写死在脚本里。"""
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
    """API key / library id：优先 env，其次 key.env，最后 ~/.claude.json 的 MCP 配置。"""
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
            env = (
                cfg.get("mcpServers", {})
                .get("zotero", {})
                .get("env", {})
            )
            key = key or env.get("ZOTERO_API_KEY")
            lib = lib or env.get("ZOTERO_LIBRARY_ID")
        except (ValueError, OSError):
            pass

    if not key or not lib:
        die("找不到 ZOTERO_API_KEY / ZOTERO_LIBRARY_ID，"
            "在 key.env 里补上，或设成环境变量。")
    return key, lib


class Ctx(object):
    def __init__(self):
        prefs = read_prefs()
        self.labd = prefs.get("extensions.zotero.baseAttachmentPath")
        self.datadir = prefs.get("extensions.zotero.dataDir")
        if not self.labd:
            die("prefs.js 里没有 extensions.zotero.baseAttachmentPath，"
                "先在 Zotero 设置里配好链接附件基准目录。")
        self.api_key, self.library = load_credentials()

    def url(self, path):
        return "%s/users/%s%s" % (API, self.library, path)


def die(msg, code=1):
    sys.stderr.write("[zotero_link] %s\n" % msg)
    sys.exit(code)


def log(msg):
    sys.stderr.write("[zotero_link] %s\n" % msg)


# --------------------------------------------------------------------------- HTTP

def request(url, method="GET", data=None, headers=None, api_key=None, raw=False):
    hdrs = {"Zotero-API-Version": "3", "User-Agent": "paper-read/1.0"}
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


def download(url, dest, api_key=None):
    hdrs = {"User-Agent": "Mozilla/5.0 paper-read/1.0"}
    if api_key:
        hdrs["Zotero-API-Key"] = api_key
    req = urllib.request.Request(url, headers=hdrs)
    tmp = dest + ".part"
    try:
        with urllib.request.urlopen(req, timeout=300) as resp, open(tmp, "wb") as fh:
            shutil.copyfileobj(resp, fh)
    except urllib.error.HTTPError as exc:
        if os.path.exists(tmp):
            os.remove(tmp)
        die("下载失败 %s -> HTTP %s" % (url, exc.code))
    except urllib.error.URLError as exc:
        if os.path.exists(tmp):
            os.remove(tmp)
        die("下载失败 %s: %s" % (url, exc.reason))
    size = os.path.getsize(tmp)
    if size == 0:
        os.remove(tmp)
        die("下载得到 0 字节：%s" % url)
    os.replace(tmp, dest)
    return size


# --------------------------------------------------------------------------- Zotero

def get_item(ctx, key):
    _, body, _ = request(ctx.url("/items/%s" % key), api_key=ctx.api_key)
    return body


def get_children(ctx, key):
    _, body, _ = request(ctx.url("/items/%s/children" % key), api_key=ctx.api_key)
    return body or []


def pick_attachment(ctx, key):
    """传父条目 key 就挑最合适的附件；传附件 key 就原样返回。"""
    item = get_item(ctx, key)
    data = item.get("data", {})
    if data.get("itemType") == "attachment":
        return item, get_item(ctx, data["parentItem"]) if data.get("parentItem") else None

    kids = [k for k in get_children(ctx, key)
            if k.get("data", {}).get("itemType") == "attachment"]
    if not kids:
        die("条目 %s 没有附件。" % key)
    pdfs = [k for k in kids
            if k["data"].get("contentType") == "application/pdf"]
    return (pdfs or kids)[0], item


def sanitize(text, limit=120):
    text = re.sub(r"[\\/:*?\"<>|\r\n\t]", "", text or "")
    text = re.sub(r"\s+", " ", text).strip().rstrip(". ")
    return text[:limit].strip()


def zotmoov_name(parent, ext=".pdf"):
    """复刻 ZotMoov 的命名：`Liu 等 - 2026 - Title.pdf`。"""
    data = (parent or {}).get("data", {})
    creators = [c for c in data.get("creators", [])
                if c.get("creatorType") in ("author", "editor", None)]
    if creators:
        first = creators[0]
        who = first.get("lastName") or first.get("name") or "Unknown"
        if len(creators) > 1:
            who += " 等"
    else:
        who = "Unknown"

    date = data.get("date", "") or ""
    m = re.search(r"(1[89]\d{2}|20\d{2}|21\d{2})", date)
    year = m.group(1) if m else "n.d."

    title = sanitize(data.get("title", "") or "Untitled")
    return "%s - %s - %s%s" % (sanitize(who, 60), year, title, ext)


def unique_path(directory, filename):
    """撞名就加 ` 1` / ` 2`，和 ZotMoov 的行为一致。"""
    base, ext = os.path.splitext(filename)
    candidate = os.path.join(directory, filename)
    n = 1
    while os.path.exists(candidate):
        candidate = os.path.join(directory, "%s %d%s" % (base, n, ext))
        n += 1
    return candidate


def attachment_local_path(ctx, att):
    """按 linkMode 算出本地路径；不判断是否存在。"""
    data = att.get("data", {})
    mode = data.get("linkMode")
    if mode == "linked_file":
        path = data.get("path", "")
        if path.startswith("attachments:"):
            return os.path.join(ctx.labd, path[len("attachments:"):])
        return path or None
    if mode in ("imported_file", "imported_url"):
        fn = data.get("filename")
        if not fn or not ctx.datadir:
            return None
        return os.path.join(ctx.datadir, "storage", data["key"], fn)
    return None


def create_linked_attachment(ctx, parent_key, filename, content_type="application/pdf"):
    payload = [{
        "itemType": "attachment",
        "linkMode": "linked_file",
        "parentItem": parent_key,
        "title": filename,
        "path": "attachments:%s" % filename,
        "contentType": content_type,
    }]
    _, body, _ = request(ctx.url("/items"), method="POST",
                         data=payload, api_key=ctx.api_key)
    ok = (body or {}).get("successful", {})
    if "0" not in ok:
        die("建 linked_file 附件失败：%s" % json.dumps(body)[:400])
    return ok["0"]["key"]


def delete_item(ctx, key, version):
    request(ctx.url("/items/%s" % key), method="DELETE",
            headers={"If-Unmodified-Since-Version": str(version)},
            api_key=ctx.api_key, raw=True)


def wait_for_local_sync(key, timeout=90):
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


# --------------------------------------------------------------------------- 命令

def do_repair(ctx, key, quiet=False):
    att, parent = pick_attachment(ctx, key)
    data = att["data"]
    mode = data.get("linkMode")

    if mode == "linked_file":
        path = attachment_local_path(ctx, att)
        if path and os.path.exists(path):
            if not quiet:
                log("已经是 linked_file 且文件在位，无需修复。")
            return path
        die("附件 %s 是 linked_file，但文件不在 %s —— 文件可能被手动挪走或删了，"
            "需要人工确认。" % (data["key"], path))

    if mode not in ("imported_file", "imported_url"):
        die("不支持的 linkMode: %s" % mode)

    enclosure = att.get("links", {}).get("enclosure")
    if not enclosure:
        die("附件 %s 在云端也没有文件，没得救 —— 重新下载 PDF 后用 `add` 子命令。"
            % data["key"])

    ext = PDF_EXT.get(data.get("contentType"),
                      os.path.splitext(data.get("filename", ""))[1] or ".pdf")
    filename = zotmoov_name(parent, ext) if parent else sanitize(data.get("filename", "paper")) + ext
    dest = unique_path(ctx.labd, filename)

    log("从云端取回 %s ..." % data["key"])
    size = download(ctx.url("/items/%s/file" % data["key"]), dest, api_key=ctx.api_key)
    log("已存到 %s (%d bytes)" % (dest, size))

    # 先删旧的 imported 附件（顺带回收云端存储配额），再建 linked_file。
    # 文件字节已经落地，删除是安全的。
    delete_item(ctx, data["key"], att["version"])
    new_key = create_linked_attachment(ctx, data["parentItem"],
                                       os.path.basename(dest),
                                       data.get("contentType") or "application/pdf")
    log("新附件 key = %s (linked_file)" % new_key)
    wait_for_local_sync(new_key)
    return dest


def do_add(ctx, pdf, parent_key, name=None):
    if not os.path.exists(pdf):
        die("找不到文件：%s" % pdf)
    parent = get_item(ctx, parent_key)
    if parent.get("data", {}).get("itemType") == "attachment":
        die("--parent 要传父条目 key，不是附件 key。")

    ext = os.path.splitext(pdf)[1] or ".pdf"
    filename = name or zotmoov_name(parent, ext)
    dest = unique_path(ctx.labd, filename)

    shutil.move(pdf, dest)
    log("已放入 %s" % dest)

    ctype = "application/pdf" if ext.lower() == ".pdf" else "application/octet-stream"
    new_key = create_linked_attachment(ctx, parent_key, os.path.basename(dest), ctype)
    log("新附件 key = %s (linked_file)" % new_key)
    wait_for_local_sync(new_key)
    return dest


def do_resolve(ctx, key):
    att, _ = pick_attachment(ctx, key)
    path = attachment_local_path(ctx, att)
    if path and os.path.exists(path):
        return path
    log("本地缺文件（linkMode=%s），自动修复……" % att["data"].get("linkMode"))
    return do_repair(ctx, key, quiet=True)


def main():
    ap = argparse.ArgumentParser(description="Zotero 附件路径解析 / 修复")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("resolve", help="拿到本地绝对路径，必要时自动修复")
    p.add_argument("key")

    p = sub.add_parser("add", help="把本地 PDF 挂到条目上（linked_file）")
    p.add_argument("pdf")
    p.add_argument("--parent", required=True)
    p.add_argument("--name", default=None)

    p = sub.add_parser("repair", help="把 imported_* 附件转成 linked_file")
    p.add_argument("key")

    args = ap.parse_args()
    ctx = Ctx()

    if args.cmd == "resolve":
        path = do_resolve(ctx, args.key)
    elif args.cmd == "add":
        path = do_add(ctx, args.pdf, args.parent, args.name)
    else:
        path = do_repair(ctx, args.key)

    print(path)


if __name__ == "__main__":
    main()
