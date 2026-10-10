import { describe, expect, it, vi } from 'vitest';
import { chatGroupView, chatRoomRow, chatReadAt, createChatServerClient, type ChatMessage, type ChatRoom, type ChatSnapshot } from '@/chat/chatServerClient';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const room = (n = 1, state = 'joined'): ChatRoom => ({ id: id(n), name: 'Discussion', kind: 'group', state, archived: false,
  revision: 1, created_at: '2026-10-01', updated_at: '2026-10-09', response_mode: 'all', speaking_mode: 'auto' });
const message = (n: number): ChatMessage => ({ id: id(n), seq: String(9007199254740992n + BigInt(n)), authorId: id(10),
  author: { kind: 'human', name: 'Other member' }, createdAt: '2026-10-09', deleted: false, threadRootId: null,
  content: [{ type: 'text', text: String(n) }] });
const snapshot = (): ChatSnapshot => ({ room: room(), cursor: '9007199254741099', messages: [], members: [
  { id: id(10), kind: 'human', name: 'Other member', state: 'joined', ownerActorId: id(10), ownerName: '', avatar: null, role: 'member' },
] });

describe('direct Chat Server client', () => {
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
    const request = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce([source])
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
    const request = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(messages).mockResolvedValueOnce([])
      .mockResolvedValueOnce([message(100)]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const client = createChatServerClient(request);
    const page = await client.load(id(1));
    expect(page.before).toBe(messages.at(-1)!.seq);
    const older = await client.older(id(1), page);
    expect(request.mock.calls[3][0]).toBe(`/conversations/${id(1)}/messages?limit=100&before=${messages.at(-1)!.seq}`);
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
  it('reauthorizes and replaces loaded older history on refresh instead of retaining deleted text', async () => {
    const recent = Array.from({ length: 100 }, (_, n) => message(200 - n));
    const request = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(recent)
      .mockResolvedValueOnce([{ ...message(100), content: [{ type: 'text', text: 'edited' }] }]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
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
