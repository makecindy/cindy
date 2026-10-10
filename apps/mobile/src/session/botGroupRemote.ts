/**
 * 伙伴群聊在手机上的数据边界（docs/product-rules/bot-group-chat.md §8）。
 *
 * 群走 Remote Resource 协议：列表是 `bot-groups` 集合，群详情是 `bot-group-chat` 块，
 * 操作是集合动作。电脑是唯一的规则执行方，这里只做三件事：把电脑发来的数据当不可信
 * 输入逐字段校验、把被拒的动作读回群聊错误码、给列表与发送准备纯函数。不碰 React。
 */
import { resolveRemoteText, type RemoteActionEffect, type RemoteCollectionItem, type RemoteResource, type RemoteResourceAvatar, type RemoteResourceRef } from '@cindy/device-link';
import {
  BOT_GROUP_ATTACHMENTS_MAX,
  BOT_GROUP_CHAT_PRIMITIVE,
  BOT_GROUP_MEMBER_LINK_REL,
  BOT_GROUP_REMOTE_COLLECTION_ID,
  BOT_GROUP_REMOTE_RESOURCE_KIND,
  type BotGroupAttachment,
  type BotGroupAttachmentCategory,
  type BotGroupErrorCode,
  type BotGroupLastMessage,
  type BotGroupMemberStatus,
  type BotGroupMemberView,
  type BotGroupMention,
  type BotGroupMessageView,
  type BotGroupOpenPlanSummary,
  type BotGroupPlanStepView,
  type BotGroupPlanView,
  type BotGroupRemoteChatData,
  type BotGroupRoundView,
  type BotGroupSpeaker,
} from '@cindy/maker-shared/botGroupChat';
import { formatRemoteError } from '@cindy/maker-shared/device-link-contract';
import { isPayloadDesktopLocalMediaUrl } from '@cindy/maker-shared/payload-summary';

/** Member links point at the teammates collection; avatars come from its cached rows. */
export const BOT_GROUP_TEAMMATES_COLLECTION_ID = 'teammates';
/** Declared on `get` so the host sends the structured chat block instead of Markdown. */
export const BOT_GROUP_CLIENT_PRIMITIVES: readonly string[] = [BOT_GROUP_CHAT_PRIMITIVE];

