/**
 * Bot group chat wire contract shared by Desktop main, preload and renderer.
 * Product rules: docs/product-rules/bot-group-chat.md.
 */
import type { BotGroupQuoteInput, BotGroupQuoteView } from './botGroupQuote';
import type { BotGroupTaskCardView } from './botGroupTask';

export * from './botGroupQuote';
export * from './botGroupTask';

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

/** Public failure categories only; never transport raw Agent errors into a group. */
export const BOT_GROUP_RUNTIME_FAILURE_CODES = [
  'IMAGE_INPUT_UNSUPPORTED', 'MODEL_UNAVAILABLE', 'AUTH_REQUIRED', 'RATE_LIMITED', 'UPSTREAM_OVERLOADED',
  'QUOTA_EXCEEDED', 'NETWORK_ERROR', 'RUNTIME_TIMEOUT', 'RUNTIME_ERROR',
] as const;
export type BotGroupRuntimeFailureCode = typeof BOT_GROUP_RUNTIME_FAILURE_CODES[number];
export function isBotGroupRuntimeFailureCode(value: unknown): value is BotGroupRuntimeFailureCode {
  return typeof value === 'string' && BOT_GROUP_RUNTIME_FAILURE_CODES.some(code => code === value);
}

/** Current execution state, separate from persisted/paginated chat messages. */
export interface BotGroupExecutionFailureView {
  executionId: string;
  epoch: number;
  sourceMessageId: string;
  botId: string;
  botName: string;
  code: BotGroupRuntimeFailureCode;
  planId: string | null;
  updatedAt?: number;
}

/** Decode only public fields from Chat Server; legacy /executions rows also work. */
export function readBotGroupExecutionFailure(value: unknown, roomId: string): BotGroupExecutionFailureView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if ((row.status !== undefined && row.status !== 'failed')
    || (row.conversation_id !== undefined && row.conversation_id !== roomId)
    || typeof row.id !== 'string' || !row.id || typeof row.source_message_id !== 'string' || !row.source_message_id
    || typeof row.bot_id !== 'string' || !row.bot_id
    || typeof row.epoch !== 'number' || !Number.isSafeInteger(row.epoch) || row.epoch < 0) return null;
  const updatedAt = typeof row.updated_at === 'string' ? Date.parse(row.updated_at) : NaN;
  return { executionId: row.id, epoch: row.epoch, sourceMessageId: row.source_message_id,
    botId: row.bot_id, botName: '', code: isBotGroupRuntimeFailureCode(row.failure_code) ? row.failure_code : 'RUNTIME_ERROR',
    planId: typeof row.plan_id === 'string' ? row.plan_id : null,
    ...(Number.isFinite(updatedAt) ? { updatedAt } : {}) };
}

/** Persisted local notice marker; migration carries the category as card metadata. */
export const BOT_GROUP_RUNTIME_FAILURE_PREFIX = 'cindy-runtime-error:';
export function botGroupRuntimeFailureDetail(code: BotGroupRuntimeFailureCode): string {
  return `${BOT_GROUP_RUNTIME_FAILURE_PREFIX}${code}`;
}
export function readBotGroupRuntimeFailureDetail(value: unknown): BotGroupRuntimeFailureCode | undefined {
  if (typeof value !== 'string' || !value.startsWith(BOT_GROUP_RUNTIME_FAILURE_PREFIX)) return undefined;
  const code = value.slice(BOT_GROUP_RUNTIME_FAILURE_PREFIX.length);
  return isBotGroupRuntimeFailureCode(code) ? code : undefined;
}

