import type { ChatMessage } from '@/lib/makerChatStore';
import { isOverloadErrorMessage, parseOverloadRetryProgress } from '@/utils/overloadError';

/** Only suppress duplicate overload progress, never actionable auth/quota errors. */
export function hasInlineOverloadRetry({
  error,
  errorReason,
  isRecoverable,
  messages,
  continuationTurnClientId,
}: {
  error: string | null;
  errorReason: string | null;
  isRecoverable: boolean;
  messages: readonly ChatMessage[];
  continuationTurnClientId: string | null;
}): boolean {
  if (
    !isRecoverable ||
    !error ||
    !isOverloadErrorMessage(error, undefined, errorReason) ||
    !parseOverloadRetryProgress(error)
  ) return false;

  const originalError = error.replace(/\s*\(auto-retry\s+\d+\s*\/\s*\d+\)\s*$/, '').trim();
  return messages.some((message) => {
    const pending = message.systemCardType === 'auto-resume-pending';
    const ownedContinuation =
      message.systemCardType === 'auto-resume' &&
      message.clientId === continuationTurnClientId;
    return (
      (pending || ownedContinuation) &&
      message.systemCardData?.outcome === undefined &&
      typeof message.systemCardData?.error === 'string' &&
      message.systemCardData.error.trim() === originalError
    );
  });
}
