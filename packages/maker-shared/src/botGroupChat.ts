/**
 * Bot group chat wire contract shared by Desktop main, preload and renderer.
 * Product rules: docs/product-rules/bot-group-chat.md.
 */

export const BOT_GROUP_MIN_MEMBERS = 2;
export const BOT_GROUP_MAX_MEMBERS = 6;
export const BOT_GROUP_NAME_MAX_CHARS = 40;
export const BOT_GROUP_MESSAGE_MAX_CHARS = 8_000;
export const BOT_GROUP_PAGE_SIZE = 100;
/** 分工 (docs/product-rules/bot-group-chat.md §7). */
export const BOT_GROUP_PLAN_MAX_STEPS = 6;
export const BOT_GROUP_PLAN_TASK_MAX_CHARS = 80;
/** Files listed under one step's hand-off message. */
export const BOT_GROUP_STEP_FILES_MAX = 20;
/** Attachments on one user message (bot-group-chat.md §3.1); each one goes to every member. */
export const BOT_GROUP_ATTACHMENTS_MAX = 20;

/** A Bot whose final reply is exactly this sentinel (after trim) stays silent. */
export const BOT_GROUP_NO_REPLY_SENTINEL = 'NO_REPLY';

export type BotGroupReplyMode = 'all' | 'mentioned';
/** `auto`: a broadcast round's first circle thinks in parallel; `sequential`: always one at a time. */
export type BotGroupSpeakingMode = 'auto' | 'sequential';
export type BotGroupAuthorKind = 'user' | 'bot' | 'system';
/**
 * `round-end` marks a naturally finished round; `notice` carries `noticeCode`;
 * `plan` is the organizer's 安排卡 (see `planId`); `plan-end` closes a finished plan.
 */
export type BotGroupMessageKind = 'message' | 'round-end' | 'notice' | 'plan' | 'plan-end';
export type BotGroupNoticeCode =
  | 'member-joined'
  | 'member-failed'
  | 'member-timeout'
  | 'member-unavailable'
  /** The organizer could not produce a plan for an explicit 安排分工. */
  | 'plan-failed'
  | 'plan-stopped'
  | 'workdir-unavailable';
export type BotGroupMemberStatus = 'active' | 'paused' | 'error' | 'archived' | 'deleting' | 'missing';

export interface BotGroupMention {
  all: boolean;
  botIds: string[];
}

export interface BotGroupMemberView {
  /** Present for Chat Server members; botId remains the composer mention key. */
  actorId?: string;
  role?: 'owner' | 'admin' | 'member' | 'guest';
  displayName?: string;
  nickname?: string | null;
  ownerActorId?: string;
  ownerName?: string;
  isOwned?: boolean;
  avatarUrl?: string | null;
  guestAccess?: 'none' | 'chat' | 'tools';
  accessRevision?: number;
  actorKind?: 'human' | 'bot' | 'integration';
  isSelf?: boolean;
  botId: string;
  name: string;
  avatar: string;
  avatarColor: string;
  status: BotGroupMemberStatus;
}

export interface BotGroupMessageView {
  isSelf?: boolean;
  threadRootId?: string | null;
  replyCount?: number;
  reactions?: Array<{ emoji: string; count: number; me: boolean }>;
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
  /** The plan this message belongs to: the 安排卡, a step hand-off or the plan's end. */
  planId: string | null;
  /** Step hand-off files, relative to the plan's work directory (POSIX separators). */
  files: string[];
  /** What the user attached to this message (images, files, videos). */
  attachments: BotGroupAttachment[];
  createdAt: number;
}

export type BotGroupAttachmentCategory = 'image' | 'pdf' | 'text' | 'office' | 'file';

/**
 * An attachment as a composer hands it over, in the same serialized shape as a task
 * message attachment. On this computer `path` is the local file (a pasted image has a
 * placeholder) and an image carries its `cindy-media://` `url`; a phone sends its upload
 * reference in `path` (and `url` for an image).
 */
export interface BotGroupAttachmentInput {
  id: string;
  name: string;
  path: string;
  ext?: string;
  size?: number;
  category: BotGroupAttachmentCategory;
  mimeType: string;
  url?: string;
  originalName?: string;
  /** The image carries the user's drawn annotations (same meaning as in task messages). */
  annotated?: boolean;
}

