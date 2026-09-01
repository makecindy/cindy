/**
 * StdioTransport — 本地 spawn `codex app-server`, 接 stdin/stdout NDJSON 流。
 *
 * 历史行为搬迁: 这文件里的 spawn/readline/stderr/exit/kill 逻辑跟原本
 * AppServerClient.spawnProcess + close 一字不差, 只是从 client 内部搬到了
 * transport 层。purpose: 让 client 只关心 NDJSON 流, transport 切换无感。
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
  /** SIGTERM 后强杀宽限毫秒数;仅测试注入,生产走默认值。 */
  forceKillGraceMs?: number;
}

/**
 * close() 发出 SIGTERM 后等待进程自行退出的宽限期。健康的 app-server 在毫秒级
 * 退出;卡死的(见 close() 内注释)永远不退,5s 已足够区分两者且不拖慢关闭方
 * (close() 本身不等待,timer 在后台收尸)。
 */
const FORCE_KILL_GRACE_MS = 5_000;

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
    // Linux/macOS: 跟父进程同 process group, 父进程退出时一并被收割。
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
    try { rl.close(); } catch { /* already closed */ }
    try { disposeProcessRegistration?.(); } catch { /* best-effort diagnostic cleanup */ }
    disposeProcessRegistration = undefined;
    for (const cb of closeHandlers) {
      try { cb({ reason }); } catch { /* handler should not throw */ }
    }
  };

  child.on('error', (err) => {
    fireClose(`child error: ${err.message}`);
  });
  child.on('exit', (code, signal) => {
    const reason = signal ? `signal=${signal}` : `exit code=${code ?? 'null'}`;
    fireClose(`child exited (${reason})`);
  });

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

    async close(reason = 'StdioTransport.close()'): Promise<void> {
      if (closed) return;
      // 优雅关: 先 stdin EOF (Rust app-server 看到会自己退), 再 SIGTERM 兜底。
      try { child.stdin.end(); } catch { /* swallow */ }
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGTERM'); } catch { /* swallow */ }
        // #3699: SIGTERM 只对健康的 app-server 有效。当它的主循环卡死(实测
        // 场景:内部模型刷新子进程 wedged,manager 反复报 "timeout waiting for
        // child process to exit")时,进程可能既不响应 stdin EOF 也不处理
        // SIGTERM —— 而调用方(retireHostKey / 切换凭证 / 关闭会话)在 close()
        // 后即视其为已弃用,不再持有引用。此前没有任何强杀兜底,弃用的
        // app-server 会以活体泄漏:继续周期性模型刷新、打错误日志、占用
        // 网络与文件句柄。宽限期后仍未退出则 SIGKILL 收尸;timer unref,
        // 不阻塞父进程退出(父进程退出时同进程组的子进程本就会被收割)。
        const killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try { child.kill('SIGKILL'); } catch { /* swallow */ }
          }
        }, opts.forceKillGraceMs ?? FORCE_KILL_GRACE_MS);
        killTimer.unref?.();
        child.once('exit', () => clearTimeout(killTimer));
      }
      fireClose(reason);
    },
  };
}
