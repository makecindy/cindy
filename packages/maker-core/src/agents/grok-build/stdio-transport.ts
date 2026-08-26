/**
 * Stdio transport for Grok Build ACP (`grok agent [flags] stdio`).
 *
 * Byte-stream only: NDJSON framing is handled by AcpClient. Spawn is injectable
 * so detection tests can fake a child without a real grok binary.
 */

import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

export type AcpLineHandler = (line: string) => void;
export type AcpStderrHandler = (line: string) => void;
export type AcpCloseHandler = (info: { reason: string }) => void;

export interface AcpTransport {
  writeLine(line: string): Promise<void>;
  onLine(handler: AcpLineHandler): () => void;
  onStderr(handler: AcpStderrHandler): () => void;
  onClose(handler: AcpCloseHandler): () => void;
  close(reason?: string): Promise<void>;
  readonly pid: number | undefined;
}

export type GrokSpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface GrokStdioTransportOptions {
  binaryPath: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: GrokSpawnFn;
  onProcessSpawned?: (pid: number) => void | (() => void);
}

export function createGrokStdioTransport(opts: GrokStdioTransportOptions): AcpTransport {
  if (!opts.binaryPath) {
    throw new Error('createGrokStdioTransport: binaryPath is required');
  }

  const spawnImpl = opts.spawnImpl ?? (spawn as GrokSpawnFn);
  const lineHandlers = new Set<AcpLineHandler>();
  const stderrHandlers = new Set<AcpStderrHandler>();
  const closeHandlers = new Set<AcpCloseHandler>();
  const pendingLines: string[] = [];
  let closed = false;
  let closeReason = 'transport closed';
  let stdoutRl: Interface | undefined;
  let stderrRl: Interface | undefined;
  let disposeProcess: (() => void) | undefined;

  const child = spawnImpl(opts.binaryPath, [...opts.args], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  if (typeof child.pid === 'number' && opts.onProcessSpawned) {
    const disposer = opts.onProcessSpawned(child.pid);
    if (typeof disposer === 'function') disposeProcess = disposer;
  }

  stdoutRl = createInterface({ input: child.stdout });
  stderrRl = createInterface({ input: child.stderr });

  stdoutRl.on('line', (line: string) => {
    if (closed) return;
    if (lineHandlers.size === 0) {
      pendingLines.push(line);
      return;
    }
    for (const handler of lineHandlers) handler(line);
  });

  stderrRl.on('line', (line: string) => {
    if (closed) return;
    for (const handler of stderrHandlers) handler(line);
  });

  const finish = (reason: string) => {
    if (closed) return;
    closed = true;
    closeReason = reason;
    disposeProcess?.();
    stdoutRl?.close();
    stderrRl?.close();
    for (const handler of closeHandlers) handler({ reason });
  };

  child.on('error', (err) => {
    finish(`grok spawn error: ${err.message}`);
  });
  child.on('exit', (code, signal) => {
    finish(signal ? `grok exited signal ${signal}` : `grok exited code ${code ?? 'unknown'}`);
  });

  return {
    get pid() {
      return child.pid;
    },
    async writeLine(line: string): Promise<void> {
      if (closed || !child.stdin.writable) {
        throw new Error(`grok ACP transport closed (${closeReason})`);
      }
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(`${line}\n`, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    onLine(handler: AcpLineHandler): () => void {
      lineHandlers.add(handler);
      if (pendingLines.length > 0) {
        const queued = pendingLines.splice(0);
        for (const line of queued) handler(line);
      }
      return () => {
        lineHandlers.delete(handler);
      };
    },
    onStderr(handler: AcpStderrHandler): () => void {
      stderrHandlers.add(handler);
      return () => {
        stderrHandlers.delete(handler);
      };
    },
    onClose(handler: AcpCloseHandler): () => void {
      closeHandlers.add(handler);
      if (closed) handler({ reason: closeReason });
      return () => {
        closeHandlers.delete(handler);
      };
    },
    async close(reason = 'client close'): Promise<void> {
      if (closed) return;
      finish(reason);
      if (!child.killed) {
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (!child.killed) child.kill('SIGKILL');
            resolve();
          }, 2_000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  };
}
