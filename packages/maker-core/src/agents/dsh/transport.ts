import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import type { Logger } from '../../interfaces/logger.js';

export interface DshTransportCloseInfo { code: number | null; signal: NodeJS.Signals | null; reason: string; }
export type DshLineHandler = (line: string) => void;
export type DshCloseHandler = (info: DshTransportCloseInfo) => void;

export interface DshTransport {
  writeLine(line: string): Promise<void>;
  onLine(handler: DshLineHandler): () => void;
  onStderr(handler: (line: string) => void): () => void;
  onClose(handler: DshCloseHandler): () => void;
  close(reason?: string): Promise<void>;
  readonly pid: number | undefined;
  isClosed(): boolean;
}

export interface DshStdioTransportOptions {
  nodePath: string;
  binPath: string;
  configPath: string;
  cwd: string;
  env: Record<string, string | undefined>;
  logger: Logger;
}

/** Spawn the dsh JSON-RPC demo runtime and expose its strictly line-framed stdio. */
export function createDshStdioTransport(opts: DshStdioTransportOptions): DshTransport {
  const child: ChildProcessWithoutNullStreams = spawn(opts.nodePath, [opts.binPath, opts.configPath], {
    cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = new Set<DshLineHandler>();
  const stderr = new Set<(line: string) => void>();
  const closes = new Set<DshCloseHandler>();
  let closed = false;
  let closing = false;
  let closeAttempt: Promise<void> | null = null;
  const fireClose = (info: DshTransportCloseInfo): void => {
    if (closed) return;
    closed = true;
    for (const handler of closes) { try { handler(info); } catch { /* observers are isolated */ } }
  };
  attachJsonlReader(child.stdout, (line) => { for (const handler of lines) handler(line); });
  attachJsonlReader(child.stderr, (line) => {
    if (!line.trim()) return;
    const safe = redactSensitiveText(line);
    opts.logger.warn('dsh stderr', { line: safe.slice(0, 2000) });
    for (const handler of stderr) handler(safe);
  });
  child.on('error', (error) => fireClose({ code: null, signal: null, reason: `dsh process error: ${error.message}` }));
  child.on('close', (code, signal) => fireClose({ code, signal, reason: `dsh process exited (code=${code}, signal=${signal})` }));

  const terminate = async (reason: string): Promise<void> => new Promise((resolve, reject) => {
    let done = false;
    let confirmTimer: NodeJS.Timeout | undefined;
    const finish = (error?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(graceTimer);
      if (confirmTimer) clearTimeout(confirmTimer);
      child.removeListener('close', onClose);
      if (error) reject(error); else resolve();
    };
    const onClose = (): void => finish();
    const graceTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      confirmTimer = setTimeout(() => finish(new Error('dsh process did not confirm exit after SIGKILL')), 5_000);
      confirmTimer.unref?.();
    }, 3_000);
    graceTimer.unref?.();
    child.once('close', onClose);
    try { child.kill('SIGTERM'); } catch { finish(); }
    void reason;
  });

  return {
    writeLine(line) {
      if (closed || closing) return Promise.reject(new Error('dsh transport already closed'));
      return new Promise((resolve, reject) => child.stdin.write(`${line}\n`, (error) => error ? reject(error) : resolve()));
    },
    onLine(handler) { lines.add(handler); return () => lines.delete(handler); },
    onStderr(handler) { stderr.add(handler); return () => stderr.delete(handler); },
    onClose(handler) { closes.add(handler); return () => closes.delete(handler); },
    close(reason = 'dsh transport close()') {
      if (closed) return Promise.resolve();
      if (closeAttempt) return closeAttempt;
      closing = true;
      closeAttempt = terminate(reason).finally(() => { closeAttempt = null; });
      return closeAttempt;
    },
    get pid() { return child.pid ?? undefined; },
    isClosed() { return closed || closing; },
  };
}

export function attachJsonlReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let decoder = new StringDecoder('utf8'); let buffer = '';
  stream.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    if (buffer.length > 16 * 1024 * 1024) { buffer = ''; decoder = new StringDecoder('utf8'); return; }
    for (;;) { const i = buffer.indexOf('\n'); if (i < 0) break; const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); onLine(line.endsWith('\r') ? line.slice(0, -1) : line); }
  });
  stream.on('end', () => { buffer += decoder.end(); if (buffer) onLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer); });
  stream.on('error', () => { /* child process close owns stream failure */ });
}
