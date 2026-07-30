/**
 * command-concurrency-gate —— agent Bash 命令的全局并发闸门(跨 session 共享)。
 *
 * 背景: Claude 会话是每 session 一个独立子进程,命令由 agent 自己 spawn,Cindy
 * 不接管执行——所以"并发上限"只能做成启动前的放行闸:PreToolUse hook 在这里
 * acquire,满员则挂起排队;命令结束(成功/失败/被拒)后 release 唤醒队首。
 *
 * 设计不变量 —— fail-open 是唯一的失败方向,任何路径都不允许把命令永久卡死:
 *  - 排队超时 → 超额放行(over-admit)并记 warn 日志;
 *  - acquire 时 signal 已中止 / 等待中被中止(用户打断 turn)→ 立即返回、不占槽;
 *  - 释放事件丢失(进程被杀、hook 没触发)→ TTL 兜底回收 + SessionEnd 清扫;
 *  - limit 每次准入判断现读,设置热更即刻生效;limit <= 0 = 不限,但在途命令
 *    仍登记 running,保证中途调低 limit 时计数不失真;
 *  - 队列非空期间跑一个轻量 repump 轮询(默认 1s,队列清空即停):设置 store 没有
 *    变更事件,limit 被调高(或改为不限)后等待者最迟一个轮询周期内被唤醒,
 *    不必干等下一次 acquire/release 或 120s fail-open。
 *
 * 释放语义: release 按 toolUseId 幂等,多事件重复释放(PostToolUse 与
 * PermissionDenied 先后到达等)只生效一次。
 */

export interface CommandGateLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  debug?(message: string, meta?: Record<string, unknown>): void;
}

export type CommandGateAdmission =
  /** 有空槽,直接放行 */
  | 'immediate'
  /** 排过队,等到空槽后放行 */
  | 'queued'
  /** 排队超时,fail-open 超额放行 */
  | 'wait-timeout'
  /** 等待期间被中止(用户打断/hook 超时),未占槽,调用方直接放行 */
  | 'aborted';

