/**
 * Personal WeChat turns always attach a confirmation policy, and none of the
 * three harnesses allow Full access under that policy. Viewing the task must
 * not suggest a mode the next message cannot use.
 */
export function autoReviewUnavailableGuidanceCode(
  sessionSource: unknown,
  quotaExhausted = false,
): string {
  // Quota exhaustion cannot be fixed by switching permission modes; a quota
  // hint must not suggest Full access either.
  if (quotaExhausted) return 'AUTO_REVIEW_UNAVAILABLE_QUOTA';
  return sessionSource === 'wechat' ? 'AUTO_REVIEW_UNAVAILABLE_WECHAT' : 'AUTO_REVIEW_UNAVAILABLE';
}

export function chatRemoteErrorGuidanceKey(
  code: string | undefined,
  sessionSource: unknown,
  quotaExhausted = false,
): string | undefined {
  if (!code) return undefined;
  const guidanceCode =
    code === 'AUTO_REVIEW_UNAVAILABLE'
      ? autoReviewUnavailableGuidanceCode(sessionSource, quotaExhausted)
      : code;
  return `chat.remoteError.${guidanceCode}`;
}