/** An attachment kept with a group message. */
export interface BotGroupAttachment {
  id: string;
  name: string;
  category: BotGroupAttachmentCategory;
  mimeType: string;
  size: number;
  /** Images: the `cindy-media://` address; controllers read it through remote media. */
  url: string | null;
  /** The file on this computer; always null in a controller's copy. */
  path: string | null;
  annotated?: boolean;
}

/**
 * `proposed` waits for 开始; `running` has a step in progress; `waiting` stopped after a
 * step (done → 继续, failed → 重试); `done`, `stopped`, `dismissed` and `superseded` are final.
 */
export type BotGroupPlanStatus =
  | 'proposed'
  | 'running'
  | 'waiting'
  | 'done'
  | 'stopped'
  | 'dismissed'
  | 'superseded';
export type BotGroupPlanStepStatus = 'pending' | 'running' | 'done' | 'failed';

export interface BotGroupPlanStepView {
  position: number;
  botId: string;
  /** Name snapshot; the Bot may have been renamed or removed since. */
  botName: string;
  task: string;
  status: BotGroupPlanStepStatus;
}

export interface BotGroupPlanView {
  id: string;
  status: BotGroupPlanStatus;
  organizerBotId: string;
  organizerName: string;
  steps: BotGroupPlanStepView[];
  /** Step that is running, being redone, or last finished / failed; null before 开始. */
  currentStep: number | null;
  /** Absolute work directory once started; git plans run in their own worktree. */
  workDir: string | null;
  branch: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface BotGroupOpenPlanSummary {
  id: string;
  status: BotGroupPlanStatus;
  currentStep: number | null;
  stepCount: number;
  /** Bot of the current step (running, being redone, or last finished / failed). */
  currentBotName: string | null;
  currentStepStatus: BotGroupPlanStepStatus | null;
}

export function isBotGroupPlanOpen(status: BotGroupPlanStatus): boolean {
  return status === 'proposed' || status === 'running' || status === 'waiting';
}

export interface BotGroupLastMessage {
  isSelf?: boolean;
  authorKind: BotGroupAuthorKind;
  authorName: string;
  /** Optional for older hosts; localize system notices in the reader's language. */
  noticeCode?: BotGroupNoticeCode | null;
  preview: string;
  createdAt: number;
}

/** `reply`: answering in the chat; `planning`: the organizer is working out a plan; `step`: doing a plan step. */
export type BotGroupSpeakerActivity = 'reply' | 'planning' | 'step';

export interface BotGroupSpeaker {
  botId: string;
  /** Hidden group lane or 分工 Session of the speaking Bot, for pending permission/question UI. */
  sessionId: string | null;
  activity: BotGroupSpeakerActivity;
}

export interface BotGroupRoundView {
  status: 'idle' | 'running';
  /** Bots currently taking their turn; several while a circle thinks in parallel. */
  speakers: BotGroupSpeaker[];
  /** True when the latest round ended naturally and may be continued. */
  canContinue: boolean;
}

export interface BotGroupSummary {
  serverBacked?: boolean;
  archived?: boolean;
  migrationPending?: boolean;
  canInvite?: boolean;
  selfActorId?: string;
  topic?: string;
  description?: string;
  revision?: number;
  id: string;
  name: string;
  replyMode: BotGroupReplyMode;
  speakingMode: BotGroupSpeakingMode;
  members: BotGroupMemberView[];
  /** Effective organizer (负责人): the chosen member, else the first available one. */
  organizerBotId: string | null;
  /** 项目文件夹; null means the group's own folder. */
  projectDir: string | null;
  lastMessage: BotGroupLastMessage | null;
  /** Latest visible incoming message (Bot or another human), excluding self and runtime activity. Older hosts omit it. */
  lastReplyAt?: number;
  speakingBotIds: string[];
  /** The organizer while it works out a plan (sidebar 「正在安排」). */
  planningBotId: string | null;
  /** The group's open plan, if any (sidebar preview). */
  openPlan: BotGroupOpenPlanSummary | null;
  createdAt: number;
  updatedAt: number;
}

export interface BotGroupDetail extends BotGroupSummary {
  /** Oldest first. */
  messages: BotGroupMessageView[];
  hasMoreBefore: boolean;
  round: BotGroupRoundView;
  /** Plans referenced by the loaded messages, plus the open plan. */
  plans: BotGroupPlanView[];
}

export type BotGroupErrorCode =
  | 'INVALID_ATTACHMENT'
  | 'ATTACHMENT_UNAVAILABLE'
  | 'ATTACHMENT_TOO_LARGE'
  | 'MEDIA_UPLOAD_FAILED'
  | 'AUTH_REQUIRED'
  | 'CHAT_UNAVAILABLE'
  | 'IMPORT_PENDING'
  | 'REQUEST_TIMEOUT'
  | 'PERMISSION_DENIED'
  | 'SERVICE_ERROR'
  | 'GROUP_ARCHIVED'
  | 'INVALID_PARAMS'
  | 'NOT_FOUND'
  | 'MEMBER_LIMIT'
  | 'MEMBER_UNAVAILABLE'
  | 'MENTION_UNAVAILABLE'
  | 'HOST_NOT_READY'
  /** An explicit 安排分工 while a plan is running or waiting. */
  | 'PLAN_OPEN'
  /** The plan already ended, was replaced, or is in a state that does not allow the action. */
  | 'PLAN_CLOSED'
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
  /** null resets to the first available member. */
  organizerBotId?: string | null;
  /** Absolute existing local directory; null uses the group's own folder. */
  projectDir?: string | null;
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
  /** 「+」→ 安排分工: always ask the organizer for a plan instead of deciding. */
  division?: boolean;
  /** At most `BOT_GROUP_ATTACHMENTS_MAX`; with attachments the text may be empty. */
  attachments?: BotGroupAttachmentInput[];
}

