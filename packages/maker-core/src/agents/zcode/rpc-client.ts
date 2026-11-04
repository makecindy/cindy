import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface ZCodeRpcRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ZCodeRpcClientOptions {
  binaryPath: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  requestTimeoutMs?: number;
  /** Host process launcher; also keeps process creation injectable in non-Electron hosts. */
  spawn?: typeof spawn;
}

export type ZCodeRpcRequestHandler = (
  method: string, params: Record<string, unknown>, signal: AbortSignal,
) => Promise<unknown>;

export class ZCodeRpcError extends Error {
  constructor(readonly method: string, readonly code: number) {
    // Upstream errors can contain account or request payloads. Keep them inside the child.
    super(`ZCode RPC ${method} failed (${code})`);
    this.name = 'ZCodeRpcError';
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  dispose(): void;
  method: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** ZCode's private NDJSON protocol. It deliberately does not share Codex method semantics. */
export class ZCodeRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly reverse = new Map<string, { controller: AbortController; method: string; requestId?: string; sessionId?: string }>();
  private readonly notifications = new Set<(method: string, params: Record<string, unknown>) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private readonly decoder = new StringDecoder('utf8');
  private readonly exited: Promise<void>;
  private resolveExited!: () => void;
  private requestHandler?: ZCodeRpcRequestHandler;
  private buffer = '';
  private nextId = 0;
  private closedError?: Error;
  private didExit = false;
  private closing?: Promise<void>;

  constructor(private readonly options: ZCodeRpcClientOptions) {
    this.exited = new Promise((resolve) => { this.resolveExited = resolve; });
    this.child = (options.spawn ?? spawn)(options.binaryPath, options.args ?? [], {
      cwd: options.cwd, env: options.env ?? process.env, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.child.stdout.on('data', (chunk: Buffer | string) => this.read(
      typeof chunk === 'string' ? chunk : this.decoder.write(chunk),
    ));
    // Consume native diagnostics without copying native account/configuration data to Cindy logs.
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.fail(new Error('ZCode input pipe closed')));
    this.child.stdout.on('error', () => this.fail(new Error('ZCode output pipe closed')));
    this.child.stdout.on('end', () => this.fail(new Error('ZCode output pipe closed')));
    this.child.once('error', () => {
      this.fail(new Error('ZCode process could not start'));
      if (this.child.pid === undefined) {
        this.didExit = true;
        this.resolveExited();
      }
    });
    this.child.once('close', () => {
      this.didExit = true;
      this.fail(new Error('ZCode process closed'));
      this.resolveExited();
    });
  }

  request<T = unknown>(method: string, params: unknown, options: ZCodeRpcRequestOptions = {}): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    if (options.signal?.aborted) return Promise.reject(new Error('ZCode request cancelled'));
    const id = `cindy-${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const finishError = (error: Error) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        entry.dispose();
        reject(error);
      };
      const abort = () => finishError(new Error('ZCode request cancelled'));
      const timer = setTimeout(() => finishError(new Error(`ZCode RPC ${method} timed out`)),
        options.timeoutMs ?? this.options.requestTimeoutMs ?? 30_000);
      timer.unref?.();
      const dispose = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      };
      this.pending.set(id, { method, resolve: (value) => resolve(value as T), reject, dispose });
      options.signal?.addEventListener('abort', abort, { once: true });
      this.write({ id, method, params }).catch(() => finishError(new Error('ZCode request could not be sent')));
    });
  }

  setRequestHandler(handler: ZCodeRpcRequestHandler): void { this.requestHandler = handler; }

  onNotification(handler: (method: string, params: Record<string, unknown>) => void): () => void {
    this.notifications.add(handler);
    return () => { this.notifications.delete(handler); };
  }

  onClose(handler: (error: Error) => void): () => void {
    if (this.closedError) handler(this.closedError);
    else this.closeListeners.add(handler);
    return () => { this.closeListeners.delete(handler); };
  }

  /** Actual child exit (or failed spawn), not merely a closed RPC pipe. */
  get whenStopped(): Promise<void> { return this.exited; }

  cancelServerRequests(match?: { method: string; requestId: string; sessionId: string }): void {
    for (const request of this.reverse.values()) {
      if (!match || (request.method === match.method && request.requestId === match.requestId && request.sessionId === match.sessionId)) {
        request.controller.abort();
      }
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.fail(new Error('ZCode process closed'));
    const attempt = (async () => {
      if (this.didExit) return;
      this.child.stdin.end();
      this.child.kill('SIGTERM');
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.exited,
          new Promise<never>((_resolve, reject) => {
            killTimer = setTimeout(() => { if (!this.didExit) this.child.kill('SIGKILL'); }, 1_000);
            deadline = setTimeout(() => reject(new Error('ZCode process exit was not confirmed')), 3_000);
          }),
        ]);
      } finally {
        clearTimeout(killTimer);
        clearTimeout(deadline);
      }
    })();
    this.closing = attempt;
    void attempt.catch(() => { if (this.closing === attempt) this.closing = undefined; });
    return attempt;
  }

  private write(frame: unknown): Promise<void> {
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => error ? reject(error) : resolve());
    });
  }

  private read(chunk: string): void {
    if (this.closedError) return;
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      if (line.length > 32 * 1024 * 1024) { this.fail(new Error('ZCode protocol frame too large')); return; }
      let frame: Record<string, unknown> | undefined;
      try { frame = record(JSON.parse(line)); } catch { /* Fail without logging the native frame. */ }
      if (!frame) { this.fail(new Error('Invalid ZCode protocol frame')); return; }
      this.dispatch(frame);
    }
    if (this.buffer.length > 32 * 1024 * 1024) this.fail(new Error('ZCode protocol frame too large'));
  }

  private dispatch(frame: Record<string, unknown>): void {
    const hasId = typeof frame.id === 'string' || typeof frame.id === 'number';
    if (typeof frame.method === 'string') {
      const params = record(frame.params) ?? {};
      if (!hasId) {
        for (const handler of this.notifications) handler(frame.method, params);
        return;
      }
      const id = String(frame.id);
      if (this.reverse.has(id)) { this.fail(new Error('Duplicate ZCode server request')); return; }
      const controller = new AbortController();
      this.reverse.set(id, { controller, method: frame.method,
        requestId: typeof params.requestId === 'string' ? params.requestId : undefined,
        sessionId: typeof params.sessionId === 'string' ? params.sessionId : undefined });
      const work = this.requestHandler
        ? Promise.resolve().then(() => this.requestHandler!(frame.method as string, params, controller.signal))
        : Promise.reject(new Error('Unsupported ZCode host request'));
      void work.then(
        (result) => this.write({ id: frame.id, result }),
        () => this.write({ id: frame.id, error: { code: -32603, message: 'Cindy could not complete this ZCode request' } }),
      ).catch(() => {}).finally(() => this.reverse.delete(id));
      return;
    }
    if (!hasId) return;
    const id = String(frame.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.dispose();
    const error = record(frame.error);
    if (error) pending.reject(new ZCodeRpcError(pending.method, typeof error.code === 'number' ? error.code : -32603));
    else if ('result' in frame) pending.resolve(frame.result);
    else pending.reject(new Error('Invalid ZCode RPC response'));
  }

  private fail(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    this.buffer = '';
    this.cancelServerRequests();
    this.requestHandler = undefined;
    for (const entry of this.pending.values()) { entry.dispose(); entry.reject(error); }
    this.pending.clear();
    for (const handler of this.closeListeners) handler(error);
    this.closeListeners.clear();
    this.notifications.clear();
  }
}
