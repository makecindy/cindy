import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  disposeWindowsProcessScanWorkers,
  runWindowsProcessScanWorker,
  type WindowsProcessScanWorkerHandle,
} from '../windowsProcessScanWorkerClient.js';

class FakeWorker extends EventEmitter implements WindowsProcessScanWorkerHandle {
  postMessage = vi.fn();
  unref = vi.fn();
  terminate = vi.fn(async () => 0);
}

afterEach(() => {
  disposeWindowsProcessScanWorkers();
});

describe('runWindowsProcessScanWorker', () => {
  it('returns PowerShell output and releases the one-shot worker', async () => {
    const worker = new FakeWorker();
    const terminateProcessTree = vi.fn();
    const result = runWindowsProcessScanWorker({
      createWorker: () => worker,
      terminateProcessTree,
    });

    worker.emit('message', { type: 'started', pid: 1234 });
    worker.emit('message', {
      type: 'result',
      response: { ok: true, stdout: '1|0|1024|0||cindy.exe' },
    });

    await expect(result).resolves.toBe('1|0|1024|0||cindy.exe');
    expect(terminateProcessTree).not.toHaveBeenCalled();
    expect(worker.unref).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('kills the announced PowerShell process when the worker emits ENOTCONN', async () => {
    const worker = new FakeWorker();
    const terminateProcessTree = vi.fn();
    const result = runWindowsProcessScanWorker({
      createWorker: () => worker,
      terminateProcessTree,
    });
    const error = Object.assign(new Error('read ENOTCONN'), {
      code: 'ENOTCONN',
      syscall: 'read',
    });

    worker.emit('message', { type: 'started', pid: 4321 });
    worker.emit('error', error);

    await expect(result).rejects.toMatchObject({ code: 'ENOTCONN', syscall: 'read' });
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'cancel' });
    expect(terminateProcessTree).toHaveBeenCalledWith(4321);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('kills the announced PowerShell process when the worker times out', async () => {
    const worker = new FakeWorker();
    const terminateProcessTree = vi.fn();
    const result = runWindowsProcessScanWorker({
      createWorker: () => worker,
      timeoutMs: 5,
      terminateProcessTree,
    });

    worker.emit('message', { type: 'started', pid: 5678 });

    await expect(result).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(terminateProcessTree).toHaveBeenCalledWith(5678);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('kills active PowerShell processes during application disposal', async () => {
    const worker = new FakeWorker();
    const terminateProcessTree = vi.fn();
    const result = runWindowsProcessScanWorker({
      createWorker: () => worker,
      terminateProcessTree,
    });

    worker.emit('message', { type: 'started', pid: 6789 });
    disposeWindowsProcessScanWorkers();

    expect(terminateProcessTree).toHaveBeenCalledWith(6789);
    expect(worker.terminate).toHaveBeenCalledOnce();
    worker.emit('exit', 1);
    await expect(result).rejects.toThrow('exited before response (1)');
  });

  it('fails and releases the worker when it exits before responding', async () => {
    const worker = new FakeWorker();
    const result = runWindowsProcessScanWorker({ createWorker: () => worker });

    worker.emit('exit', 1);

    await expect(result).rejects.toThrow('exited before response (1)');
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.runIf(process.platform === 'win32')(
    'does not leave PowerShell alive after a worker crash',
    async () => {
      const child = spawnSleepingPowerShell();
      const pid = requirePid(child);
      try {
        const worker = new FakeWorker();
        const result = runWindowsProcessScanWorker({ createWorker: () => worker });

        worker.emit('message', { type: 'started', pid });
        expect(isProcessAlive(pid)).toBe(true);
        worker.emit('error', Object.assign(new Error('read ENOTCONN'), { code: 'ENOTCONN' }));

        await expect(result).rejects.toMatchObject({ code: 'ENOTCONN' });
        expect(isProcessAlive(pid)).toBe(false);
      } finally {
        forceKillProcessTree(pid);
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not leave PowerShell alive after the outer timeout',
    async () => {
      const child = spawnSleepingPowerShell();
      const pid = requirePid(child);
      try {
        const worker = new FakeWorker();
        const result = runWindowsProcessScanWorker({
          createWorker: () => worker,
          timeoutMs: 10,
        });

        worker.emit('message', { type: 'started', pid });
        expect(isProcessAlive(pid)).toBe(true);

        await expect(result).rejects.toMatchObject({ code: 'ETIMEDOUT' });
        expect(isProcessAlive(pid)).toBe(false);
      } finally {
        forceKillProcessTree(pid);
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not leave PowerShell alive during application disposal',
    async () => {
      const child = spawnSleepingPowerShell();
      const pid = requirePid(child);
      try {
        const worker = new FakeWorker();
        const result = runWindowsProcessScanWorker({ createWorker: () => worker });

        worker.emit('message', { type: 'started', pid });
        expect(isProcessAlive(pid)).toBe(true);
        disposeWindowsProcessScanWorkers();

        expect(isProcessAlive(pid)).toBe(false);
        worker.emit('exit', 1);
        await expect(result).rejects.toThrow('exited before response (1)');
      } finally {
        forceKillProcessTree(pid);
      }
    },
  );
});

function spawnSleepingPowerShell(): ChildProcess {
  return spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30'],
    {
      windowsHide: true,
      stdio: 'ignore',
    },
  );
}

function requirePid(child: ChildProcess): number {
  if (typeof child.pid !== 'number') throw new Error('PowerShell did not expose a PID');
  return child.pid;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function forceKillProcessTree(pid: number): void {
  if (!isProcessAlive(pid)) return;
  try {
    execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
      timeout: 2_000,
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {
    // The assertion reports cleanup failure; this is only a best-effort test teardown.
  }
}
