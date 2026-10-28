/**
 * orcaWorkerResumeScheduler —— 「冷 Worker 唤醒」的进程内调度器。
 *
 * 背景（2026-09 实报：协同里第一次切到某个 dormant worker 要等 ~5s，第二次很快）：
 * `switch_focus` 过去在 IPC / MCP handler 里同步 `await resumeOrcaWorkerSessionIfMissing`，
 * 而 focus 切换是纯 UI 操作 —— 冷会话会 spawn 整个 agent runtime（Pi 实测 2~3s，含 MCP
 * gateway）才返回，面板切换被冷启动阻塞。唤醒本身仍然需要（发送、派活都依赖 live
 * runtime），但它可以后台化：worker 历史来自 DB，不需要 runtime。
 *
 * 本调度器给出三个保证：
 *  1. per-session 去重：并发的 focus 切换 / 派活共享同一次 resume，不会把同一个会话
 *     bootstrap 两次（两个调用方都会看到同一结果）；
 *  2. 与发送路径共用同一把 per-session 锁（由调用方注入 `withSessionLock`，main 侧注入
 *     `withSendToSessionLock`）：resume 期间到达的发送排在锁后；发送先持锁完成 lazy
 *     bootstrap 时，resume 在锁内重查 live 并直接跳过；
 *  3. 可取消：关闭协同 / 归档 / 显式 idle 等释放路径通过 `cancel` 取消尚未落地的唤醒。
 *     等锁中的唤醒直接放弃；已经在冷启动的由 `resume` 实现按 `isCancelled` 在
 *     bootstrap 返回后关掉刚起的 session，避免把已归档 worker 重新拉活。
 *
 * 唤醒实现与锁都由调用方注入，逻辑本身可单测。
 */

/** 调度所需的 worker 身份；真实调用点传完整 worker 记录，只要求 sessionId 稳定。 */
export interface OrcaWorkerResumeTarget {
  sessionId: string;
}

export interface OrcaWorkerResumeSchedulerDeps<Target extends OrcaWorkerResumeTarget> {
  /**
   * 真正的唤醒实现；返回是否真的启动了 runtime（已 live 时 false）。
   * `isCancelled` 在释放路径取消本次唤醒后变为 true：实现必须在冷启动前检查一次，
   * 并在 bootstrap 返回后再检查一次——已启动的 session 要自己关掉。
   * `assertCurrent` 是能力权威校验，同样在冷启动前 / bootstrap 后各校验一次。
   */
  resume(
    target: Target,
    isCancelled: () => boolean,
    assertCurrent?: () => Promise<void>,
  ): Promise<boolean>;
  /** per-session 串行锁；必须与发送路径共用同一把。 */
  withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
}

/** 单次唤醒请求的附加守卫；去重期间以首个请求的 options 为准。 */
export interface OrcaWorkerResumeRequestOptions {
  /** 能力权威校验；失效（throw）即放弃本次唤醒。 */
  assertCurrent?: () => Promise<void>;
}

export interface OrcaWorkerResumeScheduler<Target extends OrcaWorkerResumeTarget> {
  /** 去重 + 串行的 resume；需要结果的调用方 await 它。 */
  request(target: Target, opts?: OrcaWorkerResumeRequestOptions): Promise<boolean>;
  /**
   * 后台唤醒：不阻塞调用方，错误只经 onError 上报（避免 unhandled rejection）。
   * focus 切换用这个入口，resume 结果不构成切换成功与否的一部分。
   */
  requestInBackground(
    target: Target,
    onError: (error: unknown) => void,
    opts?: OrcaWorkerResumeRequestOptions,
  ): void;
  /**
   * 取消该 session 尚未落地的唤醒。取消不删除 in-flight 条目——条目要等真正 settle，
   * 期间新的 request 仍复用它，避免同一会话被 boot 两次；settle 之后的新请求照常重试。
   */
  cancel(sessionId: string): void;
  /** 诊断/测试用：当前处于 in-flight 的 session 数。 */
  pendingCount(): number;
}

interface InFlightResume {
  cancelled: boolean;
  promise: Promise<boolean>;
}

export function createOrcaWorkerResumeScheduler<Target extends OrcaWorkerResumeTarget>(
  deps: OrcaWorkerResumeSchedulerDeps<Target>,
): OrcaWorkerResumeScheduler<Target> {
  const inFlight = new Map<string, InFlightResume>();

  function request(target: Target, opts?: OrcaWorkerResumeRequestOptions): Promise<boolean> {
    const existing = inFlight.get(target.sessionId);
    if (existing) return existing.promise;
    const entry: InFlightResume = {
      cancelled: false,
      promise: Promise.resolve(false),
    };
    // 锁在 resume 内部持有整个冷启动窗口：与发送、idle 释放等同一 session 的 critical
    // section 串行；失败也要清掉 in-flight，让下一次 focus / 派活可以重试。
    entry.promise = deps
      .withSessionLock(target.sessionId, () =>
        deps.resume(target, () => entry.cancelled, opts?.assertCurrent),
      )
      .finally(() => {
        if (inFlight.get(target.sessionId) === entry) inFlight.delete(target.sessionId);
      });
    inFlight.set(target.sessionId, entry);
    return entry.promise;
  }

  function requestInBackground(
    target: Target,
    onError: (error: unknown) => void,
    opts?: OrcaWorkerResumeRequestOptions,
  ): void {
    void request(target, opts).catch(onError);
  }

  function cancel(sessionId: string): void {
    const entry = inFlight.get(sessionId);
    if (entry) entry.cancelled = true;
  }

  return { request, requestInBackground, cancel, pendingCount: () => inFlight.size };
}
