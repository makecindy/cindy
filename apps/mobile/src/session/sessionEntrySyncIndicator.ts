import { buildSessionMessagePreviewIndex } from '@cindy/maker-shared/session-list';
import { historyWorkSummaries, type HistoryViewSnapshot } from '@cindy/maker-shared/message-window';
import type { RemoteMessage } from './types';

const inline = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

/** Presentation only: unknown or folded content is not evidence of stale history. */
export function hasSessionEntryPreviewMismatch(
  sessionId: string,
  homeLoadedPreview: string | undefined,
  homePreview: string | null | undefined,
  messages: readonly RemoteMessage[],
  history: HistoryViewSnapshot<RemoteMessage>,
): boolean {
  const expected = inline(homeLoadedPreview ?? homePreview);
  if (!expected) return false;
  const latest = messages.findLast((message) =>
    buildSessionMessagePreviewIndex([sessionId], () => [message]).has(sessionId));
  if (historyWorkSummaries(history.items).some((work) =>
    !history.details.get(work.key)?.complete
      && work.endedAtMs >= (latest ? Date.parse(latest.createdAt) : 0))) return false;
  if (!messages.length) return true;

  if (homeLoadedPreview !== undefined) {
    const actual = inline(buildSessionMessagePreviewIndex([sessionId], () => messages).get(sessionId));
    return !!actual && actual !== expected;
  }

  // Server previews are plain user/assistant text, capped at 140 characters.
  // Rich/structured messages have a different projection; leave those on the
  // ordinary delay instead of guessing that formatting means stale content.
  const row = messages.findLast((message) => message.role === 'user' || message.role === 'assistant');
  if (!row || typeof row.content !== 'string'
    || /[\[\]{}<>*`#_~\\&]|^\s*(?:[-+] |\d+[.)] )/m.test(row.content)) return false;
  const actual = inline(row.content);
  return !!actual && !actual.startsWith(expected);
}
