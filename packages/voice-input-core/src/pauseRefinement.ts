// A pause may complete a sentence without ASR punctuation. Subsequent requests
// require another sentence, not a spelling/punctuation revision of the same one.
// This is intentionally conservative when the provider omits all punctuation.
function sentenceCount(text: string): number {
  return text
    .split(/[。！？!?]+|\.(?=\s|$)/u)
    .filter((part) => /[\p{L}\p{N}]/u.test(part)).length;
}

export function hasAdditionalSentence(
  previous: string,
  current: string,
): boolean {
  const contentLength = (text: string) =>
    (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return (
    contentLength(current) > contentLength(previous) &&
    sentenceCount(current) > sentenceCount(previous)
  );
}

/**
 * Refinement requests a managed voice-server session accepts when the server
 * does not report its limit: servers from before pause-time refinement allow
 * one attempt plus one client fallback retry.
 */
export const LEGACY_MANAGED_REFINE_REQUEST_LIMIT = 2;

/** Reads `refiner.maxRefineRequests` from a voice-server session response. */
export function resolveManagedRefineRequestLimit(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : LEGACY_MANAGED_REFINE_REQUEST_LIMIT;
}
