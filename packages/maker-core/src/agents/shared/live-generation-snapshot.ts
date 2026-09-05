import type { UsageSnapshot } from '../../types/events.js';

export interface LiveGenerationTiming {
  /** Turn-cumulative output tokens, including reasoning. */
  outputTokens: number;
  /** Duration captured with outputTokens; sparse usage must not include later in-flight time. */
  durationMs: number;
  /** Open interval start, or null while tools/user waits own the turn. */
  openStartedAt: number | null;
  /** False when any output lacks a compatible generation-only denominator. */
  reliable: boolean;
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

  const generationDurationMs = timing.durationMs;
  const generationActive = timing.openStartedAt != null && Number.isFinite(timing.openStartedAt);

  return {
    ...next,
    generationReliable: true,
    generationActive,
    ...(Number.isFinite(generationDurationMs) && generationDurationMs > 0
      ? { generationDurationMs }
      : {}),
  };
}

/** Capture the cumulative model time at the same boundary as an output-usage update. */
export function sampleGenerationDuration(
  closedDurationMs: number,
  openStartedAt: number | null,
  now = Date.now(),
): number {
  return closedDurationMs + (openStartedAt === null ? 0 : Math.max(0, now - openStartedAt));
}
