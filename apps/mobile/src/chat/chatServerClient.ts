import type { ChatMaskAction, ChatMaskState, ChatMaskMention } from '@cindy/maker-shared/botGroupChat';
import { teammateChatActivity, type TeammateActivity } from '@cindy/maker-shared/teammate-status';
import { inferBotTemplatePresetId } from '@cindy/maker-shared/bot-template-preset';
import { parseChatInvitationToken } from '@cindy/device-link';
import { createConversationListState } from '@cindy/maker-shared/chatConversationList';
import type { ChatHistory } from '@cindy/maker-shared/chat-history';
import { botGroupMessageSummaryText, botGroupQuoteFromMessage, buildBotGroupQuoteCard, readBotGroupExecutionFailure, readBotGroupQuote, readBotGroupQuoteCard, readBotGroupTaskCard, readImportedBotGroupRuntimeFailureCode, type BotGroupAttachment, type BotGroupMemberView, type BotGroupMessageView, type BotGroupRemoteChatData } from '@cindy/maker-shared/botGroupChat';
import { chatGroupMemberName as memberName, botGroupActivityAt, latestBotGroupMessage, botGroupExecutionFailureBatches, projectBotGroupExecutionFailures } from '@cindy/maker-shared/botGroupPresentation';
import type { HostedRemoteCollectionItem } from '@/device-link/remoteResources';
// The app's `@/i18n` sets up this default instance; importing it here would pull React bindings into a plain client.
import i18next from 'i18next';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@/i18n/locale';
import { mobileMarkdownPreviewText } from '@/session/messageMarkdown';
import { buildBotGroupThreadShareCard, botGroupThreadShareOperationId, readBotGroupThreadShareCard, type BotGroupThreadShareView } from '@cindy/maker-shared/botGroupChat';
import type { RemoteSerializedAttachment } from '@/session/types';

export interface MobileChatInviteMemberAvatar { avatar: string | null; initial: string }

/** Preview-only fields are optional for older Chat Servers. Never infer count from an avatar. */
export interface MobileChatInvitePreview {
  groupId: string; name: string; inviterName: string; joined: boolean;
  expiresAt?: string | null; reusable?: boolean;
  avatar?: string | null; memberCount?: number;
  /** At most five joined members in server order; not the total member count. */
  memberAvatars?: MobileChatInviteMemberAvatar[];
}
function invitationToken(link: string) {
  const token = parseChatInvitationToken(link);
  if (!token) throw new Error('INVALID_INVITATION_LINK');
  return token;
}
function invitationPreview(value: MobileChatInvitePreview): MobileChatInvitePreview {
  if (!value || typeof value.name !== 'string' || typeof value.inviterName !== 'string' || typeof value.joined !== 'boolean'
    || (value.expiresAt !== undefined && value.expiresAt !== null && (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))))
    || (value.reusable !== undefined && typeof value.reusable !== 'boolean')
    || (value.expiresAt === null && value.reusable !== true)) throw new Error('INVALID_CHAT_RESPONSE');
  return { groupId: chatId(value.groupId), name: value.name, inviterName: value.inviterName, joined: value.joined,
    expiresAt: value.expiresAt, reusable: value.reusable,
    ...(Array.isArray(value.memberAvatars) ? { memberAvatars: value.memberAvatars.slice(0, 5).map(member => ({
      avatar: member && typeof member.avatar === 'string' ? member.avatar : null,
      initial: member && typeof member.initial === 'string' ? member.initial : '',
    })) } : {}),
    // Optional metadata can be absent on old servers; malformed metadata is unknown, never zero.
    ...(typeof value.avatar === 'string' || value.avatar === null ? { avatar: value.avatar } : {}),
    ...(Number.isSafeInteger(value.memberCount) && value.memberCount! >= 0 ? { memberCount: value.memberCount } : {}) };
}

export interface ChatRoom {
  id: string; name: string; state?: string; kind: string; archived: boolean; dissolved_at?: string | null;
  topic?: string; description?: string;
  created_at: string; updated_at: string; revision: number; head?: string;
  response_mode: 'all' | 'mentioned'; speaking_mode: 'auto' | 'sequential'; organizer_id?: string | null;
}
export interface ChatMember {
  id: string; kind: 'human' | 'bot' | 'integration'; name: string; state: string;
  ownerActorId: string; ownerName: string; avatar: string | null;
  role: 'owner' | 'admin' | 'member' | 'guest';
}
export interface ChatMessage {
  maskAttribution?: BotGroupMessageView['maskAttribution'];
  id: string; seq: string; authorId: string; author: { kind: string; name: string };
  createdAt: string; deleted: boolean; threadRootId: string | null; origin?: string; mentions?: string[];
  replyCount?: number; revision?: number;
  reactions?: Array<{ emoji: string; count: number; me: boolean }>;
  content: Array<{ type: string; text?: string; fallback?: string; mediaId?: string; caption?: string;
    namespace?: string; schemaRevision?: number; data?: Record<string, unknown> }>;
}
export interface ChatSnapshot { cacheGeneration?: string; room: ChatRoom; members: ChatMember[]; messages: ChatMessage[]; cursor: string; reads?: Array<{ thread_key: string; read_seq: string; muted?: boolean; following?: boolean }> }
export interface ChatExecutionFailure {
  id: string; conversation_id?: string; source_message_id: string; bot_id: string; epoch: number; status?: string;
  failure_code?: unknown; updated_at?: string; plan_id?: string | null;
}
export interface ChatExecution extends ChatExecutionFailure { requester_id?: string; created_at?: string; status: string }
export interface ChatPage { threadRootId?: string; snapshot: ChatSnapshot; messages: ChatMessage[]; before: string | null; failures?: ChatExecutionFailure[]; executions?: ChatExecution[]; historyRevision?: string;
  /** Authorized enrichments only; raw card fallback is never a resolved source. */
  threadSources?: Record<string, ChatMessage | null>; threadRoots?: Record<string, ChatMessage | null>; threadRetryAt?: number; previewMessages?: ChatMessage[];
}
/** `actorId` acts as one of the account's own actors (Chat Server `X-Chat-Actor`). */
export type ChatRequest = <T>(path: string, method?: 'GET' | 'POST' | 'PATCH', body?: unknown, actorId?: string, signal?: AbortSignal) => Promise<T>;
/** An actor the account owns; a companion's `externalId` is its bot id on every computer. */
export interface ChatActor { id: string; kind: string; externalId: string; name: string; avatar: string | null; homeDeviceId: string | null }
export interface ChatCapabilities { companionHome: boolean }
/** Compare-and-set result: a conflict carries the main computer another device already chose. */
export type ChatSetHomeResult = { ok: true; homeDeviceId: string } | { ok: false; homeDeviceId: string | null };
export interface ChatHistoryPage { messages: ChatMessage[]; before: string | null; historyRevision?: string; messageUpdates?: ChatMessage[] }
export type ChatGroupSettingsAction =
  | { type: 'update'; expectedRevision: number; name?: string; description?: string; responseMode?: 'all' | 'mentioned'; speakingMode?: 'auto' | 'sequential'; organizerId?: string | null; archived?: boolean }
  | { type: 'member'; actorId: string; action: 'invite' | 'remove' | 'role'; role?: 'admin' | 'member' };

/** Prefer an owned owner, then the human's admin role, as on Desktop. */
export function chatGroupManager(snapshot: ChatSnapshot, self: string) {
  const managers = snapshot.members.filter(member => member.state === 'joined'
    && (member.id === self || member.ownerActorId === self) && ['owner', 'admin'].includes(member.role));
  return managers.find(member => member.role === 'owner') ?? managers.find(member => member.id === self) ?? managers[0];
}

export interface ChatSendInput {
  conversationKind?: 'direct';
  clientId: string; text: string; mentions: { all: boolean; botIds: string[] };
  quote?: { messageId: string }; threadRootId?: string;
  /** Local delivery intent; never sent as a new server protocol field. */
  alsoSendToMain?: true;
  attachments?: readonly RemoteSerializedAttachment[];
}
export interface ChatSendBody {
  operationId: string; content: ChatMessage['content']; mentions: string[]; threadRootId?: string;
}

