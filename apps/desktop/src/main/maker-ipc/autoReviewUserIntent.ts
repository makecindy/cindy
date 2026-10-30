import { createAutoReviewIntentProjection, type AutoReviewHistoryMessage } from '@cindy/maker-shared/auto-review-intent';
import { AUTO_REVIEW_DELEGATED_CONTINUATION, AUTO_REVIEW_SOURCE_CONTENT, AUTO_REVIEW_USER_INTENT, MAIN_OWNED_SEND_CONTEXT } from '@cindy/maker-core';
import type { AutoReviewUserIntent, SendOptions, UserMessage } from '@cindy/maker-core';
import { joinChatQuoteTextSegments, parseChatQuoteSegments } from '@cindy/maker-shared/chat-quotes';
import { projectPersistedAgentFacingUserText, readAgentInputReferences } from '@cindy/maker-shared/agent-input-projection';

/** Main-only projection of a protected delegated receipt; never accepted from wire input. */
export { AUTO_REVIEW_DELEGATED_CONTINUATION };

export type { AutoReviewHistoryMessage } from '@cindy/maker-shared/auto-review-intent';
const intentProjection = createAutoReviewIntentProjection();
/** Both queued and direct steers may reach a freshly reattached harness. */
export async function restoreAutoReviewSteerIntent(
  content: string | ReadonlyArray<{ type: string; [key: string]: unknown }>,
  options: SendOptions & { readonly [AUTO_REVIEW_DELEGATED_CONTINUATION]?: true },
  readHistory: () => Promise<AutoReviewHistoryMessage[]>,
): Promise<AutoReviewUserIntent | undefined> {
  options.signal?.throwIfAborted();
  // Resource changes already carry an explicit replacement, including an empty one.
  if (options[AUTO_REVIEW_USER_INTENT] !== undefined) return options[AUTO_REVIEW_USER_INTENT];
  const context = options[MAIN_OWNED_SEND_CONTEXT];
  if (context && context.origin.kind !== 'desktop') return undefined;
  if (options[AUTO_REVIEW_DELEGATED_CONTINUATION]) {
    const history = await readHistory();
    options.signal?.throwIfAborted();
    return restoreAutoReviewUserIntent(history);
  }
  const text = options[AUTO_REVIEW_SOURCE_CONTENT] ?? context?.rawChannelText;
  if (typeof text !== 'string') return undefined;
  const history = await readHistory().catch(() => []);
  options.signal?.throwIfAborted();
  return restoreAutoReviewUserIntent(history, {
    clientId: '', authoredText: text,
    content: typeof content === 'string' || content.every((block) => block.type === 'text')
      ? { text } : [],
  });
}

/** Read only the user's authored text, never the decorated agent-facing projection. */
export const readAutoReviewUserText = intentProjection.readText;

/** Resource changes discard old deictic grants, while preserving verified current authored text. */
export function currentAutoReviewResourceIntent(
  content: unknown,
  source: UserMessage['content'],
): string {
  if (typeof content === 'string') {
    try {
      content = JSON.parse(content);
    } catch {
      return '';
    }
  }
  if (!content || typeof content !== 'object' || Array.isArray(content)) return '';
  const value = content as Record<string, unknown>;
  if (typeof value.text !== 'string') return '';
  const wireText =
    typeof source === 'string'
      ? source
      : source
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n');
  // Queue admission carries Composer text; direct consumers may already carry
  // its agent-facing projection. Both must match this same persisted envelope.
  if (value.text !== wireText && projectPersistedAgentFacingUserText(content) !== wireText) return '';
  // Structured references have validated spans: discard those spans, not the
  // owner's adjacent request. Attached session transcripts are separate from value.text entirely.
  const references = readAgentInputReferences(value.agentReferences, value.text);
  if (Array.isArray(value.agentReferences) && references.length !== value.agentReferences.length) return '';
  const parts: string[] = [];
  let cursor = 0;
  for (const reference of references) {
    parts.push(value.text.slice(cursor, reference.start));
    cursor = reference.end;
  }
  parts.push(value.text.slice(cursor));
  const textOutsideReferences = parts.join('');
  const segments = value.quotesEncoded === true ? parseChatQuoteSegments(textOutsideReferences) : undefined;
  const authoredText = segments ? joinChatQuoteTextSegments(segments) : textOutsideReferences;
  // Composer serializes list structure outside reference/quote spans. A list
  // containing only those resources leaves markers, not a new owner request.
  // Keep all text verbatim if any line still contains actual authored content.
  if ((references.length > 0 || segments?.some(segment => segment.kind === 'quote')) &&
      authoredText.split(/\r?\n/).every(line => /^[ \t]*(?:[-+*•]|[1-9]\d*[.)、])?[ \t]*$/.test(line))) return '';
  return authoredText;
}

/** Restore a bounded suffix of actual owner messages, without promoting assistant handoffs to consent. */
export const restoreAutoReviewUserIntent = intentProjection.restore;
