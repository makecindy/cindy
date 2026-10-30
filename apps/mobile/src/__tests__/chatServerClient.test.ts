import { describe, expect, it, vi } from 'vitest';
import { resolveRemoteText } from '@cindy/device-link';
import { i18n } from '@/i18n';
import { botGroupNewMessageCount } from '@cindy/maker-shared/botGroupPresentation';
import { createChatHistory, type ChatHistoryState } from '@cindy/maker-shared/chat-history';
import { chatGroupView, chatRoomRow, chatReadAt, createChatServerClient, type ChatMessage, type ChatPage, type ChatRoom, type ChatSnapshot } from '@/chat/chatServerClient';
import type { ChatHistory } from '@cindy/maker-shared/chat-history';
import { botGroupQuoteFromMessage, resolveBotGroupQuote, buildBotGroupQuoteCard, buildBotGroupTaskCard } from '@cindy/maker-shared/botGroupChat';
import { orderedBotGroups } from '@/session/botGroupRemote';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const room = (n = 1, state = 'joined'): ChatRoom => ({ id: id(n), name: 'Discussion', kind: 'group', state, archived: false,
  revision: 1, created_at: '2026-10-01', updated_at: '2026-10-09', response_mode: 'all', speaking_mode: 'auto' });
const message = (n: number): ChatMessage => ({ id: id(n), seq: String(9007199254740992n + BigInt(n)), authorId: id(10),
  author: { kind: 'human', name: 'Other member' }, createdAt: '2026-10-09', deleted: false, threadRootId: null,
  content: [{ type: 'text', text: String(n) }] });
const snapshot = (): ChatSnapshot => ({ room: room(), cursor: '9007199254741099', messages: [], members: [
  { id: id(10), kind: 'human', name: 'Other member', state: 'joined', ownerActorId: id(10), ownerName: '', avatar: null, role: 'member' },
] });

describe('group list activity', () => {
  it('refreshes pending execution state without a new message and tolerates an older server', async () => {
    const request = vi.fn().mockResolvedValueOnce([{ status: 'running' }]).mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ status: 'needs_input' }]).mockResolvedValueOnce([])
      .mockRejectedValueOnce(Object.assign(new Error('NOT_FOUND'), { status: 404 })).mockResolvedValueOnce([]);
    const client = createChatServerClient(request);
    const value = snapshot();
    expect(await client.rosterActivity(value.room.id, value)).toEqual({ phase: 'running' });
    const awaiting = await client.rosterActivity(value.room.id, value);
    expect(chatRoomRow(value.room, value, undefined, awaiting).item.display.teammateActivity)
      .toEqual({ phase: 'needs-interaction' });
    expect(await client.rosterActivity(value.room.id, value)).toBeUndefined();
    expect(request.mock.calls.every(([path]) => /\/(executions|plans)$/.test(path))).toBe(true);
  });

  it('places a newly created empty group and a group with a new topic ahead of an older main chat', () => {
    const old = chatRoomRow(room(1), { ...snapshot(), messages: [{ ...message(20), createdAt: '2026-10-10T12:00:00Z' }] });
    const fresh = chatRoomRow({ ...room(2), created_at: '2026-10-11T12:00:00Z' }, { ...snapshot(), messages: [] });
    const topic = chatRoomRow(room(3), { ...snapshot(), messages: [{ ...message(21), threadRootId: id(20), createdAt: '2026-10-12T12:00:00Z' }] });
    expect(orderedBotGroups([old, fresh, topic], '', 'zh-CN').map(row => row.item.ref.id)).toEqual([id(3), id(2), id(1)]);
  });

  it('orders a new empty group by creation, without inventing a creation message or bumping on edits', () => {
    const empty = { ...room(), created_at: '2026-10-10T12:00:00Z', updated_at: '2026-10-20T12:00:00Z' };
    const row = chatRoomRow(empty, { ...snapshot(), room: empty });
    expect(row.item.display.timestamp).toBe(Date.parse(empty.created_at));
    expect(row.item.display.preview).toBe('');
    expect(chatRoomRow(empty).item.display.timestamp).toBe(Date.parse(empty.created_at));
  });

  it('uses the newest topic reply even when the snapshot is unordered, excluding deleted messages', () => {
    const main = { ...message(20), createdAt: '2026-10-10T12:00:00Z' };
    const topic = { ...message(21), threadRootId: main.id, createdAt: '2026-10-11T12:00:00Z' };
    const deleted = { ...message(22), deleted: true, createdAt: '2026-10-12T12:00:00Z' };
    const row = chatRoomRow(room(), { ...snapshot(), messages: [main, deleted, topic] });
    expect(row.item.display).toMatchObject({ timestamp: Date.parse(topic.createdAt), preview: '21' });
  });

  it('localizes shared joins for every reader without adding unread replies, then yields to a new message', () => {
    const reply = { ...message(20), createdAt: '2026-10-10T12:00:00Z' };
    const joined: ChatMessage = { ...message(21), origin: 'system', createdAt: '2026-10-11T12:00:00Z',
      content: [{ type: 'card', namespace: 'cindy.membership', schemaRevision: 1, fallback: 'Taylor joined the group',
        data: { type: 'member.joined', actorId: id(12), displayName: 'Taylor' } }] };
    const value = { ...snapshot(), messages: [reply, joined] };
    for (const self of [id(11), id(12)]) {
      const display = chatRoomRow(room(), value, self).item.display;
      expect(display).toMatchObject({
        timestamp: Date.parse(joined.createdAt), lastReplyAt: Date.parse(reply.createdAt),
      });
      expect(resolveRemoteText(display.preview!, 'zh-CN')).toBe('Taylor加入了群聊');
    }
    const later = { ...message(22), createdAt: '2026-10-12T12:00:00Z' };
    expect(chatRoomRow(room(), { ...value, messages: [reply, joined, later] }).item.display)
      .toMatchObject({ timestamp: Date.parse(later.createdAt), preview: '22' });
    expect(chatRoomRow(room(), { ...value, messages: [{ ...joined, origin: 'user' }] }).item.display.preview)
      .toBe('Taylor joined the group');
  });
});

// Merge regression: history generation changes while execution state is read.
// Production load must retry, retaining both the new revision and fresh work.
it('retains fresh executions when cached history changes during load', async () => {
  const stored = {
    snapshot: vi.fn().mockResolvedValueOnce({ ...snapshot(), cacheGeneration: 'old' })
      .mockResolvedValue({ ...snapshot(), cacheGeneration: 'current' }),
    page: vi.fn(async () => [message(20)]),
    projection: vi.fn(async () => ({ generation: 'current', messages: [] })),
  };
  let reads = 0;
  const request = vi.fn(async (path: string) => {
    if (path === '/me') return { actor: { id: id(11), kind: 'human' } };
    if (path.endsWith('/executions')) return [{ id: id(++reads === 1 ? 30 : 31), bot_id: id(12), status: 'stopping', epoch: 1, source_message_id: id(20) }];
    if (path.includes('/execution-failures?')) return [];
    throw new Error(path);
  });
  const client = createChatServerClient(request as any, undefined, async () => stored as unknown as ChatHistory);
  const page = await client.load(id(1));
  expect(stored.snapshot).toHaveBeenCalledTimes(2);
  expect(page.historyRevision).toBe('current');
  expect(chatGroupView(page, id(11)).round.speakers.map(speaker => [speaker.executionId, speaker.executionStatus])).toEqual([[id(31), 'stopping']]);
});

