import { expect, it, vi } from 'vitest';
import { createConversationListState } from '../chatConversationList';
const id = '00000000-0000-4000-8000-000000000001';

it('starts a fresh scan after an older in-flight read when an event cursor resets', async () => {
  const list = createConversationListState();
  let finish!: (value: unknown) => void;
  const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue([{ conversationId: id, hidden: true, revision: 2 }]);
  const initial = list.sync(request);
  const reset = list.resync(request);
  finish([{ conversationId: id, hidden: false, revision: 1 }]);
  await Promise.all([initial, reset]);
  expect(request).toHaveBeenCalledTimes(2);
  expect(list.hidden(id)).toBe(true);
});

it('shares concurrent reads and avoids full-page downloads until an explicit reconnect', async () => {
  const list = createConversationListState();
  let resolve!: (value: unknown) => void;
  const request = vi.fn().mockImplementation(() => new Promise(done => { resolve = done; }));
  const first = list.ensureSynced(request);
  const concurrent = list.sync(request);
  expect(request).toHaveBeenCalledTimes(1);
  resolve([]); await Promise.all([first, concurrent]);
  await list.ensureSynced(request);
  expect(request).toHaveBeenCalledTimes(1);
  request.mockResolvedValue([{ conversationId: id, hidden: true, revision: 1 }]);
  await list.sync(request);
  expect(request).toHaveBeenCalledTimes(2);
  expect(list.hidden(id)).toBe(true);
});

it('retries a failed reconnect before allowing an ordinary refresh to trust the cache', async () => {
  const list = createConversationListState();
  const request = vi.fn().mockResolvedValue([]);
  await list.ensureSynced(request);
  request.mockRejectedValueOnce(new Error('offline'));
  await expect(list.sync(request)).rejects.toThrow('offline');
  request.mockResolvedValue([{ conversationId: id, hidden: true, revision: 2 }]);
  await list.ensureSynced(request);
  expect(request).toHaveBeenCalledTimes(3);
  expect(list.hidden(id)).toBe(true);
});

it('keeps newer account events over a delayed startup/reconnect page', async () => {
  const list = createConversationListState();
  let resolve!: (value: unknown) => void;
  const reading = list.sync(vi.fn().mockImplementation(() => new Promise(done => { resolve = done; })));
  list.merge({ conversationId: id, hidden: true, revision: 3 });
  resolve([{ conversationId: id, hidden: false, revision: 2 }]);
  await reading;
  expect(list.hidden(id)).toBe(true);
  list.merge({ conversationId: id, hidden: false, revision: 4 });
  expect(list.hidden(id)).toBe(false);
});

it('does not hide on failed writes, then retries with the authoritative revision', async () => {
  const list = createConversationListState();
  const request = vi.fn().mockImplementation(async (_path, method) => {
    if (method === 'POST') throw new Error('REVISION_CONFLICT');
    return [{ conversationId: id, hidden: false, revision: 2 }];
  });
  await expect(list.setHidden(request, id, true, 'operation-one')).rejects.toThrow('REVISION_CONFLICT');
  expect(list.hidden(id)).toBe(false);
  expect(request).toHaveBeenLastCalledWith(`/conversations/${id}/list-state`, 'POST', { operationId: 'operation-one', hidden: true, expectedRevision: 2 });
  request.mockImplementation(async (_path, method) => method === 'POST'
    ? { conversationId: id, hidden: true, revision: 3 } : [{ conversationId: id, hidden: false, revision: 2 }]);
  await list.setHidden(request, id, true, 'operation-two');
  expect(list.hidden(id)).toBe(true);
  request.mockClear();
  await list.setHidden(request, id, true, 'operation-three');
  expect(request.mock.calls.every(call => call[1] !== 'POST')).toBe(true);
});

it('isolates accounts, validates write replies and can hide without any room snapshot', async () => {
  const first = createConversationListState();
  const second = createConversationListState();
  const request = vi.fn().mockImplementation(async (_path, method) => method === 'POST' ? { conversationId: id, hidden: true, revision: 1 } : []);
  await first.setHidden(request, id, true, 'operation-one');
  expect(first.hidden(id)).toBe(true);
  expect(second.hidden(id)).toBe(false);
  expect(request.mock.calls.map(call => call[0])).toEqual(['/conversation-list-state?limit=100', `/conversations/${id}/list-state`]);
  await expect(second.setHidden(vi.fn().mockImplementation(async (_path, method) => method === 'POST' ? {} : []), id, true, 'operation-two')).rejects.toThrow('INVALID_CHAT_LIST_STATE');
  expect(second.hidden(id)).toBe(false);
});
