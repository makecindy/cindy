import { sharedTaskGuestPeer } from '@cindy/device-link';
import { beforeEach, describe, expect, it } from 'vitest';
import { sharedTaskHostPeer } from '@cindy/device-link';
import { setDataOwnerGeneration } from '../contexts/dataOwnerGeneration';
import { bindSharedTaskPushOwner, isDeviceLinkRemotePushCurrent, isRemoteDataOwnerPushCurrent, resetRemoteDataOwnerPushFence } from '../lib/remoteDataOwnerPushFence';

const peer = sharedTaskHostPeer('shared-task', 'desktop');
const hostStamp = { dataOwnerId: 'host-account', ownerGeneration: 4 };
const localStamp = { dataOwnerId: 'guest-account', ownerGeneration: 2 };

beforeEach(() => {
  resetRemoteDataOwnerPushFence();
  setDataOwnerGeneration('guest-account', 2);
});

describe('shared task push owner', () => {
  it('accepts a restarted host only after Main advances its verified source epoch', () => {
    bindSharedTaskPushOwner(peer, 'host-account');
    const push = (generation: number, sourceEpoch: number) => ({
      deviceId: peer, ownerStamp: { ...hostStamp, ownerGeneration: generation }, sourceEpoch,
    });
    expect(isDeviceLinkRemotePushCurrent(push(7, 10), localStamp)).toBe(true);
    expect(isDeviceLinkRemotePushCurrent(push(1, 10), localStamp)).toBe(false);
    bindSharedTaskPushOwner(peer, 'host-account');
    expect(isDeviceLinkRemotePushCurrent(push(1, 10), localStamp)).toBe(false);
    expect(isDeviceLinkRemotePushCurrent(push(1, 11), localStamp)).toBe(true);
    expect(isDeviceLinkRemotePushCurrent(push(8, 10), localStamp)).toBe(false);
    expect(isDeviceLinkRemotePushCurrent(push(0, 11), localStamp)).toBe(false);
    expect(isDeviceLinkRemotePushCurrent({ deviceId: peer, ownerStamp: hostStamp }, localStamp)).toBe(false);
    expect(isDeviceLinkRemotePushCurrent(push(2, 11), localStamp)).toBe(true);
  });

  it('never resets an unrelated peer or accepts an epoch from a stale account', () => {
    const other = sharedTaskHostPeer('other-task', 'desktop');
    bindSharedTaskPushOwner(peer, 'host-account');
    bindSharedTaskPushOwner(other, 'host-account');
    const push = { deviceId: peer, ownerStamp: hostStamp, sourceEpoch: 1 };
    expect(isDeviceLinkRemotePushCurrent(push, localStamp)).toBe(true);
    expect(isDeviceLinkRemotePushCurrent({ ...push, deviceId: other }, localStamp)).toBe(true);
    const next = { ...push, sourceEpoch: 2, ownerStamp: { ...hostStamp, ownerGeneration: 1 } };
    expect(isDeviceLinkRemotePushCurrent(next, { ...localStamp, ownerGeneration: 1 })).toBe(false);
    expect(isDeviceLinkRemotePushCurrent({ ...next, ownerStamp: { ...hostStamp, dataOwnerId: 'wrong' } }, localStamp)).toBe(false);
    expect(isDeviceLinkRemotePushCurrent({ ...next, sourceEpoch: 1 }, localStamp)).toBe(false);
    expect(isDeviceLinkRemotePushCurrent(next, localStamp)).toBe(true);
    expect(isDeviceLinkRemotePushCurrent({ ...next, deviceId: other, sourceEpoch: 1 }, localStamp)).toBe(false);
    expect(isRemoteDataOwnerPushCurrent('ordinary', localStamp, true, 1)).toBe(true);
    expect(isRemoteDataOwnerPushCurrent('ordinary', { ...localStamp, ownerGeneration: 1 }, true, 2)).toBe(false);
  });

  it('accepts the authenticated host account with independent source and local generations', () => {
    bindSharedTaskPushOwner(peer, 'host-account');
    expect(isDeviceLinkRemotePushCurrent({ deviceId: peer, ownerStamp: hostStamp }, localStamp)).toBe(true);
    expect(isDeviceLinkRemotePushCurrent({ deviceId: peer, ownerStamp: hostStamp }, { ...localStamp, ownerGeneration: 1 })).toBe(false);
    expect(isRemoteDataOwnerPushCurrent(peer, { ...hostStamp, ownerGeneration: 3 })).toBe(false);
    expect(isRemoteDataOwnerPushCurrent(peer, { ...hostStamp, dataOwnerId: 'guest-account' })).toBe(false);
  });

  it('requires an authenticated binding and a valid stamp for shared hosts', () => {
    expect(isRemoteDataOwnerPushCurrent(peer, hostStamp)).toBe(false);
    bindSharedTaskPushOwner(peer, 'host-account');
    expect(isRemoteDataOwnerPushCurrent(peer, undefined)).toBe(false);
    expect(isRemoteDataOwnerPushCurrent(peer, null)).toBe(false);
    expect(isRemoteDataOwnerPushCurrent(peer, {})).toBe(false);
    expect(isRemoteDataOwnerPushCurrent(sharedTaskGuestPeer('shared-task', 'member', 'device'), hostStamp)).toBe(false);
  });

  it('invalidates bindings when the local account or generation changes', () => {
    bindSharedTaskPushOwner(peer, 'host-account');
    setDataOwnerGeneration('guest-account', 3);
    expect(isRemoteDataOwnerPushCurrent(peer, hostStamp)).toBe(false);
    bindSharedTaskPushOwner(peer, 'host-account');
    expect(isRemoteDataOwnerPushCurrent(peer, hostStamp)).toBe(true);
    setDataOwnerGeneration('another-account', 4);
    expect(isRemoteDataOwnerPushCurrent(peer, hostStamp)).toBe(false);
    setDataOwnerGeneration(null, 5);
    bindSharedTaskPushOwner(peer, 'host-account');
    expect(isRemoteDataOwnerPushCurrent(peer, hostStamp)).toBe(false);
  });

  it('does not replace a current binding or roll back source generation during polling', () => {
    bindSharedTaskPushOwner(peer, 'host-account');
    expect(isRemoteDataOwnerPushCurrent(peer, hostStamp)).toBe(true);
    bindSharedTaskPushOwner(peer, 'other-host');
    expect(isRemoteDataOwnerPushCurrent(peer, { ...hostStamp, dataOwnerId: 'other-host' })).toBe(false);
    bindSharedTaskPushOwner(peer, 'host-account');
    expect(isRemoteDataOwnerPushCurrent(peer, { ...hostStamp, ownerGeneration: 3 })).toBe(false);
  });

  it('rejects delayed frames after removal, without affecting another shared task', () => {
    const other = sharedTaskHostPeer('other-task', 'desktop');
    bindSharedTaskPushOwner(peer, 'host-account');
    bindSharedTaskPushOwner(other, 'host-account');
    resetRemoteDataOwnerPushFence(peer);
    expect(isRemoteDataOwnerPushCurrent(peer, hostStamp)).toBe(false);
    expect(isRemoteDataOwnerPushCurrent(other, hostStamp)).toBe(true);
    resetRemoteDataOwnerPushFence();
    expect(isRemoteDataOwnerPushCurrent(other, hostStamp)).toBe(false);
  });

  it('retains same-account remote control and legacy unstamped compatibility', () => {
    expect(isRemoteDataOwnerPushCurrent('ordinary-device', undefined)).toBe(true);
    expect(isRemoteDataOwnerPushCurrent('ordinary-device', hostStamp)).toBe(false);
    expect(isRemoteDataOwnerPushCurrent('ordinary-device', { ...localStamp, ownerGeneration: 9 })).toBe(true);
    expect(isRemoteDataOwnerPushCurrent('ordinary-device', { ...localStamp, ownerGeneration: 8 })).toBe(false);
    expect(isRemoteDataOwnerPushCurrent('ordinary-device', undefined)).toBe(false);
  });
});
