/**
 * A message the owner wrote in a companion's 1:1 room (cloud-companions.md §4): it is handed
 * to the companion's canonical Session like a message from another device. The reply reaches
 * the room through the conversation mirror, so the execution completes without content.
 */
import { COMPANION_DIRECT_CLIENT_PREFIX } from './mirror.js';
import type { BotGroupAttachment } from '../../shared/botGroupChat.js';
import type { ChatContentBlock } from '../maker-ipc/chatServerMigration.js';
import type { CompanionApi } from './types.js';

/** Terminal payload of a delivered direct-room execution: no room message of its own. */
export const DIRECT_ROOM_COMPLETION = Object.freeze({ continueDiscussion: false });

export interface DirectRoomSource {
  id: string;
  authorId: string;
  deleted?: boolean;
  origin?: string;
  content?: ChatContentBlock[];
}

export type DeliverToCanonical = (botId: string, text: string, clientId: string, attachments?: BotGroupAttachment[]) =>
  Promise<{ ok: true } | { ok: false; errorCode: string }>;

/** Names both the execution and the room message, so a take-over never re-inserts it as history. */
export const directRoomClientId = (executionId: string, sourceMessageId: string) =>
  `${COMPANION_DIRECT_CLIENT_PREFIX}${executionId}:${sourceMessageId}`;

/** The room message a delivered row came from, if it is one. */
export function directRoomSourceId(clientId: string): string | null {
  if (!clientId.startsWith(COMPANION_DIRECT_CLIENT_PREFIX)) return null;
  const parts = clientId.slice(COMPANION_DIRECT_CLIENT_PREFIX.length).split(':');
  return parts.length === 2 && parts[1] ? parts[1] : null;
}

export function directRoomText(message: DirectRoomSource): string {
  return (message.content ?? []).map(block => block.type === 'text' ? block.text ?? ''
    : block.type === 'media' ? `[附件: ${block.caption ?? '文件'}]` : block.fallback ?? '').filter(Boolean).join('\n').trim();
}

/** Validate the source and deliver it; throws an error code when it must fail instead. */
export async function deliverDirectRoomMessage(input: {
  api: CompanionApi;
  roomId: string;
  executionId: string;
  sourceMessageId: string;
  /** Only the owner's own words reach the companion's main task. */
  humanActorId: string;
  botId: string;
  prepareAttachments?: (content: ChatContentBlock[]) => Promise<{ attachments: BotGroupAttachment[]; notice?: string }>;
  deliver: DeliverToCanonical;
  /** Lease check right before the irreversible hand-off. */
  beforeDeliver?: () => Promise<void>;
}): Promise<string> {
  const source = await input.api<DirectRoomSource>(`/conversations/${input.roomId}/messages/${input.sourceMessageId}`);
  if (source.id !== input.sourceMessageId || source.deleted || source.origin === 'system' || source.authorId !== input.humanActorId)
    throw new Error('INVALID_EXECUTION_TRIGGER');
  const text = directRoomText(source);
  if (!text) throw new Error('INVALID_INPUT');
  const media = source.content?.filter(block => block.type === 'media') ?? [];
  const prepared = media.length ? await input.prepareAttachments?.(media) : undefined;
  if (media.length && !prepared) throw new Error('ATTACHMENT_UNAVAILABLE');
  await input.beforeDeliver?.();
  const clientId = directRoomClientId(input.executionId, input.sourceMessageId);
  const message = prepared?.notice ? `${text}\n\n${prepared.notice}` : text;
  const delivered = prepared?.attachments.length
    ? await input.deliver(input.botId, message, clientId, prepared.attachments)
    : await input.deliver(input.botId, message, clientId);
  if (!delivered.ok) throw new Error(delivered.errorCode);
  return clientId;
}