export function chatId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('INVALID_CHAT_ID');
  return value;
}
export function chatCursor(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,30}$/.test(value)) throw new Error('INVALID_CHAT_CURSOR');
  return value;
}
export function chatHttpsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('INVALID_CHAT_URL');
  return url.href;
}
export function chatAccessLost(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'status' in error && (error.status === 403 || error.status === 404);
}
/** A typed server rejection: its `details` object (possibly empty), or null when it is another error. */
export function chatRejection(error: unknown, status: number, code: string): Record<string, unknown> | null {
  if (!error || typeof error !== 'object' || !('status' in error) || error.status !== status) return null;
  if ((error as { code?: unknown }).code !== code) return null;
  const details = (error as { details?: unknown }).details;
  return details && typeof details === 'object' && !Array.isArray(details) ? details as Record<string, unknown> : {};
}
// A recognized 引用回复 card renders as the quote; an unknown revision keeps its readable fallback.
// A task card is the message's task only on a teammate's own message (bot-group-chat.md §10).
const taskCardOf = (message: ChatMessage) => message.author.kind === 'bot' ? message.content.map(readBotGroupTaskCard).find(Boolean) ?? null : null;
const bodyBlocks = (message: ChatMessage) => message.deleted || readImportedBotGroupRuntimeFailureCode(message) ? []
  : message.content.filter(block => !readBotGroupQuoteCard(block) && !(message.author.kind === 'bot' && readBotGroupTaskCard(block)));
// Media blocks are the message's attachments; only the list preview falls back to their names.
const contentText = (message: ChatMessage) => readBotGroupThreadShareCard(message) ? '' : bodyBlocks(message)
  .flatMap(block => block.type === 'media' ? [] : [block.text ?? block.fallback ?? '']).join('\n');
// The cloud companion transcript draws the same attachment strip as the group chat, so its text leaves media out too.
export const chatMessageText = contentText;
// The server makes a caption optional; an unnamed attachment still needs a visible name.
const attachmentName = (block: ChatMessage['content'][number]) => block.caption?.trim()
  || (i18next.isInitialized ? i18next.t('groupChat.files.untitled') : '') || 'Attachment';
/** The message's media blocks as attachments; the address is fetched when one is opened (`media`). */
export const chatMessageAttachments = (message: ChatMessage): BotGroupAttachment[] => message.deleted ? [] : message.content.flatMap(block => {
  if (block.type !== 'media' || !block.mediaId) return [];
  return [{ id: block.mediaId, name: attachmentName(block), category: 'file' as const, mimeType: '', size: 0, url: null, path: null }];
});
const mediaNames = (message: ChatMessage) => message.deleted ? '' : message.content
  .flatMap(block => block.type === 'media' ? [attachmentName(block)] : []).join(', ');

function joinedMemberName(message: ChatMessage): string | undefined {
  const joined = message.origin === 'system' && !message.deleted && !message.threadRootId && message.content.find(block =>
    block.type === 'card' && block.namespace === 'cindy.membership' && block.schemaRevision === 1 && block.data?.type === 'member.joined');
  return joined && typeof joined.data?.displayName === 'string' && joined.data.displayName.trim() ? joined.data.displayName : undefined;
}

function sharedReplyPreview(message: ChatMessage, members: ChatMember[], selfId?: string): string | undefined {
  if (!readBotGroupThreadShareCard(message)) return;
  const member = members.find(member => member.id === message.authorId);
  return i18next.t(message.authorId === selfId ? 'groupChat.thread.sidebarOwn' : 'groupChat.thread.sidebarOther',
    { name: member ? memberName(member, members) : message.author.name });
}

/** Empty device identity means a server-owned conversation, never a fictitious computer. */
export function chatRoomRow(room: ChatRoom, snapshot?: ChatSnapshot, selfId?: string, activity?: TeammateActivity): HostedRemoteCollectionItem {
  const members = snapshot?.members.filter(member => member.state === 'joined') ?? [];
  const last = latestBotGroupMessage(snapshot?.messages ?? []);
  const joinedName = last && joinedMemberName(last);
  // Cached rows resolve their copy at render time, even after an offline language change.
  const joinedPreview = joinedName && i18next.isInitialized ? {
    fallback: i18next.t('groupChat.notice.memberJoined', { name: joinedName, lng: DEFAULT_LOCALE }),
    translations: Object.fromEntries(SUPPORTED_LOCALES.map(lng => [lng,
      i18next.t('groupChat.notice.memberJoined', { name: joinedName, lng })])),
  } : undefined;
  const ownerMembers = room.kind === 'direct' ? [] : members;
  const subtitle = members.map(member => memberName(member, ownerMembers)).join(' · ');
  const preview = joinedPreview ?? (last
    ? mobileMarkdownPreviewText(sharedReplyPreview(last, members, selfId) || botGroupMessageSummaryText({ content: contentText(last), task: taskCardOf(last) ?? undefined, deleted: last.deleted }) || mediaNames(last)).slice(0, 160) || subtitle
    : '');
  return { key: `chat:${room.id}`, host: { deviceId: '', deviceName: '' },
    lastReplySequence: snapshot && selfId ? chatLastReplySequence(snapshot.messages, selfId) : undefined,
    chatUnread: snapshot?.reads && selfId ? chatUnread(snapshot, selfId) : undefined,
    groupMembers: snapshot ? members.map(member => chatMemberIdentity(member, ownerMembers)) : undefined, item: {
    ref: { collectionId: 'bot-groups', kind: 'bot-group', id: room.id },
    revision: String(room.head ?? room.revision), display: { title: room.name,
      subtitle,
      ...(activity ? { teammateActivity: activity } : {}),
      ...(snapshot ? { preview } : {}),
      timestamp: botGroupActivityAt({ createdAt: Date.parse(room.created_at), lastMessage: last ? { createdAt: Date.parse(last.createdAt) } : null }),
      lastReplyAt: snapshot && selfId ? chatLastReplyAt(snapshot.messages, selfId) : undefined },
    links: members.map(member => ({ rel: 'member', label: memberName(member, ownerMembers),
      target: { kind: 'resource', ref: { collectionId: 'teammates', kind: 'bot', id: member.id } } })),
  } };
}

/** Server-owned read/mute positions include followed and mentioned threads. */
function chatUnread(snapshot: ChatSnapshot, selfId: string): NonNullable<HostedRemoteCollectionItem['chatUnread']> {
  const main = snapshot.reads?.find(read => read.thread_key === 'main');
  if (main?.muted || snapshot.room.archived || snapshot.room.dissolved_at) return { count: 0, mentioned: false, threadCount: 0, threadMentioned: false };
  const messages = snapshot.messages.filter(message => {
    if (message.deleted || message.authorId === selfId || message.origin === 'system' || message.origin === 'import') return false;
    const read = message.threadRootId ? snapshot.reads?.find(read => read.thread_key === message.threadRootId) : main;
    return !read?.muted && BigInt(chatCursor(message.seq)) > BigInt(chatCursor(read?.read_seq ?? '0'))
      && (!message.threadRootId || read?.following || message.mentions?.includes(selfId));
  });
  return { count: messages.length, mentioned: messages.some(message => message.mentions?.includes(selfId)),
    threadCount: messages.filter(message => message.threadRootId).length,
    threadMentioned: messages.some(message => message.threadRootId && message.mentions?.includes(selfId)) };
}

/** Only incoming main-timeline messages count; a system notice or our own send is not a reply. */
const incomingReply = (message: ChatMessage, selfId: string) => !message.deleted && !message.threadRootId
  && message.origin !== 'system' && message.authorId !== selfId;

export function chatLastReplyAt(messages: readonly ChatMessage[], selfId: string): number {
  return messages.reduce((latest, message) => incomingReply(message, selfId)
    ? Math.max(latest, Date.parse(message.createdAt)) : latest, 0);
}

