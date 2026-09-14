import {
  execFile,
  type ChildProcess,
  type ExecFileOptionsWithStringEncoding,
} from 'node:child_process';
import { performance } from 'node:perf_hooks';

import { createLogger } from '../logger.js';

const log = createLogger('exec-file-diagnostic');

export type ExecFileDiagnosticSource =
  | 'worktree.git'
  | 'worktree.git.process-table';

type DiagnosticFailureLevel = 'info' | 'warn';

export interface ExecFileDiagnosticSpan {
  readonly callId: number;
  succeed(): void;
  fail(error: unknown): void;
}

interface ExecFileDiagnosticSpanOptions {
  failureLevel?: DiagnosticFailureLevel;
  now?: () => number;
}

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

export type DiagnosticExecFile = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: ExecFileCallback,
) => ChildProcess;

export interface ExecFileWithDiagnosticsOptions {
  source: ExecFileDiagnosticSource;
  file: string;
  args: readonly string[];
  options: Omit<ExecFileOptionsWithStringEncoding, 'encoding'> & {
    encoding?: 'utf8' | 'utf-8';
  };
  failureLevel?: DiagnosticFailureLevel;
  execFileImpl?: DiagnosticExecFile;
}

let nextDiagnosticCallId = 0;

export function beginExecFileDiagnostic(
  source: ExecFileDiagnosticSource,
  options: ExecFileDiagnosticSpanOptions = {},
): ExecFileDiagnosticSpan {
  const callId = ++nextDiagnosticCallId;
  const now = options.now ?? performance.now.bind(performance);
  const startedAt = now();
  let settled = false;

  return {
    callId,
    succeed() {
      if (settled) return;
      settled = true;
    },
    fail(error: unknown) {
      if (settled) return;
      settled = true;
      const metadata = {
        callId,
        source,
        durationMs: elapsedMs(startedAt, now()),
        ...safeErrorMetadata(error),
      };
      if (options.failureLevel === 'info') {
        log.info('execFile call failed', metadata);
      } else {
        log.warn('execFile call failed', metadata);
      }
    },
  };
}

export function execFileWithDiagnostics(
  input: ExecFileWithDiagnosticsOptions,
): Promise<{ stdout: string; stderr: string }> {
  const span = beginExecFileDiagnostic(input.source, { failureLevel: input.failureLevel });
  return new Promise((resolve, reject) => {
    let settled = false;
    let child: ChildProcess | undefined;
    const finish = (error: unknown, output?: { stdout: string; stderr: string }): void => {
      if (settled) return;
      settled = true;
      if (error) {
        span.fail(error);
        try {
          child?.kill();
        } catch {
          // A child whose pipe failed may already be gone.
        }
        reject(normalizeError(error));
        return;
      }
      span.succeed();
      resolve(output ?? { stdout: '', stderr: '' });
    };

    try {
      const run = input.execFileImpl ?? (execFile as unknown as DiagnosticExecFile);
      child = run(
        input.file,
        input.args,
        { ...input.options, encoding: input.options.encoding ?? 'utf8' },
        (error, stdout, stderr) => finish(error, { stdout, stderr }),
      );
      child?.once?.('error', (error) => finish(error));
      child?.stdout?.once('error', (error) => finish(error));
      child?.stderr?.once('error', (error) => finish(error));
    } catch (error) {
      finish(error);
    }
  });
}

function safeErrorMetadata(error: unknown): Record<string, string | number | boolean> {
  if (!error || typeof error !== 'object') return { errorType: typeof error };
  const errno = error as NodeJS.ErrnoException & {
    killed?: unknown;
    signal?: unknown;
  };
  return {
    ...(typeof errno.code === 'string' || typeof errno.code === 'number'
      ? { code: errno.code }
      : {}),
    ...(safeSyscall(errno.syscall) ? { syscall: safeSyscall(errno.syscall)! } : {}),
    ...(typeof errno.signal === 'string' ? { signal: errno.signal } : {}),
    ...(typeof errno.killed === 'boolean' ? { killed: errno.killed } : {}),
  };
}

function safeSyscall(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^[a-z0-9_.-]+/i.exec(value.trim())?.[0] ?? null;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function elapsedMs(startedAt: number, finishedAt: number): number {
  return Math.max(0, Math.round(finishedAt - startedAt));
}