describe('direct Chat Server client', () => {
  // Unit: reuse cached topic history, but refresh live execution state on every open.
  it('reuses the durable root and reply page while refreshing executions when reopening a topic', async () => {
    let executionStatus = 'running';
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/me') return { actor: { id: id(10), kind: 'human' } };
      if (path.endsWith('/snapshot')) return snapshot();
      if (path.endsWith('/executions')) return [{ id: id(30), bot_id: id(12), status: executionStatus, epoch: 1, source_message_id: id(20) }];
      if (path.endsWith(`/messages/${id(20)}`)) return message(20);
      if (path.includes('/messages?')) return [{ ...message(21), threadRootId: id(20) }];
      return [];
    });
    let saved: ChatHistoryState | undefined;
    const history = createChatHistory({ api: request, current: () => true, newGeneration: () => 'topic',
      store: { read: async () => saved, write: async (_, state) => { saved = state ?? undefined; } } });
    const client = createChatServerClient(request, undefined, async () => history);
    const first = await client.load(id(1), undefined, id(20));
    expect(chatGroupView(first, id(10)).round.speakers).toMatchObject([{ executionId: id(30), executionStatus: 'running' }]);
    executionStatus = 'stopping';
    request.mockClear();
    const reopened = await client.load(id(1), undefined, id(20));
    expect(reopened.messages).toEqual(first.messages);
    expect(first.messages.map(m => m.id)).toEqual([id(21), id(20)]);
    expect(chatGroupView(reopened, id(10)).round.speakers).toMatchObject([{ executionId: id(30), executionStatus: 'stopping' }]);
    // History stays cached while the existing live execution and failure reads
    // still refresh. No snapshot, root or reply-page request may be repeated.
    const refreshedPaths = request.mock.calls.map(([path]) => path.split('?')[0]);
    expect(refreshedPaths).toHaveLength(2);
    expect(refreshedPaths).toEqual(expect.arrayContaining([
      `/conversations/${id(1)}/executions`, `/conversations/${id(1)}/execution-failures`,
    ]));
  });
  // #6907: existing fixtures never pair a human's group name A with account ownerName B (unit tier).
  it('keeps owner labels scoped to each group and follows refreshed names without changing identities', () => {
    const human = { ...snapshot().members[0], name: 'Nickname A' };
    const bot = { ...human, id: id(12), kind: 'bot' as const, name: 'Companion X', ownerName: 'Account B' };
    const messages = [message(20), { ...message(21), authorId: bot.id, author: { kind: 'bot', name: bot.name } }];
    const group = (name: string, roomNumber = 1) => ({ ...snapshot(), room: room(roomNumber), members: [{ ...human, name }, bot], messages });
    const project = (s: ChatSnapshot) => chatGroupView({ snapshot: s, messages, before: null }, id(11));
    const first = group('Nickname A');
    expect(project(first).messages.map(m => m.authorName)).toEqual(['Nickname A', 'Companion X (Nickname A)']);
    expect(chatRoomRow(first.room, first).item.display.subtitle).toBe('Nickname A · Companion X (Nickname A)');
    expect(project(group('Nickname C')).messages[1].authorName).toBe('Companion X (Nickname C)');
    expect(project(group('Nickname D', 2)).messages[1].authorName).toBe('Companion X (Nickname D)');
    expect(project(first).messages[1].authorName).toBe('Companion X (Nickname A)');
    for (const name of ['Account B', '   ']) expect(project(group(name)).messages[1].authorName).toBe('Companion X (Account B)');
    expect(project({ ...first, members: [bot] }).messages[1].authorName).toBe('Companion X (Account B)');
    expect(project({ ...first, members: [{ ...human, state: 'left' }, bot] }).messages[1].authorName).toBe('Companion X (Account B)');
    expect(project({ ...first, members: [{ ...bot, ownerName: '   ' }] }).messages[1].authorName).toBe('Companion X');
    expect(project(first).members.find(m => m.actorId === bot.id)).toMatchObject({ botId: bot.id, isOwned: false });
    expect(bot).toMatchObject({ name: 'Companion X', ownerName: 'Account B', ownerActorId: human.id });
  });
  it.each(['Account B', ''])('keeps direct owner labels from account %s', ownerName => {
    const human = { ...snapshot().members[0], name: 'Nickname A' };
    const bot = { ...human, id: id(12), kind: 'bot' as const, name: 'Companion X', ownerName };
    const source = { ...snapshot(), room: { ...room(), kind: 'direct' }, members: [human, bot] };
    const messages = [{ ...message(20), authorId: bot.id, author: { kind: 'bot', name: bot.name } }];
    const label = ownerName ? 'Companion X (Account B)' : 'Companion X';
    const view = chatGroupView({ snapshot: source, messages, before: null }, human.id);
    expect(view).toMatchObject({ name: label, messages: [{ authorName: label }] });
    expect(view.members.find(m => m.actorId === bot.id)?.name).toBe(label);
    expect(chatRoomRow(source.room, source).groupMembers?.find(m => m.botId === bot.id)?.name).toBe(label);
  });
  it('preserves thread identity through projection into the history new-message counter', () => {
    const view = chatGroupView({ snapshot: snapshot(), before: null, messages: [message(20),
      { ...message(21), threadRootId: id(20) }, { ...message(22), threadRootId: id(99) }] }, id(11));
    expect(botGroupNewMessageCount(view.messages, message(20).seq, id(20))).toBe(1);
    expect(botGroupNewMessageCount(view.messages, message(20).seq)).toBe(0);
  });
  it('reads a 引用回复 card as the quote, keeps it out of text and previews, and marks a deleted original', () => {
    const card = buildBotGroupQuoteCard({ messageId: id(20), authorName: 'Other member', authorKind: 'user', excerpt: 'original words',
      attachmentCount: 0, attachmentName: null, sequence: 20 });
    const replying = { ...message(21), content: [card, { type: 'text', text: 'Agreed' }] };
    const future = { ...message(22), content: [{ ...card, schemaRevision: 2 }, { type: 'text', text: 'Later' }] };
    const page = { snapshot: snapshot(), messages: [message(20), replying, future], before: null };
    const view = chatGroupView(page, id(11));
    expect(view.messages[1]).toMatchObject({ content: 'Agreed', quote: { messageId: id(20), excerpt: 'original words' } });
    expect(view.messages[1].quote?.originalDeleted).toBeUndefined();
    expect(view.messages[2].quote).toBeUndefined();
    expect(view.messages[2].content).toBe(`${card.fallback}\nLater`);
    expect(chatRoomRow(room(), { ...snapshot(), messages: [replying] }, id(11)).item.display.preview).toBe('Agreed');
    const deleted = chatGroupView({ ...page, messages: [{ ...message(20), deleted: true, content: [] }, replying] }, id(11));
    expect(deleted.messages).toHaveLength(1);
    expect(deleted.messages[0].quote).toMatchObject({ messageId: id(20), originalDeleted: true });
  });

  it('opens a direct notification with the peer identity and no group leave control', () => {
    const source = snapshot();
    const peer = { ...source.members[0]!, id: id(12), kind: 'human' as const, name: 'Chris', state: 'joined' };
    const view = chatGroupView({ snapshot: { ...source, room: { ...source.room, kind: 'direct', name: '' }, members: [...source.members, peer] },
      messages: [message(20)], before: null }, source.members[0]!.id);
    expect(view).toMatchObject({ conversationKind: 'direct', name: 'Chris', supportsGroupLeave: false });
    expect(view.messages).toHaveLength(1);
  });

  it('names the home computer of my own companions from the account actors, never of other members', () => {
    const mine = { id: id(12), kind: 'bot' as const, name: 'Mine', state: 'joined', ownerActorId: id(11), ownerName: '', avatar: null, role: 'member' as const };
    const theirs = { id: id(13), kind: 'bot' as const, name: 'Theirs', state: 'joined', ownerActorId: id(10), ownerName: '', avatar: null, role: 'member' as const };
    const page: ChatPage = { snapshot: { ...snapshot(), members: [...snapshot().members, mine, theirs] }, messages: [], before: null };
    const actors = [{ id: id(12), kind: 'bot', externalId: 'mine', name: 'Mine', avatar: null, homeDeviceId: 'pc' }];
    const members = chatGroupView(page, id(11), actors).members;
    expect(members.find(member => member.botId === id(12))).toMatchObject({ isOwned: true, homeDeviceId: 'pc' });
    expect(members.find(member => member.botId === id(13))).not.toHaveProperty('homeDeviceId');
    // Without the actor list (older or failed read) an owned companion has no known computer.
    expect(chatGroupView(page, id(11)).members.find(member => member.botId === id(12))).toMatchObject({ homeDeviceId: null });
  });

  it('reads a task card on a teammate message as its task, and only there (bot-group-chat.md §10)', () => {
    const card = buildBotGroupTaskCard({ meta: { v: 1, role: 'delegation-request', delegationId: 'task-1', fromBotId: 'bot', fromBotName: 'Bot',
      toBotId: null, toBotName: 'Cindy', parentSessionId: 'lane', childSessionId: 'child', objective: 'Launch post' }, state: 'started', title: 'Launch post' },
    { task: 'Task', untitled: 'Background task', states: { started: 'In progress', waiting: 'Waiting', completed: 'Done', failed: 'Failed', cancelled: 'Cancelled', 'timed-out': 'Timed out' } });
    const fromBot = { ...message(20), authorId: id(12), author: { kind: 'bot', name: 'Bot' }, content: [{ type: 'text', text: 'Started it.' }, card] };
    const fromHuman = { ...message(21), content: [card, { type: 'text', text: 'Pasted a card' }] };
    const view = chatGroupView({ snapshot: snapshot(), messages: [fromBot, fromHuman], before: null }, id(11));
    expect(view.messages[0]).toMatchObject({ authorKind: 'bot', content: 'Started it.', task: { state: 'started', title: 'Launch post' } });
    expect(view.messages[1].task).toBeUndefined();
    expect(view.messages[1].content).toBe(`${card.fallback}\nPasted a card`);
    for (const state of ['started', 'waiting'] as const) {
      const onlyCard = { ...fromBot, content: [{ ...card, data: { ...card.data, state } }] };
      const single = chatGroupView({ snapshot: snapshot(), messages: [onlyCard], before: null }, id(11));
      expect(single.messages[0]).toMatchObject({ content: '', task: { state, title: 'Launch post' } });
      expect(single.lastMessage?.preview).toBe('Launch post');
      expect(chatRoomRow(room(), { ...snapshot(), messages: [onlyCard] }, id(11)).item.display.preview).toBe('Launch post');
      const quote = botGroupQuoteFromMessage(single.messages[0]);
      expect(quote.excerpt).toBe('Launch post');
      expect(resolveBotGroupQuote({ ...quote, excerpt: 'stale' }, single.messages)).toMatchObject({ state: 'live', excerpt: 'Launch post' });
      expect(resolveBotGroupQuote(quote, [])).toMatchObject({ state: 'snapshot', excerpt: 'Launch post' });
    }
    expect(botGroupQuoteFromMessage(view.messages[0]).excerpt).toBe('Started it.');
  });

  it('reconciles all loaded message pages in bounded requests and clears an old-source failure on refresh', async () => {
    const latest = Array.from({ length: 100 }, (_, n) => message(200 - n));
    const older = Array.from({ length: 100 }, (_, n) => message(100 - n));
    let status = 'failed';
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path.endsWith('/snapshot')) return snapshot();
      if (path.includes('/execution-failures?')) {
        const ids = new URLSearchParams(path.split('?')[1]).get('sourceIds')!.split(',');
        return ids.includes(id(1)) ? [{ id: id(500), source_message_id: id(1), bot_id: id(10), epoch: 1, status,
          failure_code: 'AUTH_REQUIRED' }] : [];
      }
      return path.includes('&before=') ? older : latest;
    });
    const client = createChatServerClient(request);
    const first = await client.load(id(1));
    expect(first.failures).toEqual([]);
    const loaded = await client.older(id(1), first);
    expect(chatGroupView(loaded, id(11)).messages[1]).toMatchObject({ runtimeFailureCode: 'AUTH_REQUIRED' });
    const scopes = request.mock.calls.filter(([path]) => path.includes('/execution-failures?'))
      .map(([path]) => new URLSearchParams(path.split('?')[1]).get('sourceIds')!.split(','));
    expect(scopes.map(ids => ids.length)).toEqual([100, 100, 100]);
    expect(scopes.slice(1).flat()).toEqual([...latest, ...older].map(message => message.id));
    status = 'queued';
    expect(chatGroupView(await client.load(id(1), older.at(-1)!.seq), id(11)).messages).toHaveLength(200);
  });

  it.each(['structured', 'old-marker', 'chat-forgery'])('projects imported runtime notices safely: %s', shape => {
    const source = { ...message(20), origin: shape === 'chat-forgery' ? 'chat' : 'import',
      content: [{ type: 'text', text: shape === 'structured' ? 'group activity' : 'cindy-runtime-error:AUTH_REQUIRED' },
        { type: 'card', namespace: 'cindy.local-history', schemaRevision: 1, fallback: 'group activity',
          data: { kind: 'notice', authorKind: 'system', authorName: 'Bot', noticeCode: 'member-failed',
            ...(shape !== 'old-marker' ? { runtimeFailureCode: 'AUTH_REQUIRED' } : {}) } }] };
    const view = chatGroupView({ snapshot: snapshot(), messages: [source], before: null }, id(11));
    if (shape === 'chat-forgery') {
      expect(view.messages[0]).toMatchObject({ kind: 'message', authorKind: 'user' });
      expect(view.messages[0].runtimeFailureCode).toBeUndefined();
    } else {
      expect(view.messages[0]).toMatchObject({ kind: 'notice', authorKind: 'system', authorName: 'Bot', runtimeFailureCode: 'AUTH_REQUIRED', content: '' });
      expect(JSON.stringify(view.messages)).not.toContain('cindy-runtime-error:');
      expect(chatRoomRow(room(), { ...snapshot(), messages: [source] }, id(11)).item.display.preview).not.toContain('cindy-runtime-error:');
    }
  });
  it('names a media block the server sent without a caption, in the attachment and the list preview', () => {
    const untitled = i18n.t('groupChat.files.untitled');
    expect(untitled).not.toBe('groupChat.files.untitled');
    const unnamed = { ...message(22), content: [{ type: 'media', mediaId: id(33) }] };
    const view = chatGroupView({ snapshot: snapshot(), messages: [unnamed], before: null }, id(11));
    expect(view.messages[0]!.attachments.map(attachment => attachment.name)).toEqual([untitled]);
    expect(chatRoomRow(room(), { ...snapshot(), messages: [unnamed] }, id(11)).item.display.preview).toBe(untitled);
  });
  it('shows media as the message attachments, not as caption text, and keeps typed look-alike text', () => {
    const withText = { ...message(20), content: [{ type: 'text', text: '我写的 [附件: a.png]' }, { type: 'media', mediaId: id(30), caption: 'clipboard-1.png' }] };
    const onlyMedia = { ...message(21), content: [{ type: 'media', mediaId: id(31), caption: 'a.png' }, { type: 'media', mediaId: id(32), caption: 'b.pdf' }] };
    const view = chatGroupView({ snapshot: snapshot(), messages: [onlyMedia, withText], before: null }, id(11));
    expect(view.messages.map(({ content, attachments }) => ({ content, names: attachments.map(attachment => attachment.name) }))).toEqual([
      { content: '我写的 [附件: a.png]', names: ['clipboard-1.png'] },
      { content: '', names: ['a.png', 'b.pdf'] },
    ]);
    expect(chatRoomRow(room(), { ...snapshot(), messages: [onlyMedia] }, id(11)).item.display.preview).toBe('a.png, b.pdf');
    const blankText = { ...onlyMedia, content: [{ type: 'text', text: ' \n' }, ...onlyMedia.content] };
    expect(chatRoomRow(room(), { ...snapshot(), messages: [blankText] }, id(11)).item.display.preview).toBe('a.png, b.pdf');
  });
  it.each(['AUTH_REQUIRED', 'private diagnostic', undefined])('reads executions and projects a safe notice beside its visible source: %s', async failure_code => {
    const source = message(20);
    let status = 'failed';
    const request = vi.fn();
    request.mockImplementation(async (path: string) => path.endsWith('/snapshot') ? snapshot()
      : path.includes('/execution-failures?') ? [{ id: id(30), source_message_id: source.id, bot_id: id(10), epoch: 1, status, failure_code }]
      : [source]);
    const client = createChatServerClient(request);
    const page = await client.load(id(1));
    expect(request).toHaveBeenCalledWith(`/conversations/${id(1)}/execution-failures?sourceIds=${source.id}`);
    const view = chatGroupView(page, id(11));
    expect(view.messages).toHaveLength(2);
    expect(view.messages[0]).toMatchObject({ id: source.id, kind: 'message' });
    expect(view.messages[1]).toMatchObject({ id: `execution-failure:${id(30)}:1`, sequence: view.messages[0].sequence,
      kind: 'notice', runtimeFailureCode: failure_code === 'AUTH_REQUIRED' ? failure_code : 'RUNTIME_ERROR' });
    expect(view.lastMessage?.preview).toBe('20');
    expect(JSON.stringify(view.messages)).not.toContain('private diagnostic');
    status = 'queued';
    expect(chatGroupView(await client.load(id(1)), id(11)).messages).toHaveLength(1);
    expect(chatGroupView({ ...page, messages: [] }, id(11)).messages).toHaveLength(0);
    expect(chatGroupView({ ...page, messages: [{ ...source, deleted: true }] }, id(11)).messages).toHaveLength(0);
  });
  it('keeps simultaneous failures distinct without changing the source cursor or leaking detail', () => {
    const source = message(20);
    const execution = { id: id(30), source_message_id: source.id, bot_id: id(10), epoch: 2, status: 'failed',
      failure_code: 'RUNTIME_TIMEOUT', detail: { message: 'private diagnostic' } };
    const view = chatGroupView({ snapshot: snapshot(), messages: [source, message(21)], before: source.seq,
      failures: [execution, { ...execution, id: id(31), bot_id: id(11), failure_code: 'AUTH_REQUIRED' },
        { ...execution, id: id(32), conversation_id: id(99) }, { ...execution, id: id(33), epoch: NaN }] }, id(11));
    expect(view.messages.map(entry => entry.id)).toEqual([source.id, `execution-failure:${id(30)}:2`, `execution-failure:${id(31)}:2`, id(21)]);
    expect(view.messages.slice(0, 3).map(entry => entry.sequence)).toEqual([1, 1, 1]);
    expect(view.messages[1].noticeCode).toBe('member-timeout');
    expect(view.hasMoreBefore).toBe(true);
    expect(view.lastMessage?.preview).toBe('21');
    expect(JSON.stringify(view.messages)).not.toContain('private diagnostic');
  });
  it('falls back only for a missing endpoint on an older server', async () => {
    const source = message(20);
    const request = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce([source]).mockResolvedValueOnce([])
      .mockRejectedValueOnce(Object.assign(new Error('NOT_FOUND'), { status: 404 }))
      .mockResolvedValueOnce([{ id: id(30), source_message_id: source.id, bot_id: id(10), epoch: 1, status: 'failed', failure_code: 'AUTH_REQUIRED' }]);
    const page = await createChatServerClient(request).load(id(1));
    expect(request.mock.calls.at(-1)?.[0]).toBe(`/conversations/${id(1)}/executions`);
    expect(chatGroupView(page, id(11)).messages[1].runtimeFailureCode).toBe('AUTH_REQUIRED');
  });
  it('surfaces execution read denial or malformed success through the existing load error path', async () => {
    const request = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce([message(20)])
      .mockRejectedValueOnce(Object.assign(new Error('NOT_MEMBER'), { status: 403 }))
      .mockResolvedValueOnce(snapshot()).mockResolvedValueOnce([message(20)]).mockResolvedValueOnce({});
    const client = createChatServerClient(request);
    await expect(client.load(id(1))).rejects.toMatchObject({ status: 403 });
    await expect(client.load(id(1))).rejects.toThrow('INVALID_CHAT_EXECUTIONS');
  });
  it('uses the account human actor and rejects a companion identity', async () => {
    const request = vi.fn().mockResolvedValueOnce({ actor: { id: id(10), kind: 'human' } })
      .mockResolvedValueOnce({ actor: { id: id(11), kind: 'bot' } });
    const client = createChatServerClient(request);
    expect(await client.me()).toBe(id(10));
    await expect(client.me()).rejects.toThrow('INVALID_CHAT_IDENTITY');
    expect(request.mock.calls.every(([path]) => path === '/me')).toBe(true);
  });
  it('pages joined groups without devices, local bots, registration, imports or duplicated host copies', async () => {
    const first = Array.from({ length: 100 }, (_, n) => room(n + 1, n === 0 ? 'invited' : 'joined'));
    const request = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce([room(101)]);
    const groups = await createChatServerClient(request).list();
    expect(groups).toHaveLength(100);
    expect(groups.some(group => group.id === id(1))).toBe(false);
    expect(request.mock.calls.map(call => call[0])).toEqual(['/conversations?limit=100', `/conversations?limit=100&after=${id(100)}`]);
    expect(chatRoomRow(groups[0]).host.deviceId).toBe('');
  });
  it('keeps empty success distinct from denied/failed list reads', async () => {
    const request = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(Object.assign(new Error('FORBIDDEN'), { status: 403 }));
    const client = createChatServerClient(request);
    expect(await client.list()).toEqual([]);
    await expect(client.list()).rejects.toMatchObject({ status: 403 });
  });
  it('opens and paginates main history, preserving exact sequence cursors and author identity', async () => {
    const messages = Array.from({ length: 100 }, (_, n) => message(200 - n));
    const request = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(messages).mockResolvedValueOnce([]).mockResolvedValueOnce([])
      .mockResolvedValueOnce([message(100)]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const client = createChatServerClient(request);
    const page = await client.load(id(1));
    expect(page.before).toBe(messages.at(-1)!.seq);
    const older = await client.older(id(1), page);
    expect(request.mock.calls[4][0]).toBe(`/conversations/${id(1)}/messages?limit=100&before=${messages.at(-1)!.seq}`);
    expect(older.before).toBeNull();
    const view = chatGroupView(older, id(11));
    expect(view.messages).toHaveLength(101);
    expect(view.messages[0]).toMatchObject({ content: '100', authorKind: 'user', isSelf: false });
    expect(view.members[0].actorKind).toBe('human');
  });
  it('preserves public, preset and emoji avatars while rejecting private or credentialed addresses', () => {
    const data = snapshot();
    const avatars = ['https://avatars.example.invalid/a.png', 'cindy://avatar/preset/cindy', '🐱',
      'http://avatars.example.invalid/a.png', 'https://user:secret@avatars.example.invalid/a.png', 'cindy-media://avatar/a.png'];
    data.members = avatars.map((avatar, index) => ({ ...data.members[0], id: id(index + 10), avatar }));
    const members = chatGroupView({ snapshot: data, messages: [], before: null }, id(1)).members;
    expect(chatRoomRow(data.room, data, id(1)).groupMembers).toEqual(members.map(({ botId, name, avatar, avatarUrl, avatarColor }) => ({ botId, name, avatar, avatarUrl, avatarColor })));
    expect(members.map(member => ({ avatar: member.avatar, avatarUrl: member.avatarUrl }))).toEqual([
      { avatar: '', avatarUrl: avatars[0] }, { avatar: avatars[1], avatarUrl: null }, { avatar: '🐱', avatarUrl: null },
      ...Array.from({ length: 3 }, () => ({ avatar: '', avatarUrl: null })),
    ]);
  });
  it('rechecks media authorization on every open and accepts only HTTPS signed downloads', async () => {
    const request = vi.fn().mockResolvedValueOnce({ name: 'report.pdf', type: 'application/pdf', size: '42', url: 'https://media.example.invalid/report?signature=test' })
      .mockRejectedValueOnce(Object.assign(new Error('NOT_MEMBER'), { status: 403 }))
      .mockResolvedValueOnce({ name: 'bad', type: 'text/plain', size: 1, url: 'file:///private/test' });
    const client = createChatServerClient(request);
    expect(await client.media(id(1), id(2))).toMatchObject({ category: 'file', path: null, size: 42 });
    await expect(client.media(id(1), id(2))).rejects.toMatchObject({ status: 403 });
    await expect(client.media(id(1), id(2))).rejects.toThrow('INVALID_CHAT_URL');
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('sends text with the original operation ID and never registers an executor', async () => {
    const request = vi.fn().mockResolvedValue({ id: id(9) });
    const client = createChatServerClient(request);
    const input = { text: 'hello', clientId: 'same-operation', mentions: { all: false, botIds: [id(3)] } };
    await client.send(id(1), input); await client.send(id(1), input);
    expect(request).toHaveBeenNthCalledWith(1, `/conversations/${id(1)}/messages`, 'POST', {
      operationId: 'same-operation', content: [{ type: 'text', text: 'hello' }], mentions: [id(3)],
    });
    expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);
  });
  // Product rule: quoting a present companion addresses that companion; a deleted
  // original must not send a stale quote or silently lose the user's reply.
  it('sends a fresh quote with the companion recipient and rejects a deleted original', async () => {
    const original = { ...message(20), authorId: id(12), author: { kind: 'bot', name: 'Before rename' } };
    const owner = { ...snapshot().members[0], name: 'Nickname A' };
    const member = { ...owner, id: id(12), kind: 'bot', state: 'joined', name: 'Current name', ownerName: 'Account B' };
    const request = vi.fn().mockImplementation(async (path: string, method?: string) => {
      if (method === 'POST') return { id: id(21) };
      return path.endsWith('/members') ? [member, owner] : original;
    });
    const client = createChatServerClient(request);
    const input = { clientId: 'quote-reply-operation', text: 'Agreed', mentions: { all: false, botIds: [] }, quote: { messageId: id(20) } };
    await client.send(id(1), input);
    expect(request).toHaveBeenLastCalledWith(`/conversations/${id(1)}/messages`, 'POST', expect.objectContaining({
      mentions: [id(12)], content: [expect.objectContaining({ type: 'card', data: expect.objectContaining({ authorName: 'Current name (Nickname A)' }) }), { type: 'text', text: 'Agreed' }],
    }));
    original.deleted = true;
    request.mockClear();
    await expect(client.send(id(1), input)).rejects.toThrow('QUOTE_UNAVAILABLE');
    expect(request.mock.calls.some(([, method]) => method === 'POST')).toBe(false);
  });
  it('retries a lost quoted-send response with the identical posted content', async () => {
    const original = message(20);
    let lost = true;
    const request = vi.fn().mockImplementation(async (path: string, method?: string) => {
      if (method === 'POST') {
        if (lost) { lost = false; throw new Error('NETWORK_ERROR'); }
        return { id: id(21) };
      }
      return path.endsWith('/members') ? snapshot().members : original;
    });
    const client = createChatServerClient(request);
    const input = { clientId: 'lost-quote-operation', text: 'Agreed', mentions: { all: false, botIds: [] }, quote: { messageId: id(20) } };
    await expect(client.send(id(1), input)).rejects.toThrow('NETWORK_ERROR');
    const posted = request.mock.calls.at(-1);
    original.deleted = true;
    await client.send(id(1), input);
    expect(request.mock.calls.at(-1)).toEqual(posted);
    expect(request.mock.calls.filter(([, method]) => method !== 'POST')).toHaveLength(2);
  });
  it.each(['', 'with files'])('sends sealed attachment IDs with text=%s and preserves the retry body', async text => {
    const request = vi.fn().mockResolvedValue({ id: id(9) });
    const client = createChatServerClient(request);
    const input = { text, clientId: 'same-media-message', mentions: { all: false, botIds: [] },
      attachments: [{ id: id(2), name: 'report.pdf', category: 'file' as const, path: '', ext: 'pdf', mimeType: 'application/pdf', size: 42 }] };
    await client.send(id(1), input); await client.send(id(1), input);
    expect(request.mock.calls[0][2]).toEqual({ operationId: 'same-media-message', mentions: [],
      content: [...(text ? [{ type: 'text', text }] : []), { type: 'media', mediaId: id(2), caption: 'report.pdf' }] });
    expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);
    expect(chatGroupView({ snapshot: snapshot(), messages: [], before: null }, id(10)).supportsAttachments).toBe(true);
  });
  it('reauthorizes and replaces loaded older history on refresh instead of retaining deleted text', async () => {
    const recent = Array.from({ length: 100 }, (_, n) => message(200 - n));
    const request = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(recent)
      .mockResolvedValueOnce([{ ...message(100), content: [{ type: 'text', text: 'edited' }] }]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const page = await createChatServerClient(request).load(id(1), message(100).seq);
    expect(chatGroupView(page, id(10)).messages[0].content).toBe('edited');
    expect(request.mock.calls[2][0]).toContain(`before=${message(101).seq}`);
  });

  it('counts only other members as unread and maps the server read cursor exactly', () => {
    const incoming = { ...message(101), createdAt: '2026-10-09T01:00:00Z' };
    const mine = { ...message(102), authorId: id(11), createdAt: '2026-10-09T02:00:00Z' };
    const notice = { ...message(103), origin: 'system', createdAt: '2026-10-09T03:00:00Z' };
    const value = { ...snapshot(), messages: [notice, mine, incoming], reads: [{ thread_key: 'main', read_seq: message(100).seq }] };
    expect(chatRoomRow(value.room, value, id(11)).item.display.lastReplyAt).toBe(Date.parse(incoming.createdAt));
    expect(chatRoomRow(value.room, value, id(11)).lastReplySequence).toBe(incoming.seq);
    expect(chatReadAt(value, id(11))).toBe(0);
    value.reads[0].read_seq = incoming.seq;
    expect(chatReadAt(value, id(11))).toBe(Date.parse(incoming.createdAt));
  });

  it('reports malformed list contracts instead of silently treating them as an empty roster', async () => {
    const request = vi.fn().mockResolvedValue([{ ...room(), kind: undefined }]);
    await expect(createChatServerClient(request).list()).rejects.toThrow('INVALID_CHAT_LIST');
  });

});

