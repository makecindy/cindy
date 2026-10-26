import { afterEach, expect, it, vi } from 'vitest';
import { createChatMessageNotifications, type ChatNotificationMessage } from '../chatMessageNotifications.js';

afterEach(() => vi.useRealTimers());
const message = (id: string, extra: Partial<ChatNotificationMessage> = {}): ChatNotificationMessage => ({
  id, seq: '9007199254740993', authorId: id, deleted: false, threadRootId: null, ...extra,
});
function fixture(messages: ChatNotificationMessage[]) {
  const snapshot = { room: { name: 'Team' }, messages,
    reads: [{ thread_key: 'main', read_seq: '0', muted: false, following: false }] };
  const notify = vi.fn();
  const service = createChatMessageNotifications({ current: () => true, selfId: () => 'me',
    snapshot: async () => snapshot, present: async (_group, m) => ({ senderName: m.authorId, avatar: `avatar:${m.authorId}`, preview: 'Hello' }), notify });
  return { service, snapshot, notify };
}

// Unit: real socket notification consumer; no prior ordinary-chat delivery covered read/mute/replay races.
it('delivers people and companions once, with sender identity and the exact destination', async () => {
  vi.useFakeTimers();
  const f = fixture([message('person'), message('bot')]);
  for (const id of ['person', 'bot', 'person']) f.service.enqueue('room', id);
  await vi.advanceTimersByTimeAsync(1200);
  expect(f.notify.mock.calls.map(([event]) => event)).toEqual(['person', 'bot'].map(id => ({
    groupId: 'room', groupName: 'Team', messageId: id, senderName: id, avatar: `avatar:${id}`, preview: 'Hello',
  })));
  f.service.enqueue('room', 'person');
  await vi.advanceTimersByTimeAsync(1200);
  expect(f.notify).toHaveBeenCalledTimes(2);
  f.service.dispose();
});

it('checks current reads and mute after the delay, excluding self, removed and imported messages', async () => {
  vi.useFakeTimers();
  const f = fixture([message('peer'), message('me'), message('deleted', { deleted: true }), message('old', { origin: 'import' })]);
  for (const m of f.snapshot.messages) f.service.enqueue('room', m.id);
  f.snapshot.reads[0]!.read_seq = '9007199254740993';
  await vi.advanceTimersByTimeAsync(1200);
  expect(f.notify).not.toHaveBeenCalled();
  f.snapshot.messages = [message('later', { seq: '9007199254740994' })];
  f.snapshot.reads[0]!.muted = true;
  f.service.enqueue('room', 'later');
  await vi.advanceTimersByTimeAsync(1200);
  expect(f.notify).not.toHaveBeenCalled();
  f.service.dispose();
});

it('notifies followed or mentioned threads and cancels queued work on owner disposal', async () => {
  vi.useFakeTimers();
  const f = fixture([message('unfollowed', { threadRootId: 'other' }),
    message('mentioned', { threadRootId: 'other', mentions: ['me'] }), message('followed', { threadRootId: 'topic' })]);
  f.snapshot.reads.push({ thread_key: 'topic', read_seq: '0', muted: false, following: true });
  for (const m of f.snapshot.messages) f.service.enqueue('room', m.id);
  await vi.advanceTimersByTimeAsync(1200);
  expect(f.notify.mock.calls.map(([event]) => [event.messageId, event.threadRootId])).toEqual([['mentioned', 'other'], ['followed', 'topic']]);
  f.snapshot.messages.push(message('pending'));
  f.service.enqueue('room', 'pending'); f.service.dispose();
  await vi.advanceTimersByTimeAsync(1200);
  expect(f.notify).toHaveBeenCalledTimes(2);
});

it('recovers a transient snapshot failure and fetches an event outside the latest snapshot window', async () => {
  vi.useFakeTimers();
  const notify = vi.fn();
  const snapshot = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({
    room: { name: 'Team' }, messages: [], reads: [{ thread_key: 'main', read_seq: '0' }],
  });
  const fetchMessage = vi.fn(async () => message('older'));
  const service = createChatMessageNotifications({ current: () => true, selfId: () => 'me', snapshot,
    message: fetchMessage, present: async () => ({ senderName: 'Peer', avatar: '', preview: 'Hello' }), notify });
  service.enqueue('room', 'older');
  await vi.advanceTimersByTimeAsync(1200);
  expect(notify).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(3000);
  expect(fetchMessage).toHaveBeenCalledWith('room', 'older');
  expect(notify).toHaveBeenCalledOnce();
  service.enqueue('room', 'older');
  await vi.advanceTimersByTimeAsync(3000);
  expect(notify).toHaveBeenCalledOnce();
  service.dispose();
});
