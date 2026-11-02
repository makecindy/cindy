import { beforeEach, expect, it, vi } from 'vitest';
import type { Routine } from '@cindy/maker-scheduler';

const h = vi.hoisted(() => ({
  createMessage: vi.fn(async () => {}), send: vi.fn(async () => ({ messageId: 'sent' })),
  dispatch: vi.fn(async () => ({ ok: true })), connected: true, contextId: 'tg-bot',
}));
vi.mock('../../localDb/ipc/messages.js', () => ({ createMessage: h.createMessage }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: vi.fn() }));
vi.mock('../../im/shared/orchestrator.js', () => ({ listImOrchestrators: () => [], getImOrchestrator: vi.fn() }));
vi.mock('../../im/shared/botImConnectionRuntime.js', () => ({
  buildBotImConnectionListPayload: (botId: string) => ({ connections: botId === 'bot' ? [{
    id: 'connection', channel: 'telegram', botContextId: h.contextId,
    status: { kind: h.connected ? 'connected' : 'idle' }, identity: { ownerUserId: 'owner' },
  }] : [] }),
  getBotImConnectionOrchestrator: () => ({ channel: 'telegram', adapter: {
    getBotDisplayName: () => 'My bot', im: { getStatus: () => ({ kind: h.connected ? 'connected' : 'idle', appId: h.contextId }), sendMarkdownText: h.send },
  } }),
}));
vi.mock('../../im/shared/botImLaneRuntime.js', () => ({ listBotImConnectionLanes: async () => ({ lanes: [
  { kind: 'topic', chatId: '-100123', threadId: '42', name: 'Reports' },
] }) }));
import { deliverRoutineResult, listRoutineDeliveryTargets } from '../delivery.js';
import { setRoutineResultDispatch } from '../deliveryDispatch.js';

const routine: Routine = { id: 'report', botId: 'bot', name: 'Report', prompt: 'Summarize', enabled: true,
  triggers: [], revision: 1, createdAt: 1, updatedAt: 1 };
const input = () => ({ routine, runId: 'run', sessionId: 'lane', targetSessionId: 'canonical',
  text: 'Finished report', assertCurrent: vi.fn() });
beforeEach(() => {
  vi.clearAllMocks(); h.connected = true; h.contextId = 'tg-bot';
  h.dispatch.mockResolvedValue({ ok: true }); setRoutineResultDispatch(h.dispatch);
});

// Regression: successful routine output remained in its hidden execution lane.
it('publishes the default result to the companion with scheduler origin and no model call', async () => {
  const args = input();
  await deliverRoutineResult(args);
  expect(h.createMessage).toHaveBeenCalledWith('canonical', expect.objectContaining({
    clientId: 'routine-result:run', role: 'assistant', content: 'Finished report',
    agentMeta: { origin: { kind: 'scheduler', scheduleId: 'routine-report', scheduleName: 'Report', runId: 'run' } },
  }), expect.any(Object));
  expect(h.dispatch).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
});

it('processes only an explicit selection through the normal queue without claiming owner authority', async () => {
  await deliverRoutineResult({ ...input(), routine: { ...routine, delivery: { kind: 'companion', mode: 'process' } } });
  expect(h.dispatch).toHaveBeenCalledWith(expect.objectContaining({ targetSessionId: 'canonical', dispatcherSessionId: 'lane',
    autoReviewUserText: { kind: 'agent-request' }, resumeWithStoredPermissionMode: true,
    message: expect.stringContaining('not a new owner instruction') }));
  expect(h.createMessage).not.toHaveBeenCalled();
});

it('sends a discovered Telegram topic through its own transport and refuses changed bot identities', async () => {
  const targets = await listRoutineDeliveryTargets('bot');
  const topic = targets.find(row => row.recipient === 'Reports')!;
  const args = { ...input(), routine: { ...routine, delivery: { kind: 'im' as const, targetId: topic.id } } };
  await deliverRoutineResult(args);
  expect(h.send).toHaveBeenCalledWith('g/-100123/42', 'Report\n\nFinished report');
  h.contextId = 'replacement-bot';
  await expect(deliverRoutineResult(args)).rejects.toThrow('unavailable');
  h.connected = false;
  await expect(deliverRoutineResult(args)).rejects.toThrow('unavailable');
  expect(h.send).toHaveBeenCalledTimes(1);
  expect(await listRoutineDeliveryTargets('other-bot')).toEqual([]);
});

it('stops publication at the account boundary and respects an explicit no-delivery choice', async () => {
  await expect(deliverRoutineResult({ ...input(), assertCurrent: () => { throw new Error('Account changed'); } })).rejects.toThrow('Account changed');
  await deliverRoutineResult({ ...input(), routine: { ...routine, delivery: { kind: 'none' } } });
  expect(h.createMessage).not.toHaveBeenCalled(); expect(h.dispatch).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
});
