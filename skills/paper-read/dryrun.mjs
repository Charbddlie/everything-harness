#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const python = join(homedir(), 'miniconda3', 'python.exe');
const result = spawnSync(python, ['-B', '-c', `
import os, runpy, sys
from pathlib import Path
m = runpy.run_path(str(Path("scripts") / "zotero_link.py"))
errors = []
prefs = m["read_prefs"]()
if not os.path.isfile(m["PREFS"]):
    errors.append("Zotero prefs.js is missing; configure Zotero first.")
labd = prefs.get("extensions.zotero.baseAttachmentPath")
if not labd or not os.path.isdir(labd):
    errors.append("Configure an existing Zotero linked attachment base directory.")
if prefs.get("extensions.zotmoov.dst_dir") != labd:
    errors.append("Set ZotMoov dst_dir to the linked attachment base directory.")
try:
    m["load_credentials"]()
except SystemExit:
    errors.append("Set ZOTERO_API_KEY and ZOTERO_LIBRARY_ID, or configure Zotero MCP.")
parser = Path("scripts") / "mineru_parse.py"
mineru = runpy.run_path(str(parser))
try:
    mineru["get_api_key"](parser)
except SystemExit as error:
    errors.append(str(error))
for error in errors:
    print(error, file=sys.stderr)
sys.exit(bool(errors))
`], { cwd: import.meta.dirname, encoding: 'utf8', windowsHide: true, timeout: 20_000 });

if (result.error || result.status !== 0) {
  console.error(result.error?.message ?? (result.stderr.trim() || `Python exited: ${result.signal ?? result.status}`));
  process.exitCode = 1;
} else {
  console.log('[paper-read] 通过');
}
