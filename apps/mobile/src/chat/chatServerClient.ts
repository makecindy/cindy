/** The existing Chat Server HTTP contract; no device-link or executor registration. */
import { readBotGroupExecutionFailure, readImportedBotGroupRuntimeFailureCode, type BotGroupAttachment, type BotGroupMemberView, type BotGroupMessageView, type BotGroupRemoteChatData } from '@cindy/maker-shared/botGroupChat';
import { botGroupExecutionFailureBatches, projectBotGroupExecutionFailures } from '@cindy/maker-shared/botGroupPresentation';
import type { HostedRemoteCollectionItem } from '@/device-link/remoteResources';

export interface ChatRoom {
  id: string; name: string; state?: string; kind: string; archived: boolean;
  created_at: string; updated_at: string; revision: number; head?: string;
  response_mode: 'all' | 'mentioned'; speaking_mode: 'auto' | 'sequential'; organizer_id?: string | null;
}
export interface ChatMember {
  id: string; kind: 'human' | 'bot' | 'integration'; name: string; state: string;
  ownerActorId: string; ownerName: string; avatar: string | null;
  role: 'owner' | 'admin' | 'member' | 'guest';
}
export interface ChatMessage {
  id: string; seq: string; authorId: string; author: { kind: string; name: string };
  createdAt: string; deleted: boolean; threadRootId: string | null; origin?: string;
  content: Array<{ type: string; text?: string; fallback?: string; mediaId?: string; caption?: string;
    namespace?: string; schemaRevision?: number; data?: Record<string, unknown> }>;
}
export interface ChatSnapshot { room: ChatRoom; members: ChatMember[]; messages: ChatMessage[]; cursor: string; reads?: Array<{ thread_key: string; read_seq: string }> }
export interface ChatExecutionFailure {
  id: string; conversation_id?: string; source_message_id: string; bot_id: string; epoch: number; status?: string;
  failure_code?: unknown; updated_at?: string; plan_id?: string | null;
}
export interface ChatPage { snapshot: ChatSnapshot; messages: ChatMessage[]; before: string | null; failures?: ChatExecutionFailure[] }
export type ChatRequest = <T>(path: string, method?: 'GET' | 'POST', body?: unknown) => Promise<T>;

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
const memberName = (member: ChatMember) => member.kind === 'bot' && member.ownerName?.trim()
  ? `${member.name} (${member.ownerName.trim()})` : member.name;
const contentText = (message: ChatMessage) => message.deleted || readImportedBotGroupRuntimeFailureCode(message) ? '' : message.content
  .map(block => block.text ?? block.fallback ?? (block.type === 'media' ? block.caption ?? '' : '')).join('\n');

