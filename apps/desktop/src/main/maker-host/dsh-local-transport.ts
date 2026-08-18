/** Local DSH JSONL transport backed by Electron's host-owned utility process. */
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import {
  type AgentDeps,
  type DshCloseHandler,
  type DshLineHandler,
  type DshTransport,
  type DshTransportCloseInfo,
} from '@cindy/maker-core';
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import { utilityProcess } from 'electron';

export interface DesktopLocalDshTransportOptions {
  binPath: string;
  configPath: string;
  workingDir: string;
  env: Record<string, string | undefined>;
  logger: AgentDeps['logger'];
  readyTimeoutMs?: number;
}

const HOST_ENV_KEYS = [
  'PATH',
  'SystemRoot',
  'WINDIR',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'SHELL',
  'COMSPEC',
  'PATHEXT',
] as const;
const DSH_ENV_KEYS = [
  'DEEPSEEK_API_KEY',
  'DSH_CWD',
  'DSH_SESSION_ROOT',
  'DSH_SYSTEM_PROMPT',
  'DSH_SNAPSHOT',
] as const;
const MAX_JSONL_BUFFER_CHARS = 16 * 1024 * 1024;

function dshEnvironment(source: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [...HOST_ENV_KEYS, ...DSH_ENV_KEYS]) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function attachLineReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): () => void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    if (buffer.length > MAX_JSONL_BUFFER_CHARS) {
      buffer = '';
      return;
    }
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      onLine(line);
    }
  };
  const onEnd = (): void => {
    buffer += decoder.end();
    if (buffer) onLine(buffer.replace(/\r$/, ''));
    buffer = '';
  };
  stream.on('data', onData);
  stream.on('end', onEnd);
  return () => {
    stream.removeListener('data', onData);
    stream.removeListener('end', onEnd);
  };
}

/** Start the utility process and return only after its virtual-stdin boundary is ready. */
export async function createDesktopLocalDshTransport(
  opts: DesktopLocalDshTransportOptions,
): Promise<DshTransport> {
  const child = utilityProcess.fork(
    path.join(__dirname, 'dshRuntimeWorkerProcess.js'),
    [opts.binPath, opts.configPath],
    {
      cwd: opts.workingDir,
      env: dshEnvironment(opts.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      serviceName: 'cindy-dsh-runtime',
      ...(process.platform === 'darwin' ? { disclaim: true } : {}),
    },
  );
  const stdout = child.stdout;
  const stderrStream = child.stderr;
  if (!stdout || !stderrStream) {
    child.kill();
    throw new Error('DSH utility process has no stdout/stderr');
  }

  const lines = new Set<DshLineHandler>();
  const stderr = new Set<(line: string) => void>();
  const closes = new Set<DshCloseHandler>();
  let closed = false;
  let closing = false;
  let ready = false;
  let closeAttempt: Promise<void> | null = null;

  const fireClose = (info: DshTransportCloseInfo): void => {
    if (closed) return;
    closed = true;
    for (const handler of closes) {
      try {
        handler(info);
      } catch {
        // Observer isolation.
      }
    }
  };

  attachLineReader(stdout, (line) => {
    for (const handler of lines) handler(line);
  });
  attachLineReader(stderrStream, (line) => {
    if (!line.trim()) return;
    const safe = redactSensitiveText(line);
    opts.logger.warn('dsh stderr', { line: safe.slice(0, 2_000) });
    for (const handler of stderr) handler(safe);
  });

  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const readyTimer = setTimeout(() => {
    rejectReady?.(new Error('DSH utility process did not become ready'));
    child.kill();
  }, opts.readyTimeoutMs ?? 10_000);
  readyTimer.unref?.();

  child.on('message', (message) => {
    if (
      !ready &&
      message &&
      typeof message === 'object' &&
      !Array.isArray(message) &&
      (message as Record<string, unknown>).type === 'ready'
    ) {
      ready = true;
      clearTimeout(readyTimer);
      resolveReady?.();
    }
  });
  child.on('error', (type) => {
    const error = new Error(`DSH utility process error: ${type}`);
    if (!ready) {
      clearTimeout(readyTimer);
      rejectReady?.(error);
    }
    fireClose({ code: null, signal: null, reason: error.message });
  });
  child.on('exit', (code) => {
    const reason = `DSH utility process exited (code=${code})`;
    if (!ready) {
      clearTimeout(readyTimer);
      rejectReady?.(new Error(reason));
    }
    fireClose({ code, signal: null, reason });
  });

  const terminate = async (): Promise<void> =>
    new Promise((resolve, reject) => {
      if (closed) {
        resolve();
        return;
      }
      let settled = false;
      let forceTimer: NodeJS.Timeout | undefined;
      let confirmTimer: NodeJS.Timeout | undefined;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (forceTimer) clearTimeout(forceTimer);
        if (confirmTimer) clearTimeout(confirmTimer);
        child.removeListener('exit', onExit);
        if (error) reject(error);
        else resolve();
      };
      const onExit = (): void => finish();
      child.once('exit', onExit);
      forceTimer = setTimeout(() => {
        if (child.pid !== undefined) {
          try {
            process.kill(child.pid, 'SIGKILL');
          } catch {
            // The utility process may already have exited.
          }
        }
        confirmTimer = setTimeout(
          () => finish(new Error('DSH utility process did not confirm exit')),
          5_000,
        );
        confirmTimer.unref?.();
      }, 3_000);
      forceTimer.unref?.();
      try {
        if (!child.kill()) finish();
      } catch {
        finish();
      }
    });

  const transport: DshTransport = {
    writeLine(line) {
      if (closed || closing) return Promise.reject(new Error('dsh transport already closed'));
      try {
        child.postMessage({
          type: 'stdin-b64',
          chunk: Buffer.from(`${line}\n`, 'utf8').toString('base64'),
        });
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    onLine(handler) {
      lines.add(handler);
      return () => lines.delete(handler);
    },
    onStderr(handler) {
      stderr.add(handler);
      return () => stderr.delete(handler);
    },
    onClose(handler) {
      closes.add(handler);
      return () => closes.delete(handler);
    },
    close() {
      if (closed) return Promise.resolve();
      if (closeAttempt) return closeAttempt;
      closing = true;
      closeAttempt = terminate().finally(() => {
        closeAttempt = null;
      });
      return closeAttempt;
    },
    get pid() {
      return child.pid;
    },
    isClosed() {
      return closed || closing;
    },
  };

  try {
    await readyPromise;
    return transport;
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }
}
