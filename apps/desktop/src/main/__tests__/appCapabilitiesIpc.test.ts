import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  mode: 'local' as 'local' | 'cloud',
  boundaryPending: false,
  ownerStable: true,
}));

vi.mock('../appSessionState.js', () => ({
  getActiveAppSession: () => ({ mode: state.mode, dataOwnerId: 'owner-a', generation: 0 }),
  isAppSessionBoundaryPending: () => state.boundaryPending,
}));

vi.mock('../authBoundaryQuarantine.js', () => ({
  isGhostSkillProjectionBoundaryStableForOwner: () => state.ownerStable,
}));

import { requireAppCapability } from '../appCapabilities.js';

describe('requireAppCapability IPC errors', () => {
  beforeEach(() => {
    state.mode = 'local';
    state.boundaryPending = false;
    state.ownerStable = true;
  });

  it('encodes unavailable account capabilities as permission errors', () => {
    expect(() => requireAppCapability('canUseSkillHubCloud')).toThrow(/\[PERMISSION_DENIED\]/);
  });

  it('encodes owner-boundary failures as retryable precondition errors', () => {
    state.mode = 'cloud';
    state.boundaryPending = true;
    expect(() => requireAppCapability('canUseDeviceLink')).toThrow(/\[PRECONDITION_FAILED\]/);
  });

  it('keeps normal cloud capabilities available when only the Ghost projection owner differs', () => {
    state.mode = 'cloud';
    state.ownerStable = false;
    expect(() => requireAppCapability('canUseCindyAccountServices')).not.toThrow();
    expect(() => requireAppCapability('canUseCindyGateway')).not.toThrow();
    expect(() => requireAppCapability('canUseDeviceLink')).not.toThrow();
    expect(() => requireAppCapability('canUseSkillHubCloud')).not.toThrow();
    expect(() => requireAppCapability('canUseCindyOAuthBroker')).not.toThrow();
    expect(() => requireAppCapability('canUseCindyHeartbeat')).not.toThrow();
  });
});