describe('group lifecycle contract', () => {
  function lifecycle(options: { supported?: boolean; kind?: string; role?: string; reject?: boolean } = {}) {
    const request = vi.fn().mockImplementation(async (path: string, method?: string) => {
      if (path === '/me') return { actor: { id: id(11), kind: 'human' }, ...(options.supported === false ? {} : { capabilities: { groupLifecycleVersion: 1, conversationListStateVersion: 1 } }) };
      if (path.startsWith('/conversation-list-state?')) return [];
      if (path.endsWith('/snapshot')) return { ...snapshot(), room: { ...room(), kind: options.kind ?? 'group' },
        members: [{ id: id(12), ownerActorId: id(11), state: 'joined', kind: 'bot', role: options.role ?? 'owner' }] };
      if (path.endsWith('/list-state')) {
        if (options.reject) throw new Error('REVISION_CONFLICT');
        return { conversationId: id(1), hidden: true, revision: 1 };
      }
      if (method === 'POST') return { revision: 2, dissolvedAt: '2026-10-15T00:00:00Z', dissolvedBy: id(12) };
      return [];
    });
    return { client: createChatServerClient(request), request };
  }
  it('uses the owned companion owner and an explicit revision for dissolution', async () => {
    const { client, request } = lifecycle();
    await client.dissolve(id(1), 1, 'fixture-dissolve');
    expect(request).toHaveBeenLastCalledWith(`/conversations/${id(1)}/dissolve`, 'POST', { operationId: 'fixture-dissolve', expectedRevision: 1 }, id(12));
    expect(request.mock.calls.some(([, method]) => method === 'PATCH')).toBe(false);
  });
  it.each([{ kind: 'direct', code: 'GROUP_REQUIRED' }, { role: 'admin', code: 'OWNER_REQUIRED' }, { supported: false, code: 'LIFECYCLE_UNAVAILABLE' }])('refuses unsupported or unauthorized dissolution %j', async ({ code, ...options }) => {
    const { client, request } = lifecycle(options);
    await expect(client.dissolve(id(1), 1, 'fixture-dissolve')).rejects.toThrow(code);
    expect(request.mock.calls.some(([, method]) => method === 'POST' || method === 'PATCH')).toBe(false);
  });
  it('hides after leave without snapshot access and does not hide a failed write', async () => {
    const failed = lifecycle({ reject: true });
    await expect(failed.client.hide(id(1), 'fixture-hide')).rejects.toThrow('REVISION_CONFLICT');
    expect(failed.client.personalList.hidden(id(1))).toBe(false);
    const { client, request } = lifecycle();
    await client.hide(id(1), 'fixture-hide');
    expect(client.personalList.hidden(id(1))).toBe(true);
    expect(request.mock.calls.some(([path]) => path.endsWith('/snapshot'))).toBe(false);
    expect(request).toHaveBeenLastCalledWith(`/conversations/${id(1)}/list-state`, 'POST', { operationId: 'fixture-hide', hidden: true, expectedRevision: 0 });
  });
});

