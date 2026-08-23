/**
 * pi RPC 客户端 —— 在 PiTransport 字节流上跑 `pi --mode rpc` 的 JSONL 协议
 * (stdin 命令 / stdout 响应+事件)。
 *
 * 协议要点(pi docs/rpc.md):
 *  - 严格 JSONL,仅以 LF 分帧;输入允许 \r\n(strip 尾部 \r)。不能用 readline
 *    (它会按 U+2028/U+2029 切行,而这些字符在 JSON 字符串里合法)。
 *  - 命令可带 id 做请求/响应关联;响应 type='response' 且回带同 id。
 *  - 其余 stdout 行都是事件(含 extension_ui_request 子协议)。
 *
 * 传输与协议分离:字节流来自 PiTransport —— 本地 spawn 的 stdio
 * (createPiStdioTransport) 或远端 ssh channel (host 侧 SshPiTransport)。
 * 本类只做 JSONL framing 之上的请求/响应关联与事件分发, 不感知字节流来源。
 */

import type { Logger } from '../../interfaces/logger.js';

import type { PiTransport } from './transport.js';

export { attachJsonlReader } from './transport.js';
export { createPiStdioTransport } from './transport.js';
export type { PiTransport, PiTransportCloseInfo, PiLineHandler, PiCloseHandler } from './transport.js';

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

export class PiRpcRequestTimeoutError extends Error {
  readonly code = 'PI_RPC_TIMEOUT';

  constructor(
    public readonly commandType: string,
    public readonly timeoutMs: number,
  ) {
    super(`pi rpc timeout after ${timeoutMs}ms: ${commandType}`);
    this.name = 'PiRpcRequestTimeoutError';
  }
}

export interface PiRpcSpawnOptions {
  /** 已建立的字节流 transport(本地 stdio 或远端 ssh channel)。 */
  transport: PiTransport;
  logger: Logger;
  /** 事件帧回调(response 之外的所有行)。 */
  onEvent: (event: PiRpcEvent) => void;
  /** 进程退出回调(exit code / signal;正常 close() 也会触发)。 */
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  onStderrLine?: (line: string) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// 轮 40-w4-t5 CRITICAL:key-aware 敏感字段名 —— 值形状正则覆盖不了 64-hex
// sessionToken / 自定义 MCP header 值, 字段名命中即整体替换。
const SENSITIVE_KEY_RE =
  /(^|[\s,{[])("?)([A-Za-z0-9_-]*)(token|secret|api[_-]?key|authorization|password|credential|CINDY_PI_MCP_BRIDGE|CINDY_PI_REMOTE_MCP_SECRET)([A-Za-z0-9_-]*)(\s*["]?\s*[:=]\s*)([^,\s}\]]+)/gi;

