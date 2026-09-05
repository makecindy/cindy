import type { DictationRefinementContext } from '@cindy/voice-input-core';
import type { Node as PMNode } from '@tiptap/pm/model';
import {
  formatVoiceInputHistoryContext,
  takeRefinementContextHead,
  takeRefinementContextTail,
  truncateRefinementReply,
  MAX_REFINEMENT_REPLY_TO_MESSAGE_CHARS,
} from '@cindy/voice-input-core';
export {
  MAX_REFINEMENT_SIDE_CONTEXT_CHARS,
  MAX_REFINEMENT_REPLY_TO_MESSAGE_CHARS,
  estimateVoiceInputHistoryContextChars,
  VOICE_INPUT_HISTORY_COMPACT_CHARS,
  VOICE_INPUT_HISTORY_COMPACT_KEEP_ENTRIES,
  VOICE_INPUT_HISTORY_COMPACT_TARGET_CHARS,
} from '@cindy/voice-input-core';

export const VOICE_INPUT_REFINEMENT_CACHE_SCOPE = 'voice-input-refinement';

export type VoiceInputChatMessage = {
  role: string;
  content: string;
  isStreaming?: boolean;
};

export function buildEditorSelectionContext(doc: PMNode, range: { from: number; to: number }) {
  return {
    selectionBefore: takeRefinementContextTail(doc.textBetween(0, range.from, '\n', '\n')),
    selectedText: takeRefinementContextHead(doc.textBetween(range.from, range.to, '\n', '\n')),
    selectionAfter: takeRefinementContextHead(doc.textBetween(range.to, doc.content.size, '\n', '\n')),
  };
}

export function truncateContextText(text: string, maxChars: number): string {
  return takeRefinementContextHead(text, maxChars);
}

export function buildReplyToMessageFromChatMessages(messages: VoiceInputChatMessage[] | undefined): string | undefined {
  if (!messages?.length) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.isStreaming || message.role !== 'assistant') continue;
    return truncateRefinementReply(message.content, MAX_REFINEMENT_REPLY_TO_MESSAGE_CHARS) || undefined;
  }
  return undefined;
}

/**
 * Build the only long-lived history block sent to refinement: prior voice
 * input text, oldest first. Normal chat history is deliberately excluded.
 *
 * The model only needs this as a terminology/style hint, so one bounded block
 * is simpler and less surprising than separate stable/recent fields.
 */
export function buildVoiceInputHistoryContext(
  newestFirst: ReadonlyArray<{ text: string }>,
): Pick<DictationRefinementContext, 'voiceInputHistory'> {
  const voiceInputHistory = formatVoiceInputHistoryContext(newestFirst);
  return voiceInputHistory ? { voiceInputHistory } : {};
}

export function takeContextHead(text: string, maxChars: number): string {
  return truncateContextText(text, maxChars);
}

export function takeContextTail(text: string, maxChars: number): string {
  return takeRefinementContextTail(text, maxChars);
}
