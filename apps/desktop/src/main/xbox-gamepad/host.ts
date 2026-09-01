import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';

import { createLogger } from '../logger.js';
import { isXboxGamepadHostMessage, type XboxGamepadHostMessage } from './protocol.js';

const execFilePromise = promisify(execFile);
const log = createLogger('xbox-gamepad-host');

const MAC_HELPER_SOURCE = path.join('native', 'xbox-gamepad', 'macos-xbox-gamepad-helper.swift');
const MAC_HELPER_RESOURCE = path.join('tools', 'xbox-gamepad', 'cindy-macos-xbox-gamepad-helper');

/** Skip recompiling the same broken helper source on every 2s probe. */
let failedHelperSourceMtime = 0;

export interface XboxGamepadHost {
  start(): void;
  probe(): void;
  stop(): void;
}

export interface XboxGamepadHostDeps {
  spawnHelper?(command: string): ChildProcessWithoutNullStreams;
  resolveHelperPath?(): Promise<string>;
}

const HELPER_RESTART_LIMIT = 3;
const HELPER_RESTART_BASE_MS = 1_000;
const HELPER_STABLE_MS = 10_000;

export function createXboxGamepadHost(
  onMessage: (message: XboxGamepadHostMessage) => void,
  deps: XboxGamepadHostDeps = {},
): XboxGamepadHost {
  let child: ChildProcessWithoutNullStreams | null = null;
  let starting = false;
  let wanted = false;
  let buffer = '';
  let consecutiveFailures = 0;
  let crashAccounted = false;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isXboxGamepadHostMessage(parsed)) return;
      if (parsed.kind === 'log') {
        log[parsed.level](`[host] ${parsed.message}`);
        return;
      }
      onMessage(parsed);
    } catch {
      log.debug('ignored malformed Xbox gamepad helper line');
    }
  };

  const clearTimer = (timer: ReturnType<typeof setTimeout> | null): null => {
    if (timer) clearTimeout(timer);
    return null;
  };

  const clearRestart = (): void => {
    restartTimer = clearTimer(restartTimer);
  };

  const clearStable = (): void => {
    stableTimer = clearTimer(stableTimer);
  };

  const noteChildGone = (): void => {
    clearStable();
    if (!wanted || crashAccounted) return;
    crashAccounted = true;
    consecutiveFailures += 1;
    if (restartTimer || consecutiveFailures > HELPER_RESTART_LIMIT) return;
    const delayMs = HELPER_RESTART_BASE_MS * 2 ** (consecutiveFailures - 1);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (wanted) void startChild();
    }, delayMs);
    restartTimer.unref?.();
  };

  const writeHelper = (line: string): boolean => {
    if (!child?.stdin || child.stdin.destroyed) return false;
    try {
      child.stdin.write(line, (error) => {
        if (error) log.debug('xbox gamepad helper stdin write failed', { error: error.message });
      });
      return true;
    } catch {
      return false;
    }
  };

  const attach = (next: ChildProcessWithoutNullStreams): void => {
    child = next;
    starting = false;
    crashAccounted = false;
    clearStable();
    stableTimer = setTimeout(() => {
      if (child === next) consecutiveFailures = 0;
    }, HELPER_STABLE_MS);
    stableTimer.unref?.();
    next.stdout.setEncoding('utf8');
    next.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });
    next.stderr.setEncoding('utf8');
    next.stderr.on('data', (chunk: string) => {
      const message = chunk.trim();
      if (message) log.debug('xbox gamepad helper stderr', { message });
    });
    next.stdin.on('error', (error: Error) => {
      log.debug('xbox gamepad helper stdin error', { error: error.message });
    });
    next.on('error', (error: Error) => {
      if (child === next) child = null;
      starting = false;
      if (!wanted) return;
      reportHostFailure(error.message);
      noteChildGone();
    });
    next.on('exit', (code, signal) => {
      if (child === next) child = null;
      if (!wanted) return;
      reportHostFailure(`Xbox gamepad helper exited unexpectedly (${code ?? signal ?? 'unknown'})`);
      noteChildGone();
    });
  };

  const reportHostFailure = (message: string): void => {
    log.warn('Xbox gamepad helper failed', { error: message });
    onMessage({ kind: 'host-error', message });
  };

  const startChild = async (): Promise<void> => {
    if (!wanted || child || starting || consecutiveFailures > HELPER_RESTART_LIMIT) return;
    starting = true;
    try {
      const helperPath = await (deps.resolveHelperPath ?? resolveXboxGamepadHelperPath)();
      if (!wanted) {
        starting = false;
        return;
      }
      const next = (deps.spawnHelper ?? defaultSpawnHelper)(helperPath);
      attach(next);
    } catch (error) {
      starting = false;
      const message = error instanceof Error ? error.message : String(error);
      // Not `presence: false` — a helper that won't build is an error state, not
      // "no controller plugged in", and the settings page must say so.
      reportHostFailure(message);
      noteChildGone();
    }
  };

  return {
    start() {
      wanted = true;
      consecutiveFailures = 0;
      crashAccounted = false;
      void startChild();
    },
    probe() {
      if (writeHelper('probe\n')) return;
      void startChild();
    },
    stop() {
      wanted = false;
      clearRestart();
      clearStable();
      const current = child;
      child = null;
      if (!current) return;
      try {
        if (!current.stdin.destroyed) {
          current.stdin.write('stop\n', (error) => {
            if (error)
              log.debug('xbox gamepad helper stdin write failed', { error: error.message });
          });
          current.stdin.end();
        }
      } catch {
        // The helper may already have exited.
      }
      current.kill();
    },
  };
}

