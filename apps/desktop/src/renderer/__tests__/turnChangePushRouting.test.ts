import { afterEach, expect, it, vi } from 'vitest';
import { PUSH_FORWARD_ALLOWLIST, REMOTE_INVOKE_ALLOWLIST, topicForPush, isPeerResetRetryableReadChannel, isCompletedInvokeRetryableReadChannel, canCoalesceRemoteListing } from '@cindy/device-link';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { subscribeTurnChangeSetUpdated, makerApiForSticky } from '@/lib/makerTransport';
import type { Session } from '@/lib/ccAgent.types';

afterEach(() => vi.unstubAllGlobals());

it('filters summary pushes by device, task and owner', () => {
  const onRemotePush = vi.fn((_callback: (value: unknown, stamp: unknown) => void) => vi.fn());
  const onTurnChangeSetUpdated = vi.fn();
  vi.stubGlobal('window', {
    electronAPI: {
      deviceLink: { onRemotePush },
      maker: { onTurnChangeSetUpdated },
    },
  });
  setDataOwnerGeneration('owner', 1);
  remoteProjectsStore.setDeviceSessions('host', 'Host', [{ id: 'remote-task' } as Session]);
  const callback = vi.fn();
  const off = subscribeTurnChangeSetUpdated('remote-task', callback);
  const push = onRemotePush.mock.calls[0][0];
  const channel = 'maker:turn-change-set:updated';
  const payload = { sessionId: 'remote-task', summary: { id: 'set', sessionId: 'remote-task' } };
  const stamp = { dataOwnerId: 'owner', ownerGeneration: 1 };
  expect(PUSH_FORWARD_ALLOWLIST.has(channel)).toBe(true);
  expect(topicForPush(channel, payload)).toBe('session:remote-task');
  push({ deviceId: 'other', channel, payload, ownerStamp: stamp }, stamp);
  push(
    { deviceId: 'host', channel, payload: { ...payload, sessionId: 'other' }, ownerStamp: stamp },
    stamp,
  );
  push(
    { deviceId: 'host', channel, payload, ownerStamp: { ...stamp, dataOwnerId: 'other' } },
    stamp,
  );
  expect(callback).not.toHaveBeenCalled();
  push({ deviceId: 'host', channel, payload, ownerStamp: stamp }, stamp);
  expect(callback).toHaveBeenCalledWith(payload);
  expect(onTurnChangeSetUpdated).not.toHaveBeenCalled();
  off();
});


it('keeps undo/reapply on the owning device after the live listing disappears', async () => {
  const invoke = vi.fn().mockResolvedValue({ changed: true });
  const applyTurnChangeSet = vi.fn();
  vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke }, maker: { applyTurnChangeSet } } });
  remoteProjectsStore.setDeviceSessions('restore-host', 'Host', [{ id: 'restore-task' } as Session]);
  const api = makerApiForSticky('restore-task');
  await api.applyTurnChangeSet('restore-task', 'change', 'undo');
  remoteProjectsStore.setDeviceSessions('restore-host', 'Host', []);
  await makerApiForSticky('restore-task').applyTurnChangeSet('restore-task', 'change', 'reapply');
  expect(invoke.mock.calls).toEqual([
    ['restore-host', 'maker:turn-change-set:apply', ['restore-task', 'change', 'undo']],
    ['restore-host', 'maker:turn-change-set:apply', ['restore-task', 'change', 'reapply']],
  ]);
  expect(applyTurnChangeSet).not.toHaveBeenCalled();
});

it('admits explicit restore requests without enabling read retries or coalescing', () => {
  const channel = 'maker:turn-change-set:apply';
  expect(REMOTE_INVOKE_ALLOWLIST.has(channel)).toBe(true);
  expect(isPeerResetRetryableReadChannel(channel)).toBe(false);
  expect(isCompletedInvokeRetryableReadChannel(channel)).toBe(false);
  expect(canCoalesceRemoteListing({ channel, args: ['restore-task', 'change', 'undo'] })).toBe(false);
});