/** Only a server-stamped import of a system notice can supply historical failure metadata. */
export function readImportedBotGroupRuntimeFailureCode(message: {
  origin?: unknown; deleted?: unknown;
  content: readonly { type?: unknown; namespace?: unknown; schemaRevision?: unknown; data?: unknown; text?: unknown; fallback?: unknown }[];
}): BotGroupRuntimeFailureCode | undefined {
  if (message.origin !== 'import' || message.deleted === true) return undefined;
  const card = message.content.find(block => block.type === 'card' && block.namespace === 'cindy.local-history' && block.schemaRevision === 1);
  if (!card?.data || typeof card.data !== 'object' || Array.isArray(card.data)) return undefined;
  const data = card.data as Record<string, unknown>;
  if (data.kind !== 'notice' || data.authorKind !== 'system') return undefined;
  if (isBotGroupRuntimeFailureCode(data.runtimeFailureCode)) return data.runtimeFailureCode;
  // Compatibility with notices imported before the metadata projection existed.
  for (const block of message.content) {
    const code = readBotGroupRuntimeFailureDetail(block.type === 'text' ? block.text : block === card ? block.fallback : undefined);
    if (code) return code;
  }
  return undefined;
}

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
  /** The computer running this owned companion (its Chat Server actor home); live task cards read there. */
  homeDeviceId?: string | null;
  avatarUrl?: string | null;
  /** Explicit group-only override; null follows the account avatar. */
  groupAvatar?: string | null;
  defaultAvatarUrl?: string | null;
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
  /** Server tombstone; it cannot anchor a runtime failure notice. */
  deleted?: boolean;
  isSelf?: boolean;
  threadRootId?: string | null;
  replyCount?: number;
  /** 引用回复: the earlier main-timeline message this one quotes; not a Thread parent. */
  quote?: BotGroupQuoteView;
  /** An independent task this teammate started from the group (bot-group-chat.md §10). */
  task?: BotGroupTaskCardView;
  reactions?: Array<{ emoji: string; count: number; me: boolean }>;
  id: string;
  sequence: number;
  /** Stable decimal server position; presentation indices can change when history is loaded. */
  serverSequence?: string;
  kind: BotGroupMessageKind;
  authorKind: BotGroupAuthorKind;
  authorBotId: string | null;
  /** Name snapshot taken when the message was written. */
  authorName: string;
  content: string;
  mentions: BotGroupMention;
  noticeCode: BotGroupNoticeCode | null;
  /** Localized cause and remedy for a failed execution; raw diagnostics stay on the executor. */
  runtimeFailureCode?: BotGroupRuntimeFailureCode;
  /** The plan this message belongs to: the 安排卡, a step hand-off or the plan's end. */
  planId: string | null;
  /** Step hand-off files, relative to the plan's work directory (POSIX separators). */
  files: string[];
  /** What the user attached to this message (images, files, videos). */
  attachments: BotGroupAttachment[];
  createdAt: number;
  /** Thread roots only: the newest replies, shown in the main chat without opening the thread. */
  threadPreview?: BotGroupThreadPreview;
  /**
   * Thread roots only: replies from others since this reader last opened the Thread, by the
   * server's read state. Omitted when the server keeps no read state (older servers).
   */
  threadUnread?: BotGroupThreadUnread;
  /** A main-chat message that re-posts an existing thread reply by reference. */
  threadShare?: BotGroupThreadShareView;
}

/** Unread replies of one Thread; `mentioned` when one of them names this reader. */
export interface BotGroupThreadUnread {
  count: number;
  mentioned: boolean;
  /** Sequence of the newest unread reply; tells a new reply apart from the same ones counted again. */
  latest?: number;
}

/**
 * One Thread of the group for the in-chat 话题 list (bot-group-chat.md §10「话题未读与提示」).
 * Root text and author come from the server's copy; empty while that copy is still being read.
 */
export interface BotGroupThreadSummary {
  rootId: string;
  rootAuthorName: string;
  rootAuthorBotId: string | null;
  rootText: string;
  replyCount: number;
  unread: BotGroupThreadUnread;
  /** The reader chose to follow it; absent when the server keeps no read state. */
  following?: boolean;
  lastReply: { authorName: string; text: string; createdAt: number } | null;
}

/** Spoken summaries and distinct responders have independent limits. */
export const BOT_GROUP_THREAD_PREVIEW_REPLIES = 2;
export const BOT_GROUP_THREAD_PREVIEW_RESPONDERS = 3;

/**
 * Main-chat share of a thread reply. The card stores only the two IDs; clients resolve the
 * author, text and files from the server's copy of the reply, so a card cannot put words
 * in someone else's name. `fallback` keeps older clients readable.
 */
