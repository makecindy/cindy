/**
 * pi RPC 子进程客户端 —— spawn `pi --mode rpc` + JSONL 协议(stdin 命令 / stdout 响应+事件)。
 *
 * 协议要点(pi docs/rpc.md):
 *  - 严格 JSONL,仅以 LF 分帧;输入允许 \r\n(strip 尾部 \r)。不能用 readline
 *    (它会按 U+2028/U+2029 切行,而这些字符在 JSON 字符串里合法)。
 *  - 命令可带 id 做请求/响应关联;响应 type='response' 且回带同 id。
 *  - 其余 stdout 行都是事件(含 extension_ui_request 子协议)。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import type { Logger } from '../../interfaces/logger.js';

/** pi RPC 响应帧。 */
export interface PiRpcResponse {
  type: 'response';
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** pi RPC 事件帧(response 之外的一切;具体形状 translator 侧收窄)。 */
export interface PiRpcEvent {
  type: string;
  [key: string]: unknown;
}

export interface PiRpcSpawnOptions {
  binaryPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  logger: Logger;
  /** 事件帧回调(response 之外的所有行)。 */
  onEvent: (event: PiRpcEvent) => void;
  /** 进程退出回调(exit code / signal;正常 close() 也会触发)。 */
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  onStderrLine?: (line: string) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 3_000;

export class PiRpcProcess {
  private child: ChildProcessWithoutNullStreams;
  private nextRequestId = 1;
  private pending = new Map<string, {
    resolve: (resp: PiRpcResponse) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private closed = false;
  private readonly logger: Logger;

  constructor(private readonly opts: PiRpcSpawnOptions) {
    this.logger = opts.logger;
    this.child = spawn(opts.binaryPath, opts.args, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    attachJsonlReader(this.child.stdout, (line) => this.handleStdoutLine(line));
    attachJsonlReader(this.child.stderr, (line) => {
      if (line.trim().length === 0) return;
      this.logger.warn('pi stderr', { line: line.slice(0, 2000) });
      opts.onStderrLine?.(line);
    });

    this.child.on('error', (err) => {
      this.logger.error('pi process error', { message: err.message });
      this.failAllPending(new Error(`pi process error: ${err.message}`));
    });
    this.child.on('close', (code, signal) => {
      this.closed = true;
      this.failAllPending(new Error(`pi process exited (code=${code}, signal=${signal})`));
      opts.onExit({ code, signal });
    });
  }

  get pid(): number | undefined {
    return this.child.pid ?? undefined;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 发送命令并等待同 id 响应。success:false 时同样 resolve(由调用方看 success/error)。 */
  async request(
    command: Record<string, unknown>,
    { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }: { timeoutMs?: number } = {},
  ): Promise<PiRpcResponse> {
    if (this.closed) throw new Error('pi process already exited');
    const id = `c${this.nextRequestId++}`;
    const payload = JSON.stringify({ ...command, id });

    return new Promise<PiRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi rpc timeout after ${timeoutMs}ms: ${String(command.type)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(payload + '\n', (err) => {
        if (err) {
          const entry = this.pending.get(id);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(id);
            reject(new Error(`pi rpc write failed: ${err.message}`));
          }
        }
      });
    });
  }

  /** fire-and-forget 写入(extension_ui_response 等不产生 response 的帧)。 */
  send(frame: Record<string, unknown>): void {
    if (this.closed) return;
    this.child.stdin.write(JSON.stringify(frame) + '\n');
  }

  /** 优雅关闭:SIGTERM → 宽限期 → SIGKILL。幂等。 */
  async close(): Promise<void> {
    if (this.closed) return;
    const child = this.child;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(killTimer);
        resolve();
      };
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, KILL_GRACE_MS);
      child.once('close', done);
      try {
        child.kill('SIGTERM');
      } catch {
        done();
      }
    });
  }

  private handleStdoutLine(line: string): void {
    if (line.trim().length === 0) return;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      this.logger.warn('pi rpc: non-JSON stdout line dropped', { line: line.slice(0, 500) });
      return;
    }
    if (typeof frame !== 'object' || frame === null) return;
    const obj = frame as Record<string, unknown>;

    if (obj.type === 'response') {
      const resp = obj as unknown as PiRpcResponse;
      const id = typeof resp.id === 'string' ? resp.id : undefined;
      if (id && this.pending.has(id)) {
        const entry = this.pending.get(id)!;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.resolve(resp);
      } else {
        // 无 id 的响应(如 parse error)或迟到响应 —— 记日志不丢语义。
        this.logger.warn('pi rpc: unmatched response', {
          command: resp.command,
          success: resp.success,
          error: resp.error,
        });
      }
      return;
    }

    this.opts.onEvent(obj as PiRpcEvent);
  }

  private failAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}

/**
 * 协议合规的 JSONL 读取:只按 \n 切,strip 尾部 \r,跨 chunk 维护缓冲。
 * (pi docs/rpc.md 明确警告 Node readline 不合规。)
 */
export function attachJsonlReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';

  stream.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) break;
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      onLine(line);
    }
  });

  stream.on('end', () => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      onLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
    }
  });
}
