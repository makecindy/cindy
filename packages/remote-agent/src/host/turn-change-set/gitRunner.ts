/**
 * git-review git runner.
 *
 * Unlike worktree/gitExec, this runner supports stdin, timeouts, allowed
 * non-zero exit codes, and explicit stdout guards for large diff reads.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';

export interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitRunBufferResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

export class GitRunError extends Error {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly cause?: Error;

  constructor(opts: {
    args: readonly string[];
    cwd?: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    cause?: Error;
    message?: string;
  }) {
    super(
      opts.message ??
        `git ${opts.args.join(' ')} failed${
          opts.exitCode === null ? '' : ` with exit code ${opts.exitCode}`
        }: ${opts.stderr.trim() || opts.cause?.message || '<no stderr>'}`,
    );
    this.name = 'GitRunError';
    this.args = opts.args;
    this.cwd = opts.cwd;
    this.exitCode = opts.exitCode;
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
    this.cause = opts.cause;
  }
}

export interface GitRunOptions {
  cwd?: string;
  stdin?: string | Buffer;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  allowedExitCodes?: readonly number[];
  extraEnv?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

export interface GitRunBufferOptions extends GitRunOptions {
  maxStdoutBytes?: number;
}

/**
 * Request-scoped Git execution surface. SSH review installs one of these for
 * the lifetime of an IPC request, while local review keeps using spawn below.
 * AsyncLocalStorage prevents concurrent local/remote review panes from sharing
 * a host or working directory.
 */
export interface GitExecutionBackend {
  run(args: readonly string[], opts?: GitRunOptions): Promise<GitRunResult>;
  runBuffer(args: readonly string[], opts?: GitRunBufferOptions): Promise<GitRunBufferResult>;
}

const executionBackend = new AsyncLocalStorage<GitExecutionBackend>();

export function withGitExecutionBackend<T>(backend: GitExecutionBackend, task: () => Promise<T>): Promise<T> {
  return executionBackend.run(backend, task);
}

const DEFAULT_TIMEOUT_MS = 30_000;

function buildEnv(extraEnv?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    LC_ALL: 'C',
    ...extraEnv,
  };
}

async function runGitOnce(args: readonly string[], opts: GitRunOptions = {}): Promise<GitRunResult> {
  const allowed = new Set(opts.allowedExitCodes ?? [0]);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (opts.signal?.aborted) {
    throw new GitRunError({
      args,
      cwd: opts.cwd,
      exitCode: null,
      stdout: '',
      stderr: '',
      message: `git ${args.join(' ')} aborted`,
    });
  }

  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd: opts.cwd,
      env: buildEnv(opts.extraEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    let timedOut = false;
    let stdoutTooLarge = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      fn();
    };

    const abort = () => {
      child.kill();
      finish(() => {
        reject(
          new GitRunError({
            args,
            cwd: opts.cwd,
            exitCode: null,
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
            message: `git ${args.join(' ')} aborted`,
          }),
        );
      });
    };

    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    opts.signal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (opts.maxStdoutBytes !== undefined && stdoutBytes > opts.maxStdoutBytes) {
        stdoutTooLarge = true;
        child.kill();
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (err) => {
      finish(() => {
        reject(
          new GitRunError({
            args,
            cwd: opts.cwd,
            exitCode: null,
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
            cause: err,
          }),
        );
      });
    });
    child.on('close', (code) => {
      finish(() => {
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        if (stdoutTooLarge) {
          reject(
            new GitRunError({
              args,
              cwd: opts.cwd,
              exitCode: code,
              stdout,
              stderr,
              message: `git ${args.join(' ')} exceeded stdout limit of ${opts.maxStdoutBytes} bytes`,
            }),
          );
          return;
        }
        if (timedOut) {
          reject(
            new GitRunError({
              args,
              cwd: opts.cwd,
              exitCode: code,
              stdout,
              stderr,
              message: `git ${args.join(' ')} timed out after ${timeoutMs}ms`,
            }),
          );
          return;
        }
        const exitCode = code ?? 0;
        if (!allowed.has(exitCode)) {
          reject(new GitRunError({ args, cwd: opts.cwd, exitCode, stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr, exitCode });
      });
    });

    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

async function runGitBufferOnce(args: readonly string[], opts: GitRunBufferOptions = {}): Promise<GitRunBufferResult> {
  const allowed = new Set(opts.allowedExitCodes ?? [0]);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (opts.signal?.aborted) {
    throw new GitRunError({
      args,
      cwd: opts.cwd,
      exitCode: null,
      stdout: '',
      stderr: '',
      message: `git ${args.join(' ')} aborted`,
    });
  }

  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd: opts.cwd,
      env: buildEnv(opts.extraEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    let timedOut = false;
    let stdoutTooLarge = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      fn();
    };

    const abort = () => {
      child.kill();
      finish(() => {
        reject(
          new GitRunError({
            args,
            cwd: opts.cwd,
            exitCode: null,
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
            message: `git ${args.join(' ')} aborted`,
          }),
        );
      });
    };

    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    opts.signal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (opts.maxStdoutBytes !== undefined && stdoutBytes > opts.maxStdoutBytes) {
        stdoutTooLarge = true;
        child.kill();
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (err) => {
      finish(() => {
        reject(
          new GitRunError({
            args,
            cwd: opts.cwd,
            exitCode: null,
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
            cause: err,
          }),
        );
      });
    });
    child.on('close', (code) => {
      finish(() => {
        const stdout = Buffer.concat(stdoutChunks);
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        if (stdoutTooLarge) {
          reject(
            new GitRunError({
              args,
              cwd: opts.cwd,
              exitCode: code,
              stdout: stdout.toString('utf8'),
              stderr,
              message: `git ${args.join(' ')} exceeded stdout limit of ${opts.maxStdoutBytes} bytes`,
            }),
          );
          return;
        }
        if (timedOut) {
          reject(
            new GitRunError({
              args,
              cwd: opts.cwd,
              exitCode: code,
              stdout: stdout.toString('utf8'),
              stderr,
              message: `git ${args.join(' ')} timed out after ${timeoutMs}ms`,
            }),
          );
          return;
        }
        const exitCode = code ?? 0;
        if (!allowed.has(exitCode)) {
          reject(new GitRunError({ args, cwd: opts.cwd, exitCode, stdout: stdout.toString('utf8'), stderr }));
          return;
        }
        resolve({ stdout, stderr, exitCode });
      });
    });

    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

export async function runGit(args: readonly string[], opts: GitRunOptions = {}): Promise<GitRunResult> {
  const backend = executionBackend.getStore();
  return backend ? backend.run(args, opts) : runGitOnce(args, opts);
}

export async function runGitBuffer(args: readonly string[], opts: GitRunBufferOptions = {}): Promise<GitRunBufferResult> {
  const backend = executionBackend.getStore();
  return backend ? backend.runBuffer(args, opts) : runGitBufferOnce(args, opts);
}
