/**
 * Prime Agent RPC 客户端 —— 在 PrimeAgentTransport 字节流上跑
 * `prime-agent --mode rpc` 的 JSONL 协议 (stdin 命令 / stdout 响应+事件)。
 *
 * 协议要点(Prime Agent 源码 crates/pa-daemon/src/rpc/):
 *  - 严格 JSONL, 只以 LF 分帧 (`LineWriter::write` 只 push '\n', mod.rs:66-70);
 *    `parse_line` 对每行先 `trim()` 再 `serde_json::from_str` (protocol.rs:71-73)。
 *    输入不能带 readline 语义 —— Node readline 会按 U+2028/U+2029 切行。
 *  - 命令带 `id` 做请求/响应关联; 响应 `type='response'` 且回带同 id
 *    (protocol.rs:24-36)。**id 可省略**: parse error 一律不带 id (protocol.rs:76-89)。
 *  - 响应 `command` 字段**总是存在**, 值为该命令的 `type` (protocol.rs:31/45) ——
 *    包括 `command:'parse'` 的解析失败帧。
 *  - `success` 恒为 boolean (protocol.rs:31/47)。
 *  - `data` 区分「键缺失」与「JSON null」: `ResponseData::Absent` 时整个键不出现
 *    (protocol.rs:8-13, 32-34)。`prompt`/`abort`/`steer` 等答的就是无 data 的响应。
 *  - `error` 是**字符串**, 不是对象 (protocol.rs:48)。
 *  - 其余 stdout 行都是事件, 与响应共用同一个有序 writer 队列 (mod.rs:36-71)。
 *
 * 传输与协议分离: 字节流来自 PrimeAgentTransport —— 本地 spawn 的 stdio
 * (createPrimeAgentStdioTransport) 或远端桥接 channel。本类只做 JSONL framing
 * 之上的请求/响应关联与事件分发, 不感知字节流来源。
 */

import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import type { Logger } from '../../interfaces/logger.js';

import type {
  PrimeAgentDisconnectReason,
  PrimeAgentTransport,
} from './transport.js';

export { attachJsonlReader, createPrimeAgentStdioTransport } from './transport.js';
export { MAX_JSONL_BUFFER_CHARS } from './transport.js';
export type {
  PrimeAgentTransport,
  PrimeAgentTransportCloseInfo,
  PrimeAgentLineHandler,
  PrimeAgentCloseHandler,
  PrimeAgentDisconnectReason,
} from './transport.js';

/** Prime Agent RPC 响应帧。 */
export interface PrimeAgentRpcResponse {
  type: 'response';
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** Prime Agent RPC 事件帧(response 之外的一切; 具体形状 translator 侧收窄)。 */
export interface PrimeAgentRpcEvent {
  type: string;
  [key: string]: unknown;
}

export const PRIME_AGENT_RPC_OVERSIZED_FRAME_ERROR =
  'RPC response exceeded 16 MiB and was discarded.';

export class PrimeAgentRpcRequestTimeoutError extends Error {
  readonly code = 'PRIME_AGENT_RPC_TIMEOUT';

