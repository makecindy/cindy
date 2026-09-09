import { execFileSync } from 'node:child_process';
import path from 'node:path';
// eslint-disable-next-line no-restricted-imports -- Windows child-process pipes must be isolated from Electron Main.
import { Worker } from 'node:worker_threads';

import { isWindowsProcessScanWorkerMessage } from './windowsProcessScanProtocol.js';

export const WINDOWS_PROCESS_SCAN_WORKER_TIMEOUT_MS = 12_000;

export interface WindowsProcessScanWorkerHandle {
  on(event: 'message', listener: (value: unknown) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number) => void): this;
  postMessage(value: unknown): void;
  unref(): void;
  terminate(): Promise<number>;
}

interface WindowsProcessScanWorkerOptions {
  createWorker?: () => WindowsProcessScanWorkerHandle;
  timeoutMs?: number;
  terminateProcessTree?: (pid: number) => void;
}

interface ActiveWindowsProcessScan {
  worker: WindowsProcessScanWorkerHandle;
  childPid: number | null;
  childClosed: boolean;
  cleaning: boolean;
  cleanupPromise: Promise<void> | null;
  terminateProcessTree: (pid: number) => void;
}

const activeWindowsProcessScans = new Set<ActiveWindowsProcessScan>();

export async function runWindowsProcessScanWorker(
  options: WindowsProcessScanWorkerOptions = {},
): Promise<string> {
  const worker =
    options.createWorker?.() ?? new Worker(path.join(__dirname, 'windowsProcessScanWorker.js'));
  const scan: ActiveWindowsProcessScan = {
    worker,
    childPid: null,
    childClosed: false,
    cleaning: false,
    cleanupPromise: null,
    terminateProcessTree: options.terminateProcessTree ?? terminateWindowsProcessTree,
  };
  worker.unref();
  activeWindowsProcessScans.add(scan);
  try {
    return await waitForWorker(scan, options.timeoutMs ?? WINDOWS_PROCESS_SCAN_WORKER_TIMEOUT_MS);
  } finally {
    await cleanupWindowsProcessScan(scan);
    activeWindowsProcessScans.delete(scan);
  }
}

export function disposeWindowsProcessScanWorkers(): void {
  for (const scan of activeWindowsProcessScans) {
    void cleanupWindowsProcessScan(scan);
  }
}

function waitForWorker(scan: ActiveWindowsProcessScan, timeoutMs: number): Promise<string> {
  const { worker } = scan;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const timer = setTimeout(
      () => finish(() => reject(workerError('Windows process scan worker timed out', 'ETIMEDOUT'))),
      timeoutMs,
    );
    timer.unref?.();

    worker.on('message', (value) => {
      if (!isWindowsProcessScanWorkerMessage(value)) {
        finish(() => reject(new Error('invalid Windows process scan worker response')));
        return;
      }
      if (value.type === 'started') {
        if (scan.childPid !== null && scan.childPid !== value.pid) {
          finish(() => reject(new Error('Windows process scan worker reported multiple PIDs')));
          return;
        }
        if (scan.cleaning) {
          terminatePowerShell(scan, value.pid);
          return;
        }
        scan.childPid = value.pid;
        return;
      }

      scan.childClosed = true;
      scan.childPid = null;
      const { response } = value;
      if (response.ok) {
        const { stdout } = response;
        finish(() => resolve(stdout));
        return;
      }
      const { error } = response;
      finish(() => reject(workerError(error.message, error.code, error.syscall)));
    });
    worker.once('error', (error) => finish(() => reject(error)));
    worker.once('exit', (code) =>
      finish(() =>
        reject(new Error(`Windows process scan worker exited before response (${code})`)),
      ),
    );
  });
}

function cleanupWindowsProcessScan(scan: ActiveWindowsProcessScan): Promise<void> {
  if (scan.cleanupPromise) return scan.cleanupPromise;

  scan.cleaning = true;
  if (!scan.childClosed) {
    try {
      scan.worker.postMessage({ type: 'cancel' });
    } catch {
      // A crashed worker can no longer receive cancellation; the PID fallback remains available.
    }
  }
  terminateTrackedPowerShell(scan);

  const termination = scan.worker.terminate().catch(() => void 0);
  scan.cleanupPromise = termination.then(() => {
    // Catch a late "started" message delivered while terminate() was in flight.
    terminateTrackedPowerShell(scan);
  });
  return scan.cleanupPromise;
}

function terminateTrackedPowerShell(scan: ActiveWindowsProcessScan): void {
  const pid = scan.childPid;
  scan.childPid = null;
  if (pid === null) return;
  terminatePowerShell(scan, pid);
}

function terminatePowerShell(scan: ActiveWindowsProcessScan, pid: number): void {
  try {
    scan.terminateProcessTree(pid);
  } catch {
    // Cleanup must not mask the worker's original scan failure.
  }
}

function terminateWindowsProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
        timeout: 2_000,
        windowsHide: true,
        stdio: 'ignore',
      });
      return;
    } catch {
      // The process may already have exited; retain a direct-kill fallback below.
    }
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // The process is already gone or inaccessible.
  }
}

function workerError(message: string, code?: string, syscall?: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), {
    ...(code ? { code } : {}),
    ...(syscall ? { syscall } : {}),
  });
}
