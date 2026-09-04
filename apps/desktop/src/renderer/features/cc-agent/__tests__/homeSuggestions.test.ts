import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HOME_SUGGESTION_BATCH_COUNT,
  HOME_SUGGESTION_BATCH_SIZE,
  HOME_SUGGESTION_IDS,
  homeSuggestionBatch,
  homeSuggestionLabelKey,
  homeSuggestionPromptKey,
  isHomeSuggestionsHidden,
  nextHomeSuggestionBatch,
  setHomeSuggestionsHidden,
} from '../homeSuggestions';

describe('homeSuggestions', () => {
  const memory = new Map<string, string>();

  beforeEach(() => {
    memory.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
      removeItem: (key: string) => {
        memory.delete(key);
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps three batches of four and cycles', () => {
    expect(HOME_SUGGESTION_IDS).toHaveLength(12);
    expect(HOME_SUGGESTION_BATCH_COUNT).toBe(3);
    expect(homeSuggestionBatch(0)).toEqual(HOME_SUGGESTION_IDS.slice(0, 4));
    expect(homeSuggestionBatch(1)).toEqual(HOME_SUGGESTION_IDS.slice(4, 8));
    expect(homeSuggestionBatch(2)).toEqual(HOME_SUGGESTION_IDS.slice(8, 12));
    expect(homeSuggestionBatch(3)).toEqual(homeSuggestionBatch(0));
    expect(nextHomeSuggestionBatch(2)).toBe(0);
    expect(HOME_SUGGESTION_BATCH_SIZE).toBe(4);
  });

  it('builds i18n keys for the visible line and the submitted prompt', () => {
    expect(homeSuggestionLabelKey('whySlow')).toBe('newChat.homeSuggestions.whySlow.label');
    expect(homeSuggestionPromptKey('whySlow')).toBe('newChat.homeSuggestions.whySlow.prompt');
  });

  it('persists dismiss without throwing', () => {
    expect(isHomeSuggestionsHidden()).toBe(false);
    setHomeSuggestionsHidden(true);
    expect(isHomeSuggestionsHidden()).toBe(true);
    setHomeSuggestionsHidden(false);
    expect(isHomeSuggestionsHidden()).toBe(false);
  });
});
