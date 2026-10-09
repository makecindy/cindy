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
    const request = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(messages).mockResolvedValueOnce([message(100)]);
    const client = createChatServerClient(request);
    const page = await client.load(id(1));
    expect(page.before).toBe(messages.at(-1)!.seq);
    const older = await client.older(id(1), page);
    expect(request.mock.calls[2][0]).toBe(`/conversations/${id(1)}/messages?limit=100&before=${messages.at(-1)!.seq}`);
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
      .mockResolvedValueOnce([{ ...message(100), content: [{ type: 'text', text: 'edited' }] }]);
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
