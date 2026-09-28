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
  /** The plan this message belongs to: the 安排卡, a step hand-off or the plan's end. */
  planId: string | null;
  /** Step hand-off files, relative to the plan's work directory (POSIX separators). */
  files: string[];
  createdAt: number;
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
  authorKind: BotGroupAuthorKind;
  authorName: string;
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
  | 'INVALID_PARAMS'
  | 'NOT_FOUND'
  | 'MEMBER_LIMIT'
  | 'MEMBER_UNAVAILABLE'
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
  const match = typeof routeKey === 'string' ? /^group:([^:]+):plan:([^:]+)$/.exec(routeKey) : null;
  return match ? { groupId: match[1]!, planId: match[2]! } : null;
}