export const BOT_GROUP_THREAD_SHARE_NAMESPACE = 'cindy.thread-share';
const THREAD_SHARE_REVISION = 1;
const THREAD_SHARE_FALLBACK_TEXT_MAX = 280;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One share per person and reply: retries and repeats replay the same server operation. */
export function botGroupThreadShareOperationId(messageId: string): string {
  return `thread-share:${messageId}`;
}

export function buildBotGroupThreadShareCard(input: { messageId: string; threadRootId: string; authorName: string; text: string }) {
  const text = input.text.replace(/\s+/g, ' ').trim();
  const clipped = text.length > THREAD_SHARE_FALLBACK_TEXT_MAX ? `${text.slice(0, THREAD_SHARE_FALLBACK_TEXT_MAX)}…` : text;
  const author = input.authorName.trim() || '…';
  return {
    type: 'card' as const, namespace: BOT_GROUP_THREAD_SHARE_NAMESPACE, schemaRevision: THREAD_SHARE_REVISION,
    fallback: clipped ? `↪ ${author}: ${clipped}` : `↪ ${author}`,
    data: { messageId: input.messageId, threadRootId: input.threadRootId },
  };
}

export function readBotGroupThreadShareCard(message: {
  deleted?: unknown; threadRootId?: unknown;
  content: readonly { type?: unknown; namespace?: unknown; schemaRevision?: unknown; data?: unknown }[];
}): { messageId: string; threadRootId: string } | null {
  // A share lives in the main chat; a card copied into a thread is just content.
  if (message.deleted === true || (message.threadRootId !== null && message.threadRootId !== undefined)) return null;
  // Classify the whole message, not a block: hiding mixed content would disagree with Agent history.
  if (message.content.length !== 1) return null;
  const card = message.content[0];
  if (card?.type !== 'card' || card.namespace !== BOT_GROUP_THREAD_SHARE_NAMESPACE
    || card.schemaRevision !== THREAD_SHARE_REVISION) return null;
  if (!card?.data || typeof card.data !== 'object' || Array.isArray(card.data)) return null;
  const { messageId, threadRootId } = card.data as Record<string, unknown>;
  if (typeof messageId !== 'string' || typeof threadRootId !== 'string' || !UUID.test(messageId) || !UUID.test(threadRootId)
    || messageId === threadRootId) return null;
  return { messageId, threadRootId };
}

export interface BotGroupThreadPreviewReply {
  id: string;
  authorKind: BotGroupAuthorKind;
  authorBotId: string | null;
  authorName: string;
  isSelf?: boolean;
  /** Plain text; empty when the reply only carries attachments. */
  text: string;
  /** Names only: a preview never downloads the reply's files. */
  attachments: Array<{ name: string; category: BotGroupAttachmentCategory }>;
  createdAt: number;
}

export interface BotGroupThreadPreview {
  /** Chronological, newest last. */
  replies: BotGroupThreadPreviewReply[];
  /** Distinct server authors from the fetched window, oldest last-reply first. Older hosts omit this. */
  responders?: Array<Pick<BotGroupThreadPreviewReply, 'id' | 'authorKind' | 'authorBotId' | 'authorName'>>;
}

/**
 * The reply a main-chat share points at. Everything except the IDs is read from the
 * server's current copy of that reply, never from what the sharer's card claims.
 */
