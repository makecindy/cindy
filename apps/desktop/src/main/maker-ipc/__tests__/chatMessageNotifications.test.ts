import { afterEach, expect, it, vi } from 'vitest';
import { createChatMessageNotifications, selectChatAttentionMessage, type ChatNotificationMessage } from '../chatMessageNotifications.js';

afterEach(() => vi.useRealTimers());

// Unit: the same eligibility feeds both alert surfaces; ensure a mention does not get displaced
// by newer ordinary traffic, and reading/muting its thread reveals the remaining unread message.
it('selects an unread mention first and falls back to ordinary unread after its read position advances', () => {
  const ordinary = message('ordinary', { seq: '9007199254740995' });
  const mention = message('mention', { threadRootId: 'topic', mentions: ['me'] });
  const snapshot = { room: { name: 'Team' }, messages: [ordinary, mention], reads: [
    { thread_key: 'main', read_seq: '0', muted: false }, { thread_key: 'topic', read_seq: '0', muted: false },
  ] };
  expect(selectChatAttentionMessage(snapshot, 'me')).toBe(mention);
  snapshot.reads[1].read_seq = mention.seq;
  expect(selectChatAttentionMessage(snapshot, 'me')).toBe(ordinary);
  snapshot.reads[1].read_seq = '0'; snapshot.reads[1].muted = true;
  expect(selectChatAttentionMessage(snapshot, 'me')).toBe(ordinary);
  snapshot.reads[0].muted = true;
  expect(selectChatAttentionMessage(snapshot, 'me')).toBeNull();
});
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

// Unit: a read or mute may arrive while the notification's sender presentation is loading.
// A stale snapshot must neither display a notice nor consume a still-unread message.
it('rechecks read state when the room changes during notification presentation', async () => {
  vi.useFakeTimers();
  let revision = 0;
  const snapshot = { room: { name: 'Team' }, messages: [message('peer')],
    reads: [{ thread_key: 'main', read_seq: '0' }] };
  let finishPresentation!: () => void;
  const notify = vi.fn();
  const present = vi.fn(() => new Promise<{ senderName: string; avatar: string; preview: string }>(resolve => {
    finishPresentation = () => resolve({ senderName: 'Peer', avatar: '', preview: 'Hello' });
  }));
  const service = createChatMessageNotifications({ current: () => true, selfId: () => 'me',
    revision: () => revision, snapshot: async () => snapshot, present, notify });
  service.enqueue('room', 'peer');
  await vi.advanceTimersByTimeAsync(1200);
  expect(present).toHaveBeenCalledOnce();
  snapshot.reads[0].read_seq = snapshot.messages[0].seq;
  revision++;
  finishPresentation();
  await vi.advanceTimersByTimeAsync(3000);
  expect(notify).not.toHaveBeenCalled();
  expect(present).toHaveBeenCalledOnce();
  service.dispose();
});
