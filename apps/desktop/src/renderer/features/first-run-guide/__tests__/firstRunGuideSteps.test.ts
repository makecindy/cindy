/**
 * Rule: docs/product-rules/first-run-guide.md §3 — the guide shows only the steps that apply
 * to this person. Gap: the path selection is the product decision of the guide and had no
 * coverage. Tier: unit on the exported step rule (the window renders exactly this list).
 */
import { describe, expect, it } from 'vitest';

import { firstRunGuideSteps } from '../firstRunGuideStore';

const blank = { cloud: true, hadModel: false, hasLocalContent: false };
const auto = { manual: false, migration: false, legacyMigrated: false };

describe('firstRunGuideSteps', () => {
  it('introduces a new user to Cindy and leaves out steps with nothing to do', () => {
    expect(firstRunGuideSteps(auto, blank)).toEqual(['intro', 'models', 'finish']);
    // A new user is shown how models work here even when the official service is already on.
    expect(firstRunGuideSteps(auto, { cloud: true, hadModel: true, hasLocalContent: true }))
      .toEqual(['intro', 'models', 'import', 'finish']);
  });

  it('leads a returning user with migration or earlier-version data, without the introduction', () => {
    expect(firstRunGuideSteps({ ...auto, migration: true }, blank)).toEqual(['migration', 'models', 'finish']);
    expect(firstRunGuideSteps({ ...auto, legacyMigrated: true }, { ...blank, hadModel: true }))
      .toEqual(['legacy', 'finish']);
  });

  it('offers every step when opened by hand, except migration without an account', () => {
    const everything = { cloud: true, hadModel: true, hasLocalContent: false };
    expect(firstRunGuideSteps({ ...auto, manual: true }, everything))
      .toEqual(['intro', 'migration', 'models', 'import', 'finish']);
    expect(firstRunGuideSteps({ ...auto, manual: true }, { ...everything, cloud: false }))
      .toEqual(['intro', 'models', 'import', 'finish']);
  });
});