// Missing mobile stop path: preserve server revision and actor ownership; unit tier.
it('stops my requests and companions without stopping another member’s work', async () => {
  const ownBot = { ...snapshot().members[0], id: id(12), kind: 'bot', ownerActorId: id(11) };
  const planId = id(40);
  const execution = (n: number, bot: number, requester: number, plan_id: string | null = null) => ({ id: id(n), bot_id: id(bot), requester_id: id(requester), status: 'running', plan_id });
  const request = vi.fn(async (path: string, method?: string) => {
    if (method === 'POST') return {};
    if (path === '/me') return { actor: { id: id(11), kind: 'human' } };
    if (path.endsWith('/snapshot')) return { ...snapshot(), members: [...snapshot().members, ownBot] };
    if (path.endsWith('/plans')) return [{ id: planId, creator_id: id(11), status: 'running', revision: 7 }];
    if (path.endsWith('/executions')) return [execution(30, 12, 10), execution(31, 13, 11), execution(32, 13, 10), execution(33, 12, 11, planId)];
    throw new Error(path);
  });
  await createChatServerClient(request as any).stop(id(1), 'stop-operation');
  const writes = request.mock.calls.filter(([, method]) => method === 'POST');
  expect(writes).toEqual([
    [`/conversations/${id(1)}/plans/${planId}`, 'POST', { operationId: `stop-operation:plan:${planId}`, expectedRevision: 7, action: 'stop' }],
    [`/conversations/${id(1)}/executions/${id(30)}/control`, 'POST', { operationId: `stop-operation:execution:${id(30)}`, action: 'stop' }, id(12)],
    [`/conversations/${id(1)}/executions/${id(31)}/control`, 'POST', { operationId: `stop-operation:execution:${id(31)}`, action: 'stop' }, undefined],
  ]);
});

