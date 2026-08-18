import { describe, expect, it } from 'vitest';

import { isModelVisibilityLegacyOwnerClaim } from '../modelVisibility.js';

describe('model visibility legacy owner claim validation', () => {
  it('accepts a complete owner-stamped claim', () => {
    expect(isModelVisibilityLegacyOwnerClaim({
      dataOwnerId: 'owner-a',
      ownerGeneration: 1,
      canWriteOwnerScoped: true,
      claimed: true,
      claimedByOtherOwner: false,
      canInitialize: true,
    })).toBe(true);
  });

  it('rejects missing or malformed fields', () => {
    expect(isModelVisibilityLegacyOwnerClaim({
      dataOwnerId: 'owner-a',
      ownerGeneration: 1,
      claimedByOtherOwner: false,
      claimed: true,
      canInitialize: true,
    })).toBe(false);
    expect(isModelVisibilityLegacyOwnerClaim({
      dataOwnerId: 'owner-a',
      ownerGeneration: -1,
      canWriteOwnerScoped: true,
      claimed: false,
      claimedByOtherOwner: true,
      canInitialize: false,
    })).toBe(false);
  });
});
