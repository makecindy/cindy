/**
 * StdioTransport — 本地 spawn `codex app-server`, 接 stdin/stdout NDJSON 流。
 *
 * Lifecycle:
 *   - 构造时同步 spawn 子进程 (跟原版 spawnProcess 一致)
 *   - readline on('line') → fan-out 给 onLine handlers
 *   - stderr → 整行 normalize 后 fan-out 给 onStderr handlers
 *   - child.on('exit') 或我们调 close() → 触发 onClose, 之后 writeLine 都 reject
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type {
  CloseHandler,
  LineHandler,
  StderrHandler,
  Transport,
} from './transport.js';

export interface StdioTransportOptions {
  /** `codex` 可执行文件的绝对路径 (host 已 provisioned)。 */
  binaryPath: string;
  /** 子进程 cwd; 不传则继承父进程 cwd。 */
  cwd?: string;
  /** 子进程 env (host 用 env-builder 拼好的, 已含 PATH / CODEX_HOME / OAuth)。 */
  env?: NodeJS.ProcessEnv;
  /** `app-server` 子命令之前/之后的额外参数 (一般用于注入 `-c` overrides)。 */
  extraArgs?: string[];
  /** 本地进程生命周期观察器；仅用于宿主诊断，不得影响 transport 启动。 */
  onProcessSpawned?: (pid: number) => void | (() => void);
  /** stdin EOF 后等待正常保存和退出的时间；仅测试注入。 */
  gracefulCloseMs?: number;
  /** SIGTERM 后强杀宽限毫秒数;仅测试注入,生产走默认值。 */
  forceKillGraceMs?: number;
  /** SIGKILL 后确认退出的时间；仅测试注入。 */
  killConfirmationMs?: number;
}

// 合计 3s，给 Desktop 6s 退出预算中的其它收尾留出时间。
const GRACEFUL_CLOSE_MS = 1_500;
const FORCE_KILL_GRACE_MS = 1_000;
const KILL_CONFIRMATION_MS = 500;