export function chatLastReplySequence(messages: readonly ChatMessage[], selfId: string): string {
  return messages.reduce((latest, message) => incomingReply(message, selfId) && BigInt(chatCursor(message.seq)) > BigInt(latest)
    ? message.seq : latest, '0');
}

export function chatReadSequence(snapshot: ChatSnapshot): string {
  return chatCursor(snapshot.reads?.find(read => read.thread_key === 'main')?.read_seq ?? '0');
}

export function chatThreadMetadata(page: ChatPage, selfId: string) {
  const known = new Map([...page.snapshot.messages, ...(page.previewMessages ?? []), ...page.messages].map(message => [message.id, message]));
  const shares: Record<string, { messageId: string; bySelf: boolean }> = {};
  for (const message of known.values()) {
    const card = message.deleted ? null : readBotGroupThreadShareCard(message);
    if (!card || shares[card.messageId]?.bySelf) continue;
    shares[card.messageId] = { messageId: message.id, bySelf: message.authorId === selfId };
  }
  const read = page.snapshot.reads?.find(read => read.thread_key === page.threadRootId);
  return { shares, readSeq: page.snapshot.reads ? read?.read_seq ?? '0' : undefined,
    following: page.snapshot.reads && page.threadRootId ? read?.following === true : undefined };
}

/** Import only the server's acknowledged position, never mark an unseen reply as read. */
export function chatReadAt(snapshot: ChatSnapshot, selfId: string): number {
  const sequence = chatReadSequence(snapshot);
  return chatLastReplyAt(snapshot.messages.filter(message => BigInt(chatCursor(message.seq)) <= BigInt(chatCursor(sequence))), selfId);
}

/** Public profile images never enter the computer's local media resolver. */
export function chatMemberAvatar(value: string | null): Pick<BotGroupMemberView, 'avatar' | 'avatarUrl'> {
  const raw = value ?? '';
  try { return { avatar: '', avatarUrl: chatHttpsUrl(raw) }; } catch { /* Not a public HTTPS image. */ }
  // The server also accepts the existing bundled presets and short emoji identities.
  const avatar = /^cindy:\/\/avatar\/preset\/(cindy|dash|lizi)$/.test(raw)
    || (raw.length <= 16 && !/[a-zA-Z0-9/:\x00-\x1f]/.test(raw)) ? raw : '';
  return { avatar, avatarUrl: null };
}

function chatMemberIdentity(member: ChatMember, members: readonly ChatMember[]) {
  return { botId: member.id, name: memberName(member, members), ...chatMemberAvatar(member.avatar), avatarColor: '' };
}

/**
 * Sequence strings stay on the wire; numeric positions below are presentation order only.
 * `actors` (the account's own, from `/actors`) tell which computer runs each owned companion.
 */
export function chatGroupView(page: ChatPage, selfId: string, actors: readonly ChatActor[] = []): BotGroupRemoteChatData {
  const { room, members } = page.snapshot;
  const ownerMembers = room.kind === 'direct' ? [] : members;
  const active = members.filter(member => member.state === 'joined');
  const memberViews: BotGroupMemberView[] = active.map(member => ({
    ...chatMemberIdentity(member, ownerMembers), actorId: member.id, actorKind: member.kind, isSelf: member.id === selfId,
    isOwned: member.ownerActorId === selfId, role: member.role,
    ...(member.ownerActorId === selfId && member.kind === 'bot'
      ? { homeDeviceId: actors.find(actor => actor.id === member.id)?.homeDeviceId ?? null } : {}),
    status: 'active',
  }));
  const deletedIds = new Set(page.messages.filter(message => message.deleted).map(message => message.id));
  const sorted = [...new Map(page.messages.map(message => [message.id, message])).values()].filter(message => !message.deleted)
    .sort((a, b) => BigInt(chatCursor(a.seq)) < BigInt(chatCursor(b.seq)) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0);
  const messages: BotGroupMessageView[] = sorted.map((message, index) => {
    const runtimeFailureCode = readImportedBotGroupRuntimeFailureCode(message);
    const legacy = runtimeFailureCode ? message.content.find(block => block.type === 'card' && block.namespace === 'cindy.local-history' && block.schemaRevision === 1)?.data : undefined;
    if (runtimeFailureCode) return { id: message.id, sequence: index + 1, serverSequence: chatCursor(message.seq), kind: 'notice', authorKind: 'system',
      authorBotId: message.authorId, authorName: typeof legacy?.authorName === 'string' ? legacy.authorName : '', isSelf: false,
      content: '', mentions: { all: false, botIds: [] }, noticeCode: runtimeFailureCode === 'RUNTIME_TIMEOUT' ? 'member-timeout' : 'member-failed',
      runtimeFailureCode, planId: null, files: [], attachments: [], createdAt: Date.parse(message.createdAt) };
    const member = active.find(candidate => candidate.id === message.authorId);
    const joinedName = joinedMemberName(message);
    const quote = message.origin === 'system' ? null : readBotGroupQuote(message.content);
    const task = message.origin === 'system' ? null : taskCardOf(message);
    return { id: message.id, sequence: index + 1, serverSequence: chatCursor(message.seq), kind: message.origin === 'system' ? 'notice' : 'message',
      ...(message.maskAttribution ? { maskAttribution: message.maskAttribution } : {}),
      ...(task ? { task } : {}), threadRootId: message.threadRootId, replyCount: message.replyCount, reactions: message.reactions,
      authorKind: message.origin === 'system' ? 'system' : message.author.kind === 'human' ? 'user' : 'bot',
      authorBotId: message.authorId, authorName: joinedName !== undefined ? joinedName
        : member ? memberName(member, ownerMembers) : message.author.name,
      isSelf: message.authorId === selfId, content: contentText(message), mentions: { all: false, botIds: message.mentions ?? [] },
      ...(quote ? { quote: deletedIds.has(quote.messageId) ? { ...quote, originalDeleted: true } : quote } : {}),
      noticeCode: joinedName !== undefined ? 'member-joined' : null, planId: null, files: [],
      attachments: chatMessageAttachments(message), createdAt: Date.parse(message.createdAt) };
  });
  const known = new Map([...page.snapshot.messages, ...(page.previewMessages ?? []), ...page.messages].map(message => [message.id, message]));
  const authorName = (message: ChatMessage) => {
    const member = members.find(member => member.id === message.authorId);
    return member ? memberName(member, ownerMembers) : message.author.name;
  };
  const preview = (message: ChatMessage) => ({ id: message.id, authorKind: message.author.kind === 'human' ? 'user' as const : 'bot' as const,
    authorBotId: message.authorId, authorName: authorName(message), isSelf: message.authorId === selfId,
    text: mobileMarkdownPreviewText(contentText(message)), attachments: chatMessageAttachments(message).map(({ name, category }) => ({ name, category })),
    createdAt: Date.parse(message.createdAt) });
  const threadRepliesFor = (rootId: string, extra?: ChatMessage) => {
    const replies = new Map([...known.values(), ...(extra ? [extra] : [])]
      .filter(reply => reply.threadRootId === rootId && !reply.deleted && reply.origin !== 'system')
      .map(reply => [reply.id, reply] as const));
    return [...replies.values()].sort((a, b) => BigInt(a.seq) > BigInt(b.seq) ? -1 : 1);
  };
  const threadPreviewFor = (rootId: string, extra?: ChatMessage) => {
    const replies = threadRepliesFor(rootId, extra);
    if (!replies.length) return undefined;
    const authors = new Set<string>();
    return { replies: replies.slice(0, 2).reverse().map(preview),
      responders: replies.filter(reply => { if (authors.has(reply.authorId)) return false; authors.add(reply.authorId); return true; }).slice(0, 3).reverse().map(preview) };
  };
  const threadUnreadFor = (rootId: string) => {
    if (!page.snapshot.reads) return undefined;
    const read = page.snapshot.reads.find(read => read.thread_key === rootId)?.read_seq ?? '0';
    const unread = page.snapshot.messages.filter(reply => reply.threadRootId === rootId && !reply.deleted && reply.origin !== 'system'
      && reply.origin !== 'import' && reply.authorId !== selfId && BigInt(chatCursor(reply.seq)) > BigInt(chatCursor(read)));
    return { count: unread.length, mentioned: unread.some(reply => reply.mentions?.includes(selfId)) };
  };
  for (const view of messages) {
    const message = known.get(view.id)!;
    if (!message.threadRootId && message.replyCount) {
      view.threadPreview = threadPreviewFor(message.id);
    }
    if (!message.threadRootId) view.threadUnread = threadUnreadFor(message.id);
    const card = readBotGroupThreadShareCard(message);
    if (card) {
      const source = page.threadSources && Object.hasOwn(page.threadSources, card.messageId) ? page.threadSources[card.messageId] : known.get(card.messageId);
      const available = source && source.id === card.messageId && source.threadRootId === card.threadRootId && !source.deleted && source.origin !== 'system';
      const root = page.threadRoots && Object.hasOwn(page.threadRoots, card.threadRootId)
        ? page.threadRoots[card.threadRootId] : known.get(card.threadRootId);
      const threadPreview = threadPreviewFor(card.threadRootId, available ? source : undefined);
      const replyCount = root?.replyCount ?? (threadPreview ? Math.max(threadPreview.replies.length, 1) : available ? 1 : undefined);
      view.threadShare = { ...card, status: source === undefined ? 'loading' : available ? 'available' : 'unavailable',
        authorKind: available && source.author.kind !== 'human' ? 'bot' : 'user', authorBotId: available ? source.authorId : null,
        authorName: available ? authorName(source) : '', sharedByAuthor: !!available && source.authorId === message.authorId,
        content: available ? contentText(source) : '', attachments: available ? chatMessageAttachments(source) : [],
        createdAt: available ? Date.parse(source.createdAt) : null, edited: !!available && (source.revision ?? 1) > 1,
        ...(replyCount !== undefined ? { replyCount } : {}), ...(threadPreview ? { threadPreview } : {}),
        ...(threadUnreadFor(card.threadRootId) ? { threadUnread: threadUnreadFor(card.threadRootId) } : {}) } satisfies BotGroupThreadShareView;
    }
  }
  const last = messages.at(-1);
  const failures = (page.failures ?? []).flatMap(row => {
    const failure = readBotGroupExecutionFailure(row, room.id);
    if (!failure) return [];
    const member = members.find(candidate => candidate.id === failure.botId);
    return [{ ...failure, botName: member ? memberName(member, ownerMembers) : '' }];
  });
  const executions = (page.executions ?? []).filter(row => ['queued', 'running', 'needs_input', 'stopping'].includes(row.status));
  const speakers = executions.map(row => ({ botId: row.bot_id, sessionId: null, executionId: row.id,
    ...(row.created_at && Number.isFinite(Date.parse(row.created_at)) ? { startedAt: Date.parse(row.created_at) } : {}),
    executionStatus: row.status as 'queued' | 'running' | 'needs_input' | 'stopping', stopping: row.status === 'stopping',
    activity: row.plan_id ? 'step' as const : 'reply' as const }));
  return { id: room.id, conversationKind: room.kind === 'direct' ? 'direct' : 'group',
    name: room.kind === 'direct' ? active.filter(member => member.id !== selfId).map(member => memberName(member, [])).join(', ') || room.name : room.name,
    serverBacked: true, supportsGroupLeave: room.kind !== 'direct', dissolvedAt: room.dissolved_at ?? null, archived: room.archived, selfActorId: selfId,
    topic: room.topic, description: room.description,
    supportsSettingsManagement: room.kind === 'group', supportsMemberRemoval: room.kind === 'group',
    revision: room.revision, members: memberViews, replyMode: room.response_mode, speakingMode: room.speaking_mode,
    organizerBotId: room.organizer_id ?? null, projectDir: null, projectDirName: null,
    createdAt: Date.parse(room.created_at), updatedAt: Date.parse(room.updated_at),
    lastMessage: last ? { authorKind: last.authorKind, authorName: last.authorName, preview: mobileMarkdownPreviewText(last.threadShare ? i18next.t(last.isSelf ? 'groupChat.thread.sidebarOwn' : 'groupChat.thread.sidebarOther', { name: last.authorName }) : botGroupMessageSummaryText(last)).slice(0, 80), createdAt: last.createdAt } : null,
    speakingBotIds: speakers.map(speaker => speaker.botId), planningBotId: null, openPlan: null, plans: [], messages: projectBotGroupExecutionFailures(messages, failures),
    hasMoreBefore: page.before !== null, round: { status: speakers.length ? 'running' : 'idle', speakers, canContinue: false }, supportsAttachments: true };
}