export interface BotGroupPlanActionInput {
  groupId: string;
  planId: string;
}

export type BotGroupPlanAction = 'start' | 'dismiss' | 'continue' | 'retry';

export interface BotGroupPlanEditInput extends BotGroupPlanActionInput {
  position: number;
  /** `reassign` needs `botId`; `remove` keeps at least one step. Proposed plans only. */
  action: 'reassign' | 'remove';
  botId?: string;
}

export interface BotGroupGetOptions {
  /** Load messages with a smaller sequence (older page). */
  beforeSequence?: number;
  limit?: number;
}

export type BotGroupChange = 'created' | 'updated' | 'deleted' | 'messages' | 'round' | 'plan';

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

// ---- Controllers (phones) — docs/product-rules/bot-group-chat.md §8 -------------

/**
 * Groups reach controllers through the Remote Resource protocol (collection below), not
 * dedicated channels. The host keeps every rule; controllers only render and invoke actions.
 */
export const BOT_GROUP_REMOTE_COLLECTION_ID = 'bot-groups';
export const BOT_GROUP_REMOTE_RESOURCE_KIND = 'bot-group';
/** Block primitive whose `data` is `BotGroupRemoteChatData`; only sent to controllers declaring it. */
export const BOT_GROUP_CHAT_PRIMITIVE = 'bot-group-chat';
/** Collection item link to each member (`teammates` resource), in member order. */
export const BOT_GROUP_MEMBER_LINK_REL = 'member';

/**
 * Remote actions. `create` is collection-level ({ name, botIds }); the others target a group:
 * `send` ({ text, mentions, clientId, division? }), `continue`, `stop`, `update`
 * ({ name?, replyMode?, speakingMode?, organizerBotId? } — never a host path),
 * `set-members` ({ botIds }), `remove-member` ({ actorId }, capability-gated), `delete`, `plan-start` / `plan-dismiss` / `plan-continue` /
 * `plan-retry` ({ planId }) and `plan-edit` ({ planId, position, action, botId? }).
 * A refused action fails with the `BotGroupErrorCode` as its message.
 */
export type BotGroupRemoteActionId =
  | 'create'
  | 'send'
  | 'continue'
  | 'stop'
  | 'update'
  | 'set-members'
  | 'remove-member'
  | 'delete'
  | 'plan-start'
  | 'plan-dismiss'
  | 'plan-continue'
  | 'plan-retry'
  | 'plan-edit';

/**
 * The group as a controller sees it. Host paths never leave the computer: `projectDir`
 * and every plan `workDir` are null, and `projectDirName` names the folder.
 */
export interface BotGroupRemoteChatData extends BotGroupDetail {
  projectDirName: string | null;
  /**
   * The computer accepts attachments on `send` (absent on older computers, which would
   * drop them). Attachment `path`s are always null here.
   */
  supportsAttachments?: boolean;
  /** Host supports removing one server actor, including a human. */
  supportsMemberRemoval?: boolean;
}

export const BOT_GROUP_CLIENT_ID_PREFIX = 'bot-group:';

