export type BotDirectMessageThreadStatus = 'active' | 'closed';
export type BotDirectMessageCloseReason = 'message-limit' | 'idle-timeout' | null;

export interface BotDirectMessageMeta {
  v: 1;
  threadId: string;
  viewerBotId: string;
  peerBotId: string;
  peerBotName: string;
  direction: 'sent' | 'received';
  sequence: number;
  preview: string;
}

export interface BotDirectMessageItem {
  id: string;
  sequence: number;
  senderBotId: string;
  senderBotName: string;
  recipientBotId: string;
  recipientBotName: string;
  content: string;
  createdAt: number;
}

export interface BotDirectMessageThreadView {
  id: string;
  botAId: string;
  botAName: string;
  botBId: string;
  botBName: string;
  status: BotDirectMessageThreadStatus;
  closeReason: BotDirectMessageCloseReason;
  messageCount: number;
  maxMessages: number;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  messages: BotDirectMessageItem[];
}

export type BotDirectMessageThreadResult =
  | { ok: true; thread: BotDirectMessageThreadView }
  | { ok: false; errorCode: string; message: string };

export interface BotDirectMessageChangedPayload {
  threadId: string;
  participantBotIds: [string, string];
}

export function readBotDirectMessageMeta(value: unknown): BotDirectMessageMeta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.v !== 1) return null;
  if (typeof raw.threadId !== 'string' || !raw.threadId) return null;
  if (typeof raw.viewerBotId !== 'string' || !raw.viewerBotId) return null;
  if (typeof raw.peerBotId !== 'string' || !raw.peerBotId) return null;
  if (typeof raw.peerBotName !== 'string') return null;
  if (raw.direction !== 'sent' && raw.direction !== 'received') return null;
  if (typeof raw.sequence !== 'number' || !Number.isInteger(raw.sequence) || raw.sequence < 1) {
    return null;
  }
  if (typeof raw.preview !== 'string') return null;
  return {
    v: 1,
    threadId: raw.threadId,
    viewerBotId: raw.viewerBotId,
    peerBotId: raw.peerBotId,
    peerBotName: raw.peerBotName,
    direction: raw.direction,
    sequence: raw.sequence,
    preview: raw.preview,
  };
}

export const BOT_DIRECT_MESSAGE_CLIENT_ID = {
  timelineAnchor: (threadId: string, deliveryId: string, sessionId: string) =>
    `bot-dm-thread:${threadId}:${deliveryId}:${sessionId}`,
} as const;
