/**
 * orcaWorkerResumeScheduler —— 「冷 Worker 唤醒」的进程内调度器。
 *
 * 背景（2026-09 实报：协同里第一次切到某个 dormant worker 要等 ~5s，第二次很快）：
 * `switch_focus` 过去在 IPC / MCP handler 里同步 `await resumeOrcaWorkerSessionIfMissing`，
 * 而 focus 切换是纯 UI 操作 —— 冷会话会 spawn 整个 agent runtime（Pi 实测 2~3s，含 MCP
 * gateway）才返回，面板切换被冷启动阻塞。唤醒本身仍然需要（发送、派活都依赖 live
 * runtime），但它可以后台化：worker 历史来自 DB，不需要 runtime。
 *
 * 本调度器给出两个保证：
 *  1. per-session 去重：并发的 focus 切换 / 派活共享同一次 resume，不会把同一个会话
 *     bootstrap 两次（两个调用方都会看到同一结果）；
 *  2. 与发送路径共用同一把 per-session 锁（由调用方注入 `withSessionLock`，main 侧注入
 *     `withSendToSessionLock`）：resume 期间到达的发送排在锁后；发送先持锁完成 lazy
 *     bootstrap 时，resume 在锁内重查 live 并直接跳过。
 *
 * 唤醒实现与锁都由调用方注入，逻辑本身可单测。
 */

/** 调度所需的 worker 身份；真实调用点传完整 worker 记录，只要求 sessionId 稳定。 */
export interface OrcaWorkerResumeTarget {
  sessionId: string;
}

export interface OrcaWorkerResumeSchedulerDeps<Target extends OrcaWorkerResumeTarget> {
  /** 真正的唤醒实现；返回是否真的启动了 runtime（已 live 时 false）。 */
  resume(target: Target): Promise<boolean>;
  /** per-session 串行锁；必须与发送路径共用同一把。 */
  withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
}

export interface OrcaWorkerResumeScheduler<Target extends OrcaWorkerResumeTarget> {
  /** 去重 + 串行的 resume；需要结果的调用方 await 它。 */
  request(target: Target): Promise<boolean>;
  /**
   * 后台唤醒：不阻塞调用方，错误只经 onError 上报（避免 unhandled rejection）。
   * focus 切换用这个入口，resume 结果不构成切换成功与否的一部分。
   */
  requestInBackground(target: Target, onError: (error: unknown) => void): void;
  /** 诊断/测试用：当前处于 in-flight 的 session 数。 */
  pendingCount(): number;
}

export function createOrcaWorkerResumeScheduler<Target extends OrcaWorkerResumeTarget>(
  deps: OrcaWorkerResumeSchedulerDeps<Target>,
): OrcaWorkerResumeScheduler<Target> {
  const inFlight = new Map<string, Promise<boolean>>();

  function request(target: Target): Promise<boolean> {
    const existing = inFlight.get(target.sessionId);
    if (existing) return existing;
    // 锁在 resume 内部持有整个冷启动窗口：与发送、idle 释放等同一 session 的 critical
    // section 串行；失败也要清掉 in-flight，让下一次 focus / 派活可以重试。
    const promise = deps
      .withSessionLock(target.sessionId, () => deps.resume(target))
      .finally(() => {
        if (inFlight.get(target.sessionId) === promise) inFlight.delete(target.sessionId);
      });
    inFlight.set(target.sessionId, promise);
    return promise;
  }

  function requestInBackground(target: Target, onError: (error: unknown) => void): void {
    void request(target).catch(onError);
  }

  return { request, requestInBackground, pendingCount: () => inFlight.size };
}
