/**
 * PrimeAgentTransport — Prime Agent `--mode rpc` JSONL 字节流的双向 transport 抽象。
 *
 * 设计动机(与 pi / codex app-server transport 同构):
 *   `PrimeAgentRpcProcess` 协议层只跟「一行行 JSON」打交道, 跟字节流从哪来无关。把字节流
 *   抽象到这个 interface 后, 同一份 client 能同时驱动:
 *     - StdioTransport: 本地 spawn `prime-agent --mode rpc`, 接 stdin/stdout
 *     - 远端 transport (host 侧): 经 `RemoteHost.execStream` 桥接的字节流
 *   两种 transport 对 client 表现完全一致 (writeLine + onLine + onClose)。
 *
 * 协议无关性:
 *   transport 只搬字节流, 不解析 JSON, 不做 framing 之外的握手。JSONL 分帧 (LF-only) 由
 *   本文件的 attachJsonlReader 负责。
 *
 * 错误模型:
 *   - writeLine() reject = "这一行没写出去" (caller 自行决定怎么处理)
 *   - onClose = 已确认进程退出
 *   - onDisconnect = RPC 管道失联但进程退出未确认, 不能提前清理 runtime
 *   - RPC 失联后仍须 close() 确认终止; 不靠静默时长推断管道失联
 *
 * 生命周期语义 —— Prime Agent 与 pi 的**关键差异**:
 *   Prime Agent 的 RPC 模式把「stdin 关闭」定义为优雅退出路径: `serve_stdin` 读到 EOF 后
 *   会 settle 在飞的 turn、dispose kernel、drain 已排队帧, 然后 exit 0
 *   (crates/pa-daemon/src/rpc/mod.rs:220-268)。而 Windows 上控制台子系统进程收不到
 *   SIGTERM/SIGHUP, `spawn_signal_handlers` 在 `#[cfg(not(unix))]` 下是空实现
 *   (crates/pa-daemon/src/rpc/mod.rs:117-119) —— 所以**不能**照搬 pi 那套
 *   「SIGTERM → 宽限期 → SIGKILL」的顺序, 否则 Windows 上永远等不到信号退出。
 *   这里的 close() 顺序因此是: 先 end stdin 让对端自行 settle → 宽限期 → SIGKILL。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import type { Logger } from '../../interfaces/logger.js';

/** transport 关闭信息: 对端进程退出码 / 信号 + 人类可读原因。 */
export interface PrimeAgentTransportCloseInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  reason: string;
}

export type PrimeAgentLineHandler = (line: string) => void;
export type PrimeAgentCloseHandler = (info: PrimeAgentTransportCloseInfo) => void;
export type PrimeAgentOversizedFrameHandler = () => void;
export type PrimeAgentDisconnectReason =
  | 'stdout-ended'
  | 'stdout-closed'
  | 'stdout-error'
  | 'stdin-error';

/**
 * 双向 transport。一个实例只服务一个 PrimeAgentRpcProcess (1:1)。
 */
export interface PrimeAgentTransport {
  /** 把一行 JSONL (不含尾部 \n) 写到对端。reject = "这一行没写出去"。 */
  writeLine(line: string): Promise<void>;

  /** 注册逐行 JSONL 回调 (fan-out), 返回 unsubscribe。 */
  onLine(handler: PrimeAgentLineHandler): () => void;

  /** (可选) 注册 stderr / 诊断行 handler。 */
  onStderr?(handler: (line: string) => void): () => void;

  /** 注册关闭回调。触发后此 transport 不再可用, writeLine 一律 reject。 */
  onClose(handler: PrimeAgentCloseHandler): () => void;

  /** RPC pipes are unusable; this is NOT proof that the executor exited. */
  onDisconnect?(handler: (reason: PrimeAgentDisconnectReason) => void): () => void;

  /**
   * (可选) 丢掉超限 JSONL 帧时通知协议层。超限帧可能是合法响应, transport 必须保持存活,
   * 但对应 pending RPC 不能再空等超时。
   */
  onOversizedFrame?(handler: PrimeAgentOversizedFrameHandler): () => void;

