import {
  parseChatQuoteSegments,
  stripChatQuoteMarkerLines,
} from '@cindy/maker-shared/chat-quotes';
import { slashCommandDisplayLabel } from '@cindy/maker-shared/composer-palette';
import {
  type ConversationShareAttachment,
  type ConversationShareBodyPart,
  type ConversationShareMessage,
} from '@/session/conversationShareWebViewHtml';
import { partitionMessageAttachments } from '@/session/messageAttachments';
import type { NormalizedRemoteMessage } from '@/session/messageNormalize';
import { compactQuoteLabel } from '@/session/quotePresentation';
import {
  buildVisibleSentInlineTokens,
  type SentInlineToken,
  sentInlineTokensDisplayText,
} from '@/session/sentMessageAtoms';
import {
  estimateTextVisualLineCount,
  truncateTextToVisualLines,
} from '@/session/userMessageCollapse';

type ConversationShareSourceMessage = Pick<
  NormalizedRemoteMessage,
  | 'attachments'
  | 'automationOrigin'
  | 'body'
  | 'kind'
  | 'pastedTextRanges'
  | 'quotesEncoded'
  | 'secondaryBody'
  | 'slashCommandRanges'
>;

export function projectConversationShareMessage(
  clientId: string,
  message: ConversationShareSourceMessage,
  options: {
    automationOriginLabel?: string;
    maxVisibleLines?: number;
    visualLineCapacity?: number;
  } = {},
): ConversationShareMessage | null {
  if (message.kind !== 'user' && message.kind !== 'assistant') return null;

  const attachments = projectAttachments(message.attachments ?? []);
  const attachmentFields = attachments.length > 0 ? { attachments } : {};
  const automationOriginFields = options.automationOriginLabel
    ? { automationOriginLabel: options.automationOriginLabel }
    : {};
  const secondaryBody = message.secondaryBody || undefined;
  if (message.kind === 'assistant') {
    return {
      ...attachmentFields,
      ...automationOriginFields,
      body: message.quotesEncoded
        ? stripChatQuoteMarkerLines(message.body)
        : message.body,
      clientId,
      kind: message.kind,
      ...(secondaryBody ? { secondaryBody } : {}),
    };
  }

  const quoteSegments = message.quotesEncoded
    ? parseChatQuoteSegments(message.body)
    : message.body
      ? [{ kind: 'text' as const, text: message.body }]
      : [];
  const tokens = buildVisibleSentInlineTokens(
    message.body,
    quoteSegments,
    message.pastedTextRanges,
    message.slashCommandRanges,
  );
  const visibleTokens = options.maxVisibleLines
    ? truncateSentInlineTokens(tokens, options.maxVisibleLines, options.visualLineCapacity)
    : tokens;
  const hasStructuredBody = visibleTokens.some((token) => token.kind !== 'text');
  const bodyParts = hasStructuredBody ? projectBodyParts(visibleTokens) : undefined;

  return {
    ...attachmentFields,
    ...automationOriginFields,
    body: sentInlineTokensDisplayText(visibleTokens),
    ...(bodyParts ? { bodyParts } : {}),
    clientId,
    kind: message.kind,
    ...(secondaryBody ? { secondaryBody } : {}),
  };
}

function truncateSentInlineTokens(
  tokens: readonly SentInlineToken[],
  maxVisibleLines: number,
  visualLineCapacity?: number,
): SentInlineToken[] {
  const visibleTokens: SentInlineToken[] = [];
  let remainingLines = maxVisibleLines;
  for (const token of tokens) {
    if (remainingLines <= 0) break;
    if (token.kind === 'text') {
      const text = truncateTextToVisualLines(token.text, remainingLines, visualLineCapacity);
      if (!text) continue;
      visibleTokens.push({ ...token, text });
      remainingLines -= estimateTextVisualLineCount(text, visualLineCapacity);
      continue;
    }
    visibleTokens.push(token);
    remainingLines -= 1;
  }
  return visibleTokens;
}

function projectBodyParts(
  tokens: ReturnType<typeof buildVisibleSentInlineTokens>,
): ConversationShareBodyPart[] {
  const parts: ConversationShareBodyPart[] = [];
  for (const token of tokens) {
    if (token.kind === 'text') {
      if (token.text) parts.push({ kind: 'text', text: token.text });
      continue;
    }
    if (token.kind === 'quote') {
      const label = compactQuoteLabel(token.quote.text);
      if (label) parts.push({ kind: 'quote', label });
      continue;
    }
    if (token.kind === 'pasted') {
      if (token.display) parts.push({ kind: 'pasted', label: token.display });
      continue;
    }
    if (token.text) parts.push({ kind: 'slash', label: slashCommandDisplayLabel(token.text) });
  }
  return parts;
}

function projectAttachments(
  attachments: NonNullable<NormalizedRemoteMessage['attachments']>,
): ConversationShareAttachment[] {
  const { imageAttachments, fileAttachments } =
    partitionMessageAttachments(attachments);
  return [...imageAttachments, ...fileAttachments].map(({ kind, name }) => ({
    kind,
    name,
  }));
}
