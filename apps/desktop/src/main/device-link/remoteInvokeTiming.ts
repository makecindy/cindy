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
): () => void {
  const started = now();
  const emit = (outcome: 'waiting' | 'settled') => {
    try { report({ outcome, executionMs: Math.round(Math.max(0, now() - started)),
      activeStage: timing.activeStage ?? null, stagesMs: { ...timing.stages } }); }
    catch { /* Diagnostics cannot change execution or lease cleanup. */ }
  };
  const timer = setTimeout(() => emit('waiting'), 5_000);
  timer.unref?.();
  return () => {
    clearTimeout(timer);
    if (now() - started >= 1_000) emit('settled');
  };
}
