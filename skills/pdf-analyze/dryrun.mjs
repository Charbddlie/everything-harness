#!/usr/bin/env node
import { environmentIssues } from './scripts/mineru_parse.mjs';

export function dryrun() {
  const errors = environmentIssues();
  if (errors.length) {
    console.error(`[pdf-analyze] 失败：${errors.join('；')}`);
    return 1;
  }
  console.log('[pdf-analyze] 通过');
  return 0;
}

if (import.meta.main) process.exitCode = dryrun();
