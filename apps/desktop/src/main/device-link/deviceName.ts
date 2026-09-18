import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
let resolvedName: string | undefined;
let initialization: Promise<void> | undefined;

/** One process-lifetime lookup. Restart Cindy to pick up a changed ComputerName. */
export function initializeDeviceName(): Promise<void> {
  initialization ??= readDeviceName().then((name) => {
    resolvedName = name;
  });
  return initialization;
}

/** Default name reported to the relay; user-assigned names are handled by the server. */
export function deviceName(): string {
  return resolvedName ?? hostnameFallback();
}

async function readDeviceName(): Promise<string> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('/usr/sbin/scutil', ['--get', 'ComputerName'], {
        encoding: 'utf8',
        timeout: 500,
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024,
      });
      const name = stdout.trim();
      if (name) return name;
    } catch {
      // Missing/unavailable ComputerName is expected to fall back to hostname.
    }
  }

  return hostnameFallback();
}

function hostnameFallback(): string {
  const name = os
    .hostname()
    .trim()
    .replace(/\.local\.?$/i, '')
    .trim();
  return name || 'Unknown Device';
}