it('projects waiting and stopping executions without inventing task IDs or losing concurrent turns', () => {
  const common = { source_message_id: id(20), bot_id: id(12), epoch: 1 };
  const page = { snapshot: snapshot(), messages: [], before: null, executions: [
    { ...common, id: id(30), status: 'needs_input' }, { ...common, id: id(31), status: 'stopping' },
    { ...common, id: id(32), status: 'succeeded' },
  ] };
  const view = chatGroupView(page, id(11));
  expect(view.round.status).toBe('running');
  expect(view.round.speakers.map(speaker => [speaker.executionId, speaker.executionStatus, speaker.sessionId])).toEqual([
    [id(30), 'needs_input', null], [id(31), 'stopping', null],
  ]);
});

// Unit: cross-device Cindy filters use profile identity, including exact legacy presets.
it('reads Cindy preset identity without inferring from names and retains known IDs on transient failure', async () => {
  const { CINDY_DEFAULT_IDENTITY } = await import('@cindy/maker-shared/bot-template-preset');
  const request = vi.fn(async (_path: string, _method?: string, _body?: unknown, actorId?: string) => {
    if (actorId === id(4)) throw new Error('offline');
    return [{ key: 'companion.profile.v1', value: actorId === id(1) ? { templateId: 'cindy' }
      : actorId === id(2) ? { soul: CINDY_DEFAULT_IDENTITY } : { name: 'Cindy', soul: 'custom' } }];
  });
  const actors = [1, 2, 3, 4].map(n => ({ id: id(n), externalId: `bot-${n}`, kind: 'bot', name: 'Cindy', avatar: null, homeDeviceId: 'mac' }));
  const ids = await createChatServerClient(request as any).cindyCompanionIds(actors, ['bot-4']);
  expect(ids).toEqual(['bot-1', 'bot-2', 'bot-4']);
  expect(request.mock.calls.every(call => call[0] === '/preferences' && call[1] === 'GET')).toBe(true);
});

