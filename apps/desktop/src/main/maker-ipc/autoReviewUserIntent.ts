import { AUTO_REVIEW_SOURCE_CONTENT, AUTO_REVIEW_USER_INTENT, MAIN_OWNED_SEND_CONTEXT, appendAutoReviewUserIntent, extractAutoReviewUserIntent } from '@cindy/maker-core';
import type { SendOptions, UserMessage } from '@cindy/maker-core';
import { joinChatQuoteTextSegments, parseChatQuoteSegments } from '@cindy/maker-shared/chat-quotes';
import { projectPersistedAgentFacingUserText } from '@cindy/maker-shared/agent-input-projection';

/** Existing transcript projection, already filtered by the database's clear/rewind boundary. */
export interface AutoReviewHistoryMessage {
  clientId: string;
  role: string;
  content: unknown;
  createdAt?: number;
  agentMeta: Record<string, unknown> | null;
}

function interactionAnswer(message: AutoReviewHistoryMessage): { text: string; acceptedAt: number } | null {
  if (message.role !== 'ask_user' && message.role !== 'plan_review') return null;
  const value = message.agentMeta?.autoReviewUserText;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const answer = value as Record<string, unknown>;
  return typeof answer.text === 'string' && typeof answer.acceptedAt === 'number'
    && Number.isFinite(answer.acceptedAt)
    ? { text: answer.text, acceptedAt: answer.acceptedAt } : null;
}

/** Both queued and direct steers may reach a freshly reattached harness. */
export async function restoreAutoReviewSteerIntent(
  content: string | ReadonlyArray<{ type: string; [key: string]: unknown }>,
  options: SendOptions,
  readHistory: () => Promise<AutoReviewHistoryMessage[]>,
): Promise<string | undefined> {
  options.signal?.throwIfAborted();
  // Resource changes already carry an explicit replacement, including an empty one.
  if (options[AUTO_REVIEW_USER_INTENT] !== undefined) return options[AUTO_REVIEW_USER_INTENT];
  const context = options[MAIN_OWNED_SEND_CONTEXT];
  if (context && context.origin.kind !== 'desktop') return undefined;
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
export function readAutoReviewUserText(content: unknown): string | null {
  if (typeof content === 'string') {
    try {
      content = JSON.parse(content);
    } catch {
      return content as string;
    }
  }
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const value = content as Record<string, unknown>;
  if (typeof value.text !== 'string') return null;
  if (
    value.quotesEncoded === true ||
    [
      'images',
      'files',
      'mentions',
      'sessionReferences',
      'agentReferences',
      'references',
      'pastedTextRanges',
    ].some((key) => Array.isArray(value[key]) && value[key].length > 0)
  )
    return null;
  return value.text;
}

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
export function restoreAutoReviewUserIntent(
  history: readonly AutoReviewHistoryMessage[],
  current: { clientId: string; content: unknown; authoredText?: string },
): string {
  let intent = '';
  let replayed = false;
  const latest = current.authoredText ?? readAutoReviewUserText(current.content);
  // Cards are created before the user answers; their acceptance time orders authority.
  const ordered = history.map((message, index) => ({ message, index,
    at: interactionAnswer(message)?.acceptedAt ?? message.createdAt ?? index,
  })).sort((a, b) => a.at - b.at || a.index - b.index);
  for (let index = 0; index < ordered.length; index++) {
    const { message, at } = ordered[index]!;
    if (message.role === 'ask_user' || message.role === 'plan_review') {
      const answer = interactionAnswer(message);
      if (!answer) { intent = ''; continue; }
      // Millisecond ties cannot establish whether a card overrode a newer restriction.
      if (ordered.some((entry, other) => other !== index && entry.at === at)) return '';
      if (answer.text) intent = appendAutoReviewUserIntent(intent, answer.text);
      continue;
    }
    if (message.role !== 'user') continue;
    // An already-persisted retry is the same input, not a second authorization.
    if (message.clientId === current.clientId) {
      if (message.agentMeta?.autoReviewUserText !== latest) return '';
      replayed = true;
    }
    const meta = message.agentMeta;
    const text = meta?.autoReviewUserText;
    // delivery/wire alone are not authorship proof: plugin rewrites have the same shape.
    // Old rows without Host-captured text cannot safely restore authorization.
    if (
      typeof text !== 'string' ||
      !['turn', 'steer'].includes(String(meta?.delivery)) ||
      meta?.autoResume ||
      meta?.contextRebuild ||
      text.startsWith('[UI_ACTION_TRIGGER]')
    ) {
      intent = '';
      continue;
    }
    if (readAutoReviewUserText(message.content) === null) intent = '';
    intent = appendAutoReviewUserIntent(intent, text);
  }
  if (replayed) return intent;
  if (readAutoReviewUserText(current.content) === null) intent = '';
  return latest !== null
    ? appendAutoReviewUserIntent(intent, latest)
    : extractAutoReviewUserIntent('');
}
