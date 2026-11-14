/** Per-invocation monotonic stage timings; no payload, SQL, or identity data. */
export class RemoteInvokeTiming {
  readonly stages: Partial<Record<'authorizeBefore' | 'handler' | 'authorizeAfter' | 'persist' | 'project', number>> = {};

  activeStage: keyof RemoteInvokeTiming['stages'] | undefined;

  constructor(private readonly now: () => number = () => performance.now()) {}

  async measure<T>(stage: keyof RemoteInvokeTiming['stages'], work: () => T | Promise<T>): Promise<T> {
    const started = this.now();
    const previous = this.activeStage;
    this.activeStage = stage;
    try {
      return await work();
    } finally {
      this.activeStage = previous;
      this.stages[stage] = Math.round(Math.max(0, this.now() - started));
    }
  }
}

/** Observe a live invocation as well as its completion. A hung handler must leave
 * evidence even when its caller disconnects before a result exists. */
export function observeRemoteInvoke(
  timing: RemoteInvokeTiming,
  report: (fields: Record<string, unknown>) => void,
  now: () => number = () => performance.now(),
  /** 协议允许被控端刻意挂起的时长(长轮询)；两个阈值都顺延它，挂起本身不是慢执行。 */
  intendedHoldMs = 0,
): () => void {
  const started = now();
  const emit = (outcome: 'waiting' | 'settled') => {
    try { report({ outcome, executionMs: Math.round(Math.max(0, now() - started)),
      activeStage: timing.activeStage ?? null, stagesMs: { ...timing.stages } }); }
    catch { /* Diagnostics cannot change execution or lease cleanup. */ }
  };
  const timer = setTimeout(() => emit('waiting'), 5_000 + intendedHoldMs);
  timer.unref?.();
  return () => {
    clearTimeout(timer);
    if (now() - started >= 1_000 + intendedHoldMs) emit('settled');
  };
}