export const BOT_GROUP_CLIENT_ID = {
  memberTurn: (groupId: string, turnId: string, botId: string) =>
    `${BOT_GROUP_CLIENT_ID_PREFIX}${groupId}:${turnId}:${botId}`,
  planStep: (groupId: string, planId: string, position: number, turnId: string) =>
    `${BOT_GROUP_CLIENT_ID_PREFIX}${groupId}:plan:${planId}:${position}:${turnId}`,
} as const;

export function isBotGroupClientId(clientId: string | null | undefined): boolean {
  return typeof clientId === 'string' && clientId.startsWith(BOT_GROUP_CLIENT_ID_PREFIX);
}

/** The server chooses the grant. Different grants never reuse private model context. */
export interface ChatLaneAccess { mode: 'owner' | 'chat' | 'tools'; revision: number }
export function chatGroupLaneRouteKey(groupId: string, access: ChatLaneAccess): string {
  return `group:${groupId}:access:${access.mode}:${access.revision}`;
}
export function isChatOnlyGroupLane(routeKey: string | null | undefined): boolean {
  return /^group:[^:]+:access:chat:[1-9][0-9]*(?::plan:[^:]+)?$/.test(routeKey ?? '');
}

export function botGroupLaneRouteKey(groupId: string): string {
  return `group:${groupId}`;
}

/** 分工 Session of one Bot for one plan; shares the lane's `role = 'group'`. */
export function botGroupPlanRouteKey(groupId: string, planId: string): string {
  return `${botGroupPlanRouteKeyPrefix(groupId)}${planId}`;
}

export function botGroupPlanRouteKeyPrefix(groupId: string): string {
  return `group:${groupId}:plan:`;
}

/** Plan id of a 分工 Session route key, or null for lanes and other routes. */
export function parseBotGroupPlanRouteKey(routeKey: string | null | undefined): { groupId: string; planId: string } | null {
  const match = typeof routeKey === 'string' ? /^group:([^:]+)(?::access:(?:owner|tools|chat):[1-9][0-9]*)?:plan:([^:]+)$/.exec(routeKey) : null;
  return match ? { groupId: match[1]!, planId: match[2]! } : null;
}


/** Named, credential-free Desktop chat capabilities. Older/local-only hosts omit them. */
export type ChatServerResult<T> = ({ ok: true } & T) | { ok: false; errorCode: string };
export interface ChatInvitePreview {
  groupId: string; name: string; inviterName: string; expiresAt: string | null; joined: boolean;
  /** Omitted by old servers, whose links remain dated and single-use. */
  reusable?: boolean;
}
export type ChatGroupAction =
  | { type: 'update'; name: string; topic: string; description: string; expectedRevision: number; responseMode?: BotGroupReplyMode; speakingMode?: BotGroupSpeakingMode }
  | { type: 'nickname'; actorId: string; nickname: string | null }
  | { type: 'member'; actorId: string; action: 'invite' | 'leave' | 'remove' | 'ban' | 'unban' | 'role'; role?: 'admin' | 'member' }
  | { type: 'transfer'; actorId: string }
  | { type: 'botAccess'; actorId: string; access: 'none' | 'chat' | 'tools'; expectedRevision: number }
  | { type: 'archive'; archived: boolean; expectedRevision: number };
export interface ChatServerApi {
  manage(input: { groupId: string; action: ChatGroupAction }): Promise<ChatServerResult<Record<never, never>>>;
  ownedBots(): Promise<ChatServerResult<{ bots: Array<{ actorId: string; name: string }> }>>;
  refreshProfile(): Promise<ChatServerResult<Record<never, never>>>;
  status(): Promise<{ enabled: boolean; connected: boolean }>;
  thread(input: { groupId: string; rootId: string; before?: number }): Promise<ChatServerResult<{
    root: BotGroupMessageView; replies: BotGroupMessageView[]; hasMore: boolean;
  }>>;
  reply(input: { groupId: string; rootId: string; text: string; clientId: string; mentions: BotGroupMention }): Promise<ChatServerResult<{ messageId: string }>>;
  react(input: { groupId: string; messageId: string; emoji: string; present: boolean }): Promise<ChatServerResult<Record<never, never>>>;
  createInvite(input: { groupId: string; clientId: string }): Promise<ChatServerResult<{ link: string; expiresAt: string | null; reusable?: boolean }>>;
  revokeInvite(input: { groupId: string; link: string; clientId: string }): Promise<ChatServerResult<{ revoked: true }>>;
  previewInvite(input: { link: string }): Promise<ChatServerResult<ChatInvitePreview>>;
  acceptInvite(input: { link: string; clientId: string }): Promise<ChatServerResult<{ groupId: string }>>;
}
