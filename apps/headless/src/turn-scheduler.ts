type Job = { sessionId: string; run: () => Promise<void> };

/**
 * Bounded, per-session serial execution. The host owns this boundary so CLI,
 * Device Link and scheduled jobs cannot accidentally oversubscribe an agent.
 */
export class HeadlessTurnScheduler {
  private readonly queues = new Map<string, Job[]>();
  private readonly activeSessions = new Set<string>();
  private activeCount = 0;

  constructor(private readonly maxConcurrentTurns = 4) {
    if (!Number.isInteger(maxConcurrentTurns) || maxConcurrentTurns < 1) {
      throw new Error('maxConcurrentTurns must be a positive integer');
    }
  }

  enqueue(sessionId: string, run: () => Promise<void>): number {
    const queue = this.queues.get(sessionId) ?? [];
    queue.push({ sessionId, run });
    this.queues.set(sessionId, queue);
    this.drain();
    return queue.length + (this.activeSessions.has(sessionId) ? 1 : 0);
  }

  cancelQueued(sessionId: string): number {
    const queue = this.queues.get(sessionId);
    if (!queue?.length) return 0;
    this.queues.delete(sessionId);
    return queue.length;
  }

  cancelAllQueued(): number {
    const count = [...this.queues.values()].reduce((total, queue) => total + queue.length, 0);
    this.queues.clear();
    return count;
  }

  snapshot(): { activeTurns: number; queuedTurns: number; activeSessionIds: string[] } {
    return {
      activeTurns: this.activeCount,
      queuedTurns: [...this.queues.values()].reduce((total, queue) => total + queue.length, 0),
      activeSessionIds: [...this.activeSessions],
    };
  }

  private drain(): void {
    while (this.activeCount < this.maxConcurrentTurns) {
      const job = this.nextRunnable();
      if (!job) return;
      this.activeCount++;
      this.activeSessions.add(job.sessionId);
      void job.run()
        .catch(() => undefined)
        .finally(() => {
          this.activeCount--;
          this.activeSessions.delete(job.sessionId);
          this.drain();
        });
    }
  }

  private nextRunnable(): Job | null {
    for (const [sessionId, queue] of this.queues) {
      if (this.activeSessions.has(sessionId)) continue;
      const job = queue.shift();
      if (!job) {
        this.queues.delete(sessionId);
        continue;
      }
      if (queue.length === 0) this.queues.delete(sessionId);
      return job;
    }
    return null;
  }
}
