#!/usr/bin/env node
/**
 * Internal TTY-preserving runner for restart-desktop-remote.mjs.
 * Electron writes the ready status; this runner records an early pnpm/Forge exit.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePnpmInvocation, usablePnpmExecPath } from './shared/pnpm-invocation.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
if (mode !== 'remote' && mode !== 'local') {
  console.error(`desktop-dev-runner: mode must be remote or local, received ${mode ?? '(empty)'}`);
  process.exit(2);
}

const devScript = mode === 'local' ? 'dev:desktop' : 'dev:desktop:remote';
// The restart pipeline opens a fresh Windows cmd.exe. That environment does
// not always carry npm_execpath, and may carry a stale one, so the path is
// validated before use; resolvePnpmInvocation then decides how to execute it
// (JS entry via node, native binary directly, command wrapper through PATH),
// and falls back to PATH/PATHEXT resolution when nothing usable is left.
const invocation = resolvePnpmInvocation([devScript], {
  npmExecPath: usablePnpmExecPath(process.env.npm_execpath, fs.existsSync),
});
const { command, args } = invocation;

const child = spawn(command, args, {
  cwd: rootDir,
  env: { ...process.env, COREPACK_ENABLE_AUTO_PIN: '0', ...(invocation.env ?? {}) },
  stdio: 'inherit',
  windowsHide: false,
  shell: invocation.shell,
  windowsVerbatimArguments: invocation.windowsVerbatimArguments,
});

child.once('error', (error) => {
  writeFailedStatus({ exitCode: null, error: error.message });
  console.error(`desktop-dev-runner: ${error.message}`);
  process.exit(1);
});

child.once('exit', (code, signal) => {
  const statusPath = process.env.XDT_DESKTOP_DEV_STARTUP_STATUS_FILE;
  const existing = statusPath ? readStatus(statusPath) : null;
  if (statusPath) {
    if (existing?.state === 'ready' || existing?.state === 'abandoned' || !existing) {
      fs.rmSync(statusPath, { force: true });
    } else if (existing.state !== 'failed') {
      writeFailedStatus({ exitCode: code, signal });
    }
  }

  if (signal && process.platform !== 'win32') {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

function readStatus(statusPath) {
  try {
    return JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeFailedStatus(detail) {
  const statusPath = process.env.XDT_DESKTOP_DEV_STARTUP_STATUS_FILE;
  const state = statusPath ? readStatus(statusPath)?.state : null;
  if (!statusPath || state === 'ready' || state === 'abandoned') return;
  const errorMessage = detail.error ? ` Desktop dev command failed: ${detail.error}` : '';
  writeStatus(statusPath, {
    state: 'failed',
    code: 'DEV_PROCESS_EXITED',
    message: `The desktop dev process exited before the main window became ready.${errorMessage}`,
    detail: {
      rootDir,
      command,
      devScript,
      ...detail,
    },
    ...detail,
    pid: process.pid,
    at: Date.now(),
  });
}

function writeStatus(statusPath, status) {
  const tempPath = `${statusPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(status)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, statusPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    console.error(`desktop-dev-runner: failed to write startup status: ${error.message}`);
  }
}