  constructor(
    public readonly commandType: string,
    public readonly timeoutMs: number,
  ) {
    super(`prime-agent rpc timeout after ${timeoutMs}ms: ${commandType}`);
    this.name = 'PrimeAgentRpcRequestTimeoutError';
  }
}

export interface PrimeAgentRpcSpawnOptions {
  /** 已建立的字节流 transport(本地 stdio 或远端桥接 channel)。 */
  transport: PrimeAgentTransport;
  logger: Logger;
  /** 事件帧回调(response 之外的所有行)。 */
  onEvent: (event: PrimeAgentRpcEvent) => void;
  /** 进程退出回调(exit code / signal; 正常 close() 也会触发)。 */
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  /** RPC loss without confirmed executor exit. Runtime cleanup still needs close(). */
  onDisconnect?: (reason: PrimeAgentDisconnectReason) => void;
  onStderrLine?: (line: string) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_STARTUP_STDERR_CHARS = 2000;

// key-aware 敏感字段名 —— 值形状正则覆盖不了 64-hex token / 自定义 header 值,
// 字段名命中即整体替换。Prime Agent 自带 provider 的内联 API 密钥会出现在
// models.json / 报错文本里, 进日志前必须拦。
const SENSITIVE_KEY_RE =
  /(^|[\s,{[])("?)([A-Za-z0-9_-]*)(token|secret|api[_-]?key|authorization|password|credential)([A-Za-z0-9_-]*)(\s*["]?\s*[:=]\s*)([^,\s}\]]+)/gi;

/** stderr / 非 JSON stdout 进日志前的凭证脱敏(值形状 + key-aware 双保险)。 */
function redactCredentialText(text: string): string {
  let out = text;
  try {
    // 值形状正则: 避免引入额外依赖, 内联轻量实现。
    out = out.replace(
      /(?<![A-Za-z0-9])(sk-(?:ant|or|proj|admin|svcacct)-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/g,
      '[REDACTED]',
    );
  } catch {
    /* regex 极端输入不阻断诊断 */
  }
  out = out.replace(
    SENSITIVE_KEY_RE,
    (_m, pre: string, quote: string, _k1: string, _k2: string, _k3: string, sep: string) =>
      `${pre}${quote}[REDACTED]${sep}[REDACTED]`,
  );
  return out;
}

/** Error surfaces need the failing module name, not machine paths or stacks. */
function sanitizeStartupDiagnostic(line: string): string {
  if (/^\s*at(?:\s|$)/.test(line)) return '';
  const pathLabel = (value: string): string => {
    const name = value.split(/[\\/]/).filter(Boolean).pop() ?? '';
    return `<path:${name}>`;
  };
  return line
    .replace(
      /(["'])((?:file:\/\/\/|[A-Za-z]:[\\/]|\/|\\\\)[^"'\r\n]*)\1/g,
      (_match, quote: string, value: string) => `${quote}${pathLabel(value)}${quote}`,
    )
    .replace(
      /(?<![\w:/\\])(?:file:\/\/\/|[A-Za-z]:[\\/]|\/|\\\\)[^\r\n"'<>]+?(?=:\s|["'<>\r\n]|$)/g,
      (value) => pathLabel(value),
    );
}

/**
 * 帧诊断日志的标签白名单: Prime Agent 协议的事件类型 / role / stopReason / 块类型
 * 都是短标识符。扩展或畸形事件可能把任意正文塞进这些字段 —— 不符合标识符形态的一律
 * 归一为 '(other)', 落实「不落消息内容」的白名单方向(不是靠脱敏兜底)。
 */
const FRAME_LABEL_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

function sanitizeFrameLabel(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '(untyped)';
  return FRAME_LABEL_RE.test(value) ? value : '(other)';
}

export class PrimeAgentRpcProcess {
  private readonly transport: PrimeAgentTransport;
  private nextRequestId = 1;
  private pending = new Map<string, {
    resolve: (resp: PrimeAgentRpcResponse) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
    timeoutMs: number;
    refreshTimeoutOnEvent?: (event: PrimeAgentRpcEvent) => boolean;
    /** 发送命令的 type —— 响应 envelope 校验用。 */
    commandType: string;
  }>();
  private closed = false;
  // Extension/provider loading can fail before the first RPC response. Keep only
  // a redacted, bounded tail until RPC becomes responsive, never running output.
  private startupStderr = '';
  private receivedRpcResponse = false;
  private exitError: Error | null = null;
  /**
   * In-flight/successful close is shared. A failed close clears the gate so a
   * later call can retry termination instead of reporting a false idempotent
   * success while the old process may still be alive.
   */
  private closePromise: Promise<void> | null = null;
  private readonly logger: Logger;
  /**
   * 定界诊断: 成功轮的正文可能整帧消失(jsonl 有、DB/UI 均无), 离线无法复现。
   * 这里按事件类型计数、在 message_end / **agent_end**(Prime Agent 的 turn 终态)
   * 落两行元数据日志(块类型与字符数, 不含任何消息内容), 让下一次复现能区分
   * 「Prime Agent 未发出该帧」与「Cindy 收到后在下游丢失」。
   */
  private readonly eventFrameCounts = new Map<string, number>();

  constructor(private readonly opts: PrimeAgentRpcSpawnOptions) {
    this.logger = opts.logger;
    this.transport = opts.transport;

    this.transport.onLine((line) => this.handleStdoutLine(line));
    this.transport.onStderr?.((line) => {
      if (line.trim().length === 0) return;
      // stderr 可能含 env 凭证(崩溃 dump / 依赖 debug 输出), 进桌面日志前脱敏。
      const redacted = redactCredentialText(redactSensitiveText(line));
      this.logger.warn('prime-agent stderr', { line: redacted.slice(0, 2000) });
      if (!this.receivedRpcResponse && !this.closed) {
        // Redact the whole line before truncating, so a credential straddling
        // the tail boundary cannot lose its identifying prefix and leak.
        const diagnostic = sanitizeStartupDiagnostic(redacted);
        if (diagnostic) {
          this.startupStderr = `${this.startupStderr}${this.startupStderr ? '\n' : ''}${diagnostic}`
            .slice(-MAX_STARTUP_STDERR_CHARS);
        }
      }
      opts.onStderrLine?.(redacted);
    });
    this.transport.onClose((info) => {
      this.closed = true;
      this.exitError = this.createExitError(
        `prime-agent process exited (code=${info.code}, signal=${info.signal})`,
      );
      this.startupStderr = '';
      this.failAllPending(this.exitError);
      this.flushUnsettledFrameDiagnostics();
      opts.onExit({ code: info.code, signal: info.signal });
    });
    this.transport.onDisconnect?.((reason) => {
      this.closed = true;
      this.exitError = this.createExitError(
        `prime-agent RPC disconnected (${reason}); executor exit unconfirmed`,
      );
      this.startupStderr = '';
      this.failAllPending(this.exitError);
      this.flushUnsettledFrameDiagnostics();
      opts.onDisconnect?.(reason);
    });
    this.transport.onOversizedFrame?.(() => this.failOversizedPending());
  }

  get pid(): number | undefined {
    return this.transport.pid;
  }

  private createExitError(message: string): Error {
    return new Error(
      this.startupStderr ? `${message}\nPrime Agent startup stderr:\n${this.startupStderr}` : message,
    );
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
      refreshTimeoutOnEvent?: (event: PrimeAgentRpcEvent) => boolean;
    } = {},
  ): Promise<PrimeAgentRpcResponse> {
    if (this.isClosed) {
      throw this.exitError ?? this.createExitError('prime-agent RPC transport is closed');
    }
    const id = `c${this.nextRequestId++}`;
    const payload = JSON.stringify({ ...command, id });

    return new Promise<PrimeAgentRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const commandType = typeof command.type === 'string' ? command.type : '';
        reject(new PrimeAgentRpcRequestTimeoutError(commandType, timeoutMs));
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

  /** fire-and-forget 写入(不产生 response 的帧)。 */
  send(frame: Record<string, unknown>): void {
    if (this.isClosed) return;
    void this.transport.writeLine(JSON.stringify(frame)).catch((err) => {
      // transport 已断时 onClose 会收口, 但瞬时写失败不该无迹可循。
      this.logger.debug('prime-agent rpc send failed (fire-and-forget)', {
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /** 优雅关闭: 交给 transport(end stdin → 宽限期 → SIGTERM/SIGKILL, 或关远端 channel)。 */
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
    if (transportError) throw transportError;
  }

  private handleStdoutLine(line: string): void {
    if (line.trim().length === 0) return;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      // 非 JSON stdout 也可能含凭证 —— 脱敏后记录。两层脱敏: 先跑 maker-shared 的
      // redactSensitiveText(它处理 `Authorization: Basic <base64>` 这类非 Bearer
      // 方案), 再跑本文件的 key-aware 兜底。
      this.logger.warn('prime-agent rpc: non-JSON stdout line dropped', {
        line: redactCredentialText(redactSensitiveText(line)).slice(0, 500),
      });
      return;
    }
    if (typeof frame !== 'object' || frame === null) return;
    const obj = frame as Record<string, unknown>;

    if (obj.type === 'response') {
      // 响应 error 字段集中脱敏 —— Prime Agent 的错误可能把 provider 报错 /
      // 内联密钥上下文 echo 进 error 文本。这里在进入日志/throw/UI 之前统一脱敏,
      // 下游拿到的就是已脱敏 error。
      //
      // 两层脱敏是必需的: maker-shared 的 redactSensitiveText 第一步就是
      // redactCredentialHeaderFields(), 它专门处理 `Authorization: Basic <base64>`
      // 这类非 Bearer 方案; 本文件的 redactCredentialText 只按 key 名与已知值形状
      // 匹配, 单独用会留下 base64 凭证原文(见本文件 redaction 的注释)。
      const raw = obj as unknown as PrimeAgentRpcResponse;
      const resp: PrimeAgentRpcResponse =
        raw.error !== undefined && typeof raw.error === 'string'
          ? { ...raw, error: redactCredentialText(redactSensitiveText(raw.error)) }
          : raw;
      const id = typeof resp.id === 'string' ? resp.id : undefined;
      const entry = id ? this.pending.get(id) : undefined;
      if (id && entry) {
        // 响应 envelope 集中校验 —— success 必须是 boolean; command 若存在必须
        // 匹配该 pending request 的 command.type。否则畸形/语义失败的响应会被
        // 调用方当成成功(如 get_state 失败被当成 ready + 伪 session id)。
        // 校验失败 reject pending(调用方走失败路径), 不 resolve 一个不可信的响应。
        //
        // 注意: Prime Agent 的 parse error 帧是 `{command:'parse', success:false}`
        // 且**不带 id** (protocol.rs:76-89), 所以它落到下面的 unmatched 分支,
        // 不会误伤一个合法的 pending request。
        if (typeof resp.success !== 'boolean') {
          clearTimeout(entry.timer);
          this.pending.delete(id);
          entry.reject(
            new Error(`prime-agent rpc: response for ${entry.commandType} missing boolean success`),
          );
          return;
        }
        if (typeof resp.command !== 'string') {
          // `command` 缺失或非字符串 —— Prime Agent 的响应**总是**回带它
          // (protocol.rs:31/45, 含 parse error 帧的 command:'parse')。缺失说明
          // 这是一帧畸形响应, 不能当成合法响应 resolve 给调用方。
          clearTimeout(entry.timer);
          this.pending.delete(id);
          entry.reject(
            new Error(
              `prime-agent rpc: response for ${entry.commandType} missing a string command`,
            ),
          );
          return;
        }
        if (resp.command !== entry.commandType) {
          clearTimeout(entry.timer);
          this.pending.delete(id);
          entry.reject(
            new Error(
              `prime-agent rpc: response command mismatch (expected ${entry.commandType}, got ${resp.command})`,
            ),
          );
          return;
        }
        clearTimeout(entry.timer);
        this.pending.delete(id);
        this.receivedRpcResponse = true;
        this.startupStderr = '';
        entry.resolve(resp);
      } else {
        // 无 id 的响应(如 parse error)或迟到响应 —— 记日志不丢语义。
        this.logger.warn('prime-agent rpc: unmatched response', {
          command: resp.command,
          success: resp.success,
          error: resp.error,
        });
      }
      return;
    }

    const event = obj as PrimeAgentRpcEvent;
    this.recordEventFrameDiagnostics(event);
    for (const [id, entry] of this.pending) {
      if (!entry.refreshTimeoutOnEvent?.(event)) continue;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        if (this.pending.get(id) !== entry) return;
        this.pending.delete(id);
        entry.reject(new PrimeAgentRpcRequestTimeoutError(entry.commandType, entry.timeoutMs));
      }, entry.timeoutMs);
    }
    this.opts.onEvent(event);
  }

  /** 只记帧元数据(类型 / 块类型 / 字符数), 绝不落消息正文 —— 日志白名单方向。 */
  private recordEventFrameDiagnostics(event: PrimeAgentRpcEvent): void {
    const type = sanitizeFrameLabel(event.type);
    // abort / 进程异常的轮次收不到 agent_end: 计数留到下一轮会把「message_end
    // 是否到达」污染成不可归属。新轮 agent_start 先冲刷再清零 —— 既保住未收口轮的
    // 证据, 又保证每份直方图只属于一轮。
    if (type === 'agent_start' && this.eventFrameCounts.size > 0) {
      this.logger.info('prime-agent rpc turn frame histogram (no agent_end)', {
        frames: Object.fromEntries(this.eventFrameCounts),
      });
      this.eventFrameCounts.clear();
    }
    this.eventFrameCounts.set(type, (this.eventFrameCounts.get(type) ?? 0) + 1);
    if (type === 'message_end') {
      const message = event.message as
        | { role?: unknown; stopReason?: unknown; content?: unknown }
        | undefined;
      const blocks = Array.isArray(message?.content) ? message.content : [];
      const blockTypes: string[] = [];
      let textChars = 0;
      let thinkingChars = 0;
      for (const block of blocks) {
        if (!block || typeof block !== 'object') {
          blockTypes.push('(invalid)');
          continue;
        }
        const rec = block as Record<string, unknown>;
        const blockType = sanitizeFrameLabel(rec.type);
        blockTypes.push(blockType);
        if (rec.type === 'text' && typeof rec.text === 'string') textChars += rec.text.length;
        if (rec.type === 'thinking' && typeof rec.thinking === 'string') {
          thinkingChars += rec.thinking.length;
        }
      }
      this.logger.info('prime-agent rpc message_end frame', {
        role: sanitizeFrameLabel(message?.role),
        stopReason:
          message?.stopReason === undefined || message?.stopReason === null
            ? null
            : sanitizeFrameLabel(message.stopReason),
        blockTypes,
        textChars,
        thinkingChars,
      });
      return;
    }
    if (type === 'agent_end') {
      // Prime Agent 的 turn 终态(translator 侧合成为 agent_settled)。这里落的直方图
      // 就是「turn 收口」的直接证据。
      this.logger.info('prime-agent rpc turn frame histogram (agent_end)', {
        frames: Object.fromEntries(this.eventFrameCounts),
      });
      this.eventFrameCounts.clear();
    }
  }

  private flushUnsettledFrameDiagnostics(): void {
    if (this.eventFrameCounts.size === 0) return;
    this.logger.info('prime-agent rpc turn frame histogram (no agent_end)', {
      frames: Object.fromEntries(this.eventFrameCounts),
    });
    this.eventFrameCounts.clear();
  }

  private failOversizedPending(): void {
    // 超限通知不带帧 type / 响应 id。事件帧(如 message_end)也可能超限; 只能结束能
    // 确定归属的请求, 不能把唯一 pending 的 steer/abort 猜成受害者。
    const victims = [...this.pending.entries()].filter(([, entry]) => entry.commandType === 'get_state');
    if (victims.length === 0) {
      this.logger.warn(
        'prime-agent rpc: discarded oversized JSONL frame with no matching pending get_state',
      );
      return;
    }
    for (const [id, entry] of victims) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve({
        type: 'response',
        id,
        command: entry.commandType,
        success: false,
        error: PRIME_AGENT_RPC_OVERSIZED_FRAME_ERROR,
      });
    }
  }

  private failAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}