export interface BotGroupThreadShareView {
  messageId: string;
  /** The thread the reply stays in; sharing never moves it. */
  threadRootId: string;
  /**
   * `loading`: the reply is still being read. `unavailable`: deleted, outside this reader's
   * history, or not a reply in `threadRootId`. Neither shows the card's fallback text.
   */
  status: 'available' | 'loading' | 'unavailable';
  authorKind: BotGroupAuthorKind;
  authorBotId: string | null;
  authorName: string;
  /** The sharer wrote the reply themselves (sent to the thread and the main chat). */
  sharedByAuthor: boolean;
  content: string;
  attachments: BotGroupAttachment[];
  createdAt: number | null;
  edited: boolean;
  /** Cache version this view was checked at; compare with `BotGroupDetail.threadShareVersion`. */
  version?: number;
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
  /**
   * A server attachment whose bytes are not on this computer yet: `loading` until the
   * download settles, `unavailable` after it failed (a later read retries). `url` and
   * `path` are null and only `id` and `name` are known. Absent once the file is here.
   */
  state?: 'loading' | 'unavailable';
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
  /** The step's latest hand-off message (a redo replaces it); absent where the host does not report it. */
  resultMessageId?: string | null;
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
  /** Server groups: `talk` queues teammates answering in turn (the first five go on by themselves); `work` divides work into steps. */
  kind?: 'talk' | 'work';
  /** Server groups: the viewer may continue or stop it (creator, owner or admin). */
  canManage?: boolean;
  /** Server groups: what the viewer sends without naming anyone goes to the step under way (creator, or a human owner/admin). */
  canAdd?: boolean;
  /**
   * Server 分工: this computer starts the next step once one is done, instead of waiting for 继续.
   * A choice of the computer that made it, not shared chat state; absent where unsupported.
   */
  autoContinue?: boolean;
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
  /** Server groups: a queue of teammates answering in turn (`talk`) or a division of work. */
  kind?: 'talk' | 'work';
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
  /** The latest message re-posts a thread reply; `preview` is then empty, never the card's text. */
  threadShare?: boolean;
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
  /** Server groups: someone else's request or teammate is also working, so stopping only yours leaves it running. */
  othersActive?: boolean;
}

export interface BotGroupSummary {
  /** Explicit direct-message landing; group management remains unavailable. */
  conversationKind?: 'direct' | 'group';
  serverBacked?: boolean;
  /** Authoritative unread window for this account, including followed thread replies. */
  serverUnread?: { count: number; mentioned: boolean };
  /** Explicit server capabilities; absent on old servers/hosts. */
  supportsDissolve?: boolean;
  /** Upgraded host forwards leave explicitly; absent on old compatibility hosts. */
  supportsGroupLeave?: boolean;
  supportsListRemoval?: boolean;
  supportsMemberAvatar?: boolean;
  dissolvedAt?: string | null;
  archived?: boolean;
  migrationPending?: boolean;
  canInvite?: boolean;
  /** Server groups: an owner or admin may also stop everyone's work, not only their own. */
  canStopAll?: boolean;
  /**
   * Server groups whose server gives each request one teammate (the lead when nobody is named)
   * and arranges turns itself; no speaking modes (bot-group-chat.md §4).
   */
  singleSpeaker?: boolean;
  /** A single-speaker group whose computer arranges 「安排分工」 (older computers answered it as a queue). */
  supportsDivision?: boolean;
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
  /**
   * Server groups: 分工 you start here go on to the next step by themselves instead of waiting
   * for 继续 (§7.4). Kept on this computer like the project folder; absent where unsupported.
   */
  autoContinue?: boolean;
  lastMessage: BotGroupLastMessage | null;
  /** Latest visible incoming message (Bot or another human), excluding self and runtime activity. Older hosts omit it. */
  lastReplyAt?: number;
  /**
   * ISO `createdAt` of the newest (up to 99) messages from someone else — Bots and other people,
   * not this account, notices, round/plan endings or system events — oldest first. Derived from
   * the messages the host already read. Older hosts omit it.
   */
  incomingMessageTimes?: string[];
  speakingBotIds: string[];
  /** The organizer while it works out a plan (sidebar 「正在安排」). */
  planningBotId: string | null;
  /** The group's open plan, if any (sidebar preview). */
  openPlan: BotGroupOpenPlanSummary | null;
  createdAt: number;
  updatedAt: number;
}