/** stderr / 非 JSON stdout 进日志前的凭证脱敏(值形状 + key-aware 双保险)。 */
function redactCredentialText(text: string): string {
  let out = text;
  try {
    // 值形状正则(与 daemon 侧同款, 覆盖常见 token 格式)。
    // 避免引入额外依赖:内联轻量实现。
    out = out.replace(
      /(?<![A-Za-z0-9])(sk-(?:ant|or|proj|admin|svcacct)-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/g,
      '[REDACTED]',
    );
  } catch {
    /* regex 极端输入不阻断诊断 */
  }
  out = out.replace(SENSITIVE_KEY_RE, (_m, pre: string, quote: string, _k1: string, _k2: string, _k3: string, sep: string) =>
    `${pre}${quote}[REDACTED]${sep}[REDACTED]`);
  return out;
}

export class PiRpcProcess {
  private readonly transport: PiTransport;
  private nextRequestId = 1;
  private pending = new Map<string, {
    resolve: (resp: PiRpcResponse) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
    timeoutMs: number;
    refreshTimeoutOnEvent?: (event: PiRpcEvent) => boolean;
    /** 发送命令的 type —— 响应 envelope 校验用(轮 40-w4-t4 CRITICAL)。 */
    commandType: string;
  }>();
  private closed = false;
  /**
   * In-flight/successful close is shared. A failed close clears the gate so a
   * later call can retry remote termination instead of reporting a false
   * idempotent success while the old daemon session may still be alive.
   */
  private closePromise: Promise<void> | null = null;
  private readonly logger: Logger;

  constructor(private readonly opts: PiRpcSpawnOptions) {
    this.logger = opts.logger;
    this.transport = opts.transport;

    this.transport.onLine((line) => this.handleStdoutLine(line));
    this.transport.onStderr?.((line) => {
      if (line.trim().length === 0) return;
      // 轮 40-w4-t5 CRITICAL:stderr 可能含 env 凭证(崩溃 dump/依赖 debug 输出),
      // 进桌面日志前 key-aware 脱敏(值形状正则覆盖不了 64-hex sessionToken)。
      this.logger.warn('pi stderr', { line: redactCredentialText(line).slice(0, 2000) });
      opts.onStderrLine?.(redactCredentialText(line));
    });
    this.transport.onClose((info) => {
      this.closed = true;
      this.failAllPending(new Error(`pi process exited (code=${info.code}, signal=${info.signal})`));
      opts.onExit({ code: info.code, signal: info.signal });
    });
  }

  get pid(): number | undefined {
    return this.transport.pid;
  }

  get isClosed(): boolean {
    return this.closed || this.transport.isClosed();
  }

  /** 发送命令并等待同 id 响应。success:false 时同样 resolve(由调用方看 success/error)。 */
  async request(
    command: Record<string, unknown>,
    {
      timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
      refreshTimeoutOnEvent,
    }: {
      timeoutMs?: number;
      refreshTimeoutOnEvent?: (event: PiRpcEvent) => boolean;
    } = {},
  ): Promise<PiRpcResponse> {
    if (this.isClosed) throw new Error('pi process already exited');
    const id = `c${this.nextRequestId++}`;
    const payload = JSON.stringify({ ...command, id });

    return new Promise<PiRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const commandType = typeof command.type === 'string' ? command.type : '';
        reject(new PiRpcRequestTimeoutError(commandType, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        timeoutMs,
        refreshTimeoutOnEvent,
        commandType: typeof command.type === 'string' ? command.type : '',
      });
      this.transport.writeLine(payload).catch((err) => {
        const entry = this.pending.get(id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  /** fire-and-forget 写入(extension_ui_response 等不产生 response 的帧)。 */
  send(frame: Record<string, unknown>): void {
    if (this.isClosed) return;
    void this.transport.writeLine(JSON.stringify(frame)).catch((err) => {
      // transport 已断时 onClose 会收口, 但瞬时写失败(如 ssh channel 缓冲满)
      // 不该无迹可循 —— 留 debug 日志便于诊断(R7 审计 I-1)。
      this.logger.debug('pi rpc send failed (fire-and-forget)', {
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /** 优雅关闭:交给 transport(SIGTERM → 宽限期 → SIGKILL,或关 ssh channel)。 */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const attempt = this.performClose();
    this.closePromise = attempt;
    void attempt.catch(() => {
      if (this.closePromise === attempt) this.closePromise = null;
    });
    return attempt;
  }

  private async performClose(): Promise<void> {
    this.closed = true;
    // daemon 模式:用户主动关会话 → 先杀远端 daemon 持有的 pi(对齐 CC/Codex daemon
    // 生命周期),再关 transport。顺序关键:先杀 pi 再关 channel,PiAgent 的 onExit
    // cleanup(configHome/perm)才发生在 pi 已死后 —— 否则 kill 失败而 cleanup 已删
    // configHome,daemon pi 继续跑会用已删文件(R2 生命周期 B3)。
    // kill 失败时仍关 transport，但必须 reject；失败 gate 会被 close() 清掉，
    // 后续可经独立 SSH RPC 真正重试 kill，不能第二次 close 伪成功。
    let killError: unknown = null;
    try {
      await this.transport.killRemoteSession?.();
    } catch (err) {
      killError = new Error(
        `pi killRemoteSession failed: ${err instanceof Error ? err.message : String(err)} — remote daemon session may still be running`,
      );
    }
    let transportError: unknown = null;
    try {
      await this.transport.close();
    } catch (err) {
      transportError = err;
    }
    if (transportError) {
      this.failAllPending(
        transportError instanceof Error ? transportError : new Error(String(transportError)),
      );
    }
    if (killError) throw killError;
    if (transportError) throw transportError;
  }

  private handleStdoutLine(line: string): void {
    if (line.trim().length === 0) return;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      // 轮 40-w4-t5 CRITICAL:非 JSON stdout 也可能含 env 凭证 —— 脱敏后记录。
      this.logger.warn('pi rpc: non-JSON stdout line dropped', { line: redactCredentialText(line).slice(0, 500) });
      return;
    }
    if (typeof frame !== 'object' || frame === null) return;
    const obj = frame as Record<string, unknown>;

    if (obj.type === 'response') {
      // 轮 18-T1 MEDIUM:响应 error 字段集中脱敏 —— pi/extension 错误可能把
      // env 内容/Authorization/MCP secret 值 echo 进 error 文本。这里在进入
      // 日志/throw/UI 之前统一走 redactCredentialText, 下游(index.ts 各
      // 调用点)拿到的就是已脱敏 error, 不再逐点漏配。
      const raw = obj as unknown as PiRpcResponse;
      const resp: PiRpcResponse =
        raw.error !== undefined && typeof raw.error === 'string'
          ? { ...raw, error: redactCredentialText(raw.error) }
          : raw;
      const id = typeof resp.id === 'string' ? resp.id : undefined;
      const entry = id ? this.pending.get(id) : undefined;
      if (id && entry) {
        // 轮 40-w4-t4 CRITICAL:response envelope 集中校验 —— success 必须是
        // boolean;command 若存在必须匹配该 pending request 的 command.type。
        // 否则畸形/语义失败的响应会被调用方当成成功(如 get_state 失败被
        // 当成 ready + 伪 session id)。校验失败 reject pending(调用方走
        // 失败路径), 不 resolve 一个不可信的响应。
        if (typeof resp.success !== 'boolean') {
          clearTimeout(entry.timer);
          this.pending.delete(id);
          entry.reject(new Error(`pi rpc: response for ${entry.commandType} missing boolean success`));
          return;
        }
        if (
          typeof resp.command === 'string'
          && resp.command !== entry.commandType
        ) {
          clearTimeout(entry.timer);
          this.pending.delete(id);
          entry.reject(
            new Error(
              `pi rpc: response command mismatch (expected ${entry.commandType}, got ${resp.command})`,
            ),
          );
          return;
        }
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

    const event = obj as PiRpcEvent;
    for (const [id, entry] of this.pending) {
      if (!entry.refreshTimeoutOnEvent?.(event)) continue;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        if (this.pending.get(id) !== entry) return;
        this.pending.delete(id);
        entry.reject(new PiRpcRequestTimeoutError(entry.commandType, entry.timeoutMs));
      }, entry.timeoutMs);
    }
    this.opts.onEvent(event);
  }

  private failAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}