// Unit: invitation contract (bot-group-chat §10). Existing client tests covered joined rooms only.
// A pre-join link must POST just its token to this account's server, never fetch members or accept implicitly.
describe('invitation preview and explicit acceptance', () => {
  const token = 'A'.repeat(43);
  const preview = { groupId: id(1), name: 'Weekend', inviterName: 'Lin', joined: false, expiresAt: null, reusable: true };
  it('previews only and preserves real optional identity without guessing missing counts', async () => {
    const request = vi.fn().mockResolvedValueOnce({ ...preview, avatar: 'https://images.example.invalid/group.png', memberCount: 8 })
      .mockResolvedValueOnce(preview).mockResolvedValueOnce({ ...preview, memberCount: -1 });
    const client = createChatServerClient(request);
    expect(await client.previewInvite(`https://untrusted.example/chat-invite/join#${token}`)).toMatchObject({ memberCount: 8, avatar: 'https://images.example.invalid/group.png' });
    expect(request).toHaveBeenCalledExactlyOnceWith('/invite-links/preview', 'POST', { token }, undefined, undefined);
    expect((await client.previewInvite(token)).memberCount).toBeUndefined();
    expect((await client.previewInvite(token)).memberCount).toBeUndefined();
  });
  // V9 summary is optional and bounded; a missing image is still a real member slot.
  it('keeps ordered avatar slots and Unicode initials without granting a member-roster read', async () => {
    const memberAvatars = [
      { avatar: 'https://images.example.invalid/a.png', initial: '林' },
      { avatar: 'cindy://avatar/preset/cindy', initial: 'C' },
      { avatar: '🐱', initial: 'é' }, { avatar: null, initial: '👩🏽‍💻' }, { avatar: null, initial: '' },
    ];
    const request = vi.fn().mockResolvedValueOnce({ ...preview, memberAvatars, memberCount: 19 })
      .mockResolvedValueOnce(preview).mockResolvedValueOnce({ ...preview, memberAvatars: [] })
      .mockResolvedValueOnce({ ...preview, memberAvatars: 'invalid' })
      .mockResolvedValueOnce({ ...preview, memberAvatars: [...memberAvatars, memberAvatars[0]] })
      .mockResolvedValueOnce({ ...preview, memberAvatars: [{ avatar: {}, initial: '林' }, null] });
    const client = createChatServerClient(request);
    expect(await client.previewInvite(token)).toMatchObject({ memberAvatars, memberCount: 19 });
    expect((await client.previewInvite(token)).memberAvatars).toBeUndefined();
    expect((await client.previewInvite(token)).memberAvatars).toEqual([]);
    expect((await client.previewInvite(token)).memberAvatars).toBeUndefined();
    expect((await client.previewInvite(token)).memberAvatars).toEqual(memberAvatars);
    expect((await client.previewInvite(token)).memberAvatars).toEqual([{ avatar: null, initial: '林' }, { avatar: null, initial: '' }]);
    expect(request.mock.calls.every(call => call[0] === '/invite-links/preview' && call[1] === 'POST')).toBe(true);
  });
  it('rejects malformed links before HTTP and invalid responses before navigation', async () => {
    const request = vi.fn().mockResolvedValue({ ...preview, groupId: 'not-a-room' });
    const client = createChatServerClient(request);
    await expect(client.previewInvite('https://example.invalid/other#secret')).rejects.toThrow('INVALID_INVITATION_LINK');
    expect(request).not.toHaveBeenCalled();
    await expect(client.previewInvite(token)).rejects.toThrow('INVALID_CHAT_ID');
    request.mockResolvedValue({ ...preview, expiresAt: 'invalid' });
    await expect(client.previewInvite(token)).rejects.toThrow('INVALID_CHAT_RESPONSE');
  });
  it('accepts through the existing operation contract and validates its room receipt', async () => {
    const request = vi.fn().mockResolvedValueOnce({ groupId: id(1) }).mockResolvedValueOnce({ groupId: 'bad' });
    const client = createChatServerClient(request);
    const signal = new AbortController().signal;
    expect(await client.acceptInvite(token, 'operation-1', signal)).toEqual({ groupId: id(1) });
    expect(request).toHaveBeenCalledExactlyOnceWith('/invite-links/accept', 'POST', { token, operationId: 'operation-1' }, undefined, signal);
    await expect(client.acceptInvite(token, 'operation-1')).rejects.toThrow('INVALID_CHAT_ID');
  });
});