export function botGroupResourceRef(groupId: string): RemoteResourceRef {
  return { collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, kind: BOT_GROUP_REMOTE_RESOURCE_KIND, id: groupId };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Old desktops have no group collection: the phone then hides groups entirely. */
export function hasBotGroupCollection(manifest: unknown): boolean {
  const collections = recordOf(manifest)?.collections;
  return Array.isArray(collections) && collections.some((collection) => {
    const record = recordOf(collection);
    return record?.id === BOT_GROUP_REMOTE_COLLECTION_ID && record.resourceKind === BOT_GROUP_REMOTE_RESOURCE_KIND;
  });
}

export interface BotGroupMemberLink {
  botId: string;
  label: string;
}

/** Members of a list row, in member order, from the row's `member` links. */
export function botGroupMemberLinks(item: Pick<RemoteCollectionItem, 'links'>, locale: string): BotGroupMemberLink[] {
  const seen = new Set<string>();
  return item.links.flatMap((link) => {
    const target = link.target;
    if (link.rel !== BOT_GROUP_MEMBER_LINK_REL || target.kind !== 'resource') return [];
    if (target.ref.collectionId !== BOT_GROUP_TEAMMATES_COLLECTION_ID || target.ref.kind !== 'bot') return [];
    if (seen.has(target.ref.id)) return [];
    seen.add(target.ref.id);
    return [{ botId: target.ref.id, label: link.label ? resolveRemoteText(link.label, locale) : '' }];
  });
}

/** Group rows: newest activity first, one row per host and group, filtered by name or member. */
export function orderedBotGroups<T extends { host: { deviceId: string }; item: RemoteCollectionItem }>(
  rows: readonly T[],
  query: string,
  locale: string,
): T[] {
  const needle = query.normalize('NFKC').trim().toLocaleLowerCase(locale);
  const unique = new Map<string, T>();
  for (const row of rows) {
    if (row.item.ref.collectionId !== BOT_GROUP_REMOTE_COLLECTION_ID || row.item.ref.kind !== BOT_GROUP_REMOTE_RESOURCE_KIND) continue;
    if (needle) {
      const haystack = [
        resolveRemoteText(row.item.display.title, locale),
        row.item.display.subtitle ? resolveRemoteText(row.item.display.subtitle, locale) : '',
        ...botGroupMemberLinks(row.item, locale).map((member) => member.label),
      ].join('\n').normalize('NFKC').toLocaleLowerCase(locale);
      if (!haystack.includes(needle)) continue;
    }
    unique.set(JSON.stringify([row.host.deviceId, row.item.ref.id]), row);
  }
  return [...unique.values()].sort((a, b) => (b.item.display.timestamp ?? 0) - (a.item.display.timestamp ?? 0));
}

// ---- Chat block validation ------------------------------------------------------

const MEMBER_STATUSES = new Set<BotGroupMemberStatus>(['active', 'paused', 'error', 'archived', 'deleting', 'missing']);
const MESSAGE_KINDS = new Set<BotGroupMessageView['kind']>(['message', 'round-end', 'notice', 'plan', 'plan-end']);
const AUTHOR_KINDS = new Set<BotGroupMessageView['authorKind']>(['user', 'bot', 'system']);
const NOTICE_CODES = new Set<string>([
  'member-joined', 'member-failed', 'member-timeout', 'member-unavailable', 'plan-failed', 'plan-stopped', 'workdir-unavailable',
]);
const PLAN_STATUSES = new Set<BotGroupPlanView['status']>([
  'proposed', 'running', 'waiting', 'done', 'stopped', 'dismissed', 'superseded',
]);
const STEP_STATUSES = new Set<BotGroupPlanStepView['status']>(['pending', 'running', 'done', 'failed']);
const SPEAKER_ACTIVITIES = new Set<BotGroupSpeaker['activity']>(['reply', 'planning', 'step']);
const ATTACHMENT_CATEGORIES = new Set<BotGroupAttachmentCategory>(['image', 'pdf', 'text', 'office', 'file']);
const MAX_ID = 256;
const MAX_NAME = 512;
const MAX_TEXT = 200_000;
const MAX_FILES = 64;

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}
function id(value: unknown): string | null {
  const parsed = text(value, MAX_ID);
  return parsed ? parsed : null;
}
function optionalId(value: unknown): string | null {
  return value === null || value === undefined ? null : id(value);
}
function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function stringList(value: unknown, max: number, itemMax: number): string[] {
  return Array.isArray(value)
    ? value.slice(0, max).flatMap((item) => {
      const parsed = text(item, itemMax);
      return parsed ? [parsed] : [];
    })
    : [];
}
function enumOf<T extends string>(value: unknown, allowed: ReadonlySet<T>): T | null {
  return typeof value === 'string' && allowed.has(value as T) ? value as T : null;
}

function parseMember(value: unknown): BotGroupMemberView | null {
  const record = recordOf(value);
  const botId = id(record?.botId);
  const name = text(record?.name, MAX_NAME);
  if (!record || !botId || name === null) return null;
  return {
    botId,
    name,
    ...(id(record.actorId) ? { actorId: id(record.actorId)! } : {}),
    ...(record.actorKind === 'human' || record.actorKind === 'bot' || record.actorKind === 'integration' ? { actorKind: record.actorKind } : {}),
    ...(typeof record.isOwned === 'boolean' ? { isOwned: record.isOwned } : {}),
    ...(typeof record.isSelf === 'boolean' ? { isSelf: record.isSelf } : {}),
    avatar: text(record.avatar, 4_096) ?? '',
    avatarColor: text(record.avatarColor, 64) ?? '',
    status: enumOf(record.status, MEMBER_STATUSES) ?? 'missing',
  };
}

function parseMentions(value: unknown): BotGroupMention {
  const record = recordOf(value);
  return { all: record?.all === true, botIds: stringList(record?.botIds, 32, MAX_ID) };
}

