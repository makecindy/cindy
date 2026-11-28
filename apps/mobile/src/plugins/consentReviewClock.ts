/**
 * iOS confirmation sheet: after "Review source and permissions", the same button becomes Allow in the same place. A
 * press within this long after the review press is the rest of a quick double tap, not a read of the reordered list, so
 * it answers nothing (it stays reviewed; a later press answers).
 */
export const CONSENT_REVIEW_ALLOW_DELAY_MS = 500;
/** A monotonic clock for that check (its own module so tests can drive it). */
export function consentReviewClockNow(): number {
  return performance.now();
}
