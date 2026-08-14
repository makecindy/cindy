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
    /** 发送命令的 type —— 响应 envelope 校验用(轮 40-w4-t4 CRITICAL)。 */
    commandType: string;
  }>();
  private closed = false;
  /**
   * 轮 42 P2(codex-connector):close() 的幂等守卫单独跟踪 —— 与 closed(进程/通道
   * 已死)分离。bridge 断链时 onClose 置 closed, 但**用户显式 close 仍未发生过**:
   * 复用 closed 做 close() 守卫会让显式关闭直接 return, 跳过 killRemoteSession
   * (它走独立 SSH RPC, 断链后仍能送达 daemon), 远端 pi 带凭证跑到 idle 回收。
   * closeCalled 只在用户(或上层)显式 close 后置位, 保证 kill 一定执行一次。
   */
  private closeCalled = false;
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
    { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }: { timeoutMs?: number } = {},
  ): Promise<PiRpcResponse> {
    if (this.isClosed) throw new Error('pi process already exited');
    const id = `c${this.nextRequestId++}`;
    const payload = JSON.stringify({ ...command, id });

    return new Promise<PiRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi rpc timeout after ${timeoutMs}ms: ${String(command.type)}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
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

  /** 优雅关闭:交给 transport(SIGTERM → 宽限期 → SIGKILL,或关 ssh channel)。幂等。 */
  async close(): Promise<void> {
    // 轮 21 H-2 幂等竞态:closeCalled 必须在任何 await 前置位 —— 否则并发 close()
    // 都通过守卫、killRemoteSession RPC 发两次(daemon 模式)+ transport.close
    // 跑两次。置位后 killRemoteSession/close 的失败不再影响幂等语义。
    // 轮 42 P2:守卫用 closeCalled 而非 closed —— onClose(bridge 断链)已置 closed
    // 时, 用户显式 close 仍必须执行 killRemoteSession(独立 SSH RPC 可送达 daemon)。
    if (this.closeCalled) return;
    this.closeCalled = true;
    this.closed = true;
    // daemon 模式:用户主动关会话 → 先杀远端 daemon 持有的 pi(对齐 CC/Codex daemon
    // 生命周期),再关 transport。顺序关键:先杀 pi 再关 channel,PiAgent 的 onExit
    // cleanup(configHome/perm)才发生在 pi 已死后 —— 否则 kill 失败而 cleanup 已删
    // configHome,daemon pi 继续跑会用已删文件(R2 生命周期 B3)。
    // 轮 40-w4-t10 HIGH(修复的修复):kill 失败(SSH 断/daemon 不可达)时**仍必须
    // 关 transport** —— 旧实现直接 throw 会跳过 transport.close, 把可恢复的关闭
    // 失败变成永久半开(channel/daemon 继续存活, 重试因 closed 置位 no-op)。
    // kill 失败只决定是否上浮错误, 不阻断底层收口。
    let killError: unknown = null;
    try {
      await this.transport.killRemoteSession?.();
    } catch (err) {
      // 轮 40-w4-t7 HIGH:kill 失败时 pi 可能继续跑, 残留持凭证的远端 session。
      // fail-closed:上浮错误, 让上层明确知道关闭未完成(daemon idle timeout 兜底)。
      killError = new Error(
        `pi killRemoteSession failed: ${err instanceof Error ? err.message : String(err)} — remote daemon session may still be running`,
      );
    }
    try {
      await this.transport.close();
    } catch {
      // transport.close 自身幂等且不抛;防御未来实现变更(自审轮 6 L-1 语义保留)。
    }
    if (killError) throw killError;
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