/**
 * What the user attached to a message. Only the computer's media address of an image is
 * kept (read through remote media); host paths never reach the phone.
 */
function parseAttachment(value: unknown): BotGroupAttachment | null {
  const record = recordOf(value);
  const attachmentId = id(record?.id);
  const name = text(record?.name, MAX_NAME);
  if (!record || !attachmentId || !name) return null;
  const url = text(record.url, 4_096);
  const size = finite(record.size);
  return {
    id: attachmentId,
    name,
    category: enumOf(record.category, ATTACHMENT_CATEGORIES) ?? 'file',
    mimeType: text(record.mimeType, 255) ?? '',
    size: size !== null && size >= 0 ? size : 0,
    url: url && isPayloadDesktopLocalMediaUrl(url) ? url : null,
    path: null,
    ...(record.annotated === true ? { annotated: true } : {}),
  };
}

function parseMessage(value: unknown): BotGroupMessageView | null {
  const record = recordOf(value);
  const messageId = id(record?.id);
  const sequence = finite(record?.sequence);
  const kind = enumOf(record?.kind, MESSAGE_KINDS);
  const authorKind = enumOf(record?.authorKind, AUTHOR_KINDS);
  const content = text(record?.content, MAX_TEXT);
  const createdAt = finite(record?.createdAt);
  // Unknown future kinds are dropped rather than shown as ordinary chat.
  if (!record || !messageId || sequence === null || !kind || !authorKind || content === null || createdAt === null) return null;
  const noticeCode = typeof record.noticeCode === 'string' && NOTICE_CODES.has(record.noticeCode)
    ? record.noticeCode as BotGroupMessageView['noticeCode']
    : null;
  return {
    id: messageId,
    sequence,
    kind,
    authorKind,
    authorBotId: optionalId(record.authorBotId),
    authorName: text(record.authorName, MAX_NAME) ?? '',
    content,
    mentions: parseMentions(record.mentions),
    noticeCode,
    planId: optionalId(record.planId),
    files: stringList(record.files, MAX_FILES, 1_024),
    // Older computers send no attachments.
    attachments: Array.isArray(record.attachments)
      ? record.attachments.slice(0, BOT_GROUP_ATTACHMENTS_MAX).flatMap((raw) => {
        const attachment = parseAttachment(raw);
        return attachment ? [attachment] : [];
      })
      : [],
    createdAt,
  };
}

function parseStep(value: unknown): BotGroupPlanStepView | null {
  const record = recordOf(value);
  const position = finite(record?.position);
  const botId = id(record?.botId);
  const status = enumOf(record?.status, STEP_STATUSES);
  const task = text(record?.task, 4_096);
  if (!record || position === null || !botId || !status || task === null) return null;
  return { position, botId, botName: text(record.botName, MAX_NAME) ?? '', task, status };
}

function parsePlan(value: unknown): BotGroupPlanView | null {
  const record = recordOf(value);
  const planId = id(record?.id);
  const status = enumOf(record?.status, PLAN_STATUSES);
  if (!record || !planId || !status || !Array.isArray(record.steps)) return null;
  const steps = record.steps.slice(0, 32).map(parseStep);
  // A plan with an unreadable step would misstate who does what; show it as unreadable instead.
  if (steps.length === 0 || steps.some((step) => step === null)) return null;
  const currentStep = record.currentStep === null ? null : finite(record.currentStep);
  return {
    id: planId,
    status,
    organizerBotId: id(record.organizerBotId) ?? '',
    organizerName: text(record.organizerName, MAX_NAME) ?? '',
    steps: steps as BotGroupPlanStepView[],
    currentStep,
    // Host paths never leave the computer.
    workDir: null,
    branch: text(record.branch, 1_024),
    createdAt: finite(record.createdAt) ?? 0,
    updatedAt: finite(record.updatedAt) ?? 0,
  };
}

