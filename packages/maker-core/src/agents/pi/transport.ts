/**
 * PiTransport — pi `--mode rpc` JSONL 字节流的双向 transport 抽象。
 *
 * 设计动机(与 codex app-server transport 同构):
 *   `PiRpcProcess` 协议层只跟「一行行 JSON」打交道, 跟字节流从哪来无关。把字节流
 *   抽象到这个 interface 后, 同一份 client 能同时驱动:
 *     - StdioTransport: 本地 spawn `pi --mode rpc`, 接 stdin/stdout (历史行为)
 *     - SshPiTransport (host 侧): 远端 pi 经 `RemoteHost.execStream` 桥接的 ssh
 *       channel 字节流 (desktop 层实现, maker-core 只依赖本接口)
 *   两种 transport 对 client 表现完全一致 (writeLine + onLine + onClose)。
 *
 * 协议无关性:
 *   transport 只搬字节流, 不解析 JSON, 不做 framing 之外的握手。JSONL 分帧 (LF、
 *   strip 尾部 \r) 由 PiRpcProcess 侧的 attachJsonlReader 负责。
 *
 * 错误模型:
 *   - writeLine() reject = "这一行没写出去" (caller 自行决定怎么处理)
 *   - onClose 触发 = "transport 已经断了" (重连由上层 / 不在 transport 责任内)
 *   - transport 内部任何异步错误都最终走 onClose(reason)
 *
 * 生命周期语义 (SSH remote 关键差异):
 *   - 本地 stdio: close() = SIGTERM → 宽限期 → SIGKILL 子进程
 *   - 远端 ssh channel: close() = 关闭 channel (kill 远端进程); 远端 pi 没有
 *     daemon 形态, 断链即进程终止, 重连 = 重新 exec + switch_session resume
 *     (见 docs/research/pi-ssh-remote-feasibility.md §4 实测)。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import type { Logger } from '../../interfaces/logger.js';

/** transport 关闭信息:远端进程退出码 / 信号 + 人类可读原因。 */
export interface PiTransportCloseInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  reason: string;
}

export type PiLineHandler = (line: string) => void;
export type PiCloseHandler = (info: PiTransportCloseInfo) => void;

/**
 * 双向 transport。一个实例只服务一个 PiRpcProcess (1:1)。
 */
export interface PiTransport {
  /** 把一行 JSONL (不含尾部 \n) 写到对端。reject = "这一行没写出去"。 */
  writeLine(line: string): Promise<void>;

  /** 注册逐行 JSONL 回调 (fan-out), 返回 unsubscribe。 */
  onLine(handler: PiLineHandler): () => void;

  /** (可选) 注册 stderr / 诊断行 handler。 */
  onStderr?(handler: (line: string) => void): () => void;

  /** 注册关闭回调。触发后此 transport 不再可用, writeLine 一律 reject。 */
  onClose(handler: PiCloseHandler): () => void;

  /** 主动关闭。幂等; resolve 后内部资源已释放。 */
  close(reason?: string): Promise<void>;

  /** 本地进程 pid (ssh 场景无意义, undefined)。 */
  readonly pid: number | undefined;

  /** 已关闭 (进程退出 / channel 断开 / close() 之后)。 */
  isClosed(): boolean;

  /**
   * (可选)远端 transport 实际使用的 pi 二进制路径。本地 stdio 不设(用 deps.binaryPath);
   * SshPiTransport 设远端 `$INSTALL_DIR/pi/pi`。PiAgent 的 plan-mode 扩展路径 /
   * subagent 二进制 env 需要它 —— 远端场景必须指向远端文件。
   */
  readonly remoteBinaryPath?: string;

  /**
   * (可选)daemon 模式会话结束钩子:用户主动 close 会话时杀掉远端 daemon 持有的 pi
   * 进程(对齐 CC/Codex daemon 生命周期)。普通(非 daemon)transport 不设。
   */
  killRemoteSession?: () => Promise<void>;

  /**
   * (可选)远端会话按需建立 Desktop host loopback provider 的 SSH reverse-forward。
   * 启动时只为当前 provider 建隧道；会话内 setModel 切到其它 host-backed provider
   * 时先调用本钩子，成功后才允许更新路由快照或发送 set_model RPC。
   */
  ensureHostProxyForward?: (spec: {
    localUrl: string;
    remotePort: number;
  }) => Promise<void>;
}

export interface PiStdioTransportOptions {
  binaryPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  logger: Logger;
  /** 本地进程生命周期观察器; 返回值在该 spawn 的 error/close 时幂等调用。 */
  onProcessSpawned?: (pid: number) => void | (() => void);
}