function defaultSpawnHelper(command: string): ChildProcessWithoutNullStreams {
  return spawn(command, [], { stdio: ['pipe', 'pipe', 'pipe'] });
}

async function resolveXboxGamepadHelperPath(): Promise<string> {
  if (process.platform === 'darwin') return resolveMacHelperPath();
  throw new Error(`Xbox gamepad helper is not available on ${process.platform}`);
}

async function resolveMacHelperPath(): Promise<string> {
  const packaged = path.join(process.resourcesPath, MAC_HELPER_RESOURCE);
  if (app.isPackaged && fs.existsSync(packaged)) return packaged;

  const source = resolveMacHelperSource();
  const helperDir = path.dirname(source);
  const switch2UsbC = path.join(helperDir, 'switch2_usb.c');
  const switch2UsbH = path.join(helperDir, 'switch2_usb.h');
  const binary = path.join(
    app.getPath('userData'),
    'xbox-gamepad',
    'cindy-macos-xbox-gamepad-helper',
  );
  if (!fs.existsSync(source)) {
    throw new Error(`Xbox gamepad helper source missing at ${source}`);
  }
  const sourceMtime = Math.max(
    fs.statSync(source).mtimeMs,
    fs.existsSync(switch2UsbC) ? fs.statSync(switch2UsbC).mtimeMs : 0,
    fs.existsSync(switch2UsbH) ? fs.statSync(switch2UsbH).mtimeMs : 0,
  );
  if (fs.existsSync(binary) && fs.statSync(binary).mtimeMs >= sourceMtime) {
    failedHelperSourceMtime = 0;
    return binary;
  }
  if (failedHelperSourceMtime === sourceMtime) {
    throw new Error('Xbox gamepad helper compile failed; waiting for source change');
  }
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  try {
    await execFilePromise(
      'swiftc',
      [
        source,
        switch2UsbC,
        '-import-objc-header',
        switch2UsbH,
        '-O',
        '-framework',
        'Foundation',
        '-framework',
        'GameController',
        '-framework',
        'IOKit',
        '-o',
        binary,
      ],
      { timeout: 30_000 },
    );
  } catch (error) {
    failedHelperSourceMtime = sourceMtime;
    throw error;
  }
  failedHelperSourceMtime = 0;
  fs.chmodSync(binary, 0o755);
  log.info('built Xbox gamepad helper', { path: binary });
  return binary;
}

function resolveMacHelperSource(): string {
  const fromApp = path.join(app.getAppPath(), MAC_HELPER_SOURCE);
  if (fs.existsSync(fromApp)) return fromApp;
  return path.join(__dirname, '..', '..', MAC_HELPER_SOURCE);
}
