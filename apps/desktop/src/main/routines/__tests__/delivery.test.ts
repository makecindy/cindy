import { beforeEach, expect, it, vi } from 'vitest';
import type { Routine } from '@cindy/maker-scheduler';
import type { ImOrchestrator } from '../../im/shared/orchestrator.js';

const h = vi.hoisted(() => ({
  createMessage: vi.fn(async () => {}), send: vi.fn(async () => ({ messageId: 'sent' })),
  dispatch: vi.fn(async () => ({ ok: true })), connected: true, contextId: 'tg-bot',
  personal: [] as ImOrchestrator[], companionBotId: 'bot' as string | undefined,
  sessionRows: vi.fn(async (): Promise<Array<{ receiver: string; title: string }>> => []),
}));
vi.mock('../../localDb/ipc/messages.js', () => ({ createMessage: h.createMessage }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: {
  select: () => ({ from: () => ({ where: h.sessionRows }) }),
} }) }));
vi.mock('../../im/shared/orchestrator.js', () => ({
  listImOrchestrators: () => h.personal,
  getImOrchestrator: (channel: string) => h.personal.find(row => row.channel === channel),
}));
vi.mock('../../im/wechat/channelSettings.js', () => ({
  readWechatChannelSettings: () => ({ companionBotId: h.companionBotId }),
}));
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
  h.personal = []; h.companionBotId = 'bot';
  h.sessionRows.mockResolvedValue([]);
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

// #9486: a companion chat is source=bot, so no source=wechat session exists.
// Exercise public discovery/delivery; only the transport and persistence boundaries are faked.
function personalWechat() {
  const state = { connected: true, contextId: 'wx-bot', bindingEpoch: 'wx-epoch', knownOwner: true };
  const send = vi.fn(async () => ({ messageId: 'sent' }));
  const resolve = vi.fn(async () => {
    const epoch = state.bindingEpoch;
    return state.connected && state.knownOwner ? {
      receiver: 'wx-owner', bindingEpoch: epoch,
      isCurrent: () => state.connected && state.bindingEpoch === epoch,
    } : null;
  });
  h.personal = [{ channel: 'wechat', adapter: { im: {
    getStatus: () => ({ kind: state.connected ? 'connected' : 'idle', appId: state.contextId }),
    getOwnerDeliveryTarget: resolve, sendMarkdownText: send,
  } } } as unknown as ImOrchestrator];
  return { state, send, resolve };
}

it('discovers and delivers to the bound WeChat owner without channel session rows', async () => {
  const { send } = personalWechat();
  const target = (await listRoutineDeliveryTargets('bot')).find(row => row.channel === 'wechat');
  expect(target).toMatchObject({ channel: 'wechat', recipient: 'wx-owner' });
  expect(h.sessionRows).not.toHaveBeenCalled();
  await deliverRoutineResult({ ...input(), routine: { ...routine, delivery: { kind: 'im', targetId: target!.id } } });
  expect(send).toHaveBeenCalledWith('wx-owner', 'Report\n\nFinished report');
  expect(await listRoutineDeliveryTargets('other-bot')).toEqual([]);
});

// Unit / PR #9497: a failed owner-context read must not break unrelated destinations.
// Existing coverage only made the WeChat lookup succeed or return an unavailable owner.
it('keeps Telegram available when the bound WeChat owner lookup fails', async () => {
  const { send, resolve } = personalWechat();
  const targets = await listRoutineDeliveryTargets('bot');
  const wechat = targets.find(row => row.channel === 'wechat')!;
  const telegram = targets.find(row => row.recipient === 'Reports')!;
  resolve.mockRejectedValue(new Error('Cannot decrypt owner context'));

  expect(await listRoutineDeliveryTargets('bot')).toEqual(targets.filter(row => row.channel !== 'wechat'));
  await deliverRoutineResult({ ...input(), routine: { ...routine, delivery: { kind: 'im', targetId: telegram.id } } });
  expect(h.send).toHaveBeenCalledWith('g/-100123/42', 'Report\n\nFinished report');
  await expect(deliverRoutineResult({ ...input(), routine: { ...routine, delivery: { kind: 'im', targetId: wechat.id } } }))
    .rejects.toThrow('unavailable');
  expect(send).not.toHaveBeenCalled();
});

