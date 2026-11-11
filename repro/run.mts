// Scratch diagnostic (not for merge): on Windows, does a timed-out memory scope probe leave the
// real git running inside the probed folder, so the folder cannot be deleted? Old vs new code.
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import * as oldResolver from './old/scope-resolver.ts';
import * as newResolver from './new/scope-resolver.ts';

const pipeName = `\\\\.\\pipe\\cindy-git-probe-${process.pid}`;
const held: net.Socket[] = [];
// A config include that never answers: git blocks reading it, after `-C` moved it into the folder.
const server = net.createServer((socket) => { held.push(socket); socket.pause(); });
await new Promise<void>((resolve) => server.listen(pipeName, resolve));

function gitProcesses(): string {
  return execFileSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='git.exe'\" | ForEach-Object { \"$($_.ProcessId) parent=$($_.ParentProcessId) $($_.ExecutablePath) :: $($_.CommandLine)\" }"],
  { encoding: 'utf8' }).trim() || '(none)';
}

async function variant(label: string, resolve: typeof oldResolver.resolveMemoryScopeKey, includeValue: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `probe-${label}-`));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'include.path';
  process.env.GIT_CONFIG_VALUE_0 = includeValue;
  const started = Date.now();
  const key = await resolve(dir);
  const took = Date.now() - started;
  delete process.env.GIT_CONFIG_COUNT;
  delete process.env.GIT_CONFIG_KEY_0;
  delete process.env.GIT_CONFIG_VALUE_0;
  const after = gitProcesses();
  let removal = 'removed';
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    removal = `${e.code} ${e.syscall} ${e.path}`;
  }
  console.log(`\n[${label}] include=${includeValue} probe took ${took}ms, key===dir: ${key === dir}`);
  console.log(`[${label}] git.exe processes right after the probe settled:\n${after}`);
  console.log(`[${label}] immediate fs.rm of the probed folder: ${removal}`);
  try { execFileSync('taskkill', ['/IM', 'git.exe', '/T', '/F'], { stdio: 'ignore' }); } catch { /* none left */ }
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  return took;
}

console.log(execFileSync('where', ['git'], { encoding: 'utf8' }));
for (const include of [pipeName, pipeName.replace(/\\/g, '/')]) {
  const took = await variant('old', oldResolver.resolveMemoryScopeKey, include);
  if (took < 2500) { console.log('git did not block with this include form; trying the next'); continue; }
  await variant('new', newResolver.resolveMemoryScopeKey, include);
  break;
}
for (const socket of held) socket.destroy();
server.close();