export function createStdioTransport(opts: StdioTransportOptions): Transport {
  if (!opts.binaryPath) {
    throw new Error('createStdioTransport: binaryPath is required');
  }

  const lineHandlers = new Set<LineHandler>();
  const stderrHandlers = new Set<StderrHandler>();
  const closeHandlers = new Set<CloseHandler>();
  /**
   * Lines arrive at readline 'line' event whether anyone listens or not. Buffer
   * them until the FIRST onLine subscriber registers, then drain in order. After
   * drain, subsequent lines fan out immediately. Solves the "factory returns sync
   * but client.start() races with first chunk of stdout" timing.
   */
  const lineBuffer: string[] = [];
  let lineHandlerArmed = false;
  let closed = false;
  let closePromise: Promise<void> | null = null;
  let exited = false;
  let resolveExit!: () => void;
  const exitPromise = new Promise<void>((resolve) => { resolveExit = resolve; });

  const args = ['app-server', ...(opts.extraArgs ?? [])];
  const child: ChildProcessWithoutNullStreams = spawn(opts.binaryPath, args, {
    cwd: opts.cwd,
    env: opts.env,
    // 三路全 pipe: stdin 我们写, stdout 我们读, stderr 走 onStderr (诊断用)。
    stdio: ['pipe', 'pipe', 'pipe'],
    // Windows: 不开 shell, 直接走 binary; 走 shell 会带来 env injection 风险
    // 且 stdio piping 行为不可控。
    shell: false,
    // Windows 上 app-server 及其控制台句柄不应打断桌面端 UI。
    windowsHide: true,
    // 不创建独立进程组；close() 仍必须显式等待并确认子进程退出。
    detached: false,
  });
  let disposeProcessRegistration: (() => void) | undefined;
  if (child.pid != null && child.pid > 0) {
    try {
      const dispose = opts.onProcessSpawned?.(child.pid);
      if (typeof dispose === 'function') disposeProcessRegistration = dispose;
    } catch {
      // 诊断观察器失败不能阻断 app-server；进程归属仍由既有扫描安全边界判断。
    }
  }

  // stdout NDJSON 增量解析: readline 处理 \r\n / \n / EOF, 单行触发 callback。
  child.stdout.setEncoding('utf8');
  const rl: Interface = createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });
  rl.on('line', (line) => {
    // 关闭协议后继续排空 stdout，避免退出收尾写满 pipe。
    if (closed) return;
    if (!lineHandlerArmed) {
      lineBuffer.push(line);
      return;
    }
    for (const cb of lineHandlers) cb(line);
  });

  // stderr 当诊断信息流, 不参与协议。按行 fan-out, client 层做 ANSI 剥除/分级。
  child.stderr.setEncoding('utf8');
  let stderrBuffer = '';
  child.stderr.on('data', (chunk: string) => {
    stderrBuffer += chunk;
    const idx = stderrBuffer.lastIndexOf('\n');
    if (idx === -1) return;
    const lines = stderrBuffer.slice(0, idx).split('\n');
    stderrBuffer = stderrBuffer.slice(idx + 1);
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, '');
      if (!trimmed) continue;
      for (const cb of stderrHandlers) cb(trimmed);
    }
  });

  const fireClose = (reason: string): void => {
    if (closed) return;
    closed = true;
    lineBuffer.length = 0;
    for (const cb of closeHandlers) {
      try { cb({ reason }); } catch { /* handler should not throw */ }
    }
  };

  const finishProcess = (reason: string): void => {
    if (exited) return;
    exited = true;
    try { rl.close(); } catch { /* already closed */ }
    try { disposeProcessRegistration?.(); } catch { /* best-effort diagnostic cleanup */ }
    disposeProcessRegistration = undefined;
    resolveExit();
    fireClose(reason);
  };

  child.on('error', (err) => {
    const reason = `child error: ${err.message}`;
    // spawn 失败没有进程；运行中的 error（例如 kill 失败）不是退出证据。
    if (child.pid == null) finishProcess(reason);
    else fireClose(reason);
  });
  child.stdin.on('error', (err) => fireClose(`child stdin error: ${err.message}`));
  child.on('exit', (code, signal) => {
    const reason = signal ? `signal=${signal}` : `exit code=${code ?? 'null'}`;
    finishProcess(`child exited (${reason})`);
  });

  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    if (exited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exitPromise,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
      return exited;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return {
    writeLine(line: string): Promise<void> {
      if (closed || !child.stdin.writable) {
        return Promise.reject(new Error('StdioTransport.writeLine after close'));
      }
      return new Promise<void>((resolve, reject) => {
        const ok = child.stdin.write(line + '\n', 'utf8', (err) => {
          if (err) reject(err);
          else resolve();
        });
        if (!ok) {
          // backpressure: stdin 内核 buffer 满, 下次 'drain' 自动恢复。
          // Codex 协议消息体积/频率都小, 这里不主动 throttle。
        }
      });
    },

    onLine(handler: LineHandler): () => void {
      lineHandlers.add(handler);
      // First subscriber: drain buffered lines (received between spawn and first
      // onLine). Done sync within the same microtask so handler sees full order.
      if (!lineHandlerArmed) {
        lineHandlerArmed = true;
        if (lineBuffer.length > 0) {
          const drained = lineBuffer.splice(0);
          for (const line of drained) {
            for (const cb of lineHandlers) cb(line);
          }
        }
      }
      return () => { lineHandlers.delete(handler); };
    },

    onStderr(handler: StderrHandler): () => void {
      stderrHandlers.add(handler);
      return () => { stderrHandlers.delete(handler); };
    },

    onClose(handler: CloseHandler): () => void {
      closeHandlers.add(handler);
      return () => { closeHandlers.delete(handler); };
    },

    close(reason = 'StdioTransport.close()'): Promise<void> {
      // 首次严格关闭可以超时；迟到的真实 exit 使后续幂等检查成功。
      if (exited) return exitPromise;
      if (!closePromise) {
        // 先发布 Promise，再调用可能同步重入 close() 的监听器。
        closePromise = Promise.resolve().then(async () => {
          if (exited) return;
          // EOF 让 app-server 中止在飞 turn 并保存历史；不能紧跟 SIGTERM。
          try { child.stdin.end(); } catch { /* signal fallback below */ }
          if (await waitForExit(opts.gracefulCloseMs ?? GRACEFUL_CLOSE_MS)) return;
          try { child.kill('SIGTERM'); } catch { /* still confirm exit */ }
          if (await waitForExit(opts.forceKillGraceMs ?? FORCE_KILL_GRACE_MS)) return;
          // #3699: 卡死进程仍需强杀，且不能在确认退出前释放 Host。
          try { child.kill('SIGKILL'); } catch { /* still confirm exit */ }
          if (await waitForExit(opts.killConfirmationMs ?? KILL_CONFIRMATION_MS)) return;
          throw new Error('Codex app-server did not exit after SIGKILL');
        });
        fireClose(reason);
      }
      return closePromise;
    },
  };
}