export interface BotGroupDetail extends BotGroupSummary {
  /** Durable cache generation. A changed value discards pages from a previous history/permission boundary. */
  historyRevision?: string;
  /** Current authorized versions of already displayed messages, including deletion tombstones. */
  messageUpdates?: BotGroupMessageView[];
  /** Room-wide; bumped when a reset skipped realtime events or the chat runtime was recreated, so every message's reactors count as changed. */
  reactionRevision?: number;
  /** Per message id; bumped by realtime reaction changes, so a same-count change of who reacted is noticed. */
  reactionRevisions?: Record<string, number>;
  /** Oldest first. */
  messages: BotGroupMessageView[];
  /** Authorized current failures, independent of message pagination. Local/older hosts omit this. */
  executionFailures?: BotGroupExecutionFailureView[];
  /** Current state of shares the reader listed in `shownShares`, keyed by the share's message ID. */
  threadShareUpdates?: Record<string, BotGroupThreadShareView>;
  /** Raised by every edit, deletion or reset; an older share view may no longer be true. */
  threadShareVersion?: number;
  hasMoreBefore: boolean;
  round: BotGroupRoundView;
  /** Plans referenced by the loaded messages, plus the open plan. */
  plans: BotGroupPlanView[];
  /**
   * Threads with replies in the newest window, unread ones first. Omitted by local groups,
   * older hosts and servers without read state.
   */
  threads?: BotGroupThreadSummary[];
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
  | 'GROUP_DISSOLVED'
  | 'LIFECYCLE_UNAVAILABLE'
  | 'LAST_OWNER'
  | 'INVALID_PARAMS'
  | 'REVISION_CONFLICT'
  | 'NOT_FOUND'
  | 'MEMBER_LIMIT'
  | 'MEMBER_UNAVAILABLE'
  | 'MENTION_UNAVAILABLE'
  | 'HOST_NOT_READY'
  /** An explicit 安排分工 while a plan is running or waiting. */
  | 'PLAN_OPEN'
  /** The plan already ended, was replaced, or is in a state that does not allow the action. */
  | 'PLAN_CLOSED'
  /** The quoted message was deleted, moved out of reach or never belonged to this timeline. */
  | 'QUOTE_UNAVAILABLE'
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
  /** Optional optimistic precondition for server-backed settings. */
  expectedRevision?: number;
  name?: string;
  replyMode?: BotGroupReplyMode;
  speakingMode?: BotGroupSpeakingMode;
  /** null resets to the first available member. */
  organizerBotId?: string | null;
  /** Absolute existing local directory; null uses the group's own folder. */
  projectDir?: string | null;
  /** Server groups: whether 分工 you start go on by themselves (kept on this computer). */
  autoContinue?: boolean;
}

export interface BotGroupSetMembersInput {
  groupId: string;
  /** Complete ordered member list. */
  botIds: string[];
  /** Server-backed additive invite; preserves every existing member. */
  addOnly?: boolean;
}

export interface BotGroupSendInput {
  conversationKind?: 'direct';
  groupId: string;
  text: string;
  mentions: BotGroupMention;
  /** Renderer-generated idempotency key; a repeated id returns the original message. */
  clientId: string;
  /** 「+」→ 安排分工: always ask the organizer for a plan instead of deciding. */
  division?: boolean;
  /** At most `BOT_GROUP_ATTACHMENTS_MAX`; with attachments the text may be empty. */
  attachments?: BotGroupAttachmentInput[];
  /** 引用回复 on a server group; the host reads the message itself. A quote alone is not a message. */
  quote?: BotGroupQuoteInput;
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
  /** Local display snapshot only; callers separately request current server state. */
  cacheOnly?: boolean;
  conversationKind?: 'direct';
  /** Load messages with a smaller sequence (older page). */
  beforeSequence?: number;
  limit?: number;
  /** Reconcile execution state for real messages already displayed on older pages. */
  sourceMessageIds?: string[];
  /** Shares already shown from older pages, so edits and deletions reach them without a reload. */
  shownShares?: Array<{ id: string; messageId: string; threadRootId: string; sharerId?: string }>;
}

export type BotGroupChange = 'created' | 'updated' | 'deleted' | 'messages' | 'round' | 'plan' | 'list';

