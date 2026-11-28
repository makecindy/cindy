import type { AgentEvent } from '@cindy/maker-core';

/** Hold the previous turn's completion until the queue or outstanding worker reports drain. */
export class DeferredSessionCompletions {
  private readonly entries = new Map<string, { event: AgentEvent; suppressAttention: boolean }>();

  constructor(
    private readonly hasPendingWork: (sessionId: string) => boolean,
    private readonly maxEntries = Infinity,
  ) {}

  deferIfPending(sessionId: string, event: AgentEvent): boolean {
    if (!this.hasPendingWork(sessionId)) return false;
    this.entries.delete(sessionId);
    this.entries.set(sessionId, { event, suppressAttention: false });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    return true;
  }

  takeIfReady(sessionId: string) {
    const completion = this.entries.get(sessionId);
    if (!completion || this.hasPendingWork(sessionId)) return;
    this.entries.delete(sessionId);
    return completion;
  }

  suppressAttention(sessionId: string): void {
    const completion = this.entries.get(sessionId);
    if (completion) completion.suppressAttention = true;
  }

  delete(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  clear(): void {
    this.entries.clear();
  }
}