it('retains unbound personal WeChat targets but never borrows them from another companion', async () => {
  const { send, resolve, state } = personalWechat();
  h.companionBotId = undefined;
  h.sessionRows.mockResolvedValue([{ receiver: 'known-peer', title: 'Existing chat' }]);
  const target = (await listRoutineDeliveryTargets('bot')).find(row => row.channel === 'wechat')!;
  expect(target.id).toBe(JSON.stringify(['wechat', 'wx-bot', 'known-peer']));
  expect(resolve).not.toHaveBeenCalled();
  const args = { ...input(), routine: { ...routine, delivery: { kind: 'im' as const, targetId: target.id } } };
  await deliverRoutineResult(args);
  expect(send).toHaveBeenCalledWith('known-peer', 'Report\n\nFinished report');
  h.companionBotId = 'other-bot';
  await expect(deliverRoutineResult(args)).rejects.toThrow('unavailable');
  h.companionBotId = 'bot';
  state.knownOwner = false;
  expect((await listRoutineDeliveryTargets('bot')).filter(row => row.channel === 'wechat')).toEqual([]);
  h.companionBotId = undefined;
  args.assertCurrent.mockImplementationOnce(() => {}).mockImplementationOnce(() => { h.companionBotId = 'other-bot'; });
  await expect(deliverRoutineResult(args)).rejects.toThrow('unavailable');
  expect(send).toHaveBeenCalledTimes(1);
});

it.each(['disconnect', 'identity', 'epoch', 'owner', 'rebind', 'unbind', 'unregister', 'account'])(
  'rejects a saved WeChat target after %s', async (change) => {
    const { state, send } = personalWechat();
    const target = (await listRoutineDeliveryTargets('bot')).find(row => row.channel === 'wechat')!;
    expect(target).toBeDefined();
    if (change === 'disconnect') state.connected = false;
    if (change === 'identity') state.contextId = 'another-wx-bot';
    if (change === 'epoch') state.bindingEpoch = 'new-epoch';
    if (change === 'owner') state.knownOwner = false;
    if (change === 'rebind') h.companionBotId = 'other-bot';
    if (change === 'unbind') h.companionBotId = undefined;
    if (change === 'unregister') h.personal = [];
    const args = { ...input(), routine: { ...routine, delivery: { kind: 'im' as const, targetId: target.id } } };
    if (change === 'account') args.assertCurrent.mockImplementation(() => { throw new Error('Account changed'); });
    await expect(deliverRoutineResult(args)).rejects.toThrow(change === 'account' ? 'Account changed' : 'unavailable');
    expect(send).not.toHaveBeenCalled();
  },
);

it.each(['rebind', 'epoch', 'unregister'])('revalidates WeChat %s immediately before sending', async (change) => {
  const { state, send, resolve } = personalWechat();
  const target = (await listRoutineDeliveryTargets('bot')).find(row => row.channel === 'wechat')!;
  expect(target).toBeDefined();
  const args = { ...input(), routine: { ...routine, delivery: { kind: 'im' as const, targetId: target.id } } };
  args.assertCurrent.mockImplementation(() => {
    if (resolve.mock.calls.length < 2) return;
    if (change === 'rebind') h.companionBotId = 'other-bot';
    if (change === 'epoch') state.bindingEpoch = 'new-epoch';
    if (change === 'unregister') h.personal = [];
  });
  await expect(deliverRoutineResult(args)).rejects.toThrow('unavailable');
  expect(send).not.toHaveBeenCalled();
});