// D2 root-deletion regression (unit): production load used to classify every 404
// as room access loss. Existing cache-reopen coverage only has a successful root.
// Minimal input: an authorized reply page followed by a missing root lookup.
it.each([false, true])('keeps authorized thread replies when the root is missing (stored=%s)', async stored => {
  const reply = { ...message(21), threadRootId: id(20) };
  const request = vi.fn().mockImplementation(async (path: string) => {
    if (path === '/me') return { actor: { id: id(11), kind: 'human' } };
    if (path.endsWith('/snapshot')) return snapshot();
    if (path.startsWith('/changes?')) return { cursor: snapshot().cursor, changes: [], hasMore: false };
    if (path.endsWith(`/messages/${id(20)}`)) throw { status: 404, code: 'MESSAGE_NOT_FOUND' };
    if (path.includes('/messages?')) return [reply];
    return [];
  });
  let saved: ChatHistoryState | undefined;
  const history = createChatHistory({ api: request, current: () => true, newGeneration: () => 'topic',
    store: { read: async () => saved, write: async (_, state) => { saved = state ?? undefined; } } });
  const client = createChatServerClient(request, undefined, stored ? async () => history : undefined);
  const page = await client.load(id(1), undefined, id(20));
  expect(page.threadRootId).toBe(id(20));
  expect(chatGroupView(page, id(11)).messages.map(m => m.id)).toEqual([id(21)]);
});

it.each([{ status: 403, code: 'PERMISSION_DENIED' }, { status: 404, code: 'CONVERSATION_NOT_FOUND' }])(
  'does not turn root lookup access failure $code into readable thread content', async error => {
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path.endsWith('/snapshot')) return snapshot();
      if (path.endsWith(`/messages/${id(20)}`)) throw error;
      if (path.includes('/messages?')) return [{ ...message(21), threadRootId: id(20) }];
      return [];
    });
    await expect(createChatServerClient(request).load(id(1), undefined, id(20))).rejects.toEqual(error);
  });

// PC parity, unit: actual HTTP client/projection. Earlier tests never exercised
// root summaries, explicit following, or trustworthy thread-share source resolution.
it('projects authoritative reply counts, distinct responders, unread mentions and resolved shares', () => {
  const root = { ...message(20), replyCount: 17 };
  const reply = { ...message(21), threadRootId: root.id, mentions: [id(11)] };
  const share = { ...message(22), content: [{ type: 'card', namespace: 'cindy.thread-share', schemaRevision: 1,
    data: { messageId: reply.id, threadRootId: root.id }, fallback: 'Untrusted old text' }] };
  const s = { ...snapshot(), messages: [share, reply, root], reads: [] };
  const view = chatGroupView({ snapshot: s, messages: [root, share], before: null }, id(11));
  expect(view.messages[0]).toMatchObject({ replyCount: 17, threadUnread: { count: 1, mentioned: true },
    threadPreview: { responders: [{ authorBotId: reply.authorId }], replies: [{ id: reply.id }] } });
  expect(view.messages[1]).toMatchObject({ content: '', threadShare: { status: 'available', content: '21', sharedByAuthor: true } });
  expect(chatGroupView({ snapshot: { ...s, reads: undefined }, messages: [root], before: null }, id(11)).messages[0].threadUnread).toBeUndefined();
  expect(chatGroupView({ snapshot: s, messages: [share], before: null, threadSources: { [reply.id]: null } }, id(11)).messages[0])
    .toMatchObject({ content: '', threadShare: { status: 'unavailable', content: '', attachments: [] } });
});

it('changes explicit following without advancing the existing read cursor', async () => {
  const request = vi.fn(async (path: string, _method?: string, body?: any) => path.endsWith('/snapshot')
    ? { ...snapshot(), reads: [{ thread_key: id(20), read_seq: '9007199254740993' }] } : { following: body.following });
  const client = createChatServerClient(request as any);
  await expect(client.followThread(id(1), id(20), true, 'follow-op')).resolves.toEqual({ following: true });
  expect(request).toHaveBeenLastCalledWith(`/conversations/${id(1)}/read`, 'POST', {
    operationId: 'follow-op', threadRootId: id(20), readSeq: '9007199254740993', following: true,
  });
});

it('persists a self-directed share body before posting and retries identical bytes after source edits', async () => {
  let stored: any;
  let edited = false;
  const bodies: any[] = [];
  const request = vi.fn(async (path: string, method?: string, body?: any) => {
    if (path === '/me') return { actor: { id: id(11), kind: 'human' } };
    if (path.endsWith('/members')) return snapshot().members;
    if (path.endsWith(`/messages/${id(21)}`)) return { ...message(21), threadRootId: id(20), content: [{ type: 'text', text: edited ? 'changed' : '@bot original' }] };
    if (method === 'POST') { expect(stored).toEqual(body); bodies.push(body); if (!edited) throw new Error('lost response'); return { id: id(22) }; }
    throw new Error(path);
  });
  const client = createChatServerClient(request as any);
  const save = async (body: any) => { stored = body; };
  await expect(client.shareToMain(id(1), id(21), id(20), { save })).rejects.toThrow('lost response');
  edited = true;
  await expect(client.shareToMain(id(1), id(21), id(20), { body: stored, save })).resolves.toEqual({ messageId: id(22), alreadyShared: false });
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[0]).toMatchObject({ operationId: `thread-share:${id(21)}`, mentions: [id(11)], content: [{ data: { messageId: id(21), threadRootId: id(20) } }] });
});

