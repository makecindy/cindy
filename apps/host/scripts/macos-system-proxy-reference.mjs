// Shared Electron reference for the macOS and Windows CI comparisons.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const script = fileURLToPath(new URL('./macos-system-proxy-electron.cjs', import.meta.url));

export async function electronProxyResults(binary, urls) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-proxy-compare-electron-'));
  try {
    const env = { ...process.env, CINDY_COMPARE_USER_DATA: userData };
    delete env.ELECTRON_RUN_AS_NODE;
    // This process serves the loopback PAC while Electron loads it.
    const { stdout } = await promisify(execFile)(binary, [script, JSON.stringify(urls)], { env, timeout: 60_000 });
    return JSON.parse(stdout.trim().split('\n').at(-1));
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
}
