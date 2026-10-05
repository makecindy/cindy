import { createAutoReviewIntentProjection, type AutoReviewHistoryMessage } from '@cindy/maker-shared/auto-review-intent';
import { AUTO_REVIEW_DELEGATED_CONTINUATION, AUTO_REVIEW_SOURCE_CONTENT, AUTO_REVIEW_USER_INTENT, MAIN_OWNED_SEND_CONTEXT } from '@cindy/maker-core';
import type { AutoReviewUserIntent, SendOptions, UserMessage } from '@cindy/maker-core';
import { joinChatQuoteTextSegments, parseChatQuoteSegments } from '@cindy/maker-shared/chat-quotes';
import { projectPersistedAgentFacingUserText } from '@cindy/maker-shared/agent-input-projection';

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
  if (projectPersistedAgentFacingUserText(content) !== wireText) return '';
  // Pasted ranges and attached transcript projections are evidence, not a signed instruction.
  if (
    ['pastedTextRanges', 'sessionReferences', 'agentReferences'].some(
      (key) => Array.isArray(value[key]) && value[key].length > 0,
    )
  )
    return '';
  return value.quotesEncoded === true
      ? joinChatQuoteTextSegments(parseChatQuoteSegments(value.text))
      : value.text;
}

/** Restore a bounded suffix of actual owner messages, without promoting assistant handoffs to consent. */
export const restoreAutoReviewUserIntent = intentProjection.restore;
