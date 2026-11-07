import { describe, expect, it, vi } from 'vitest';

vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'owner-a',
}));

import {
  type PaletteSkillListCacheFacts,
  shouldCachePaletteSkillListing,
} from '../paletteSkillListCache.js';

const clean: PaletteSkillListCacheFacts = {
  preparationClean: true,
  scanClean: true,
  ownerStable: true,
  boundaryPending: false,
  readOnlyRemote: false,
};

describe('palette Skill listing cache eligibility', () => {
  it('caches a roster whose every step reported success', () => {
    expect(shouldCachePaletteSkillListing(clean)).toBe(true);
  });

  it('refuses a roster that any step could have left incomplete', () => {
    for (const fact of ['preparationClean', 'scanClean', 'ownerStable'] as const) {
      expect(shouldCachePaletteSkillListing({ ...clean, [fact]: false }), fact).toBe(false);
    }
    for (const fact of ['boundaryPending', 'readOnlyRemote'] as const) {
      expect(shouldCachePaletteSkillListing({ ...clean, [fact]: true }), fact).toBe(false);
    }
  });
});