// #7847 review, unit: an old share can be the only visible reference to its thread.
// Earlier hydration tests kept a recent reply in the snapshot and missed this case.
it('hydrates the root and latest replies for an old share outside the snapshot', async () => {
  const root = { ...message(20), replyCount: 17 };
  const source = { ...message(21), threadRootId: root.id };
  const latest = { ...message(29), threadRootId: root.id, createdAt: '2026-10-29T12:00:00Z' };
  const share = { ...message(30), content: [{ type: 'card', namespace: 'cindy.thread-share', schemaRevision: 1,
    data: { messageId: source.id, threadRootId: root.id }, fallback: '' }] };
  const request = vi.fn(async (path: string) => {
    if (path.endsWith(`/messages/${root.id}`)) return root;
    if (path.endsWith(`/messages/${source.id}`)) return source;
    if (path.includes(`threadRootId=${root.id}`)) return [latest, source];
    throw new Error(`Unexpected request: ${path}`);
  });
  const page = { snapshot: { ...snapshot(), messages: Array.from({ length: 100 }, (_, i) => message(100 + i)) }, messages: [share], before: null };
  const view = chatGroupView(await createChatServerClient(request as any).hydrateThreads(id(1), page), id(11));
  expect(view.messages[0].threadShare).toMatchObject({ status: 'available', replyCount: 17,
    threadPreview: { replies: [{ id: source.id }, { id: latest.id, createdAt: Date.parse(latest.createdAt) }] } });
});

it('resolves an off-window root and retries a failed source on its bounded deadline without leaking fallback', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-28T00:00:00Z'));
  try {
    const share = { ...message(30), content: [{ type: 'card', namespace: 'cindy.thread-share', schemaRevision: 1,
      data: { messageId: id(21), threadRootId: id(20) }, fallback: 'private old text' }] };
    const reply = { ...message(22), threadRootId: id(20) };
    const request = vi.fn(async (path: string) => {
      if (path.endsWith(`/messages/${id(20)}`)) return { ...message(20), replyCount: 17 };
      throw new Error('offline');
    });
    const client = createChatServerClient(request as any);
    const page = { snapshot: { ...snapshot(), messages: [reply, share], reads: [] }, messages: [share], before: null };
    expect(chatGroupView(page, id(11)).messages[0]?.threadShare?.status).toBe('loading');
    const hydrated = await client.hydrateThreads(id(1), page);
    expect(chatGroupView(hydrated, id(11)).messages[0]?.threadShare?.replyCount).toBe(17);
    expect(hydrated.threadRetryAt).toBe(Date.now() + 30000);
    expect(chatGroupView(hydrated, id(11)).messages[0]).toMatchObject({ content: '', threadShare: { status: 'loading', content: '' } });
    const sourceCalls = () => request.mock.calls.filter(([path]) => path.endsWith(`/messages/${id(21)}`)).length;
    await client.hydrateThreads(id(1), page); expect(sourceCalls()).toBe(1);
    vi.setSystemTime(Date.now() + 30000);
    await client.hydrateThreads(id(1), page); expect(sourceCalls()).toBe(2);
    client.invalidateHistory(id(1), true); await client.hydrateThreads(id(1), page); expect(sourceCalls()).toBe(3);
    expect(chatRoomRow(room(), page.snapshot, id(11)).item.display.preview).not.toContain('private old text');
  } finally { vi.useRealTimers(); }
});

it('projects real cached read fields through load, not only a hand-built UI fixture', async () => {
  const root = { ...message(20), replyCount: 3, reactions: [{ emoji: '👍', count: 2, me: true }] };
  const reply = { ...message(21), threadRootId: root.id };
  const request = vi.fn(async (path: string) => {
    if (path === '/me') return { actor: { id: id(11), kind: 'human' } };
    if (path.endsWith('/snapshot')) return { ...snapshot(), messages: [reply, root], reads: [{ thread_key: root.id, read_seq: '0', following: true }] };
    if (path.includes('/messages?')) return [root];
    return [];
  });
  const history = createChatHistory({ api: request as any, current: () => true, newGeneration: () => 'projection', store: { read: async () => undefined, write: async () => {} } });
  const client = createChatServerClient(request as any, undefined, async () => history);
  const view = chatGroupView(await client.load(id(1)), id(11));
  expect(view.messages[0]).toMatchObject({ replyCount: 3, reactions: [{ emoji: '👍', count: 2, me: true }], threadUnread: { count: 1 }, threadPreview: { replies: [{ id: reply.id }] } });
});

it.each([403, 404, 410])('treats source %s as terminal unavailability without posting', async status => {
  const request = vi.fn().mockRejectedValue({ status });
  await expect(createChatServerClient(request).shareToMain(id(1), id(21), id(20))).rejects.toThrow('SHARE_UNAVAILABLE');
  expect(request.mock.calls.every(call => call[1] !== 'POST')).toBe(true);
});


// A persisted post must not be replayed into a different root or wake other actors.
it.each(['root', 'mentions'])('rejects a mismatched persisted share %s before POST', async changed => {
  const { buildBotGroupThreadShareCard } = await import('@cindy/maker-shared/botGroupChat');
  const body = { operationId: `thread-share:${id(21)}`, mentions: [changed === 'mentions' ? id(10) : id(11)], content: [
    buildBotGroupThreadShareCard({ messageId: id(21), threadRootId: changed === 'root' ? id(99) : id(20), authorName: 'Author', text: 'Reply' }),
  ] };
  const request = vi.fn(async () => ({ actor: { id: id(11), kind: 'human' } }));
  await expect(createChatServerClient(request as any).shareToMain(id(1), id(21), id(20), { body, save: async () => {} })).rejects.toThrow('SHARE_UNAVAILABLE');
  expect(request.mock.calls).toEqual([['/me']]);
});

// Personal delegation is a separate server contract: viewing/AI output never consumes human unread (unit).
describe('personal mask transport', () => {
  it('does not call unsupported mask endpoints on an older server', async () => {
    const request = vi.fn(async (_path: string) => ({ actor: { id: id(1), kind: 'human' } }));
    const client = createChatServerClient(request as never);
    expect(await client.mask(id(2))).toBeNull();
    expect(await client.maskMentions(id(2))).toEqual({ mentions: [], hasMore: false });
    expect(request.mock.calls.every(call => call[0] === '/me')).toBe(true);
  });
  it('pairs the original mention with its reply and acknowledges only the selected message', async () => {
    const companion = { id: id(3), name: 'Cindy', avatarUrl: null };
    const request = vi.fn(async (path: string, method?: string, body?: unknown) => {
      if (path === '/me') return { actor: { id: id(1), kind: 'human' }, capabilities: { personalMask: 1 } };
      if (path.endsWith('/read')) return {};
      return { messages: [{ ...message(20), reply: { content: [{ type: 'text', text: 'Recorded' }], maskAttribution: { companion } } }], hasMore: false };
    });
    const client = createChatServerClient(request as never);
    expect((await client.maskMentions(id(2))).mentions[0]).toMatchObject({ messageId: id(20), text: '20', reply: { companion, text: 'Recorded' } });
    expect(request.mock.calls.some(([, method]) => method === 'POST')).toBe(false);
    await client.maskMentions(id(2), undefined, [id(20)], 'read-one');
    expect(request.mock.calls.filter(([, method]) => method === 'POST')).toEqual([[`/conversations/${id(2)}/mentions/read`, 'POST', { operationId: 'read-one', messageIds: [id(20)] }]]);
  });
  it('keeps the human author and stand-in attribution in the actual mobile timeline', () => {
    const attribution = { self: { id: id(10), name: 'Chris', avatarUrl: null }, companion: { id: id(3), name: 'Cindy', avatarUrl: null }, sourceMessageId: id(19) };
    const page = { snapshot: snapshot(), messages: [{ ...message(20), maskAttribution: attribution }], before: null };
    expect(chatGroupView(page, id(10)).messages[0]).toMatchObject({ authorKind: 'user', isSelf: true, maskAttribution: attribution });
  });
});
