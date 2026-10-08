import { describe, expect, it, vi } from 'vitest';

vi.mock('../../ownerScopedStorage.js', () => ({
  ownerScopedImUserDataPath: () => '/unused/dingtalk-bot-access.json',
}));

import { normalizeDingTalkAccess } from '../accessStore';

describe('normalizeDingTalkAccess', () => {
  it('defaults to off for missing or malformed values', () => {
    expect(normalizeDingTalkAccess(undefined)).toEqual({ guestFullAccess: false });
    expect(normalizeDingTalkAccess({ guestFullAccess: 'true' })).toEqual({ guestFullAccess: false });
    expect(normalizeDingTalkAccess({ guestFullAccess: 1 })).toEqual({ guestFullAccess: false });
  });

  it('only treats an explicit true as enabled', () => {
    expect(normalizeDingTalkAccess({ guestFullAccess: true })).toEqual({ guestFullAccess: true });
  });
});