/**
 * 本地 stdio transport:spawn `pi --mode rpc`, 双向接 stdin/stdout/stderr。
 * 从原 PiRpcProcess 内联逻辑迁出, 行为不变 (JSONL framing 仍由上层负责)。
 */
export function createPiStdioTransport(opts: PiStdioTransportOptions): PiTransport {
  const child: ChildProcessWithoutNullStreams = spawn(opts.binaryPath, opts.args, {
    cwd: opts.cwd,
    env: opts.env as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const logger = opts.logger;

  let closed = false;
  // 轮 40-w1 MEDIUM-2:close() 进行中标志 —— 防并发 close 双 SIGTERM(轮 21
  // 幂等), 与 closed(已通知)分离, 保主动 close 仍触发 onClose。
  let closing = false;
  let disposeProcessRegistration: (() => void) | undefined;
  if (child.pid != null && child.pid > 0) {
    try {
      const dispose = opts.onProcessSpawned?.(child.pid);
      if (typeof dispose === 'function') disposeProcessRegistration = dispose;
    } catch {
      // Observation failures must not block Pi startup. The process simply remains
      // non-terminable in the resource usage panel.
    }
  }

  const lineHandlers = new Set<PiLineHandler>();
  const closeHandlers = new Set<PiCloseHandler>();
  const stderrHandlers = new Set<(line: string) => void>();
  const stderrBuffer: string[] = [];

  const disposeRegistration = (): void => {
    const dispose = disposeProcessRegistration;
    disposeProcessRegistration = undefined;
    try { dispose?.(); } catch { /* best-effort diagnostic cleanup */ }
  };

  const fireClose = (info: PiTransportCloseInfo): void => {
    if (closed) return;
    closed = true;
    disposeRegistration();
    for (const handler of closeHandlers) {
      try { handler(info); } catch { /* handler should not throw */ }
    }
  };

  // stderr 行缓冲:handler 在进程已开始吐 stderr 之后才注册(常见于 PiRpcProcess
  // 构造后由 caller 补挂), 缓冲到首个 handler 挂上再 drain, 保证不丢诊断。
  const fireStderr = (line: string): void => {
    if (stderrHandlers.size === 0) {
      stderrBuffer.push(line);
      return;
    }
    for (const handler of stderrHandlers) handler(line);
  };
  const armStderr = (handler: (line: string) => void): (() => void) => {
    stderrHandlers.add(handler);
    if (stderrBuffer.length > 0 && stderrHandlers.size === 1) {
      const drained = stderrBuffer.splice(0);
      for (const line of drained) handler(line);
    }
    return () => { stderrHandlers.delete(handler); };
  };

  attachJsonlReader(child.stdout, (line) => {
    for (const handler of lineHandlers) handler(line);
  });
  attachJsonlReader(child.stderr, (line) => {
    if (line.trim().length === 0) return;
    // 轮 40-w3 HIGH:本地 stderr 进日志前做凭证脱敏 —— spawnEnv 合入了 gateway/
    // BYOM/MCP header 真值, 子进程崩溃 dump 可能把它们打到 stderr(远端 daemon
    // 路径已 scrub, 本地与远端必须一致)。
    const redacted = redactSensitiveText(line);
    logger.warn('pi stderr', { line: redacted.slice(0, 2000) });
    fireStderr(redacted);
  });

  child.on('error', (err) => {
    logger.error('pi process error', { message: err.message });
    fireClose({ code: null, signal: null, reason: `pi process error: ${err.message}` });
  });
  child.on('close', (code, signal) => {
    fireClose({ code, signal, reason: `pi process exited (code=${code}, signal=${signal})` });
  });

  const KILL_GRACE_MS = 3_000;
  // SIGKILL 后确认退出的窗口(轮 40-w4-t3 HIGH —— 对齐 session-registry)。
  const KILL_CONFIRM_MS = 5_000;

  return {
    writeLine(line: string): Promise<void> {
      if (closed || closing) return Promise.reject(new Error('pi transport already closed'));
      return new Promise<void>((resolve, reject) => {
        child.stdin.write(line + '\n', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },

    onLine(handler: PiLineHandler): () => void {
      lineHandlers.add(handler);
      return () => { lineHandlers.delete(handler); };
    },

    onStderr(handler): () => void {
      return armStderr(handler);
    },

    onClose(handler: PiCloseHandler): () => void {
      closeHandlers.add(handler);
      return () => { closeHandlers.delete(handler); };
    },

    async close(reason = 'pi transport close()'): Promise<void> {
      // 轮 21 H-1 幂等竞态:closed 必须在任何 await 前置位 —— 否则两个并发
      // close() 都通过守卫、各发一次 SIGTERM + 各设一个 SIGKILL timer。
      // 轮 40-w1 MEDIUM-2:前置 closed 会吞掉子进程 close 事件的 fireClose,
      // 主动 close 不再通知 onClose(上层 PiRpcProcess 收不到 pending reject /
      // onExit 收口)。拆两个状态:closing 防并发, closed 只在真正通知时置位。
      if (closed || closing) return;
      closing = true;
      // 优雅关闭:SIGTERM → 宽限期 → SIGKILL → 确认退出。幂等。
      // 轮 40-w4-t3 HIGH:旧实现 SIGKILL 后无确认超时 —— D-state/平台异常下
      // close 事件不来, await close() 永久挂住, 上层取消流程无法收口。这里
      // 对齐 session-registry 的 waitForExit 语义:超时后仍 resolve(保 close()
      // 的 Promise<void> 契约, PiRpcProcess.close 不 catch —— reject 会冒泡成
      // 未处理错误), 残留子进程由进程管理器兜底, 日志告警可查。
      let survived = false;
      await new Promise<void>((resolve) => {
        let done = false;
        let confirmTimer: NodeJS.Timeout | undefined;
        const finish = (): void => {
          if (done) return;
          done = true;
          clearTimeout(killTimer);
          if (confirmTimer) clearTimeout(confirmTimer);
          child.removeListener('close', onClose);
          resolve();
        };
        const onClose = (): void => finish();
        const killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          // SIGKILL 后再给确认窗口;超时仍 resolve(尽力而为, 不挂死)。
          confirmTimer = setTimeout(() => {
            survived = true;
            logger.error('pi process did not confirm exit after SIGKILL — transport close resolves anyway', {
              pid: child.pid,
            });
            finish();
          }, KILL_CONFIRM_MS);
          confirmTimer.unref?.();
        }, KILL_GRACE_MS);
        killTimer.unref?.();
        child.once('close', onClose);
        try {
          child.kill('SIGTERM');
        } catch {
          finish();
        }
      });
      // 子进程 close 事件若已 fireClose 则 closed=true(通知已发);否则这里补
      // 发一次(主动 close 语义:onClose 必须收到终止通知)。
      // 轮 40-w4-t14 HIGH:未确认退出的 survived 状态经 close 通知暴露给上层
      // (reason 带标记), 调用方/进程管理器可据此走更强回收路径, 不再当作
      // 已正常关闭。
      fireClose({
        code: null,
        signal: null,
        reason: survived ? `pi process survived SIGKILL — close() resolved without confirmed exit` : reason,
      });
    },

    get pid(): number | undefined {
      return child.pid ?? undefined;
    },

    isClosed(): boolean {
      // closing 期间也算关闭:close() 已开始, 不应再接受新写入(轮 40-w1 M-2)。
      return closed || closing;
    },

    get remoteBinaryPath(): undefined {
      return undefined;
    },
  };
}

/**
 * 协议合规的 JSONL 读取:只按 \n 切,strip 尾部 \r,跨 chunk 维护缓冲。
 * (pi docs/rpc.md 明确警告 Node readline 不合规。)
 *
 * 轮 21 H-3:缓冲无界增长防护 —— 损坏/恶意 pi 进程持续输出无 \n 的字节流时
 * buffer 无限累积会 OOM 整个进程。超过上限丢弃缓冲并告警(单条 JSONL 帧
 * 远超任何合法负载;pi 协议帧都是小 JSON)。
 */
const MAX_JSONL_BUFFER_CHARS = 16 * 1024 * 1024;

export function attachJsonlReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): void {
  let decoder = new StringDecoder('utf8');
  let buffer = '';

  stream.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    // OOM 守卫:超限丢弃缓冲(与 pi-manager 的 NDJSONDecoder 同策略)。
    // 轮 40-w4-t9 HIGH:丢弃时**必须重建 StringDecoder** —— 否则被丢帧末尾
    // 残留的半个多字节字符会留在 decoder 内, 污染后续合法帧(JSONL 内容
    // 损坏或解析失败)。
    if (buffer.length > MAX_JSONL_BUFFER_CHARS) {
      console.warn(
        `[pi] JSONL line buffer exceeded ${MAX_JSONL_BUFFER_CHARS} chars without newline — discarding (corrupt stream?)`,
      );
      buffer = '';
      decoder = new StringDecoder('utf8');
      return;
    }
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

  // 轮 21 M-1:未处理 'error' 事件会让 Readable 抛未捕获异常崩进程 —— 传输层
  // 错误由 child.on('error') 统一处理, 这里仅阻止任意 stream 上的裸崩溃。
  stream.on('error', () => {
    /* 传输层错误由上层(child 'error' / close)处理 */
  });
}
