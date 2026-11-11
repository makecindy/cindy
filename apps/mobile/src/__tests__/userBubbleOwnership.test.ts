import { describe, expect, it } from 'vitest';
import { sharedTaskHostPeer } from '@cindy/device-link';
import { isOwnUserBubble } from '@/session/userBubbleOwnership';

const ownerDevice = 'mac-owner-device';
const guestView = sharedTaskHostPeer('shared-task-1', ownerDevice);

describe('my message bubble ownership', () => {
  it('tints only my messages when I own the task', () => {
    expect(isOwnUserBubble({}, { accountId: 'owner', remoteDeviceId: ownerDevice })).toBe(true);
    expect(isOwnUserBubble(
      { sharedAuthorName: 'Guest', sharedAuthorAccountId: 'guest' },
      { accountId: 'owner', remoteDeviceId: ownerDevice },
    )).toBe(false);
  });

  it('tints only my messages when I join as a guest', () => {
    expect(isOwnUserBubble({}, { accountId: 'guest', remoteDeviceId: guestView })).toBe(false);
    expect(isOwnUserBubble(
      { sharedAuthorName: 'Me', sharedAuthorAccountId: 'guest' },
      { accountId: 'guest', remoteDeviceId: guestView },
    )).toBe(true);
    expect(isOwnUserBubble(
      { sharedAuthorName: 'Other guest', sharedAuthorAccountId: 'other' },
      { accountId: 'guest', remoteDeviceId: guestView },
    )).toBe(false);
  });

  it('leaves attributed history without an account id untinted', () => {
    expect(isOwnUserBubble({ sharedAuthorName: 'Old' }, { accountId: 'owner', remoteDeviceId: ownerDevice })).toBe(false);
    expect(isOwnUserBubble({ sharedAuthorName: 'Old', sharedAuthorAccountId: 'x' }, { accountId: null })).toBe(false);
  });
});
