---
name: pdf-analyze
description: Read, inspect, summarize, extract, or analyze local PDFs using cached MinerU output first; parse only when the cache is missing, incomplete, stale, or explicitly requested. Also use when moving or renaming a local PDF to keep its cache alongside it.
---

# PDF Analyze

## Rule

When a task requires reading a local PDF, first look for cached MinerU output at:

```text
<pdf parent>/.mineru/<pdf file stem>/
```

If the cache exists and contains usable extracted Markdown, JSON, or text, read from the cache first. Call MinerU only when the cache is missing, incomplete, stale for the request, or the user explicitly asks to reparse.

## MinerU Parse

Resolve `<skill-dir>` to the directory containing this `SKILL.md`; do not assume a particular agent's installation path. Use Node.js ≥22.20.0 and curl. Run `node "<skill-dir>/dryrun.mjs"` to check the environment without uploading a PDF or calling MinerU.

```bash
node "<skill-dir>/scripts/mineru_parse.mjs" /path/to/file.pdf
```

The script:

1. Reads `MINERU_API_KEY` only from the environment. If missing or blank, exits with `环境变量缺少MINERU_API_KEY` before contacting MinerU. No key file is read. Reusing existing cached output does not require a key.
2. Creates `<pdf parent>/.mineru/<pdf file stem>/`.
3. Requests MinerU upload URLs through the Precision API.
4. Uploads the PDF to the pre-signed URL.
5. Polls for completion.
6. Writes request/result metadata into the cache folder.
7. Downloads and safely extracts the result zip into the cache folder.

By default, the helper requests MinerU's `vlm` model version with formula and table recognition enabled.

Useful options:

```bash
node "<skill-dir>/scripts/mineru_parse.mjs" /path/to/file.pdf --force
node "<skill-dir>/scripts/mineru_parse.mjs" /path/to/file.pdf --output-root /path/to/.mineru
node "<skill-dir>/scripts/mineru_parse.mjs" /path/to/file.pdf --language ch
node "<skill-dir>/scripts/mineru_parse.mjs" /path/to/file.pdf --disable-formula --disable-table
```

## Reading Cached Results

Prefer files in this order when available:

1. Markdown files (`*.md`)
2. Text files (`*.txt`)
3. Structured JSON files (`*.json`)
4. Other extracted assets only when needed

Use `rg --files <pdf parent>/.mineru/<pdf file stem>` to inspect the cache without reading every extracted file into context.

## Moving or Renaming PDFs

When moving or renaming a PDF, move its MinerU cache alongside it when present. For `<dir>/<name>.pdf`, the cache is `<dir>/.mineru/<name>/`; if the PDF becomes `<new-dir>/<new-name>.pdf`, move the cache to `<new-dir>/.mineru/<new-name>/`.
