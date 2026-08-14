/**
 * Tracks the wall-clock duration of one user-visible product turn.
 *
 * A Claude answer may span multiple SDK segments. The tracker therefore starts
 * at the first running boundary and is only consumed by the final product
 * terminal, so continuation gaps remain part of the displayed elapsed time.
 */
export class ProductTurnWallClockTracker {
  private readonly startedAtBySession = new Map<string, number>();
  private readonly continuationPendingBySession = new Set<string>();

  preserveForContinuation(sessionId: string): void {
    if (this.startedAtBySession.has(sessionId)) {
      this.continuationPendingBySession.add(sessionId);
    }
  }

  start(sessionId: string, startedAt = Date.now()): boolean {
    if (!Number.isFinite(startedAt)) {
      this.clear(sessionId);
      return false;
    }
    // Only a confirmed Claude silentStop auto-resume may reuse the existing
    // product boundary. Any other running boundary starts a genuinely new turn
    // and overwrites stale state left by an abnormal terminal path.
    if (
      this.continuationPendingBySession.delete(sessionId) &&
      this.startedAtBySession.has(sessionId)
    ) {
      return false;
    }
    this.startedAtBySession.set(sessionId, startedAt);
    return true;
  }

  finish(sessionId: string, completedAt = Date.now()): number | undefined {
    const startedAt = this.startedAtBySession.get(sessionId);
    this.clear(sessionId);
    if (startedAt === undefined || !Number.isFinite(completedAt)) return undefined;
    const durationMs = completedAt - startedAt;
    return durationMs > 0 && Number.isFinite(durationMs) ? durationMs : undefined;
  }

  clear(sessionId: string): void {
    this.startedAtBySession.delete(sessionId);
    this.continuationPendingBySession.delete(sessionId);
  }
}

/**
 * Keeps the latest assistant message target across Claude continuation SDK
 * segments. A tokenless final segment can then attach the complete product-turn
 * duration to the last message that actually carried output.
 */
export class ProductTurnUsageTargetTracker {
  private readonly clientIdBySession = new Map<string, string>();

  remember(sessionId: string, clientId: string | null | undefined): void {
    if (clientId) this.clientIdBySession.set(sessionId, clientId);
  }

  finish(sessionId: string, currentClientId: string | null | undefined): string | undefined {
    const rememberedClientId = this.clientIdBySession.get(sessionId);
    this.clientIdBySession.delete(sessionId);
    return currentClientId || rememberedClientId;
  }

  clear(sessionId: string): void {
    this.clientIdBySession.delete(sessionId);
  }
}