  /** 主动关闭。幂等; resolve 后内部资源已释放。 */
  close(reason?: string): Promise<void>;

  /** 本地进程 pid (远端场景无意义, undefined)。 */
  readonly pid: number | undefined;

  /** RPC 已不可用 (进程退出 / 管道失联 / close() 之后)。 */
  isClosed(): boolean;
}

export interface PrimeAgentStdioTransportOptions {
  binaryPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  logger: Logger;
  /** 本地进程生命周期观察器; 返回值在该 spawn 的 error/close 时幂等调用。 */
  onProcessSpawned?: (pid: number) => void | (() => void);
  /**
   * close() 里 end(stdin) 之后等待对端自行 settle 退出的宽限期。
   * Prime Agent 的优雅退出要等 turn settle + 帧 drain, 默认给足 5s。
   */
  stdinCloseGraceMs?: number;
}

const DEFAULT_STDIN_CLOSE_GRACE_MS = 5_000;
/** SIGKILL 后确认退出的窗口。 */
const KILL_CONFIRM_MS = 5_000;

/**
 * 本地 stdio transport: spawn `prime-agent --mode rpc`, 双向接 stdin/stdout/stderr。
 */
export function createPrimeAgentStdioTransport(
  opts: PrimeAgentStdioTransportOptions,
): PrimeAgentTransport {
  const child: ChildProcessWithoutNullStreams = spawn(opts.binaryPath, opts.args, {
    cwd: opts.cwd,
    env: opts.env as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    // 与仓库内其它 agent 子进程 spawn 保持一致: Windows 上不隐藏窗口会为每个
    // 本机会话派生一个 conhost.exe。
    windowsHide: true,
  });
  const logger = opts.logger;

  let closed = false;
  let disconnected: PrimeAgentDisconnectReason | undefined;
  let disconnectNotified = false;
  let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  // First close permanently fences writes. Individual termination attempts are
  // shared while in flight, then cleared after failure so a later owner can run
  // a fresh sequence.
  let closing = false;
  let closeAttempt: Promise<void> | null = null;
  let exitInfo: PrimeAgentTransportCloseInfo | null = null;
  let exitDrainTimer: ReturnType<typeof setTimeout> | undefined;
  let disposeProcessRegistration: (() => void) | undefined;
  if (child.pid != null && child.pid > 0) {
    try {
      const dispose = opts.onProcessSpawned?.(child.pid);
      if (typeof dispose === 'function') disposeProcessRegistration = dispose;
    } catch {
      // Observation failures must not block startup. The process simply remains
      // non-terminable in the resource usage panel.
    }
  }

  const lineHandlers = new Set<PrimeAgentLineHandler>();
  const oversizedHandlers = new Set<PrimeAgentOversizedFrameHandler>();
  const closeHandlers = new Set<PrimeAgentCloseHandler>();
  const disconnectHandlers = new Set<(reason: PrimeAgentDisconnectReason) => void>();
  const stderrHandlers = new Set<(line: string) => void>();
  const stderrBuffer: string[] = [];

  const disposeRegistration = (): void => {
    const dispose = disposeProcessRegistration;
    disposeProcessRegistration = undefined;
    try {
      dispose?.();
    } catch {
      /* best-effort diagnostic cleanup */
    }
  };

  const fireClose = (info: PrimeAgentTransportCloseInfo): void => {
    if (closed) return;
    closed = true;
    if (exitDrainTimer) clearTimeout(exitDrainTimer);
    exitDrainTimer = undefined;
    if (disconnectTimer) clearTimeout(disconnectTimer);
    disconnectTimer = undefined;
    disposeRegistration();
    for (const handler of closeHandlers) {
      try {
        handler(info);
      } catch {
        /* handler should not throw */
      }
    }
  };

  // stderr 行缓冲: handler 在进程已开始吐 stderr 之后才注册(常见于
  // PrimeAgentRpcProcess 构造后由 caller 补挂), 缓冲到首个 handler 挂上再 drain,
  // 保证不丢诊断。
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
    return () => {
      stderrHandlers.delete(handler);
    };
  };

  // Fence writes before the JSONL reader's EOF flush invokes tail callbacks.
  // Keep reads open through the confirmation window so settled/results survive;
  // only confirmed executor exit/close may release the process lease.
  const disconnect = (reason: PrimeAgentDisconnectReason): void => {
    if (closed || closing || exitInfo || disconnected) return;
    disconnected = reason;
    // A normal process exit often closes stdout before Node emits `exit`.
    // Fence writes now, but allow a bounded confirmation window so startup
    // failures retain their exit code and drained stderr instead of becoming
    // an unconfirmed RPC-loss error. This is not a long-tool timeout.
    disconnectTimer = setTimeout(() => {
      disconnectTimer = undefined;
      if (closed || closing || exitInfo) return;
      disconnectNotified = true;
      for (const handler of disconnectHandlers) {
        try {
          handler(reason);
        } catch {
          /* owner handles its own cleanup */
        }
      }
    }, 250);
    disconnectTimer.unref?.();
  };
  child.stdout.on('end', () => disconnect('stdout-ended'));
  child.stdout.on('close', () => disconnect('stdout-closed'));
  child.stdout.on('error', () => disconnect('stdout-error'));
  child.stdin.on('error', () => disconnect('stdin-error'));

  attachJsonlReader(child.stdout, (line) => {
    // A broken stdin fences new commands immediately, but stdout can still
    // carry already-written results/settled during the confirmation window.
    // Freeze reads only once loss is reported (or executor close is final).
    if (closed || disconnectNotified) return;
    for (const handler of lineHandlers) handler(line);
  }, () => {
    if (closed || disconnectNotified) return;
    for (const handler of oversizedHandlers) handler();
  });
  attachJsonlReader(child.stderr, (line) => {
    if (line.trim().length === 0) return;
    // 本地 stderr 进日志前做凭证脱敏 —— spawnEnv 可能含真值, 子进程崩溃 dump
    // 可能把它们打到 stderr。
    const redacted = redactSensitiveText(line);
    logger.warn('prime-agent stderr', { line: redacted.slice(0, 2000) });
    fireStderr(redacted);
  });

  child.on('error', (err) => {
    logger.error('prime-agent process error', { message: err.message });
    // kill() may synchronously emit error (e.g. EPERM). An error while
    // terminating is not exit evidence: retain registration and the attempt's
    // escalation/confirmation timers until exit or close actually arrives.
    if (closing) return;
    fireClose({ code: null, signal: null, reason: `prime-agent process error: ${err.message}` });
  });
  child.on('close', (code, signal) => {
    fireClose({
      code,
      signal,
      reason: `prime-agent process exited (code=${code}, signal=${signal})`,
    });
  });
  child.on('exit', (code, signal) => {
    // A shell/build descendant can inherit the pipes after Prime Agent itself
    // exits. Node's `close` then waits for that descendant, potentially
    // indefinitely. Exit is authoritative executor loss, but allow
    // already-written RPC tail frames to drain before notifying owners. This is
    // NOT a tool timeout: a quiet, live process never enters this path.
    closing = true;
    const info = {
      code,
      signal,
      reason: `prime-agent process exited (code=${code}, signal=${signal})`,
    };
    exitInfo = info;
    if (closed) return;
    exitDrainTimer = setTimeout(() => {
      fireClose(info);
      // Release only our pipe endpoints after the confirmed executor exit.
      // No process-tree kill or automatic command replay is performed.
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
    }, 250);
    exitDrainTimer.unref?.();
  });

  const runCloseAttempt = async (reason: string): Promise<void> => {
    // Every fresh attempt gets its own timers and close listener. A previous
    // unconfirmed SIGKILL does not prove the process exited, so retries must
    // send the signals again instead of replaying a cached error.
    let survived = false;
    await new Promise<void>((resolve) => {
      let done = false;
      let confirmTimer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (done) return;
        done = true;
        if (confirmTimer) clearTimeout(confirmTimer);
        child.removeListener('close', onClose);
        closeHandlers.delete(onConfirmedExit);
        resolve();
      };
      const onClose = (): void => finish();
      const onConfirmedExit = (): void => {
        if (exitInfo) finish();
      };
      const graceMs = opts.stdinCloseGraceMs ?? DEFAULT_STDIN_CLOSE_GRACE_MS;
      const killTimer = exitInfo
        ? undefined
        : setTimeout(() => {
          if (exitInfo) return; // Confirmed exit is still draining its tail frames.
          // Prime Agent 只在 unix 上注册 SIGTERM/SIGHUP; Windows 上 stdin EOF 是
          // 唯一的优雅退出路径, 已由 end(stdin) 触发。这里仍然补一发 SIGTERM
          // (unix 语义), 然后升级 SIGKILL。
          try {
            child.kill('SIGTERM');
          } catch {
            /* a thrown kill failure is not proof of exit either */
          }
          if (done) return;
          confirmTimer = setTimeout(() => {
            if (exitInfo) return;
            try {
              child.kill('SIGKILL');
            } catch {
              /* still require exit confirmation */
            }
            confirmTimer = setTimeout(() => {
              if (exitInfo) return;
              survived = true;
              logger.error('prime-agent process did not confirm exit after SIGKILL', {
                pid: child.pid,
              });
              finish();
            }, KILL_CONFIRM_MS);
            confirmTimer.unref?.();
          }, 1_000);
          confirmTimer.unref?.();
        }, graceMs);
      killTimer?.unref?.();
      // The same close notification also completes an explicit close racing an
      // exit whose inherited pipes have not reached EOF yet.
      closeHandlers.add(onConfirmedExit);
      child.once('close', onClose);
      if (exitInfo) return;
      // The graceful path FIRST: Prime Agent settles the running turn, drains
      // its queued frames and exits 0 when stdin reaches EOF
      // (crates/pa-daemon/src/rpc/mod.rs:220-268). Ending stdin here is what
      // makes that path run; signals alone would not on Windows.
      try {
        child.stdin.end();
      } catch {
        /* already destroyed */
      }
    });

    if (survived) {
      // Do not fire onClose: its contract is confirmed process termination.
      // A late real close remains authoritative through the global listener.
      throw new Error('prime-agent process did not confirm exit after SIGKILL');
    }
    fireClose({
      code: null,
      signal: null,
      reason,
    });
  };

  return {
    writeLine(line: string): Promise<void> {
      if (closed || closing || disconnected) {
        return Promise.reject(new Error('prime-agent transport already closed'));
      }
      return new Promise<void>((resolve, reject) => {
        child.stdin.write(line + '\n', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },

    onLine(handler: PrimeAgentLineHandler): () => void {
      lineHandlers.add(handler);
      return () => {
        lineHandlers.delete(handler);
      };
    },

    onStderr(handler): () => void {
      return armStderr(handler);
    },

    onClose(handler: PrimeAgentCloseHandler): () => void {
      closeHandlers.add(handler);
      return () => {
        closeHandlers.delete(handler);
      };
    },

    onDisconnect(handler): () => void {
      disconnectHandlers.add(handler);
      if (disconnectNotified && disconnected) handler(disconnected);
      return () => {
        disconnectHandlers.delete(handler);
      };
    },

    onOversizedFrame(handler): () => void {
      oversizedHandlers.add(handler);
      return () => {
        oversizedHandlers.delete(handler);
      };
    },

    close(reason = 'prime-agent transport close()'): Promise<void> {
      if (closed) return Promise.resolve();
      if (closeAttempt) return closeAttempt;

      // Keep the write fence after a failed attempt: the process may still be
      // alive, but it must never resume protocol traffic while owners retry
      // termination through Session/PrimeAgent/Maker cleanup paths.
      closing = true;
      const attempt = runCloseAttempt(reason);
      closeAttempt = attempt;
      void attempt.then(
        () => {
          if (closeAttempt === attempt) closeAttempt = null;
        },
        () => {
          if (closeAttempt === attempt) closeAttempt = null;
        },
      );
      return attempt;
    },

    get pid(): number | undefined {
      return child.pid ?? undefined;
    },

    isClosed(): boolean {
      // Unavailable RPC does not imply confirmed executor termination. close()
      // still retries termination until the process exit is observed.
      return closed || closing || disconnected !== undefined;
    },
  };
}

/**
 * 协议合规的 JSONL 读取: 只按 \n 切, strip 尾部 \r, 跨 chunk 维护缓冲。
 * **不能用 Node `readline`** —— 它会按 U+2028/U+2029 切行, 而这些字符在 JSON
 * 字符串里合法; Prime Agent 的帧也严格 LF-only
 * (crates/pa-daemon/src/rpc/mod.rs:66-70 `LineWriter::write` 只 push '\n')。
 *
 * 缓冲无界增长防护: 损坏/恶意子进程持续输出无 \n 的字节流时 buffer 无限累积会
 * OOM 整个进程。超过上限必须丢掉**当前这一行**并告警, 且必须继续丢到下一个 \n
 * 再恢复分帧 —— 不能把行边界重置成「从此开始是新帧」, 否则同一行的残余会被当成
 * 下一行 JSON。
 */
export const MAX_JSONL_BUFFER_CHARS = 16 * 1024 * 1024;

export function attachJsonlReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  onOversizedFrame?: () => void,
): void {
  let decoder = new StringDecoder('utf8');
  let buffer = '';
  let skippingOversizedLine = false;

  const resetDecoder = (): void => {
    // 丢弃时必须重建 StringDecoder —— 否则被丢帧末尾残留的半个多字节字符会留在
    // decoder 内, 污染后续合法帧。
    decoder = new StringDecoder('utf8');
  };

  const dropThroughNewline = (): boolean => {
    const newlineIndex = buffer.indexOf('\n');
    if (newlineIndex === -1) {
      buffer = '';
      resetDecoder();
      return false;
    }
    buffer = buffer.slice(newlineIndex + 1);
    skippingOversizedLine = false;
    return true;
  };

  const emitCompleteLines = (): void => {
    while (true) {
      if (skippingOversizedLine) {
        if (!dropThroughNewline()) return;
        continue;
      }
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        if (buffer.length > MAX_JSONL_BUFFER_CHARS) {
          console.warn(
            `[prime-agent] JSONL line buffer exceeded ${MAX_JSONL_BUFFER_CHARS} chars without newline — discarding until next newline`,
          );
          skippingOversizedLine = true;
          onOversizedFrame?.();
          dropThroughNewline();
        }
        return;
      }
      if (newlineIndex > MAX_JSONL_BUFFER_CHARS) {
        console.warn(
          `[prime-agent] JSONL line exceeded ${MAX_JSONL_BUFFER_CHARS} chars — discarding oversized frame`,
        );
        onOversizedFrame?.();
        buffer = buffer.slice(newlineIndex + 1);
        continue;
      }
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      onLine(line);
    }
  };

  stream.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    emitCompleteLines();
  });

  stream.on('end', () => {
    buffer += decoder.end();
    emitCompleteLines();
    if (!skippingOversizedLine && buffer.length > 0 && buffer.length <= MAX_JSONL_BUFFER_CHARS) {
      onLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
    }
  });

  // 未处理 'error' 事件会让 Readable 抛未捕获异常崩进程 —— 传输层错误由
  // child.on('error') 统一处理, 这里仅阻止任意 stream 上的裸崩溃。
  stream.on('error', () => {
    /* 传输层错误由上层(child 'error' / close)处理 */
  });
}
