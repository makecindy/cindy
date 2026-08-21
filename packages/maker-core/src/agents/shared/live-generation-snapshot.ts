import type { UsageSnapshot } from '../../types/events.js';

export interface LiveGenerationTiming {
  /** Turn-cumulative output tokens, including reasoning. */
  outputTokens: number;
  /** Closed model-active intervals for this turn. */
  closedDurationMs: number;
  /** Open interval start, or null while tools/user waits own the turn. */
  openStartedAt: number | null;
  /** False when any output lacks a compatible generation-only denominator. */
  reliable: boolean;
  now?: number;
}

/**
 * Attach live TPS facts to a usage snapshot.
 *
 * Timing is omitted when unreliable so the UI can fail closed instead of
 * dividing output by a partial or wall-clock denominator. `outputTokens` is
 * still included so cumulative-token tooltips stay accurate.
 */
export function attachLiveGeneration(
  snapshot: UsageSnapshot,
  timing: LiveGenerationTiming,
): UsageSnapshot {
  const outputTokens =
    typeof timing.outputTokens === 'number' && Number.isFinite(timing.outputTokens)
      ? Math.max(0, timing.outputTokens)
      : 0;
  const next: UsageSnapshot = { ...snapshot, outputTokens };
  if (!timing.reliable) {
    return {
      ...next,
      generationReliable: false,
      generationActive: false,
    };
  }

  const now = timing.now ?? Date.now();
  const closed =
    typeof timing.closedDurationMs === 'number' && Number.isFinite(timing.closedDurationMs)
      ? Math.max(0, timing.closedDurationMs)
      : 0;
  const openMs =
    timing.openStartedAt != null && Number.isFinite(timing.openStartedAt)
      ? Math.max(0, now - timing.openStartedAt)
      : 0;
  const generationDurationMs = closed + openMs;
  const generationActive = timing.openStartedAt != null && Number.isFinite(timing.openStartedAt);

  return {
    ...next,
    generationReliable: true,
    generationActive,
    ...(generationDurationMs > 0 ? { generationDurationMs } : {}),
  };
}
