import { expect, it, vi } from 'vitest';
import { createTaskCompletionDelivery, type TaskCompletionRecord, type TaskCompletionDeliveryDeps } from '../taskCompletionDelivery.js';

// Unit: generic creation formerly retained only its follower and lost the chat origin.
// Exercise the production delivery controller: exact destinations, failed posts, restart and
// execution identity. No real waits/network; persisted state survives controller recreation.
function fixture(origin: TaskCompletionRecord['origin']) {
  const record: TaskCompletionRecord = { origin, receipts: [] };
  const post = vi.fn<TaskCompletionDeliveryDeps['post']>(async () => ({ ok: true }));
  const failed = vi.fn(async () => {});
  let current = true;
  const deps: TaskCompletionDeliveryDeps = { read: async () => structuredClone(record),
    update: async (_: string, change: (value: TaskCompletionRecord) => void) => { change(record); },
    pending: async () => ['task'], post, showFailure: failed, isCurrent: () => current, log: vi.fn() };
  const start = () => createTaskCompletionDelivery(deps);
  return { record, post, failed, deps, start, stopOwner: () => { current = false; } };
}
const execution = { instanceId: 'native', generation: 1 };

it.each([
  { botId: 'creator', sessionId: 'private' },
  { botId: 'creator', sessionId: 'group-lane', groupId: 'group' },
  { botId: 'creator', sessionId: 'thread-lane', groupId: 'group', threadRootId: 'root' },
])('delivers to the frozen creation origin %j exactly once', async origin => {
  const f = fixture(origin), service = f.start();
  try {
    service.report('task', execution, true);
    await service.settle({ sessionId: 'task', execution, successful: true, text: 'Result' });
    await service.restore();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.post).toHaveBeenCalledWith('task', origin, expect.objectContaining({ text: 'Result' }), expect.any(Function));
    expect(f.record.receipts[0]?.status).toBe('delivered');
    expect(await service.handles('task')).toBe(true);
  } finally { service.dispose(); }
});

it('retains failed results without redirecting them, and retries the same frozen payload after restart', async () => {
  const f = fixture({ botId: 'creator', sessionId: 'lane', groupId: 'group', threadRootId: 'root' });
  f.post.mockImplementationOnce(async (_id, _origin, _receipt, freeze) => {
    await freeze(async () => ({ messages: [{ text: 'Result', threadRootId: 'root' }] }));
    return { ok: false, errorCode: 'OFFLINE', retryable: true };
  });
  const first = f.start();
  first.report('task', execution, true);
  await first.settle({ sessionId: 'task', execution, successful: true, text: 'Result' });
  first.dispose();
  expect(f.failed).toHaveBeenCalledTimes(1);
  expect(f.record.receipts[0]).toMatchObject({ status: 'pending', text: 'Result', postSnapshot: { messages: [{ text: 'Result', threadRootId: 'root' }] } });
  const restarted = f.start();
  try {
    await restarted.restore();
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(f.post.mock.calls[1]?.[1]).toEqual(f.record.origin);
    expect(f.record.receipts[0]?.status).toBe('delivered');
  } finally { restarted.dispose(); }
});

it('keeps a permanent refusal visible without retrying or falling back to private chat', async () => {
  const f = fixture({ botId: 'creator', sessionId: 'lane', groupId: 'group' });
  f.post.mockResolvedValue({ ok: false, errorCode: 'MEMBER_UNAVAILABLE', retryable: false });
  const service = f.start();
  try {
    service.report('task', execution, true);
    await service.settle({ sessionId: 'task', execution, successful: true, text: 'Saved result' });
    await service.restore();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.failed).toHaveBeenCalledTimes(1);
    expect(f.record.receipts[0]).toMatchObject({ text: 'Saved result', status: 'failed' });
  } finally { service.dispose(); }
});

it('does not deliver intermediate, failed or mismatched executions and retains independent later results', async () => {
  const f = fixture({ botId: 'creator', sessionId: 'private' }), service = f.start();
  try {
    for (const [generation, final, successful] of [[1, false, true], [2, true, false], [3, true, true]] as const) {
      const run = { instanceId: 'native', generation };
      service.report('task', run, final);
      await service.settle({ sessionId: 'task', execution: { ...run, instanceId: 'old' }, successful: true, text: 'Wrong' });
      await service.settle({ sessionId: 'task', execution: run, successful, text: `Result ${generation}` });
    }
    expect(f.post).toHaveBeenCalledTimes(1);
    service.report('task', { ...execution, generation: 4 }, true);
    await service.settle({ sessionId: 'task', execution: { ...execution, generation: 4 }, successful: true, text: 'Result 4' });
    expect(f.record.receipts.map(item => item.text)).toEqual(['Result 3', 'Result 4']);
    f.stopOwner();
    await service.restore();
    expect(f.post).toHaveBeenCalledTimes(2);
  } finally { service.dispose(); }
});

