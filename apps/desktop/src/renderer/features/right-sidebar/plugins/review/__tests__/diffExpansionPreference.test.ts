import { beforeEach, describe, expect, it } from 'vitest';

import {
  getReviewDiffsExpanded,
  resetReviewDiffExpansionPreferencesForTests,
  seedReviewDiffsExpanded,
  setReviewDiffsExpanded,
} from '../diffExpansionPreference';

describe('review diff expansion preference', () => {
  beforeEach(() => {
    resetReviewDiffExpansionPreferencesForTests();
  });

  it('retains the first task state across review tab recreation until the user changes it', () => {
    seedReviewDiffsExpanded('session-a', false);
    seedReviewDiffsExpanded('session-a', true);
    expect(getReviewDiffsExpanded('session-a', true)).toBe(false);

    setReviewDiffsExpanded('session-a', true);
    expect(getReviewDiffsExpanded('session-a', false)).toBe(true);
  });

  it('keeps only the 20 most recently changed tasks', () => {
    for (let index = 0; index <= 20; index += 1) {
      setReviewDiffsExpanded(`session-${index}`, false);
    }

    expect(getReviewDiffsExpanded('session-0', true)).toBe(true);
    expect(getReviewDiffsExpanded('session-1', true)).toBe(false);
    expect(getReviewDiffsExpanded('session-20', true)).toBe(false);
  });
});
