/** Host policy, not plugin-configurable. */
export const ROUTINE_EVENT_LIMITS = {
  windowMs: 60_000,
  perSource: 60,
  global: 240,
  pendingPerSource: 8,
  pendingGlobal: 32,
} as const;

/** Reserve before cloning/queuing plugin requests; separate instances isolate event and status quotas. */
export class RoutineEventAdmission {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private global = { start: 0, count: 0 };
  private readonly pending = new Map<string, number>();
  private totalPending = 0;

  acquire(sourceId: string, now: number): () => void {
    const limits = ROUTINE_EVENT_LIMITS;
    for (const [id, window] of this.windows)
      if (now - window.start >= limits.windowMs) this.windows.delete(id);
    if (now - this.global.start >= limits.windowMs) this.global = { start: now, count: 0 };
    const window = this.windows.get(sourceId) ?? { start: now, count: 0 };
    if (window.count >= limits.perSource || this.global.count >= limits.global)
      throw new Error('Routine request rate limit reached; retry after 60 seconds');
    const pending = this.pending.get(sourceId) ?? 0;
    if (pending >= limits.pendingPerSource || this.totalPending >= limits.pendingGlobal)
      throw new Error('Routine request intake is busy; retry later');
    window.count += 1;
    this.global.count += 1;
    this.windows.set(sourceId, window);
    this.pending.set(sourceId, pending + 1);
    this.totalPending += 1;
    return () => {
      const remaining = (this.pending.get(sourceId) ?? 1) - 1;
      if (remaining) this.pending.set(sourceId, remaining);
      else this.pending.delete(sourceId);
      this.totalPending -= 1;
    };
  }
}