// Unit: a transient failure writing the notice must not lose a permanent refusal after restart.
it('restores an unsaved failure notice without reposting a permanently refused result', async () => {
  const f = fixture({ botId: 'creator', sessionId: 'lane', groupId: 'group' });
  f.post.mockResolvedValue({ ok: false, errorCode: 'MEMBER_UNAVAILABLE', retryable: false });
  f.failed.mockRejectedValueOnce(new Error('DB_BUSY')).mockRejectedValueOnce(new Error('DB_BUSY'));
  const first = f.start();
  first.report('task', execution, true);
  await first.settle({ sessionId: 'task', execution, successful: true, text: 'Retained result' });
  first.dispose();
  const second = f.start();
  try {
    await second.restore();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.record.receipts[0]).toMatchObject({ status: 'failed', failureShown: true, text: 'Retained result' });
  } finally { second.dispose(); }
});

// Unit, PR #8026 review: two executions can finish while origin/message reads or receipt
// writes fail. Existing tests only failed after persistence; neither result may be overwritten.
it.each(['read', 'resolveText', 'update'] as const)('retains both original executions when %s fails before persistence', async stage => {
  vi.useFakeTimers();
  const f = fixture({ botId: 'creator', sessionId: 'lane', groupId: 'group', threadRootId: 'root' });
  f.deps.resolveText = async input => `Saved ${input.messageClientId}`;
  const original = f.deps[stage]!;
  const failure = vi.fn(original).mockRejectedValueOnce(new Error('BUSY')).mockRejectedValueOnce(new Error('BUSY'));
  Object.assign(f.deps, { [stage]: failure });
  const service = f.start();
  try {
    const next = { ...execution, generation: 2 };
    service.report('task', execution, true);
    const first = service.settle({ sessionId: 'task', execution, successful: true, text: 'Fallback 1', messageClientId: 'message-1' });
    service.report('task', next, true);
    const second = service.settle({ sessionId: 'task', execution: next, successful: true, text: 'Fallback 2', messageClientId: 'message-2' });
    await Promise.all([first, second]);
    expect(f.failed).toHaveBeenCalledTimes(2);
    expect(f.post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.record.receipts.map(receipt => ({ execution: receipt.execution, text: receipt.text, status: receipt.status }))).toEqual([
      { execution, text: 'Saved message-1', status: 'delivered' },
      { execution: next, text: 'Saved message-2', status: 'delivered' },
    ]);
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(f.post.mock.calls.every(call => call[1].threadRootId === 'root')).toBe(true);
  } finally { service.dispose(); vi.useRealTimers(); }
});

// Live test (2026-11-08): with the V1 follow-up gone, report_task_delivery answered every report
// as "not running" because report() returned nothing, and a notify_when_done target was told to
// report although its result is sent regardless.
it('confirms a recorded report and asks for one only when the origin delivery depends on it', async () => {
  const origin = fixture({ botId: 'creator', sessionId: 'private' }), service = origin.start();
  try {
    expect(await service.wantsReport('task')).toBe(true);
    expect(service.report('task', execution, true)).toBe(true);
  } finally { service.dispose(); }
  const notify = fixture({ botId: 'creator', sessionId: 'requester' });
  Object.assign(notify.record, { notify: true, armed: {} });
  const notifying = notify.start();
  try {
    expect(await notifying.hasOrigin('task')).toBe(true);
    expect(await notifying.wantsReport('task')).toBe(false);
    notify.stopOwner();
    expect(notifying.report('task', execution, true)).toBe(false);
  } finally { notifying.dispose(); }
});

// PR #9314 review (reproduced with this controller): `notify_when_done` waited for "the next turn",
// so with an earlier message already queued the requester got that unrelated reply and lost its own;
// a second requester on the same task replaced the first. Each request now waits for its message.
it('answers each notify request with the turn that handled its own message', async () => {
  const f = fixture({ sessionId: 'unused' });
  f.record.notify = true;
  f.record.requests = [
    { inputClientId: 'msg-a', origin: { sessionId: 'asker-a' } },
    { inputClientId: 'msg-b', origin: { sessionId: 'asker-b' } },
  ];
  const service = f.start();
  try {
    // Turn 11 handles an earlier queued message: nobody asked about it.
    await service.settle({ sessionId: 'task', execution: { instanceId: 'native', generation: 11 }, successful: true,
      text: 'Unrelated', inputClientIds: ['older'] });
    expect(f.post).not.toHaveBeenCalled();
    expect(await service.handles('task')).toBe(true);
    await service.settle({ sessionId: 'task', execution: { instanceId: 'native', generation: 12 }, successful: true,
      text: 'Answer A', inputClientIds: ['msg-a'] });
    await service.settle({ sessionId: 'task', execution: { instanceId: 'native', generation: 13 }, successful: true,
      text: 'Answer B', inputClientIds: ['msg-b'] });
    expect(f.post.mock.calls.map(([, origin, receipt]) => [origin.sessionId, receipt.text]))
      .toEqual([['asker-a', 'Answer A'], ['asker-b', 'Answer B']]);
    expect(f.record.requests).toBeUndefined();
    expect(await service.handles('task')).toBe(false);
  } finally { service.dispose(); }
});
