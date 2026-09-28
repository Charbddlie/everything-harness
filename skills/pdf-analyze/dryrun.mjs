#!/usr/bin/env node
import { environmentIssues } from './scripts/mineru_parse.mjs';

export function dryrun() {
  const errors = environmentIssues();
  for (const error of errors) console.error(`[pdf-analyze] ${error}`);
  if (errors.length) return 1;
  console.log('[pdf-analyze] 环境检查通过（Node.js、curl、MINERU_API_KEY）；未请求 MinerU。');
  return 0;
}

if (import.meta.main) process.exitCode = dryrun();
