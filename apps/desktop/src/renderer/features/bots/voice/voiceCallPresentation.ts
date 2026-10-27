import type { VoiceCallRecord } from '@cindy/maker-core';
import { readVoiceCallRecord } from '@/../shared/voiceConversation';
import type { ChatMessage } from '@/lib/makerChatStore';

export function hasVoiceCallContent(record: VoiceCallRecord): boolean {
  return record.turns.some((turn) => turn.text.trim().length > 0) || record.handoffs.length > 0;
}

/** Display-only: keep failed/interrupted originals and every handoff state.
 * Apply to both live rows and independently loaded history before grouping;
 * never remove anything from the source store or persisted call record. */
export function isVisibleVoiceCallMessage(
  message: Pick<ChatMessage, 'systemCardType' | 'systemCardData'>,
  activeCallId: string | null = null,
): boolean {
  if (message.systemCardType !== 'voice-call') return true;
  const record = readVoiceCallRecord(message.systemCardData?.record);
  // Unknown records are not proven empty; retain the existing presentation.
  return !record || (record.callId !== activeCallId && hasVoiceCallContent(record));
}

export function visibleVoiceCallMessages(
  messages: ChatMessage[],
  activeCallId: string | null,
): ChatMessage[] {
  return messages.filter((message) => isVisibleVoiceCallMessage(message, activeCallId));
}