function parseOpenPlan(value: unknown): BotGroupOpenPlanSummary | null {
  const record = recordOf(value);
  const planId = id(record?.id);
  const status = enumOf(record?.status, PLAN_STATUSES);
  if (!record || !planId || !status) return null;
  return {
    id: planId,
    status,
    currentStep: record.currentStep === null ? null : finite(record.currentStep),
    stepCount: finite(record.stepCount) ?? 0,
    currentBotName: text(record.currentBotName, MAX_NAME),
    currentStepStatus: enumOf(record.currentStepStatus, STEP_STATUSES),
  };
}

function parseRound(value: unknown): BotGroupRoundView {
  const record = recordOf(value);
  const speakers = Array.isArray(record?.speakers)
    ? record.speakers.slice(0, 16).flatMap((raw): BotGroupSpeaker[] => {
      const speaker = recordOf(raw);
      const botId = id(speaker?.botId);
      if (!speaker || !botId) return [];
      return [{
        botId,
        sessionId: optionalId(speaker.sessionId),
        activity: enumOf(speaker.activity, SPEAKER_ACTIVITIES) ?? 'reply',
      }];
    })
    : [];
  return {
    status: record?.status === 'running' ? 'running' : 'idle',
    speakers,
    canContinue: record?.canContinue === true,
  };
}

function parseLastMessage(value: unknown): BotGroupLastMessage | null {
  const record = recordOf(value);
  const authorKind = enumOf(record?.authorKind, AUTHOR_KINDS);
  const createdAt = finite(record?.createdAt);
  if (!record || !authorKind || createdAt === null) return null;
  return {
    authorKind,
    authorName: text(record.authorName, MAX_NAME) ?? '',
    preview: text(record.preview, 4_096) ?? '',
    ...(typeof record.noticeCode === 'string' && NOTICE_CODES.has(record.noticeCode)
      ? { noticeCode: record.noticeCode as BotGroupMessageView['noticeCode'] } : {}),
    createdAt,
  };
}

/**
 * The host's `bot-group-chat` block data, validated field by field. Returns null when
 * the essentials (id, name, members, messages) are unreadable; malformed messages and
 * plans are dropped one by one so a single bad entry cannot blank the conversation.
 */
export function parseBotGroupChatData(value: unknown): BotGroupRemoteChatData | null {
  const record = recordOf(value);
  const groupId = id(record?.id);
  const name = text(record?.name, MAX_NAME);
  if (!record || !groupId || name === null || !Array.isArray(record.members) || !Array.isArray(record.messages)) return null;
  const members = record.members.slice(0, 16).flatMap((raw) => {
    const member = parseMember(raw);
    return member ? [member] : [];
  });
  const messages = record.messages.slice(0, 500).flatMap((raw) => {
    const message = parseMessage(raw);
    return message ? [message] : [];
  }).sort((a, b) => a.sequence - b.sequence);
  const plans = Array.isArray(record.plans)
    ? record.plans.slice(0, 200).flatMap((raw) => {
      const plan = parsePlan(raw);
      return plan ? [plan] : [];
    })
    : [];
  return {
    id: groupId,
    name,
    serverBacked: record.serverBacked === true,
    supportsMemberRemoval: record.supportsMemberRemoval === true,
    replyMode: record.replyMode === 'mentioned' ? 'mentioned' : 'all',
    speakingMode: record.speakingMode === 'sequential' ? 'sequential' : 'auto',
    members,
    organizerBotId: optionalId(record.organizerBotId),
    projectDir: null,
    projectDirName: text(record.projectDirName, 1_024) || null,
    lastMessage: parseLastMessage(record.lastMessage),
    speakingBotIds: stringList(record.speakingBotIds, 16, MAX_ID),
    planningBotId: optionalId(record.planningBotId),
    openPlan: parseOpenPlan(record.openPlan),
    createdAt: finite(record.createdAt) ?? 0,
    updatedAt: finite(record.updatedAt) ?? 0,
    messages,
    hasMoreBefore: record.hasMoreBefore === true,
    round: parseRound(record.round),
    plans,
    // Older computers would drop attachments on `send`; only an explicit yes offers them.
    supportsAttachments: record.supportsAttachments === true,
  };
}

