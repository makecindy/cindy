import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@cindy/maker-core';
import type { IdentityKey } from '@cindy/im';
import type { ImChannelAdapter } from '../types';

const mocks = vi.hoisted(() => ({
  limit: vi.fn(),
  capture: vi.fn(),
  current: vi.fn(),
  binding: vi.fn<() => IdentityKey | null>(),
  status: vi.fn(),
  botContextId: vi.fn(),
  attach: vi.fn(),
}));
vi.mock('../../../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../../../localDb/client/current', () => ({
  getDbClient: () => ({ drizzle: { select: () => ({ from: () => ({ where: () => ({ limit: mocks.limit }) }) }) } }),
}));
vi.mock('../../accountBoundary', () => ({
  captureImAccountGeneration: mocks.capture, isImAccountGenerationCurrent: mocks.current,
}));
vi.mock('../../binding', () => ({ bindingStore: { findByTarget: mocks.binding } }));
vi.mock('../../../maker-ipc/register', () => ({
  acquirePendingAgentSwitchForDirectSend: vi.fn(),
  acquirePendingAgentSwitchForImSend: vi.fn(),
  registerSwitchedSessionVendorOptionsResolver: vi.fn(),
}));
vi.mock('../channelDefaultRouteSync', () => ({ createImChannelDefaultRouteSync: () => ({}) }));
vi.mock('../sessionRepo', () => ({ createImSessionRepo: () => ({}) }));
vi.mock('../cardBuilders', () => ({ createCardBuilders: () => ({}) }));
vi.mock('../turnRunner', () => ({ createTurnRunner: () => ({ attachSessionOutput: mocks.attach }) }));
vi.mock('../slashCommands', () => ({ createSlashHandlers: () => ({}) }));
vi.mock('../messageHandler', () => ({ createMessageHandler: () => vi.fn() }));
vi.mock('../cardActionHandler', () => ({ createCardActionHandler: () => vi.fn() }));

import { createImOrchestrator } from '../orchestrator';
import { channelTurnSourceFor, publishChannelTurn, withChannelTurnSource } from '../../../maker-ipc/channelTurnSignal';

for (const channel of ['telegram', 'feishu', 'discord', 'wechat', 'wecom', 'dingtalk'] as const) {
  createImOrchestrator({
    channel, im: { getStatus: mocks.status }, sessions: { source: channel },
    output: { kind: 'chunked-text' },
    ...(channel === 'discord' ? { getBotContextId: mocks.botContextId } : {}),
  } as unknown as ImChannelAdapter);
}
const session = { id: 'desktop-task' } as Session;
const binding: IdentityKey = {
  channel: 'telegram', botContextId: 'bot', userId: 'group-user', scopeKey: 'topic',
};
const nativeRow = {
  source: 'feishu', status: 'active', feishuBotAppId: 'bot', feishuOpenId: 'native-user',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capture.mockReturnValue(1);
  mocks.current.mockReturnValue(true);
  mocks.status.mockReturnValue({ kind: 'connected', appId: 'bot' });
  mocks.binding.mockReturnValue(null);
  mocks.botContextId.mockReturnValue('bot');
  mocks.limit.mockResolvedValue([nativeRow]);
});

