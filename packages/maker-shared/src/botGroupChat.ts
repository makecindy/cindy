/**
 * Bot group chat wire contract shared by Desktop main, preload and renderer.
 * Product rules: docs/product-rules/bot-group-chat.md.
 */

export const BOT_GROUP_MIN_MEMBERS = 2;
export const BOT_GROUP_MAX_MEMBERS = 6;
export const BOT_GROUP_NAME_MAX_CHARS = 40;
export const BOT_GROUP_MESSAGE_MAX_CHARS = 8_000;
export const BOT_GROUP_PAGE_SIZE = 100;

/** A Bot whose final reply is exactly this sentinel (after trim) stays silent. */
export const BOT_GROUP_NO_REPLY_SENTINEL = 'NO_REPLY';

export type BotGroupReplyMode = 'all' | 'mentioned';
/** `auto`: a broadcast round's first circle thinks in parallel; `sequential`: always one at a time. */
export type BotGroupSpeakingMode = 'auto' | 'sequential';
export type BotGroupAuthorKind = 'user' | 'bot' | 'system';
/** `round-end` marks a naturally finished round; `notice` carries `noticeCode`. */
export type BotGroupMessageKind = 'message' | 'round-end' | 'notice';
export type BotGroupNoticeCode = 'member-failed' | 'member-timeout' | 'member-unavailable';
export type BotGroupMemberStatus = 'active' | 'paused' | 'error' | 'archived' | 'deleting' | 'missing';

export interface BotGroupMention {
  all: boolean;
  botIds: string[];
}

export interface BotGroupMemberView {
  botId: string;
  name: string;
  avatar: string;
  avatarColor: string;
  status: BotGroupMemberStatus;
}

export interface BotGroupMessageView {
  id: string;
  sequence: number;
  kind: BotGroupMessageKind;
  authorKind: BotGroupAuthorKind;
  authorBotId: string | null;
  /** Name snapshot taken when the message was written. */
  authorName: string;
  content: string;
  mentions: BotGroupMention;
  noticeCode: BotGroupNoticeCode | null;
  createdAt: number;
}

export interface BotGroupLastMessage {
  authorKind: BotGroupAuthorKind;
  authorName: string;
  preview: string;
  createdAt: number;
}

export interface BotGroupSpeaker {
  botId: string;
  /** Hidden group lane Session of the speaking Bot, for pending permission/question UI. */
  sessionId: string | null;
}

export interface BotGroupRoundView {
  status: 'idle' | 'running';
  /** Bots currently taking their turn; several while a circle thinks in parallel. */
  speakers: BotGroupSpeaker[];
  /** True when the latest round ended naturally and may be continued. */
  canContinue: boolean;
}

export interface BotGroupSummary {
  id: string;
  name: string;
  replyMode: BotGroupReplyMode;
  speakingMode: BotGroupSpeakingMode;
  members: BotGroupMemberView[];
  lastMessage: BotGroupLastMessage | null;
  speakingBotIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface BotGroupDetail extends BotGroupSummary {
  /** Oldest first. */
  messages: BotGroupMessageView[];
  hasMoreBefore: boolean;
  round: BotGroupRoundView;
}

export type BotGroupErrorCode =
  | 'INVALID_PARAMS'
  | 'NOT_FOUND'
  | 'MEMBER_LIMIT'
  | 'MEMBER_UNAVAILABLE'
  | 'HOST_NOT_READY'
  | 'INTERNAL';

export interface BotGroupFailure {
  ok: false;
  errorCode: BotGroupErrorCode;
  message: string;
}

export type BotGroupListResult = { ok: true; groups: BotGroupSummary[] } | BotGroupFailure;
export type BotGroupGetResult = { ok: true; group: BotGroupDetail } | BotGroupFailure;
export type BotGroupCreateResult = { ok: true; groupId: string } | BotGroupFailure;
export type BotGroupMutationResult = { ok: true } | BotGroupFailure;
export type BotGroupSendResult = { ok: true; messageId: string } | BotGroupFailure;

export interface BotGroupCreateInput {
  name: string;
  botIds: string[];
}

export interface BotGroupUpdateInput {
  groupId: string;
  name?: string;
  replyMode?: BotGroupReplyMode;
  speakingMode?: BotGroupSpeakingMode;
}

export interface BotGroupSetMembersInput {
  groupId: string;
  /** Complete ordered member list. */
  botIds: string[];
}

export interface BotGroupSendInput {
  groupId: string;
  text: string;
  mentions: BotGroupMention;
  /** Renderer-generated idempotency key; a repeated id returns the original message. */
  clientId: string;
}

export interface BotGroupGetOptions {
  /** Load messages with a smaller sequence (older page). */
  beforeSequence?: number;
  limit?: number;
}

export type BotGroupChange = 'created' | 'updated' | 'deleted' | 'messages' | 'round';

export interface BotGroupChangedPayload {
  groupId: string;
  change: BotGroupChange;
}

export function isBotGroupNoReplyText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0 || trimmed === BOT_GROUP_NO_REPLY_SENTINEL;
}

/** True while streamed text could still turn out to be the silence sentinel. */
export function isBotGroupNoReplyPrefix(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0 || BOT_GROUP_NO_REPLY_SENTINEL.startsWith(trimmed);
}

export const BOT_GROUP_CLIENT_ID_PREFIX = 'bot-group:';

export const BOT_GROUP_CLIENT_ID = {
  memberTurn: (groupId: string, turnId: string, botId: string) =>
    `${BOT_GROUP_CLIENT_ID_PREFIX}${groupId}:${turnId}:${botId}`,
} as const;

export function isBotGroupClientId(clientId: string | null | undefined): boolean {
  return typeof clientId === 'string' && clientId.startsWith(BOT_GROUP_CLIENT_ID_PREFIX);
}

export function botGroupLaneRouteKey(groupId: string): string {
  return `group:${groupId}`;
}
