import { describe, expect, it, vi } from 'vitest';

vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'owner-a',
}));

import {
  type PaletteSkillListCacheFacts,
  isPalettePreviewRead,
  paletteRosterReuseTtlMs,
  paletteSkillListReuseKey,
  shouldCachePaletteSkillListing,
} from '../paletteSkillListCache.js';

const clean: PaletteSkillListCacheFacts = {
  preparationClean: true,
  scanClean: true,
  scanComplete: true,
  ownerStable: true,
  boundaryPending: false,
  readOnlyRemote: false,
};

describe('palette Skill listing cache eligibility', () => {
  it('caches a roster whose every step reported success', () => {
    expect(shouldCachePaletteSkillListing(clean)).toBe(true);
  });

  it('refuses a roster that any step could have left incomplete', () => {
    for (const fact of ['preparationClean', 'scanClean', 'scanComplete', 'ownerStable'] as const) {
      expect(shouldCachePaletteSkillListing({ ...clean, [fact]: false }), fact).toBe(false);
    }
    for (const fact of ['boundaryPending', 'readOnlyRemote'] as const) {
      expect(shouldCachePaletteSkillListing({ ...clean, [fact]: true }), fact).toBe(false);
    }
  });
});

describe('palette Skill listing cache key', () => {
  const base = { agentKind: 'pi', workingDir: '/repo', sessionId: 's1' };

  it('separates rosters merged from different runtime catalogs', () => {
    expect(paletteSkillListReuseKey({ ...base, runtimeGeneration: 1 }))
      .not.toBe(paletteSkillListReuseKey({ ...base, runtimeGeneration: 2 }));
  });

  it('shares an entry while the catalog and the context are unchanged', () => {
    expect(paletteSkillListReuseKey({ ...base, runtimeGeneration: 2 }))
      .toBe(paletteSkillListReuseKey({ ...base, runtimeGeneration: 2 }));
    expect(paletteSkillListReuseKey({ ...base, runtimeGeneration: 2 }))
      .not.toBe(paletteSkillListReuseKey({ ...base, sessionId: 's2', runtimeGeneration: 2 }));
  });

  it('does not reuse a roster across a live runtime and no live runtime', () => {
    expect(paletteSkillListReuseKey({ ...base, runtimeGeneration: 2 }))
      .not.toBe(paletteSkillListReuseKey(base));
  });
});

describe('palette preview read', () => {
  it('lets a plain read reuse the warm package inspection', () => {
    expect(isPalettePreviewRead(undefined)).toBe(true);
    expect(isPalettePreviewRead(false)).toBe(true);
  });

  it('keeps a forced reload off the warm package inspection', () => {
    expect(isPalettePreviewRead(true)).toBe(false);
    expect(isPalettePreviewRead('true')).toBe(false);
  });
});

describe('palette roster reuse window', () => {
  it('keeps the full window when no warm inspection was merged', () => {
    expect(paletteRosterReuseTtlMs({ inspectionReuseMs: 60_000 })).toBeUndefined();
  });

  it('keeps the full window when the inspection was computed fresh', () => {
    expect(paletteRosterReuseTtlMs({
      inspectedAt: 60_000,
      inspectionReuseMs: 60_000,
      now: 60_001,
    })).toBe(30_000);
  });

  it('caps the window at the warm inspection remaining lifetime', () => {
    expect(paletteRosterReuseTtlMs({
      inspectedAt: 0,
      inspectionReuseMs: 60_000,
      now: 45_000,
    })).toBe(15_000);
  });

  it('reports zero once the warm inspection is past its window', () => {
    expect(paletteRosterReuseTtlMs({
      inspectedAt: 0,
      inspectionReuseMs: 60_000,
      now: 60_000,
    })).toBe(0);
  });
});