export interface BotGroupChangedPayload {
  groupId: string;
  change: BotGroupChange;
  /** Personal state, only emitted after an authoritative account-scoped reply/event. */
  listState?: { hidden: boolean; revision: number };
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
 * `set-members` ({ botIds }), `dissolve` ({ expectedRevision }), `leave`, `hide`, `remove-member` ({ actorId }, capability-gated), `delete`, `plan-start` / `plan-dismiss` / `plan-continue` /
 * `plan-retry` ({ planId }) and `plan-edit` ({ planId, position, action, botId? }).
 * A refused action fails with the `BotGroupErrorCode` as its message.
 */
export type BotGroupRemoteActionId =
  | 'create'
  | 'read'
  | 'send'
  | 'continue'
  | 'stop'
  | 'update'
  | 'set-members'
  | 'add-member'
  | 'remove-member'
  | 'delete'
  | 'dissolve'
  | 'leave'
  | 'hide'
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
  /** Host forwards a measured main-timeline read to the chat server. Older hosts omit it. */
  supportsReadReceipts?: boolean;
  /**
   * The computer accepts attachments on `send` (absent on older computers, which would
   * drop them). Attachment `path`s are always null here.
   */
  supportsAttachments?: boolean;
  /** Host supports removing one server actor, including a human. */
  supportsMemberRemoval?: boolean;
  /** Revision-checked settings and additive `add-member` ({ botId }) on server groups. */
  supportsSettingsManagement?: boolean;
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
  return /^group:[^:]+:access:chat:[1-9][0-9]*(?::plan:[^:]+|:thread:[^:]+|:talk:[^:]+)?$/.test(routeKey ?? '');
}

/**
 * A queue's own lane (bot-group-chat.md §7.0): one hidden Session per queue, grant and teammate,
 * so each turn reads only its card. It talks in the group lane's place, never a project folder.
 */
export function chatGroupTalkRouteKey(groupId: string, access: ChatLaneAccess, planId: string): string {
  return `${chatGroupLaneRouteKey(groupId, access)}:talk:${planId}`;
}

/**
 * A Thread's own lane: one hidden Session per Thread, grant and teammate, so a Thread
 * keeps its own short context apart from the main group and other Threads (bot-group-chat.md §3).
 */
export function chatGroupThreadRouteKey(groupId: string, access: ChatLaneAccess, threadRootId: string): string {
  return `${chatGroupLaneRouteKey(groupId, access)}:thread:${threadRootId}`;
}

/** Group and Thread root of a Thread lane route key, or null for other routes. */
export function parseBotGroupThreadRouteKey(routeKey: string | null | undefined): { groupId: string; threadRootId: string } | null {
  const match = typeof routeKey === 'string' ? /^group:([^:]+):access:(?:owner|tools|chat):[1-9][0-9]*:thread:([^:]+)$/.exec(routeKey) : null;
  return match ? { groupId: match[1]!, threadRootId: match[2]! } : null;
}