/** The chat block of a group resource read with `BOT_GROUP_CLIENT_PRIMITIVES`. */
export function botGroupChatDataFromResource(resource: Pick<RemoteResource, 'blocks'>): BotGroupRemoteChatData | null {
  const block = resource.blocks?.find((candidate) => candidate.primitive === BOT_GROUP_CHAT_PRIMITIVE);
  return block ? parseBotGroupChatData(block.data) : null;
}

// ---- Actions ---------------------------------------------------------------

/** Specific codes first: the transport code (INVALID_PARAMS / NOT_FOUND) wraps them. */
const ERROR_CODES: readonly BotGroupErrorCode[] = [
  'INVALID_ATTACHMENT',
  'ATTACHMENT_UNAVAILABLE',
  'ATTACHMENT_TOO_LARGE',
  'MEDIA_UPLOAD_FAILED',
  'AUTH_REQUIRED',
  'CHAT_UNAVAILABLE',
  'IMPORT_PENDING',
  'REQUEST_TIMEOUT',
  'PERMISSION_DENIED',
  'SERVICE_ERROR',
  'GROUP_ARCHIVED',
  'MEMBER_LIMIT',
  'MEMBER_UNAVAILABLE',
  'MENTION_UNAVAILABLE',
  'PLAN_OPEN',
  'PLAN_CLOSED',
  'HOST_NOT_READY',
  'NOT_FOUND',
  'INVALID_PARAMS',
];

/** The group error code a refused action carries (as its message), if any. */
export function botGroupErrorCode(error: unknown): BotGroupErrorCode | null {
  const message = formatRemoteError(error);
  return ERROR_CODES.find((code) => new RegExp(`(^|[^A-Z_])${code}([^A-Z_]|$)`).test(message)) ?? null;
}

/** The new group a `create` action navigated to. */
export function createdBotGroupId(effects: readonly RemoteActionEffect[] | undefined): string | null {
  for (const effect of effects ?? []) {
    if (effect.kind !== 'navigate' || effect.target.kind !== 'resource') continue;
    const ref = effect.target.ref;
    if (ref.collectionId === BOT_GROUP_REMOTE_COLLECTION_ID && ref.kind === BOT_GROUP_REMOTE_RESOURCE_KIND && ref.id) return ref.id;
  }
  return null;
}

/**
 * The same projection the teammates collection uses for a Bot avatar, from a member's
 * raw fields. Used only when the teammates cache has no row for that Bot.
 */
export function botGroupMemberAvatar(member: Pick<BotGroupMemberView, 'avatar' | 'avatarColor' | 'name'>): RemoteResourceAvatar {
  const value = member.avatar;
  const kind = value.startsWith('cindy://avatar/')
    ? 'asset'
    : /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith('/')
      ? 'media'
      : value ? 'emoji' : 'text';
  return {
    kind,
    value,
    fallbackText: Array.from(member.name.trim())[0] ?? '',
    ...(member.avatarColor ? { color: member.avatarColor } : {}),
  };
}

export interface BotGroupSendAttempt {
  text: string;
  division: boolean;
  /** Ids of the attached uploads, in order. */
  attachmentIds: readonly string[];
  /** Explicit target identity, independent of the displayed names. */
  mentionSignature?: string;
  clientId: string;
}

/**
 * A retry of the same text, targets, 「分工」 tag and attachments reuses its
 * clientId, so the host returns the message it already stored instead of writing it twice.
 */
export function nextBotGroupSendAttempt(
  previous: BotGroupSendAttempt | null,
  text: string,
  division: boolean,
  newClientId: () => string,
  attachmentIds: readonly string[] = [],
  mentions?: BotGroupMention,
): BotGroupSendAttempt {
  const mentionSignature = mentions === undefined ? undefined : JSON.stringify([mentions.all, mentions.botIds]);
  return previous && previous.text === text && previous.division === division
    && previous.mentionSignature === mentionSignature
    && previous.attachmentIds.length === attachmentIds.length
    && previous.attachmentIds.every((attachmentId, index) => attachmentId === attachmentIds[index])
    ? previous
    : { text, division, attachmentIds: [...attachmentIds], clientId: newClientId(),
      ...(mentionSignature === undefined ? {} : { mentionSignature }) };
}