export function createChatServerClient(request: ChatRequest, personalList = createConversationListState(),
  openHistory?: (human: string) => Promise<ChatHistory>) {
  const threadFailures = new Map<string, { attempts: number; at: number }>();
  const retryDelays = [30_000, 60_000, 120_000, 240_000, 480_000];
  let historyCache: Promise<ChatHistory> | undefined;
  const cache = () => openHistory ? historyCache ??= identity().then(openHistory).catch(error => { historyCache = undefined; throw error; }) : undefined;
  async function messagePage(room: string, query: string) {
    const stored = await cache();
    return stored ? stored.page<ChatMessage>(room, new URLSearchParams(query)) : request<ChatMessage[]>(`/conversations/${room}/messages?${query}`);
  }
  // Preserve the posted quote through a lost response. Retrying an operation must
  // not change its content/recipients if the original is subsequently edited or removed.
  const postedQuotes = new Map<string, { content: ChatMessage['content']; mentions: string[] }>();
  async function failures(roomId: string, messages: ChatMessage[]): Promise<ChatExecutionFailure[]> {
    const sources = new Set(messages.map(message => chatId(message.id)));
    let value: ChatExecutionFailure[] = [];
    try {
      for (const batch of botGroupExecutionFailureBatches([...sources])) {
        const page = await request<ChatExecutionFailure[]>(`/conversations/${chatId(roomId)}/execution-failures?sourceIds=${batch.join(',')}`);
        if (!Array.isArray(page)) throw new Error('INVALID_CHAT_EXECUTIONS');
        value.push(...page);
      }
    }
    catch (error) {
      if (!error || typeof error !== 'object' || !('status' in error) || error.status !== 404) throw error;
      value = await request<ChatExecutionFailure[]>(`/conversations/${chatId(roomId)}/executions`);
    }
    if (!Array.isArray(value)) throw new Error('INVALID_CHAT_EXECUTIONS');
    return value.filter(row => sources.has(row.source_message_id));
  }
  async function history(roomId: string, before?: string | null, shownIds: string[] = [], attempt = 0): Promise<ChatHistoryPage> {
    const stored = await cache();
    if (!before) stored?.invalidate(roomId);
    const snapshot = await stored?.snapshot(roomId);
    const messages = await messagePage(chatId(roomId), `limit=100${before ? `&before=${chatCursor(before)}` : ''}`);
    if (!Array.isArray(messages)) throw new Error('INVALID_CHAT_MESSAGES');
    const next = messages.length === 100 ? chatCursor(messages.at(-1)!.seq) : null;
    if (before && next && BigInt(next) >= BigInt(before)) throw new Error('INVALID_CHAT_PAGE');
    const projection = await stored?.projection<ChatMessage>(roomId, shownIds);
    if (projection && snapshot?.cacheGeneration !== projection.generation) {
      if (attempt >= 2) throw new Error('CHAT_HISTORY_CHANGED');
      return history(roomId, before, shownIds, attempt + 1);
    }
    return { messages, before: next, ...(projection ? { historyRevision: projection.generation, messageUpdates: projection.messages } : {}) };
  }
  let supportsDissolve = false;
  let supportsListRemoval = false;
  let singleSpeaker = false;
  let personalMask = false;
  let lastIdentity: { id: string; at: number } | undefined;
  let readingIdentity: Promise<string> | undefined;
  async function identity() {
    if (openHistory && lastIdentity && Date.now() - lastIdentity.at < 60_000) return lastIdentity.id;
    return readingIdentity ??= (async () => {
      const me = await request<{ actor: { id: string; kind: string }; capabilities?: { groupLifecycleVersion?: number; conversationListStateVersion?: number; groupSingleSpeaker?: number; personalMask?: number } }>('/me');
      if (me.actor.kind !== 'human') throw new Error('INVALID_CHAT_IDENTITY');
      supportsDissolve = me.capabilities?.groupLifecycleVersion === 1;
      supportsListRemoval = me.capabilities?.conversationListStateVersion === 1;
      singleSpeaker = me.capabilities?.groupSingleSpeaker === 1;
      personalMask = me.capabilities?.personalMask === 1;
      const id = chatId(me.actor.id); lastIdentity = { id, at: Date.now() };
      return id;
    })().finally(() => { readingIdentity = undefined; });
  }
  return {
    async previewInvite(link: string, signal?: AbortSignal): Promise<MobileChatInvitePreview> {
      return invitationPreview(await request<MobileChatInvitePreview>('/invite-links/preview', 'POST', { token: invitationToken(link) }, undefined, signal));
    },
    async acceptInvite(link: string, operationId: string, signal?: AbortSignal): Promise<{ groupId: string }> {
      const token = invitationToken(link);
      if (!/^[a-zA-Z0-9_.:-]{8,160}$/.test(operationId)) throw new Error('INVALID_OPERATION_ID');
      const result = await request<{ groupId: string }>('/invite-links/accept', 'POST', { token, operationId }, undefined, signal);
      const groupId = chatId(result?.groupId);
      this.invalidateHistory(groupId, true);
      return { groupId };
    },
    invalidateHistory(room: string, metadata = false) {
      if (metadata) for (const key of threadFailures.keys()) if (key.startsWith(`${room}:`)) threadFailures.delete(key);
      void historyCache?.then(value => value.invalidate(room, metadata)).catch(() => undefined); },
    async refreshHistory(room: string, metadata = false) { const value = await cache(); value?.invalidate(room, metadata); await value?.snapshot(room); },
    personalList,
    async mask(roomId: string, action?: ChatMaskAction, operationId?: string): Promise<ChatMaskState | null> {
      await identity();
      if (!personalMask) return null;
      return request<ChatMaskState>(`/conversations/${chatId(roomId)}/mask`, action ? 'POST' : 'GET',
        action ? { ...action, operationId } : undefined);
    },
    async maskMentions(roomId: string, before?: string, readIds?: string[], operationId?: string) {
      await identity();
      if (!personalMask) return { mentions: [] as ChatMaskMention[], hasMore: false };
      const path = `/conversations/${chatId(roomId)}/mentions`;
      if (readIds?.length) await request(`${path}/read`, 'POST', { operationId, messageIds: readIds.map(chatId) });
      const page = await request<{ messages: Array<ChatMessage & { reply?: { content: ChatMessage['content']; maskAttribution: NonNullable<ChatMessage['maskAttribution']> } }> ; hasMore: boolean }>(`${path}?limit=100${before ? `&before=${chatCursor(before)}` : ''}`);
      return { hasMore: page.hasMore, mentions: page.messages.map((message): ChatMaskMention => ({
        messageId: message.id, sequence: message.seq, threadRootId: message.threadRootId ?? undefined,
        authorName: message.author.name, text: contentText(message),
        ...(message.reply ? { reply: { companion: message.reply.maskAttribution.companion,
          text: message.reply.content.map(block => block.text ?? block.fallback ?? block.caption ?? '').join('\n') } } : {}),
      })) };
    },
    lifecycleCapabilities: () => ({ supportsDissolve, supportsListRemoval, singleSpeaker }),
    async groupSettings(roomId: string) {
      const [snapshot, self] = await Promise.all([
        request<ChatSnapshot>(`/conversations/${chatId(roomId)}/snapshot`), identity(),
      ]);
      if (snapshot.room.id !== roomId || snapshot.room.kind !== 'group' || !Array.isArray(snapshot.members)) throw new Error('INVALID_CHAT_SNAPSHOT');
      return { snapshot, self, manager: chatGroupManager(snapshot, self) };
    },
    /** The server rechecks the selected owned actor's live role for every write. */
    async manageGroup(roomId: string, managerId: string, action: ChatGroupSettingsAction, operationId: string) {
      const path = `/conversations/${chatId(roomId)}`;
      const { type, ...body } = action;
      return request(type === 'member' ? `${path}/members` : path, type === 'member' ? 'POST' : 'PATCH',
        { operationId, ...body }, chatId(managerId));
    },
    async syncListState(force = false) {
      await identity();
      if (supportsListRemoval) await (force ? personalList.sync(request) : personalList.ensureSynced(request));
    },
    async resyncListState() { await identity(); if (supportsListRemoval) await personalList.resync(request); },
    async hide(roomId: string, operationId: string) {
      await identity();
      if (!supportsListRemoval) throw new Error('LIFECYCLE_UNAVAILABLE');
      await personalList.setHidden(request, chatId(roomId), true, operationId);
    },
    async dissolve(roomId: string, expectedRevision: unknown, operationId: string) {
      const self = await identity();
      if (!supportsDissolve) throw new Error('LIFECYCLE_UNAVAILABLE');
      if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1) throw new Error('REVISION_CONFLICT');
      const snapshot = await request<ChatSnapshot>(`/conversations/${chatId(roomId)}/snapshot`);
      if (snapshot.room.kind !== 'group') throw new Error('GROUP_REQUIRED');
      const owner = snapshot.members.find(m => m.state === 'joined' && m.role === 'owner' && (m.id === self || m.ownerActorId === self));
      if (!owner) throw new Error('OWNER_REQUIRED');
      const result = await request<{ revision: number; dissolvedAt: string; dissolvedBy: string }>(`/conversations/${roomId}/dissolve`, 'POST', { operationId, expectedRevision }, owner.id);
      if (!Number.isSafeInteger(result?.revision) || result.revision < 1 || !Number.isFinite(Date.parse(result.dissolvedAt))) throw new Error('INVALID_CHAT_RESPONSE');
      chatId(result.dissolvedBy);
    },
    async leave(roomId: string, operationId: string) {
      const self = await identity();
      const snapshot = await request<ChatSnapshot>(`/conversations/${chatId(roomId)}/snapshot`);
      if (snapshot.room.kind !== 'group') throw new Error('GROUP_REQUIRED');
      await request(`/conversations/${roomId}/members`, 'POST', { operationId, actorId: self, action: 'leave' });
    },
    async list(): Promise<ChatRoom[]> {
      const rooms = new Map<string, ChatRoom>();
      let after: string | undefined;
      do {
        const page = await request<ChatRoom[]>(`/conversations?limit=100${after ? `&after=${after}` : ''}`);
        if (!Array.isArray(page)) throw new Error('INVALID_CHAT_LIST');
        for (const room of page) {
          chatId(room.id);
          if (!['direct', 'group', 'channel'].includes(room.kind)) throw new Error('INVALID_CHAT_LIST');
          if (room.state === 'joined' && room.kind === 'group' && !personalList.hidden(room.id)) rooms.set(room.id, room);
        }
        const next = page.length === 100 ? chatId(page.at(-1)!.id) : undefined;
        if (next && next === after) throw new Error('INVALID_CHAT_PAGE');
        after = next;
      } while (after);
      return [...rooms.values()].filter(room => !personalList.hidden(room.id));
    },
    async me(): Promise<string> {
      return identity();
    },
    /** Server feature switches; an older server without them keeps per-computer companions. */
    async capabilities(): Promise<ChatCapabilities> {
      const me = await request<{ actor?: { kind?: string }; capabilities?: { companionHome?: unknown } }>('/me');
      return { companionHome: me?.actor?.kind === 'human' && me.capabilities?.companionHome === true };
    },
    async actors(): Promise<ChatActor[]> {
      const rows = await request<Array<ChatActor & { disabled?: unknown }>>('/actors');
      if (!Array.isArray(rows)) throw new Error('INVALID_CHAT_ACTORS');
      return rows.flatMap(row => {
        // Retired in the cloud (deleted on its main computer): not a companion any more.
        if (row.disabled === true) return [];
        try { chatId(row.id); } catch { return []; }
        if (typeof row.externalId !== 'string' && row.externalId != null) return [];
        return [{ id: row.id, kind: String(row.kind), externalId: row.externalId ?? '', name: typeof row.name === 'string' ? row.name : '',
          avatar: typeof row.avatar === 'string' ? row.avatar : null, homeDeviceId: typeof row.homeDeviceId === 'string' && row.homeDeviceId ? row.homeDeviceId : null }];
      });
    },
    /** Same preset identity as Desktop. Read profile metadata only; never infer from a name/avatar. */
    async cindyCompanionIds(actors: readonly ChatActor[], previous: readonly string[] = [], current = () => true): Promise<string[]> {
      const ids: string[] = [];
      for (const actor of actors) {
        if (!current()) break;
        if (actor.kind !== 'bot') continue;
        if (actor.externalId === 'cindy-default') { ids.push(actor.externalId); continue; }
        try {
          const rows = await request<Array<{ key?: unknown; value?: unknown }>>('/preferences', 'GET', undefined, chatId(actor.id));
          const profile = rows?.find(row => row.key === 'companion.profile.v1')?.value as { templateId?: unknown; soul?: unknown } | undefined;
          if (profile?.templateId === 'cindy' || (typeof profile?.soul === 'string' && inferBotTemplatePresetId(profile.soul) === 'cindy')) ids.push(actor.externalId);
        } catch { if (previous.includes(actor.externalId)) ids.push(actor.externalId); }
      }
      return ids;
    },
    /** The main computer has uploaded the profile snapshot another computer builds the companion from. */
    async hasProfileSnapshot(actorId: string): Promise<boolean> {
      const rows = await request<Array<{ key?: unknown; value?: unknown }>>('/preferences', 'GET', undefined, chatId(actorId));
      const row = (Array.isArray(rows) ? rows : []).find(candidate => candidate?.key === 'companion.profile.v1');
      // Same check as Desktop (companion-cloud/uploader.ts isCompanionProfileSnapshot): a complete profile.
      const value = row?.value as Record<string, unknown> | null | undefined;
      return !!value && typeof value === 'object' && !Array.isArray(value)
        && ['name', 'description', 'soul', 'systemPrompt', 'user'].every(field => typeof value[field] === 'string');
    },
    /** Move a companion's main computer only if it is still `expected` (no two devices race it). */
    async setHome(actorId: string, homeDeviceId: string, expected: string | null): Promise<ChatSetHomeResult> {
      try {
        const actor = await request<{ homeDeviceId?: unknown } | null>(`/actors/${chatId(actorId)}`, 'PATCH', { homeDeviceId, expectedHomeDeviceId: expected });
        return { ok: true, homeDeviceId: typeof actor?.homeDeviceId === 'string' ? actor.homeDeviceId : homeDeviceId };
      } catch (error) {
        const conflict = chatRejection(error, 409, 'HOME_DEVICE_CONFLICT');
        if (!conflict) throw error;
        return { ok: false, homeDeviceId: typeof conflict.homeDeviceId === 'string' && conflict.homeDeviceId ? conflict.homeDeviceId : null };
      }
    },
    /**
     * The companion's fixed 1:1 room. Every device asks with the same operation and gets the same
     * room; a room first created under another name answers OPERATION_CONFLICT, then the name-keyed
     * operation (the desktop's) resolves the same room.
     */
    async companionRoom(actorId: string, name: string, hash: (text: string) => Promise<string>): Promise<string> {
      const body = { kind: 'direct', name: name.trim().slice(0, 160) || '伙伴', participants: [chatId(actorId)], sourceId: actorId };
      let room: { id: string };
      try {
        room = await request<{ id: string }>('/conversations', 'POST', { operationId: `companion-room:${actorId}`, ...body });
      } catch (error) {
        if (!chatRejection(error, 409, 'OPERATION_CONFLICT')) throw error;
        const suffix = (await hash(body.name)).slice(0, 12);
        room = await request<{ id: string }>('/conversations', 'POST', { operationId: `companion-room:${actorId}:${suffix}`, ...body });
      }
      return chatId(room?.id ?? '');
    },
    /** Main-timeline messages of any room kind (a companion's room is `direct`), newest first. */
    history,
    async message(roomId: string, messageId: string): Promise<ChatMessage> {
      const room = chatId(roomId), id = chatId(messageId);
      const stored = await cache();
      return stored ? stored.message<ChatMessage>(room, id) : request<ChatMessage>(`/conversations/${room}/messages/${id}`);
    },
    /** Read-only roster state; independent of message heads because an approval can arrive silently. */
    async rosterActivity(roomId: string, snapshot: ChatSnapshot): Promise<TeammateActivity | undefined> {
      const room = chatId(roomId);
      const results = await Promise.allSettled([
        request<ChatExecution[]>(`/conversations/${room}/executions`),
        request<Array<{ status: string }>>(`/conversations/${room}/plans`),
      ]);
      // Older servers can lack these reads. Never manufacture a result from an ordinary unread message.
      if (results.some(result => result.status === 'rejected')) return undefined;
      const executions = results[0].status === 'fulfilled' ? results[0].value : [];
      const plans = results[1].status === 'fulfilled' ? results[1].value : [];
      if (!Array.isArray(executions) || !Array.isArray(plans)) return undefined;
      const last = latestBotGroupMessage(snapshot.messages);
      return teammateChatActivity({ executions, plans, archived: snapshot.room.archived,
        lastMessageAt: last ? Date.parse(last.createdAt) : 0 });
    },
    async snapshot(roomId: string, metadata = false): Promise<ChatSnapshot> {
      const stored = await cache();
      if (stored) { stored.invalidate(roomId, metadata); return stored.snapshot<ChatSnapshot>(chatId(roomId)); }
      return request(`/conversations/${chatId(roomId)}/snapshot`);
    },
    async members(roomId: string): Promise<ChatMember[]> {
      const members = await request<ChatMember[]>(`/conversations/${chatId(roomId)}/members`);
      if (!Array.isArray(members)) throw new Error('INVALID_CHAT_MEMBERS');
      return members;
    },
    async load(roomId: string, oldest?: string, threadRootId?: string, attempt = 0): Promise<ChatPage> {
      const room = chatId(roomId);
      const threadQuery = threadRootId ? `&threadRootId=${chatId(threadRootId)}` : '';
      const stored = await cache();
      const snapshot = stored ? await stored.snapshot<ChatSnapshot>(room) : await request<ChatSnapshot>(`/conversations/${room}/snapshot`);
      if (snapshot.room.id !== room || !Array.isArray(snapshot.members)) throw new Error('INVALID_CHAT_SNAPSHOT');
      chatCursor(snapshot.cursor);
      // Snapshot includes Thread replies; the message endpoint selects the main timeline.
      let batch = await messagePage(room, `limit=100${threadQuery}`);
      const messages = [...batch];
      let before = batch.length === 100 ? chatCursor(batch.at(-1)!.seq) : null;
      // Reauthorize and re-read the displayed window on invalidation, including edits/removals.
      while (oldest && before && BigInt(before) > BigInt(chatCursor(oldest))) {
        batch = await messagePage(room, `limit=100&before=${before}${threadQuery}`);
        const next = batch.length === 100 ? chatCursor(batch.at(-1)!.seq) : null;
        if (next && BigInt(next) >= BigInt(before)) throw new Error('INVALID_CHAT_PAGE');
        messages.push(...batch); before = next;
      }
      if (threadRootId) {
        try {
          const root = stored ? await stored.message<ChatMessage>(room, chatId(threadRootId))
            : await request<ChatMessage>(`/conversations/${room}/messages/${chatId(threadRootId)}`);
          messages.push(root);
        } catch (error) {
          // Replies were authorized above. A missing root is not room-wide access
          // loss: retain these replies, but let the UI disable further sends.
          // Other 404s and permission failures must still clear unauthorized history.
          if (!chatRejection(error, 404, 'MESSAGE_NOT_FOUND')) throw error;
        }
      }
      // Use the same execution snapshot for running status and stop controls.
      const executions = await request<ChatExecution[]>(`/conversations/${room}/executions`);
      const executionFailures = await failures(room, messages);
      const projection = await stored?.projection<ChatMessage>(room, []);
      if (projection && snapshot.cacheGeneration !== projection.generation) {
        if (attempt >= 2) throw new Error('CHAT_HISTORY_CHANGED');
        return this.load(roomId, undefined, threadRootId, attempt + 1);
      }
      return { snapshot, messages, before, ...(projection ? { historyRevision: projection.generation } : {}),
        ...(threadRootId ? { threadRootId } : {}), failures: executionFailures,
        ...(Array.isArray(executions) ? { executions } : {}) };
    },
    async stop(roomId: string, operationId: string) {
      const room = chatId(roomId);
      const self = await identity();
      const snapshot = await request<ChatSnapshot>(`/conversations/${room}/snapshot`);
      const ownBots = new Set(snapshot.members.filter(member => member.state === 'joined' && member.kind === 'bot' && member.ownerActorId === self).map(member => member.id));
      const plans = await request<Array<{ id: string; status: string; creator_id: string; revision: number }>>(`/conversations/${room}/plans`);
      const stoppedPlans = new Set<string>();
      const refused = (error: unknown) => !!error && typeof error === 'object' && 'status' in error && [403, 404, 409].includes(Number(error.status));
      for (const plan of plans.filter(plan => plan.creator_id === self && ['proposed', 'running', 'waiting'].includes(plan.status))) {
        try {
          await request(`/conversations/${room}/plans/${chatId(plan.id)}`, 'POST', { operationId: `${operationId}:plan:${plan.id}`, expectedRevision: plan.revision, action: 'stop' });
          stoppedPlans.add(plan.id);
        } catch (error) { if (!refused(error)) throw error; }
      }
      const executions = await request<ChatExecution[]>(`/conversations/${room}/executions`);
      for (const execution of executions.filter(execution => ['queued', 'running', 'needs_input'].includes(execution.status) && !(execution.plan_id && stoppedPlans.has(execution.plan_id)))) {
        const asBot = execution.requester_id !== self && ownBots.has(execution.bot_id);
        if (execution.requester_id !== self && !asBot) continue;
        try {
          await request(`/conversations/${room}/executions/${chatId(execution.id)}/control`, 'POST',
            { operationId: `${operationId}:execution:${execution.id}`, action: 'stop' }, asBot ? execution.bot_id : undefined);
        } catch (error) {
          if (!refused(error)) throw error;
        }
      }
    },
    async older(roomId: string, page: ChatPage): Promise<ChatPage> {
      if (!page.before) return page;
      const messages = await messagePage(chatId(roomId), `limit=100&before=${chatCursor(page.before)}${page.threadRootId ? `&threadRootId=${chatId(page.threadRootId)}` : ''}`);
      const projection = await (await cache())?.projection<ChatMessage>(roomId, page.messages.map(message => message.id));
      if (projection && projection.generation !== page.historyRevision) return this.load(roomId, undefined, page.threadRootId);
      const updates = new Map(projection?.messages.map(message => [message.id, message]));
      const loaded = [...page.messages.map(message => updates.get(message.id) ?? message), ...messages];
      const executionFailures = await failures(roomId, loaded);
      if (projection && (await cache())?.generation(roomId) !== projection.generation) return this.load(roomId, undefined, page.threadRootId);
      return { ...page, messages: loaded, failures: executionFailures,
        before: messages.length === 100 ? chatCursor(messages.at(-1)!.seq) : null };
    },
    async media(roomId: string, mediaId: string, signal?: AbortSignal): Promise<BotGroupAttachment> {
      const media = await request<{ name: string; type: string; size: string | number; url: string }>(`/conversations/${chatId(roomId)}/media/${chatId(mediaId)}`, 'GET', undefined, undefined, signal);
      const size = Number(media.size);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('INVALID_MEDIA_SIZE');
      return { id: mediaId, name: media.name, mimeType: media.type, size, category: media.type.startsWith('image/') ? 'image' : 'file',
        url: chatHttpsUrl(media.url), path: null };
    },
    /** Enrich the already visible page without holding its first paint behind extra reads. */
    async hydrateThreads(roomId: string, page: ChatPage): Promise<ChatPage> {
      const room = chatId(roomId);
      const threadSources: Record<string, ChatMessage | null> = {};
      const threadRoots: Record<string, ChatMessage | null> = {};
      const previewMessages: ChatMessage[] = [];
      const known = new Map([...page.snapshot.messages, ...page.messages].map(message => [message.id, message]));
      const work: Array<() => Promise<void>> = [];
      let threadRetryAt: number | undefined;
      const schedule = (at: number) => { if (Number.isFinite(at)) threadRetryAt = Math.min(threadRetryAt ?? at, at); };
      const read = (id: string, task: () => Promise<void>) => {
        const key = `${room}:${id}`, failed = threadFailures.get(key);
        if (failed && failed.at > Date.now()) { schedule(failed.at); return; }
        work.push(async () => {
          try { await task(); threadFailures.delete(key); }
          catch {
            const attempts = (failed?.attempts ?? 0) + 1;
            const at = attempts <= retryDelays.length ? Date.now() + retryDelays[attempts - 1]! : Infinity;
            threadFailures.set(key, { attempts, at }); schedule(at);
          }
        });
      };
      for (const sourceId of new Set(page.messages.flatMap(message => readBotGroupThreadShareCard(message)?.messageId ?? []))) {
        if (known.has(sourceId)) { threadSources[sourceId] = known.get(sourceId)!; continue; }
        read(`source:${sourceId}`, async () => {
          try {
            const stored = await cache();
            threadSources[sourceId] = stored ? await stored.message<ChatMessage>(room, chatId(sourceId))
              : await request<ChatMessage>(`/conversations/${room}/messages/${chatId(sourceId)}`);
          } catch (error) {
            // Source-level denial hides this reference, never the entire room.
            if ([403, 404, 410].includes((error as { status?: number })?.status ?? 0)) threadSources[sourceId] = null;
            else throw error;
          }
        });
      }
      // A recent reply does not prove that its root is in the current window.
      // Resolve roots independently; a transient failure stays loading, never deleted.
      const rootIds = new Set([...known.values()].flatMap(message => {
        const sharedRoot = readBotGroupThreadShareCard(message)?.threadRootId;
        return [...(message.threadRootId ? [message.threadRootId] : []), ...(sharedRoot ? [sharedRoot] : [])];
      }));
      for (const rootId of rootIds) {
        if (known.has(rootId)) continue;
        read(`root:${rootId}`, async () => {
          try {
            const stored = await cache();
            threadRoots[rootId] = stored ? await stored.message<ChatMessage>(room, chatId(rootId))
              : await request<ChatMessage>(`/conversations/${room}/messages/${chatId(rootId)}`);
          } catch (error) {
            if ([403, 404, 410].includes((error as { status?: number })?.status ?? 0)) threadRoots[rootId] = null;
            else throw error;
          }
        });
      }
      let index = 0;
      const drain = () => Promise.all(Array.from({ length: Math.min(4, work.length) }, async () => {
        while (index < work.length) await work[index++]!();
      }));
      await drain();
      const previewRoots = new Map([...page.messages, ...[...rootIds].flatMap(id => threadRoots[id] ?? known.get(id) ?? [])]
        .map(message => [message.id, message]));
      if (!page.threadRootId) for (const root of previewRoots.values()) {
        if (root.threadRootId || root.deleted || !root.replyCount) continue;
        const latest = page.snapshot.messages.filter(message => message.threadRootId === root.id && !message.deleted);
        if (page.snapshot.messages.length < 100 || latest.length >= Math.min(root.replyCount, 2)) continue;
        read(`preview:${root.id}`, async () => {
          let before: string | undefined;
          const found: ChatMessage[] = [];
          for (let count = 0; count < 4 && found.length < Math.min(root.replyCount!, 2); count++) {
            const batch = await messagePage(room, `limit=6&threadRootId=${chatId(root.id)}${before ? `&before=${before}` : ''}`);
            found.push(...batch.filter(message => !message.deleted && message.threadRootId === root.id));
            if (batch.length < 6) break;
            const next = batch.reduce((min, message) => BigInt(chatCursor(message.seq)) < BigInt(min) ? message.seq : min, batch[0]!.seq);
            if (before && BigInt(next) >= BigInt(before)) break;
            before = next;
          }
          previewMessages.push(...found);
        });
      }
      await drain();
      return { ...page, threadSources, threadRoots, previewMessages, threadRetryAt };
    },
    async followThread(roomId: string, rootId: string, following: boolean, operationId: string) {
      const room = chatId(roomId);
      const snapshot = await request<ChatSnapshot>(`/conversations/${room}/snapshot`);
      if (!snapshot.reads) throw new Error('THREAD_FOLLOW_UNSUPPORTED');
      const readSeq = chatCursor(snapshot.reads.find(read => read.thread_key === rootId)?.read_seq ?? '0');
      return request<{ following: boolean }>(`/conversations/${room}/read`, 'POST', {
        operationId, threadRootId: chatId(rootId), readSeq, following,
      });
    },
    async shareToMain(roomId: string, messageId: string, threadRootId: string, durable?: { body?: ChatSendBody; save(body: ChatSendBody): Promise<void> }) {
      const room = chatId(roomId);
      let body = durable?.body;
      if (body) {
        const self = await identity();
        const card = readBotGroupThreadShareCard({ content: body.content });
        if (body.operationId !== botGroupThreadShareOperationId(messageId) || card?.messageId !== messageId
          || card.threadRootId !== threadRootId || body.threadRootId || body.mentions.length !== 1 || body.mentions[0] !== self) throw new Error('SHARE_UNAVAILABLE');
      }
      if (!body) {
        let source: ChatMessage;
        try { source = await request<ChatMessage>(`/conversations/${room}/messages/${chatId(messageId)}`); }
        catch (error) {
          if ([403, 404, 410].includes((error as { status?: number })?.status ?? 0)) throw new Error('SHARE_UNAVAILABLE');
          throw error;
        }
        if (source.id !== messageId || source.threadRootId !== chatId(threadRootId) || source.deleted || source.origin === 'system') throw new Error('SHARE_UNAVAILABLE');
        const [members, self] = await Promise.all([request<ChatMember[]>(`/conversations/${room}/members`), identity()]);
        const author = members.find(member => member.id === source.authorId);
        body = { operationId: botGroupThreadShareOperationId(source.id), mentions: [self], content: [buildBotGroupThreadShareCard({
          messageId: source.id, threadRootId: source.threadRootId,
          authorName: author ? memberName(author, members) : source.author.name,
          text: mobileMarkdownPreviewText(contentText(source)) || mediaNames(source),
        })] };
        await durable?.save(body);
      }
      try {
        const result = await request<{ id: string }>(`/conversations/${room}/messages`, 'POST', body);
        return { messageId: chatId(result.id), alreadyShared: false };
      } catch (error) {
        if ((error as { code?: string })?.code === 'OPERATION_CONFLICT' || (error instanceof Error && error.message === 'OPERATION_CONFLICT')) {
          return { messageId: null, alreadyShared: true };
        }
        throw error;
      }
    },
    async react(roomId: string, messageId: string, emoji: string, present: boolean, operationId: string) {
      return request(`/conversations/${chatId(roomId)}/messages/${chatId(messageId)}/reactions`, 'POST', { operationId, emoji, present });
    },
    async markRead(roomId: string, page: ChatPage, messageIds: readonly string[]) {
      // Old servers omit reads. Never infer a read position from a presentation index.
      if (!page.snapshot.reads) return;
      const seen = new Set(messageIds);
      const key = page.threadRootId ?? 'main';
      const before = page.snapshot.reads.find(read => read.thread_key === key)?.read_seq ?? '0';
      const newest = page.messages.reduce((latest, message) => seen.has(message.id) && (message.threadRootId ?? undefined) === page.threadRootId
        && BigInt(chatCursor(message.seq)) > BigInt(latest) ? message.seq : latest, before);
      if (BigInt(newest) <= BigInt(before)) return;
      const saved = await request<{ readSeq: string }>(`/conversations/${chatId(roomId)}/read`, 'POST', {
        operationId: `read-${key}:${newest}`, readSeq: newest, ...(page.threadRootId ? { threadRootId: page.threadRootId } : {}),
      });
      const readSeq = chatCursor(saved.readSeq);
      const current = page.snapshot.reads.find(read => read.thread_key === key);
      if (current) { if (BigInt(readSeq) > BigInt(current.read_seq)) current.read_seq = readSeq; }
      else page.snapshot.reads.push({ thread_key: key, read_seq: readSeq });
    },
    async send(roomId: string, input: ChatSendInput, durable?: {
      body?: ChatSendBody;
      save(body: ChatSendBody): Promise<void>;
    }) {
      if (durable?.body) return request<ChatMessage>(`/conversations/${chatId(roomId)}/messages`, 'POST', durable.body);
      const key = JSON.stringify([roomId, input.clientId, input.text, input.mentions, input.quote?.messageId, input.threadRootId, input.attachments]);
      const known = input.quote ? postedQuotes.get(key) : undefined;
      const content: ChatMessage['content'] = known?.content ?? [
        ...(input.text ? [{ type: 'text', text: input.text }] : []),
        ...(input.attachments ?? []).map(attachment => ({ type: 'media', mediaId: chatId(attachment.id), caption: attachment.name })),
      ];
      const mentions = new Set(known?.mentions ?? input.mentions.botIds.map(chatId));
      if (input.quote && !known) {
        const [original, members] = await Promise.all([
          request<ChatMessage>(`/conversations/${chatId(roomId)}/messages/${chatId(input.quote.messageId)}`),
          request<ChatMember[]>(`/conversations/${chatId(roomId)}/members`),
        ]);
        if (original.deleted || (original.threadRootId && original.threadRootId !== input.threadRootId) || original.origin === 'system') throw new Error('QUOTE_UNAVAILABLE');
        const member = members.find(member => member.id === original.authorId);
        const quote = botGroupQuoteFromMessage({ id: original.id, sequence: Number(original.seq), authorKind: original.author.kind === 'human' ? 'user' : 'bot',
          authorName: member ? memberName(member, input.conversationKind === 'direct' ? [] : members) : original.author.name, content: contentText(original), task: taskCardOf(original) ?? undefined,
          attachments: original.content.filter(block => block.type === 'media').map(block => ({ name: attachmentName(block) })) });
        // Quote positions are only an optional UI hint; never round a server cursor into it.
        if (!Number.isSafeInteger(quote.sequence)) quote.sequence = null;
        content.unshift(buildBotGroupQuoteCard(quote));
        if (member?.kind === 'bot' && member.state === 'joined') mentions.add(chatId(member.id));
      }
      if (input.quote) {
        postedQuotes.set(key, { content, mentions: [...mentions] });
        if (postedQuotes.size > 128) postedQuotes.delete(postedQuotes.keys().next().value!);
      }
      try {
        const body: ChatSendBody = { operationId: input.clientId,
          content, mentions: [...mentions], ...(input.threadRootId ? { threadRootId: chatId(input.threadRootId) } : {}) };
        // The exact body is durable before POST. A lost response/restart must not
        // rebuild its quote or recipients under the same operationId.
        await durable?.save(body);
        const result = await request<ChatMessage>(`/conversations/${chatId(roomId)}/messages`, 'POST', body);
        postedQuotes.delete(key);
        return result;
      } catch (error) {
        const status = (error as { status?: number })?.status;
        if (status && status >= 400 && status < 500 && status !== 408) postedQuotes.delete(key);
        throw error;
      }
    },
  };
}
