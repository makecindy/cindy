/**
 * How long a consent sheet's measured layout has to stay unchanged before Allow may answer in the regular layout (iOS,
 * dispatcher 2026-11-27): the two frames the check compares can come from different layout passes for a moment, and
 * that moment could read looser than the truth. Every report of one layout pass lands within a frame; 150 ms is several
 * frames. Pressed sooner, the sheet asks to review first (one more step, never an answer).
 */
export const CONSENT_SETTLE_MS = 150;
/** A monotonic clock for that check (its own module so tests can drive it). */
export function consentClockNow(): number {
  return performance.now();
}
