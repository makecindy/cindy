import { UPSTREAM_STREAM_INTERRUPTED_REASON } from '@/utils/streamInterruptError';
import type { ChatMessage } from './makerChatStore';

/** Location/model/history boundaries record a change, not progress on the failed input. */
export function findErrorTailMessage(
  messages: readonly ChatMessage[],
  disposedErrorPersistId: string | null = null,
): ChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    // Persisted agent_switch rows are projected as assistant system cards. Do not
    // skip ordinary assistant replies, user inputs (including accepted retries),
    // tools, or interactive cards: any of those supersedes the old recovery UI.
    if (message.role === 'assistant' && (
      message.systemCardType === 'agent-switch' ||
      message.systemCardType === 'context-rebuild' ||
      message.systemCardType === 'session-import' ||
      message.systemCardType === 'compact'
    )) continue;
    // A dismissed/disposed error is itself a terminal boundary. Never scan past
    // it and resurrect an earlier failure.
    return message.role === 'error' &&
      !message.errorDismissed &&
      message.clientId !== disposedErrorPersistId
      ? message
      : null;
  }
  return null;
}

/** Only advertise saved text when the persisted failure identifies its failed reply. */
export function hasSavedPiInterruptedReply(
  messages: readonly ChatMessage[],
  error: ChatMessage | undefined,
): boolean {
  if (!error?.id || error.role !== 'error' || !error.replyToClientId) return false;
  const interrupted = error.errorReason === UPSTREAM_STREAM_INTERRUPTED_REASON
    || (!error.errorReason && error.content.trim() === 'Stream ended without finish_reason');
  if (!interrupted) return false;

  return messages.some(message =>
    message.role === 'assistant'
    && message.replyToClientId === error.replyToClientId
    && Boolean(message.id)
    && (message.rowid === undefined || error.rowid === undefined || message.rowid < error.rowid)
    && message.turnCompleted === false
    && !message.systemCardType
    && message.content.trim().length > 0,
  );
}