/** Empty device identity means a server-owned conversation, never a fictitious computer. */
export function chatRoomRow(room: ChatRoom, snapshot?: ChatSnapshot, selfId?: string): HostedRemoteCollectionItem {
  const members = snapshot?.members.filter(member => member.state === 'joined') ?? [];
  const last = snapshot?.messages.filter(message => !message.threadRootId && !message.deleted)
    .sort((a, b) => BigInt(chatCursor(a.seq)) < BigInt(chatCursor(b.seq)) ? 1 : -1)[0];
  return { key: `chat:${room.id}`, host: { deviceId: '', deviceName: '' },
    lastReplySequence: snapshot && selfId ? chatLastReplySequence(snapshot.messages, selfId) : undefined,
    groupMembers: snapshot ? members.map(chatMemberIdentity) : undefined, item: {
    ref: { collectionId: 'bot-groups', kind: 'bot-group', id: room.id },
    revision: String(room.head ?? room.revision), display: { title: room.name,
      subtitle: members.map(memberName).join(' · '),
      ...(snapshot ? { preview: last ? contentText(last).slice(0, 160) || members.map(memberName).join(' · ') : '' } : {}),
      timestamp: Date.parse(last?.createdAt ?? room.updated_at),
      lastReplyAt: snapshot && selfId ? chatLastReplyAt(snapshot.messages, selfId) : undefined },
    links: members.map(member => ({ rel: 'member', label: memberName(member),
      target: { kind: 'resource', ref: { collectionId: 'teammates', kind: 'bot', id: member.id } } })),
  } };
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

/** Import only the server's acknowledged position, never mark an unseen reply as read. */
export function chatReadAt(snapshot: ChatSnapshot, selfId: string): number {
  const sequence = chatReadSequence(snapshot);
  return chatLastReplyAt(snapshot.messages.filter(message => BigInt(chatCursor(message.seq)) <= BigInt(chatCursor(sequence))), selfId);
}

/** Public profile images never enter the computer's local media resolver. */
function chatMemberAvatar(value: string | null): Pick<BotGroupMemberView, 'avatar' | 'avatarUrl'> {
  const raw = value ?? '';
  try { return { avatar: '', avatarUrl: chatHttpsUrl(raw) }; } catch { /* Not a public HTTPS image. */ }
  // The server also accepts the existing bundled presets and short emoji identities.
  const avatar = /^cindy:\/\/avatar\/preset\/(cindy|dash|lizi)$/.test(raw)
    || (raw.length <= 16 && !/[a-zA-Z0-9/:\x00-\x1f]/.test(raw)) ? raw : '';
  return { avatar, avatarUrl: null };
}

function chatMemberIdentity(member: ChatMember) {
  return { botId: member.id, name: memberName(member), ...chatMemberAvatar(member.avatar), avatarColor: '' };
}

/** Sequence strings stay on the wire; numeric positions below are presentation order only. */
export function chatGroupView(page: ChatPage, selfId: string): BotGroupRemoteChatData {
  const { room, members } = page.snapshot;
  const active = members.filter(member => member.state === 'joined');
  const memberViews: BotGroupMemberView[] = active.map(member => ({
    ...chatMemberIdentity(member), actorId: member.id, actorKind: member.kind, isSelf: member.id === selfId,
    isOwned: member.ownerActorId === selfId, role: member.role,
    status: 'active',
  }));
  const sorted = [...new Map(page.messages.map(message => [message.id, message])).values()].filter(message => !message.deleted)
    .sort((a, b) => BigInt(chatCursor(a.seq)) < BigInt(chatCursor(b.seq)) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0);
  const messages: BotGroupMessageView[] = sorted.map((message, index) => {
    const runtimeFailureCode = readImportedBotGroupRuntimeFailureCode(message);
    const legacy = runtimeFailureCode ? message.content.find(block => block.type === 'card' && block.namespace === 'cindy.local-history' && block.schemaRevision === 1)?.data : undefined;
    if (runtimeFailureCode) return { id: message.id, sequence: index + 1, kind: 'notice', authorKind: 'system',
      authorBotId: message.authorId, authorName: typeof legacy?.authorName === 'string' ? legacy.authorName : '', isSelf: false,
      content: '', mentions: { all: false, botIds: [] }, noticeCode: runtimeFailureCode === 'RUNTIME_TIMEOUT' ? 'member-timeout' : 'member-failed',
      runtimeFailureCode, planId: null, files: [], attachments: [], createdAt: Date.parse(message.createdAt) };
    const member = active.find(candidate => candidate.id === message.authorId);
    const joined = message.origin === 'system' && !message.deleted && message.content.find(block =>
      block.type === 'card' && block.namespace === 'cindy.membership' && block.schemaRevision === 1 && block.data?.type === 'member.joined');
    return { id: message.id, sequence: index + 1, kind: message.origin === 'system' ? 'notice' : 'message',
      authorKind: message.origin === 'system' ? 'system' : message.author.kind === 'human' ? 'user' : 'bot',
      authorBotId: message.authorId, authorName: joined && typeof joined.data?.displayName === 'string' ? joined.data.displayName
        : member ? memberName(member) : message.author.name,
      isSelf: message.authorId === selfId, content: contentText(message), mentions: { all: false, botIds: [] },
      noticeCode: joined ? 'member-joined' : null, planId: null, files: [],
      attachments: message.deleted ? [] : message.content.flatMap(block => {
        if (block.type !== 'media' || !block.mediaId) return [];
        return [{ id: block.mediaId, name: block.caption ?? '', category: 'file' as const,
          mimeType: '', size: 0, url: null, path: null }];
      }), createdAt: Date.parse(message.createdAt) };
  });
  const last = messages.at(-1);
  const failures = (page.failures ?? []).flatMap(row => {
    const failure = readBotGroupExecutionFailure(row, room.id);
    if (!failure) return [];
    const member = members.find(candidate => candidate.id === failure.botId);
    return [{ ...failure, botName: member ? memberName(member) : '' }];
  });
  return { id: room.id, name: room.name, serverBacked: true, archived: room.archived, selfActorId: selfId,
    revision: room.revision, members: memberViews, replyMode: room.response_mode, speakingMode: room.speaking_mode,
    organizerBotId: room.organizer_id ?? null, projectDir: null, projectDirName: null,
    createdAt: Date.parse(room.created_at), updatedAt: Date.parse(room.updated_at),
    lastMessage: last ? { authorKind: last.authorKind, authorName: last.authorName, preview: last.content.slice(0, 80), createdAt: last.createdAt } : null,
    speakingBotIds: [], planningBotId: null, openPlan: null, plans: [], messages: projectBotGroupExecutionFailures(messages, failures),
    hasMoreBefore: page.before !== null, round: { status: 'idle', speakers: [], canContinue: false }, supportsAttachments: false };
}

export function createChatServerClient(request: ChatRequest) {
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
  return {
    async list(): Promise<ChatRoom[]> {
      const rooms = new Map<string, ChatRoom>();
      let after: string | undefined;
      do {
        const page = await request<ChatRoom[]>(`/conversations?limit=100${after ? `&after=${after}` : ''}`);
        if (!Array.isArray(page)) throw new Error('INVALID_CHAT_LIST');
        for (const room of page) {
          chatId(room.id);
          if (!['direct', 'group', 'channel'].includes(room.kind)) throw new Error('INVALID_CHAT_LIST');
          if (room.state === 'joined' && room.kind === 'group') rooms.set(room.id, room);
        }
        const next = page.length === 100 ? chatId(page.at(-1)!.id) : undefined;
        if (next && next === after) throw new Error('INVALID_CHAT_PAGE');
        after = next;
      } while (after);
      return [...rooms.values()];
    },
    async me(): Promise<string> {
      const { actor } = await request<{ actor: { id: string; kind: string } }>('/me');
      if (actor.kind !== 'human') throw new Error('INVALID_CHAT_IDENTITY');
      return chatId(actor.id);
    },
    async snapshot(roomId: string): Promise<ChatSnapshot> {
      return request(`/conversations/${chatId(roomId)}/snapshot`);
    },
    async members(roomId: string): Promise<ChatMember[]> {
      const members = await request<ChatMember[]>(`/conversations/${chatId(roomId)}/members`);
      if (!Array.isArray(members)) throw new Error('INVALID_CHAT_MEMBERS');
      return members;
    },
    async load(roomId: string, oldest?: string): Promise<ChatPage> {
      const room = chatId(roomId);
      const snapshot = await request<ChatSnapshot>(`/conversations/${room}/snapshot`);
      if (snapshot.room.id !== room || !Array.isArray(snapshot.members)) throw new Error('INVALID_CHAT_SNAPSHOT');
      chatCursor(snapshot.cursor);
      // Snapshot includes Thread replies; the message endpoint selects the main timeline.
      let batch = await request<ChatMessage[]>(`/conversations/${room}/messages?limit=100`);
      const messages = [...batch];
      let before = batch.length === 100 ? chatCursor(batch.at(-1)!.seq) : null;
      // Reauthorize and re-read the displayed window on invalidation, including edits/removals.
      while (oldest && before && BigInt(before) > BigInt(chatCursor(oldest))) {
        batch = await request<ChatMessage[]>(`/conversations/${room}/messages?limit=100&before=${before}`);
        const next = batch.length === 100 ? chatCursor(batch.at(-1)!.seq) : null;
        if (next && BigInt(next) >= BigInt(before)) throw new Error('INVALID_CHAT_PAGE');
        messages.push(...batch); before = next;
      }
      return { snapshot, messages, before, failures: await failures(room, messages) };
    },
    async older(roomId: string, page: ChatPage): Promise<ChatPage> {
      if (!page.before) return page;
      const messages = await request<ChatMessage[]>(`/conversations/${chatId(roomId)}/messages?limit=100&before=${chatCursor(page.before)}`);
      const loaded = [...page.messages, ...messages];
      return { ...page, messages: loaded, failures: await failures(roomId, loaded),
        before: messages.length === 100 ? chatCursor(messages.at(-1)!.seq) : null };
    },
    async media(roomId: string, mediaId: string): Promise<BotGroupAttachment> {
      const media = await request<{ name: string; type: string; size: string | number; url: string }>(`/conversations/${chatId(roomId)}/media/${chatId(mediaId)}`);
      const size = Number(media.size);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('INVALID_MEDIA_SIZE');
      return { id: mediaId, name: media.name, mimeType: media.type, size, category: media.type.startsWith('image/') ? 'image' : 'file',
        url: chatHttpsUrl(media.url), path: null };
    },
    async send(roomId: string, input: { clientId: string; text: string; mentions: { all: boolean; botIds: string[] } }) {
      return request(`/conversations/${chatId(roomId)}/messages`, 'POST', { operationId: input.clientId,
        content: [{ type: 'text', text: input.text }], mentions: input.mentions.botIds.map(chatId) });
    },
  };
}
