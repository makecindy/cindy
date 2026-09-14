import { describe, expect, it } from 'vitest';

import { deriveAppCapabilities } from '../appCapabilities';
import { isLocalDbOwnerCurrent, legacyMigrationOwner } from '../appSessionPolicy';

describe('local app-session policy', () => {
  it('disables every Cindy account capability in local mode', () => {
    expect(deriveAppCapabilities('local')).toEqual({
      canUseCindyAccountServices: false,
      canUseCindyGateway: false,
      canUseDeviceLink: false,
      canUseSkillHubCloud: false,
      canUseCindyOAuthBroker: false,
      canUseCindyHeartbeat: false,
    });
  });

  it('fails closed while a cloud owner boundary is pending', () => {
    expect(deriveAppCapabilities('cloud', true).canUseCindyAccountServices).toBe(false);
    expect(deriveAppCapabilities('cloud', true).canUseCindyGateway).toBe(false);
    expect(deriveAppCapabilities('cloud', false).canUseCindyAccountServices).toBe(true);
  });

  it('rejects local DB work while the matching owner boundary is pending', () => {
    const state = { dataOwnerId: 'cloud-a' };
    expect(isLocalDbOwnerCurrent(state, 'cloud-a', false)).toBe(true);
    expect(isLocalDbOwnerCurrent(state, 'cloud-a', true)).toBe(false);
    expect(isLocalDbOwnerCurrent(state, 'cloud-b', false)).toBe(false);
  });

  it('never selects XDMaker migration for the local owner', () => {
    expect(legacyMigrationOwner({
      mode: 'local',
      dataOwnerId: 'local-v1',
      user: null,
    }, 'local-v1')).toBeNull();
  });

  it('selects migration only for a matching verified cloud owner', () => {
    expect(legacyMigrationOwner({
      mode: 'cloud',
      dataOwnerId: 'user-1',
      user: { id: 'user-1' },
    }, 'user-1')).toBe('user-1');
    expect(() => legacyMigrationOwner({
      mode: 'cloud',
      dataOwnerId: 'user-1',
      user: { id: 'user-2' },
    }, 'user-1')).toThrow(/authenticated membership/);
  });
});
