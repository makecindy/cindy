import { spawn, type ChildProcess } from 'node:child_process';
// eslint-disable-next-line no-restricted-imports -- child-process pipe failures are isolated from Electron Main.
import { parentPort } from 'node:worker_threads';

import {
  WINDOWS_PROCESS_SCAN_SCRIPT,
  type WindowsProcessScanWorkerMessage,
  type WindowsProcessScanWorkerResponse,
} from './windowsProcessScanProtocol.js';

const CHILD_TIMEOUT_MS = 10_000;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

if (!parentPort) throw new Error('Windows process scan must run in a worker thread');
const workerPort = parentPort;

runWindowsProcessTable();

function runWindowsProcessTable(): void {
  let child: ChildProcess;
  try {
    child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_SCAN_SCRIPT],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    workerPort.postMessage({
      type: 'result',
      response: workerFailure(error),
    } satisfies WindowsProcessScanWorkerMessage);
    workerPort.close();
    return;
  }

  let stdout = '';
  let stdoutBytes = 0;
  let stderr = '';
  let stderrBytes = 0;
  let pendingFailure: NodeJS.ErrnoException | null = null;
  let finished = false;
  const timeout = setTimeout(() => {
    failChild(workerError('Windows process scan PowerShell timed out', 'ETIMEDOUT'));
  }, CHILD_TIMEOUT_MS);
  timeout.unref?.();

  child.unref();
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  const pid = child.pid;
  if (typeof pid === 'number' && pid > 0) {
    workerPort.postMessage({ type: 'started', pid } satisfies WindowsProcessScanWorkerMessage);
  }

  child.once('error', failChild);
  child.stdout?.on('error', failChild);
  child.stderr?.on('error', failChild);
  child.stdout?.on('data', (chunk: string) => {
    if (pendingFailure) return;
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > MAX_STDOUT_BYTES) {
      failChild(workerError('Windows process scan stdout exceeded maxBuffer', 'ENOBUFS'));
      return;
    }
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    if (stderrBytes >= MAX_STDERR_BYTES) return;
    const remaining = MAX_STDERR_BYTES - stderrBytes;
    const slice = Buffer.from(chunk).subarray(0, remaining).toString('utf8');
    stderr += slice;
    stderrBytes += Buffer.byteLength(slice);
  });
  child.once('close', (code, signal) => {
    if (finished) return;
    clearTimeout(timeout);
    if (pendingFailure) {
      postResult(workerFailure(pendingFailure));
      return;
    }
    if (code === 0) {
      postResult({ ok: true, stdout });
      return;
    }
    postResult(
      workerFailure(
        workerError(
          stderr.trim() ||
            `Windows process scan PowerShell exited (${code ?? signal ?? 'unknown'})`,
          'ECHILD',
        ),
      ),
    );
  });
  workerPort.once('message', (value: unknown) => {
    if ((value as { type?: unknown } | null)?.type === 'cancel') {
      failChild(workerError('Windows process scan cancelled', 'ECANCELED'));
    }
  });

  function failChild(error: unknown): void {
    if (finished || pendingFailure) return;
    pendingFailure = normalizeError(error);
    try {
      child.kill('SIGKILL');
    } catch {
      // Parent owns the announced PID and performs a taskkill fallback.
    }
  }

  function postResult(response: WindowsProcessScanWorkerResponse): void {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    workerPort.removeAllListeners('message');
    workerPort.postMessage({ type: 'result', response } satisfies WindowsProcessScanWorkerMessage);
    workerPort.close();
  }
}

function workerFailure(error: unknown): WindowsProcessScanWorkerResponse {
  const errno = normalizeError(error);
  return {
    ok: false,
    error: {
      message: errno.message,
      ...(typeof errno.code === 'string' ? { code: errno.code } : {}),
      ...(typeof errno.syscall === 'string' ? { syscall: errno.syscall } : {}),
    },
  };
}

function normalizeError(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error ? error : new Error(String(error));
}

function workerError(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}
