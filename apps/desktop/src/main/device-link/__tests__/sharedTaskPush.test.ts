import { sharedTaskGuestPeer } from '@cindy/device-link';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DL_SUBSCRIBE_CHANNEL } from '@cindy/device-link';

vi.mock('electron', () => ({
  app: { getAppPath: () => '/tmp/cindy-test/app', getPath: () => '/tmp/cindy-test', getVersion: () => 'test' },
  powerSaveBlocker: { start: () => 0, stop: () => {}, isStarted: () => false },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
}));
vi.mock('../settings-store', () => ({
  readDeviceLinkSettings: () => ({ remoteControlEnabled: true, revokedControllers: [] }),
}));

import { __testing } from '../dispatch';
import * as subscriptions from '../subscriptions';
import { setSharedTaskDispatchHost } from '../sharedTaskDispatch';
import type { SharedTaskHost } from '../sharedTaskHost';

const guestA = sharedTaskGuestPeer('sharedTask-a', 'member-a', 'device-a');
const guestB = sharedTaskGuestPeer('sharedTask-b', 'member-b', 'device-b');
const grants = new Map<string, string>();
const metadata = [
  ['local-db:sessions:created', { sessionId: 'task-a' }],
  ['local-db:sessions:patched', { sessionId: 'task-a', patch: { title: 'Updated task' } }],
  ['local-db:sessions:activity', { sessionId: 'task-a', phase: 'completed', compactDetail: 'Done' }],
  ['local-db:session:error-persisted', { sessionId: 'task-a', clientId: 'error-row' }],
  ['usage:session-spend-changed', { sessionId: 'task-a', totalCost: 1 }],
  ['usage:session-tokens-changed', { sessionId: 'task-a', totalTokens: 100 }],
] as const;

function client() {
  return {
    getStatus: vi.fn(() => 'online'), getReliableSendQueueDepth: vi.fn(() => 0),
    canSendPush: vi.fn(() => true), sendPush: vi.fn(),
    sendInvokeResult: vi.fn(), sendLinkAccept: vi.fn(), closeLink: vi.fn(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  __testing.reset();
  grants.clear();
  grants.set(guestA, 'task-a'); grants.set(guestB, 'task-b');
  setSharedTaskDispatchHost({ capturePeer(source: string) {
    const sessionId = grants.get(source);
    if (!sessionId) return null;
    const current = () => grants.get(source) === sessionId;
    return {
      author: { sharedTaskId: 'sharedTask-a', sessionId, memberId: 'member-a', accountId: 'guest', displayName: 'Guest' },
      isCurrent: current, authorize: current,
    };
  } } as unknown as SharedTaskHost);
});
afterEach(() => {
  __testing.reset();
  setSharedTaskDispatchHost(null);
  vi.useRealTimers();
});

describe('shared task metadata uses only its authorized task subscription', () => {
  it.each(metadata)('delivers %s to the matching guest and ordinary list subscriber only', async (channel, payload) => {
    const transport = client();
    __testing.setActiveClient(transport as never);
    subscriptions.subscribe(guestA, ['session:task-a']);
    subscriptions.subscribe(guestB, ['session:task-b']);
    subscriptions.subscribe('own-list', ['sessions']);
    subscriptions.subscribe('own-task', ['session:task-a']);
    __testing.forwardPush(channel, payload);
    await vi.advanceTimersByTimeAsync(300);
    expect(transport.sendPush.mock.calls.map((call) => call[0]).sort()).toEqual([guestA, 'own-list'].sort());
    expect(transport.sendPush.mock.calls.every((call) => call[1] === channel && call[2].sessionId === 'task-a')).toBe(true);
  });

  it('keeps offline metadata under the task topic and replays it after that topic is restored', async () => {
    const transport = client();
    __testing.setActiveClient(transport as never);
    subscriptions.subscribe(guestA, ['session:task-a']);
    subscriptions.subscribe(guestB, ['session:task-b']);
    subscriptions.clearController(guestA);
    for (const [channel, payload] of metadata) __testing.forwardPush(channel, payload);
    expect(transport.sendPush).not.toHaveBeenCalled();
    expect(__testing.queuedPushesFor(guestA).map((item) => item.topic)).toEqual(metadata.map(() => 'session:task-a'));
    expect(__testing.queuedPushesFor(guestB)).toEqual([]);
    const result = __testing.handleSubscriptionFrame(guestA, {
      channel: DL_SUBSCRIBE_CHANNEL, args: [{ topics: ['session:task-a'] }],
    });
    expect(result.ok).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(transport.sendPush.mock.calls.filter((call) => metadata.some(([channel]) => channel === call[1]))).toHaveLength(metadata.length);
    expect(__testing.queuedPushesFor(guestA)).toEqual([]);
  });

  it('queues metadata while the relay is offline even if the guest subscription remains active', () => {
    const transport = client();
    transport.getStatus.mockReturnValue('reconnecting');
    __testing.setActiveClient(transport as never);
    subscriptions.subscribe(guestA, ['session:task-a']);
    __testing.forwardPush(...metadata[1]);
    expect(transport.sendPush).not.toHaveBeenCalled();
    expect(__testing.queuedPushesFor(guestA)).toEqual([expect.objectContaining({ topic: 'session:task-a', channel: metadata[1][0] })]);
  });

  it.each(['revoke', 'unsubscribe'] as const)('does not deliver deferred patch/activity after %s', async (boundary) => {
    const transport = client();
    transport.getReliableSendQueueDepth.mockReturnValue(100);
    __testing.setActiveClient(transport as never);
    subscriptions.subscribe(guestA, ['session:task-a']);
    __testing.forwardPush(...metadata[1]);
    __testing.forwardPush(...metadata[2]);
    expect(transport.sendPush).not.toHaveBeenCalled();
    if (boundary === 'revoke') grants.delete(guestA);
    else subscriptions.unsubscribe(guestA, ['session:task-a']);
    transport.getReliableSendQueueDepth.mockReturnValue(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(transport.sendPush).not.toHaveBeenCalled();
  });

  it('does not grant global metadata, another task, or a revoked remembered subscriber', () => {
    const transport = client();
    __testing.setActiveClient(transport as never);
    subscriptions.subscribe(guestA, ['session:task-a']);
    __testing.forwardPush('maker:provider:changed', { sessionId: 'task-a' });
    __testing.forwardPush('local-db:sessions:patched', { sessionId: 'other-task', patch: { title: 'Private' } });
    __testing.forwardPush('local-db:sessions:activity', { phase: 'completed' });
    subscriptions.clearController(guestA);
    grants.delete(guestA);
    for (const [channel, payload] of metadata) __testing.forwardPush(channel, payload);
    expect(transport.sendPush).not.toHaveBeenCalled();
    expect(__testing.queuedPushesFor(guestA)).toEqual([]);
  });
});
