/**
 * Regression coverage for persisted Plugin recent-use ordering normalization.
 */

import { describe, expect, it } from 'vitest';

import { normalizeGhostRecentIds } from '../ghostRecentUsageStore';

describe('ghostRecentUsageStore', () => {
  it('keeps valid ids newest-first while removing invalid and duplicate values', () => {
    expect(
      normalizeGhostRecentIds([
        'cindy-github',
        '',
        'bad id',
        'xd-mivo',
        '_ns__acme__helper',
        'cindy-github',
        42,
      ]),
    ).toEqual(['cindy-github', 'xd-mivo', '_ns__acme__helper']);
  });

  it('bounds persisted history', () => {
    const ids = Array.from({ length: 120 }, (_, index) => `plugin-${index}`);
    expect(normalizeGhostRecentIds(ids)).toEqual(ids.slice(0, 100));
  });
});
