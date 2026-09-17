/** Per-invocation monotonic stage timings; no payload, SQL, or identity data. */
export class RemoteInvokeTiming {
  readonly stages: Partial<Record<'authorizeBefore' | 'handler' | 'authorizeAfter' | 'persist' | 'project', number>> = {};

  constructor(private readonly now: () => number = () => performance.now()) {}

  async measure<T>(stage: keyof RemoteInvokeTiming['stages'], work: () => T | Promise<T>): Promise<T> {
    const started = this.now();
    try {
      return await work();
    } finally {
      this.stages[stage] = Math.round(Math.max(0, this.now() - started));
    }
  }
}
