#!/usr/bin/env node
// Native integration regression; requires a logged-in macOS desktop and Xcode.
// Run: node apps/desktop/scripts/test-island-reminder-drag.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

if (process.platform !== 'darwin') {
  throw new Error('灵动岛原生交互测试需要 macOS。');
}
const nativeDir = fileURLToPath(new URL('../native/agent-island/', import.meta.url));
const directory = mkdtempSync(path.join(tmpdir(), 'cindy-island-drag-'));
const env = { ...process.env, XDT_AGENT_ISLAND_ASSET_DIR: nativeDir };
if (!env.DEVELOPER_DIR && existsSync('/Applications/Xcode.app/Contents/Developer')) {
  env.DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';
}
try {
  // A single compilation unit lets the fixture exercise the private event handlers
  // without exporting test-only runtime APIs or copying their implementation.
  const source = ['macos-agent-island-helper.swift', 'reminder-drag.test.swift']
    .map(file => readFileSync(path.join(nativeDir, file), 'utf8')).join('\n');
  const main = path.join(directory, 'main.swift');
  const binary = path.join(directory, 'reminder-drag');
  writeFileSync(main, source);
  execFileSync('xcrun', ['swiftc', '-D', 'AGENT_ISLAND_INTERACTION_TEST', main, '-o', binary], {
    stdio: 'inherit', env,
  });
  execFileSync(binary, [], { stdio: 'inherit', env, timeout: 10000 });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
