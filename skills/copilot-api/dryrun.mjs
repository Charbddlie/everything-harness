#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const [major, minor] = process.versions.node.split('.').map(Number);
const errors = [];
if (major < 22 || (major === 22 && minor < 20)) {
  errors.push('Install Node.js >= 22.20.0.');
}
const result = process.platform === 'win32'
  ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'npm --version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
  : spawnSync('npm', ['--version'], { encoding: 'utf8', timeout: 15_000 });
if (result.error || result.status !== 0) {
  errors.push(`npm is unavailable: ${result.error?.message ?? (result.stderr.trim() || result.signal || result.status)}`);
}
if (errors.length) {
  console.error(`[copilot-api] ${errors.join(' ')}`);
  process.exitCode = 1;
} else {
  console.log('[copilot-api] Node.js and npm are ready. Run the skill to install and sign in.');
}
