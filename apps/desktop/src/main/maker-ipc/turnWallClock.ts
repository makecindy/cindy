/**
 * Tracks the wall-clock duration of one user-visible product turn.
 *
 * A Claude answer may span multiple SDK segments. The tracker therefore starts
 * at the first running boundary and is only consumed by the final product
 * terminal, so continuation gaps remain part of the displayed elapsed time.
 */
export class ProductTurnWallClockTracker {
  private readonly startedAtBySession = new Map<string, number>();

  start(sessionId: string, startedAt = Date.now()): void {
    if (!Number.isFinite(startedAt)) {
      this.startedAtBySession.delete(sessionId);
      return;
    }
    this.startedAtBySession.set(sessionId, startedAt);
  }

  finish(sessionId: string, completedAt = Date.now()): number | undefined {
    const startedAt = this.startedAtBySession.get(sessionId);
    this.startedAtBySession.delete(sessionId);
    if (startedAt === undefined || !Number.isFinite(completedAt)) return undefined;
    const durationMs = completedAt - startedAt;
    return durationMs > 0 && Number.isFinite(durationMs) ? durationMs : undefined;
  }

  clear(sessionId: string): void {
    this.startedAtBySession.delete(sessionId);
  }
}