describe('background output route recovery', () => {
  it.each(['desktop', 'feishu'])('prefers takeover identity over %s source', async (source) => {
    mocks.limit.mockResolvedValue([{ ...nativeRow, source }]);
    mocks.binding.mockReturnValue(binding);
    await publishChannelTurn(session, 'starting');
    expect(mocks.attach).toHaveBeenCalledExactlyOnceWith(session, 'group-user', { attached: true, scopeKey: 'topic' }, undefined);
  });

  it.each(['feishu', 'telegram', 'wechat', 'wecom', 'dingtalk'])('falls back to native %s identity without a binding', async (source) => {
    mocks.limit.mockResolvedValue([{ ...nativeRow, source, imBotContextId: 'bot', imUserId: 'native-user' }]);
    await publishChannelTurn(session, 'starting');
    expect(mocks.attach).toHaveBeenCalledExactlyOnceWith(session, 'native-user', { attached: false, scopeKey: undefined }, undefined);
  });

  it('passes the other-task source of the send that starts the turn, only to that turn', async () => {
    mocks.limit.mockResolvedValue([{ ...nativeRow, source: 'telegram', imBotContextId: 'bot', imUserId: 'native-user' }]);
    const other = { kind: 'session', senderSessionId: 'sender', displayText: 'hi' };
    await withChannelTurnSource(session.id, channelTurnSourceFor(other, false), () => publishChannelTurn(session, 'starting'));
    expect(mocks.attach).toHaveBeenLastCalledWith(session, 'native-user', { attached: false, scopeKey: undefined }, 'other-task');
    await publishChannelTurn(session, 'starting');
    expect(mocks.attach).toHaveBeenLastCalledWith(session, 'native-user', { attached: false, scopeKey: undefined }, undefined);
    // Internal delegation coordination and guest-projected origins are not other-task mail.
    expect(channelTurnSourceFor(other, true)).toBeUndefined();
    expect(channelTurnSourceFor({ ...other, senderSessionId: '' }, false)).toBeUndefined();
    expect(channelTurnSourceFor({ kind: 'scheduler', scheduleId: 's' }, false)).toBeUndefined();
  });

  it.each([false, true])('uses stable Discord identity for cold route (takeover: %s)', async (attached) => {
    mocks.status.mockReturnValue({ kind: 'connected', appId: 'display#0000' });
    mocks.limit.mockResolvedValue([{ source: 'discord', status: 'active', imBotContextId: 'bot', imUserId: 'user' }]);
    if (attached) mocks.binding.mockReturnValue({ ...binding, channel: 'discord' });
    await publishChannelTurn(session, 'starting');
    expect(mocks.attach).toHaveBeenCalledExactlyOnceWith(session, attached ? 'group-user' : 'user', {
      attached, scopeKey: attached ? 'topic' : undefined,
    }, undefined);
    mocks.attach.mockClear();
    mocks.botContextId.mockReturnValue('other-bot');
    await publishChannelTurn(session, 'starting');
    expect(mocks.attach).not.toHaveBeenCalled();
    // An unavailable identity must not fall back to a matching display label.
    mocks.status.mockReturnValue({ kind: 'connected', appId: 'bot' });
    mocks.botContextId.mockReturnValue('');
    await publishChannelTurn(session, 'starting');
    expect(mocks.attach).not.toHaveBeenCalled();
    mocks.botContextId.mockReturnValue('bot');
    mocks.status.mockReturnValue({ kind: 'connecting' });
    await publishChannelTurn(session, 'starting');
    expect(mocks.attach).not.toHaveBeenCalled();
  });

  it.each(['deleted', 'archived', 'missing', 'disconnected', 'wrong-bot', 'wrong-account', 'unbound-desktop', 'unsupported-binding'])(
    'does not attach for %s', async (state) => {
      mocks.binding.mockReturnValue(binding);
      if (state === 'deleted' || state === 'archived') mocks.limit.mockResolvedValue([{ ...nativeRow, status: state }]);
      if (state === 'missing') mocks.limit.mockResolvedValue([]);
      if (state === 'disconnected') mocks.status.mockReturnValue({ kind: 'disconnected' });
      if (state === 'wrong-bot') mocks.status.mockReturnValue({ kind: 'connected', appId: 'other-bot' });
      if (state === 'wrong-account') mocks.current.mockReturnValue(false);
      if (state === 'unbound-desktop') {
        mocks.binding.mockReturnValue(null);
        mocks.limit.mockResolvedValue([{ ...nativeRow, source: 'desktop' }]);
      }
      if (state === 'unsupported-binding') mocks.binding.mockReturnValue({ ...binding, channel: 'unknown' });
      await publishChannelTurn(session, 'starting');
      expect(mocks.attach).not.toHaveBeenCalled();
    },
  );

  it('reads the current binding after the async row query, not a detached identity', async () => {
    let finish!: (rows: unknown[]) => void;
    mocks.limit.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    mocks.binding.mockReturnValue(binding);
    const restoring = publishChannelTurn(session, 'starting');
    mocks.binding.mockReturnValue(null);
    finish([{ source: 'desktop', status: 'active' }]);
    await restoring;
    expect(mocks.attach).not.toHaveBeenCalled();
  });
});
