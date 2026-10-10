import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';

// Transport interface and process-group shutdown pattern adapted from Cindy PR #2386.
// Framing is byte-bounded; unlike that prototype, close never reports success without exit proof.
export interface AcpTransport {
  writeLine(line: string): Promise<void>;
  onLine(handler: (line: string) => void): () => void;
  onClose(handler: (info: { reason: string }) => void): () => void;
  close(): Promise<void>;
  getPid?(): number | null;
}
export interface AcpTransportOptions {
  binaryPath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  maxFrameBytes?: number;
  shutdownGraceMs?: number;
  killTimeoutMs?: number;
  /** Injection is only for process/lifecycle tests; production always supplies AgentDeps.binaryPath. */
  spawnChild?: typeof spawn;
  platformOverride?: NodeJS.Platform;
}
export function spawnAcpTransport(options: AcpTransportOptions): AcpTransport {
  if (!isAbsolute(options.binaryPath)) throw new Error('ACP binaryPath must be absolute');
  if (!isAbsolute(options.cwd)) throw new Error('ACP cwd must be absolute');
  const maxBytes = options.maxFrameBytes ?? 16 * 1024 * 1024;
  const grace = options.shutdownGraceMs ?? 1_000;
  const killWait = options.killTimeoutMs ?? 3_000;
  if (![maxBytes, grace, killWait].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647)) {
    throw new Error('Invalid ACP transport limits');
  }
  const posix = (options.platformOverride ?? process.platform) !== 'win32';
  const child = (options.spawnChild ?? spawn)(options.binaryPath, ['acp'], {
    cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: posix,
  }) as ChildProcessWithoutNullStreams;
  const lines = new Set<(line: string) => void>();
  const closes = new Set<(info: { reason: string }) => void>();
  let buffered = Buffer.alloc(0);
  let queued: string[] = [];
  let queuedBytes = 0;
  let armed = false;
  let reason: string | undefined;
  let exited = child.exitCode !== null || child.signalCode !== null;
  let closing: Promise<void> | undefined;
  let windowsTreeUnconfirmed = false;
  const disconnect = (why: string) => {
    if (reason) return;
    reason = why;
    buffered = Buffer.alloc(0); queued = []; queuedBytes = 0;
    for (const listener of closes) { try { listener({ reason: why }); } catch { /* observer */ } }
  };
  const fail = (why: string) => {
    disconnect(why);
    // Retain the rejected cleanup for callers to retry; do not make an unhandled rejection.
    void transport.close().catch(() => {});
  };
  child.on('error', () => {
    // A failed spawn has no process. Other child errors are not exit evidence.
    if (child.pid === undefined) exited = true;
    fail('ACP process error');
  });
  child.on('exit', () => { exited = true; disconnect('ACP process exited'); });
  child.stdin.on('error', () => fail('ACP input disconnected'));
  child.stdout.on('error', () => fail('ACP output disconnected'));
  child.stdout.on('end', () => fail('ACP output ended'));
  // Drain without logging, retaining, or exposing secrets that CLI diagnostics might contain.
  child.stderr.resume();
  child.stderr.on('error', () => {});
  child.stdout.on('data', (chunk: Buffer) => {
    if (reason) return;
    let offset = 0;
    while (offset < chunk.length && !reason) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const piece = chunk.subarray(offset, end);
      if (buffered.length + piece.length > maxBytes) { fail('ACP frame exceeds limit'); return; }
      buffered = buffered.length ? Buffer.concat([buffered, piece]) : Buffer.from(piece);
      if (newline < 0) return;
      const line = buffered.toString('utf8').replace(/\r$/, '');
      buffered = Buffer.alloc(0);
      offset = newline + 1;
      if (!line) continue;
      if (!armed) {
        queuedBytes += Buffer.byteLength(line);
        if (queuedBytes > maxBytes) { fail('ACP initial frames exceed limit'); return; }
        queued.push(line);
      } else for (const listener of lines) { try { listener(line); } catch { /* observer */ } }
    }
  });
  function waitForExit(ms: number): Promise<boolean> {
    if (exited) return Promise.resolve(true);
    return new Promise(resolve => {
      const done = (value: boolean) => { clearTimeout(timer); child.removeListener('exit', onExit); child.removeListener('error', onError); resolve(value); };
      const onExit = () => done(true);
      const onError = () => { if (exited) done(true); };
      const timer = setTimeout(() => done(false), ms);
      child.once('exit', onExit); child.on('error', onError);
    });
  }
  function signalTree(signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    if (posix) {
      try { process.kill(-child.pid, signal); return; } catch { /* direct child fallback */ }
    }
    if (!exited) { try { child.kill(signal); } catch { /* verified by waitForExit */ } }
  }
  async function killWindowsTree(): Promise<boolean> {
    if (child.pid === undefined || exited) return true;
    return new Promise(resolve => {
      // taskkill is a system utility, never a PATH-selected executable or shell command.
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
      const killer = spawn(`${systemRoot}\\System32\\taskkill.exe`, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: false });
      let finished = false;
      const done = (success: boolean) => { if (finished) return; finished = true; clearTimeout(timer); resolve(success); };
      const timer = setTimeout(() => { try { killer.kill(); } catch { /* best effort */ } done(false); }, killWait);
      killer.once('error', () => done(false)); killer.once('exit', code => done(code === 0));
    });
  }
  const transport: AcpTransport = {
    writeLine(line) {
      if (reason || !child.stdin.writable) return Promise.reject(new Error('ACP transport closed'));
      if (line.includes('\n') || Buffer.byteLength(line) > maxBytes) return Promise.reject(new Error('Invalid ACP output frame'));
      return new Promise((resolve, reject) => {
        child.stdin.write(`${line}\n`, 'utf8', error => error ? reject(new Error('ACP write failed')) : resolve());
      });
    },
    onLine(handler) {
      lines.add(handler);
      if (!armed) {
        armed = true;
        const initial = queued; queued = []; queuedBytes = 0;
        for (const line of initial) {
          if (reason) break;
          try { handler(line); } catch { /* observer isolation */ }
        }
      }
      return () => { lines.delete(handler); };
    },
    onClose(handler) {
      closes.add(handler);
      if (reason) handler({ reason });
      return () => { closes.delete(handler); };
    },
    getPid: () => exited ? null : child.pid ?? null,
    close() {
      if (closing) return closing;
      disconnect('ACP transport closed');
      closing = (async () => {
        try { child.stdin.end(); } catch { /* best effort */ }
        if (posix) {
          signalTree('SIGTERM');
          await waitForExit(grace);
          // Signal the group even if its leader exited; descendants may still own inherited pipes.
          signalTree('SIGKILL');
          if (!await waitForExit(killWait)) throw new Error('ACP process exit could not be confirmed');
        } else {
          const treeStopped = !windowsTreeUnconfirmed && await killWindowsTree();
          if (!treeStopped) windowsTreeUnconfirmed = true;
          if (!treeStopped) signalTree('SIGKILL');
          if (!await waitForExit(killWait) || !treeStopped) throw new Error('ACP process tree exit could not be confirmed');
        }
      })().catch(error => { closing = undefined; throw error; });
      return closing;
    },
  };
  return transport;
}