/** The group lane a Thread or queue lane belongs to; both work in the same place as their group lane. */
export function groupLaneOfRouteKey(routeKey: string): string {
  return routeKey.replace(/:(?:thread|talk):[^:]+$/, '');
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

/** Group id of any lane or 分工 Session route key (`group:<groupId>…`), or null for other routes. */
export function parseBotGroupIdFromRouteKey(routeKey: string | null | undefined): string | null {
  const match = typeof routeKey === 'string' ? /^group:([^:]+)(?::|$)/.exec(routeKey) : null;
  return match ? match[1]! : null;
}

/** Plan id of a 分工 Session route key, or null for lanes and other routes. */
export function parseBotGroupPlanRouteKey(routeKey: string | null | undefined): { groupId: string; planId: string } | null {
  const match = typeof routeKey === 'string' ? /^group:([^:]+)(?::access:(?:owner|tools|chat):[1-9][0-9]*)?:plan:([^:]+)$/.exec(routeKey) : null;
  return match ? { groupId: match[1]!, planId: match[2]! } : null;
}


/** Named, credential-free Desktop chat capabilities. Older/local-only hosts omit them. */
export type ChatServerResult<T> = ({ ok: true } & T) | { ok: false; errorCode: string };
/** One reacting actor. `name` is null when the group has no member record for it. */
export interface ChatReactor { actorId: string; name: string | null; isSelf: boolean; formerMember: boolean }
export interface ChatInvitePreview {
  groupId: string; name: string; inviterName: string; expiresAt: string | null; joined: boolean;
  /** Omitted by old servers, whose links remain dated and single-use. */
  reusable?: boolean;
}
export type ChatGroupAction =
  | { type: 'read'; messageId: string; conversationKind?: 'direct' }
  | { type: 'update'; name: string; topic: string; description: string; expectedRevision: number; responseMode?: BotGroupReplyMode; speakingMode?: BotGroupSpeakingMode }
  | { type: 'nickname'; actorId: string; nickname: string | null }
  | { type: 'avatar'; actorId: string; avatar: { type: 'keep' | 'reset' } | { type: 'set'; data: Uint8Array; mimeType: string } }
  | { type: 'member'; actorId: string; action: 'invite' | 'leave' | 'remove' | 'ban' | 'unban' | 'role'; role?: 'admin' | 'member' }
  | { type: 'transfer'; actorId: string }
  | { type: 'botAccess'; actorId: string; access: 'none' | 'chat' | 'tools'; expectedRevision: number }
  | { type: 'dissolve'; expectedRevision: number }
  | { type: 'hide' }
  | { type: 'archive'; archived: boolean; expectedRevision: number };
export interface ChatServerApi {
  manage(input: { groupId: string; action: ChatGroupAction }): Promise<ChatServerResult<{ listState?: { conversationId: string; hidden: boolean; revision: number } }>>;
  /** `botId` is the local teammate id behind each Chat Server actor. */
  ownedBots(): Promise<ChatServerResult<{ bots: Array<{ actorId: string; botId?: string; name: string }> }>>;
  refreshProfile(): Promise<ChatServerResult<Record<never, never>>>;
  status(): Promise<{ enabled: boolean; connected: boolean }>;
  /**
   * `markRead` (latest page only): the reader is looking at the Thread, so its server read state
   * moves to the newest reply read here; `readBefore` is where it stood before this read.
   * `following` (latest page only) is whether the reader follows the Thread; absent when the
   * server keeps no read state.
   */
  thread(input: { groupId: string; rootId: string; before?: number; sourceMessageIds?: string[]; markRead?: boolean }): Promise<ChatServerResult<{
    root: BotGroupMessageView; replies: BotGroupMessageView[]; hasMore: boolean;
    /** Same authoritative state as the main timeline; root and replies use one projection. */
    executionFailures?: BotGroupExecutionFailureView[];
    readBefore?: number;
    following?: boolean;
  }>>;
  /**
   * Sets whether the reader follows a Thread (bot-group-chat.md §10「关注开关」) and answers what
   * the server saved. Only the reader's own choice ever follows a Thread.
   */
  followThread(input: { groupId: string; rootId: string; following: boolean }): Promise<ChatServerResult<{ following: boolean }>>;
  reply(input: { groupId: string; rootId: string; text: string; clientId: string; mentions: BotGroupMention }): Promise<ChatServerResult<{ messageId: string }>>;
  /**
   * Re-post a thread reply to the main chat as the current user. Repeating it for the same
   * reply returns the existing share (`alreadyShared`); it never starts a companion round.
   */
  shareToMain(input: { groupId: string; messageId: string }): Promise<ChatServerResult<{ messageId: string | null; alreadyShared: boolean }>>;
  react(input: { groupId: string; messageId: string; emoji: string; present: boolean }): Promise<ChatServerResult<Record<never, never>>>;
  /** Read-only: who added one emoji to a message. Names use the group member projection. */
  reactors(input: { groupId: string; messageId: string; emoji: string }): Promise<ChatServerResult<{ reactors: ChatReactor[] }>>;
  createInvite(input: { groupId: string; clientId: string }): Promise<ChatServerResult<{ link: string; expiresAt: string | null; reusable?: boolean }>>;
  revokeInvite(input: { groupId: string; link: string; clientId: string }): Promise<ChatServerResult<{ revoked: true }>>;
  previewInvite(input: { link: string }): Promise<ChatServerResult<ChatInvitePreview>>;
  acceptInvite(input: { link: string; clientId: string }): Promise<ChatServerResult<{ groupId: string }>>;
}
