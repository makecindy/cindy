import { CODEX_HISTORY_OVERSIZED_REASON, CONTEXT_OVERFLOW_REASON, isContextOverflowErrorMessage, isRemoteCompactEncryptedContentError } from '@cindy/maker-core';
export function isContextOverflowErrorData(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const rec = data as { reason?: unknown; message?: unknown; sdkError?: unknown };
  if (rec.reason === CONTEXT_OVERFLOW_REASON) return true;
  return [rec.message, rec.sdkError].some(
    (value) =>
      typeof value === 'string' &&
      (isContextOverflowErrorMessage(value) || isRemoteCompactEncryptedContentError(value)),
  );
}

export function isOversizedHistoryErrorData(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  return (data as { reason?: unknown }).reason === CODEX_HISTORY_OVERSIZED_REASON;
}

