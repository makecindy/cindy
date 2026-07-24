import { describe, expect, it } from 'vitest';
import { resolveModerationIdentity } from '../eligibility.js';

const base = {
  isPackaged: true,
  region: 'cn' as const,
  commandLineEnabled: false,
  membershipKind: 'personal' as const,
  membershipId: 'member-1',
  accessToken: 'access-token',
  identityEpoch: 7,
  productionSignBaseUrl: 'https://sign.example.com',
  testSignBaseUrl: 'https://test-sign.example.com',
};

describe('content moderation eligibility', () => {
  it('enables packaged cn personal users without consulting the dev switch', () => {
    expect(resolveModerationIdentity(base)).toMatchObject({
      environment: 'production',
      signBaseUrl: 'https://sign.example.com',
    });
  });

  it('bypasses org, logged-out, and packaged global users', () => {
    expect(resolveModerationIdentity({ ...base, membershipKind: 'org' })).toBeNull();
    expect(resolveModerationIdentity({ ...base, accessToken: null })).toBeNull();
    expect(resolveModerationIdentity({ ...base, region: 'global' })).toBeNull();
  });

  it('requires the switch and the separate test endpoint for every dev shape', () => {
    expect(resolveModerationIdentity({ ...base, isPackaged: false })).toBeNull();
    expect(resolveModerationIdentity({
      ...base,
      isPackaged: false,
      commandLineEnabled: true,
    })).toMatchObject({
      environment: 'test',
      signBaseUrl: 'https://test-sign.example.com',
    });
    expect(resolveModerationIdentity({
      ...base,
      region: 'dev',
      commandLineEnabled: true,
    })).toMatchObject({ environment: 'test' });
  });
});