export interface CommandConcurrencyGate {
  /** 申请一个执行槽;resolve 即代表"可以开始执行"。永不 reject。 */
  acquire(args: {
    toolUseId: string;
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<CommandGateAdmission>;
  /** 释放 toolUseId 对应的槽(幂等);也会移除同 id 的排队等待。 */
  release(toolUseId: string, reason: string): void;
  /** 会话结束时清扫其全部在途槽位与排队项。 */
  releaseSession(sessionId: string, reason: string): void;
  /** 观测用快照。 */
  snapshot(): { running: number; queued: number };
}

export interface CommandConcurrencyGateOptions {
  /** 每次准入判断现读的并发上限;<= 0 = 不限。 */
  readMaxConcurrent: () => number;
  log: CommandGateLogger;
  /** 排队最长等待,超时 fail-open 放行。默认 120s。 */
  queueWaitMaxMs?: number;
  /** running 记录的 TTL,兜底回收释放事件丢失的槽。默认 30min。 */
  runningTtlMs?: number;
  /** 队列非空期间的 repump 轮询间隔(响应 limit 热更调高)。默认 1s。 */
  repumpIntervalMs?: number;
  now?: () => number;
}

const DEFAULT_QUEUE_WAIT_MAX_MS = 120_000;
const DEFAULT_RUNNING_TTL_MS = 30 * 60_000;
const DEFAULT_REPUMP_INTERVAL_MS = 1_000;

interface RunningEntry {
  sessionId: string;
  admittedAt: number;
}

interface Waiter {
  toolUseId: string;
  sessionId: string;
  resolve: (admission: CommandGateAdmission) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export function createCommandConcurrencyGate(
  options: CommandConcurrencyGateOptions,
): CommandConcurrencyGate {
  const log = options.log;
  const now = options.now ?? Date.now;
  const queueWaitMaxMs = options.queueWaitMaxMs ?? DEFAULT_QUEUE_WAIT_MAX_MS;
  const runningTtlMs = options.runningTtlMs ?? DEFAULT_RUNNING_TTL_MS;
  const repumpIntervalMs = options.repumpIntervalMs ?? DEFAULT_REPUMP_INTERVAL_MS;

  const running = new Map<string, RunningEntry>();
  const queue: Waiter[] = [];
  /**
   * 队列非空期间的 repump 轮询:设置 store 没有变更事件,limit 被调高后必须有人
   * 主动再跑 pump,否则等待者只能干等下一次 acquire/release 或 fail-open 超时
   * (bot review P1)。队列清空即自停,空闲零成本。
   */
  let repumpTimer: ReturnType<typeof setInterval> | null = null;

  function ensureRepumpTimer(): void {
    if (repumpTimer !== null || queue.length === 0) return;
    repumpTimer = setInterval(() => {
      pump();
      if (queue.length === 0 && repumpTimer !== null) {
        clearInterval(repumpTimer);
        repumpTimer = null;
      }
    }, repumpIntervalMs);
    (repumpTimer as { unref?: () => void }).unref?.();
  }

  function readLimit(): number {
    try {
      const limit = options.readMaxConcurrent();
      return Number.isFinite(limit) ? limit : 0;
    } catch (err) {
      // 设置读取失败不属于安全拦截,fail-open 到"不限"。
      log.warn('command gate limit read failed, treating as unlimited', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  function hasFreeSlot(limit: number): boolean {
    return limit <= 0 || running.size < limit;
  }

  /** 兜底回收:释放事件丢失(进程被杀等)的 running 记录超过 TTL 后强制清除。 */
  function sweepStaleRunning(): void {
    if (running.size === 0) return;
    const deadline = now() - runningTtlMs;
    for (const [id, entry] of running) {
      if (entry.admittedAt <= deadline) {
        running.delete(id);
        log.warn('command gate reclaimed stale slot (release event lost?)', {
          toolUseId: id,
          sessionId: entry.sessionId,
          heldMs: now() - entry.admittedAt,
        });
      }
    }
  }

  function admit(toolUseId: string, sessionId: string): void {
    running.set(toolUseId, { sessionId, admittedAt: now() });
  }

  function settleWaiter(waiter: Waiter, admission: CommandGateAdmission): void {
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    waiter.resolve(admission);
  }

  function removeWaiter(waiter: Waiter): boolean {
    const idx = queue.indexOf(waiter);
    if (idx < 0) return false;
    queue.splice(idx, 1);
    return true;
  }

  function pump(): void {
    sweepStaleRunning();
    while (queue.length > 0) {
      const limit = readLimit();
      if (!hasFreeSlot(limit)) return;
      const waiter = queue.shift()!;
      admit(waiter.toolUseId, waiter.sessionId);
      settleWaiter(waiter, 'queued');
    }
  }

  function acquire(args: {
    toolUseId: string;
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<CommandGateAdmission> {
    const { toolUseId, sessionId, signal } = args;
    if (signal?.aborted) {
      return Promise.resolve('aborted');
    }
    // 先清队列(内含 TTL sweep):limit 热更调高后,新空槽必须先给先来的等待者,
    // 新命令不许越过非空队列插队(严格 FIFO)。
    pump();
    // 同 id 重复 acquire(理论上不发生):刷新登记时间即可,不重复占槽。
    if (running.has(toolUseId)) {
      admit(toolUseId, sessionId);
      return Promise.resolve('immediate');
    }
    const limit = readLimit();
    if (queue.length === 0 && hasFreeSlot(limit)) {
      admit(toolUseId, sessionId);
      return Promise.resolve('immediate');
    }

    return new Promise<CommandGateAdmission>((resolve) => {
      const waiter: Waiter = {
        toolUseId,
        sessionId,
        resolve,
        signal,
        timer: setTimeout(() => {
          if (!removeWaiter(waiter)) return;
          // 排队超时:fail-open 超额放行。仍登记 running,让计数如实反映超载。
          admit(toolUseId, sessionId);
          log.warn('command gate queue wait timed out, admitting over limit', {
            toolUseId,
            sessionId,
            waitedMs: queueWaitMaxMs,
            running: running.size,
            limit: readLimit(),
          });
          settleWaiter(waiter, 'wait-timeout');
        }, queueWaitMaxMs),
      };
      // Electron main 常驻,unref 防测试/退出被空转 timer 拖住(node timer 才有)。
      (waiter.timer as { unref?: () => void }).unref?.();
      if (signal) {
        const onAbort = () => {
          if (!removeWaiter(waiter)) return;
          settleWaiter(waiter, 'aborted');
        };
        waiter.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
      queue.push(waiter);
      ensureRepumpTimer();
      log.debug?.('command gate queued', {
        toolUseId,
        sessionId,
        running: running.size,
        queued: queue.length,
        limit,
      });
    });
  }

  function release(toolUseId: string, reason: string): void {
    const entry = running.get(toolUseId);
    if (entry) {
      running.delete(toolUseId);
      log.debug?.('command gate released', {
        toolUseId,
        reason,
        heldMs: now() - entry.admittedAt,
        running: running.size,
        queued: queue.length,
      });
      pump();
      return;
    }
    // 等待中的同 id 被释放(如 PermissionDenied 先到):撤出队列,按 aborted 放行。
    const waiter = queue.find((w) => w.toolUseId === toolUseId);
    if (waiter && removeWaiter(waiter)) {
      settleWaiter(waiter, 'aborted');
    }
  }

  function releaseSession(sessionId: string, reason: string): void {
    let removed = 0;
    for (const [id, entry] of running) {
      if (entry.sessionId === sessionId) {
        running.delete(id);
        removed += 1;
      }
    }
    const waiters = queue.filter((w) => w.sessionId === sessionId);
    for (const waiter of waiters) {
      if (removeWaiter(waiter)) {
        settleWaiter(waiter, 'aborted');
      }
    }
    if (removed > 0 || waiters.length > 0) {
      log.info('command gate session cleanup', {
        sessionId,
        reason,
        releasedRunning: removed,
        cancelledQueued: waiters.length,
      });
      pump();
    }
  }

  return {
    acquire,
    release,
    releaseSession,
    snapshot: () => ({ running: running.size, queued: queue.length }),
  };
}
