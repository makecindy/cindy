import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HOME_SUGGESTION_BATCH_SIZE,
  HOME_SUGGESTION_CATALOG,
  HOME_SUGGESTION_IDS,
  homeSuggestionLabelKey,
  homeSuggestionPromptKey,
  isHomeSuggestionsHidden,
  nextHomeSuggestionBatch,
  selectHomeSuggestionBatch,
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

  it('provides the reviewed 25 topics across eight broad categories', () => {
    expect(HOME_SUGGESTION_IDS).toHaveLength(25);
    expect(new Set(HOME_SUGGESTION_IDS).size).toBe(25);
    expect(new Set(HOME_SUGGESTION_CATALOG.map(({ category }) => category)).size).toBe(8);
    expect(HOME_SUGGESTION_BATCH_SIZE).toBe(4);
  });

  it.each([2, 4] as const)(
    'draws %i distinct visible categories without adjacent repeats or hidden-topic starvation',
    (size) => {
      for (const seed of [0, 1, 42, 2026]) {
        let value = seed;
        const random = () => {
          value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
          return value / 2 ** 32;
        };
        let state = nextHomeSuggestionBatch(null, size, random);
        const seen = new Set<string>();
        for (let index = 0; index < HOME_SUGGESTION_IDS.length; index++) {
          const visible = state.ids.slice(0, size);
          expect(visible).toHaveLength(size);
          const categories = visible.map(
            (id) => HOME_SUGGESTION_CATALOG.find((entry) => entry.id === id)!.category,
          );
          expect(new Set(categories).size).toBe(size);
          visible.forEach((id) => seen.add(id));
          const next = nextHomeSuggestionBatch(state, size, random);
          expect(next.ids.some((id) => visible.includes(id))).toBe(false);
          state = next;
        }
        expect(seen).toEqual(new Set(HOME_SUGGESTION_IDS));
      }
    },
  );

  it('randomizes fresh openings instead of using a fixed first batch', () => {
    const first = nextHomeSuggestionBatch(null, 4, () => 0);
    const another = nextHomeSuggestionBatch(null, 4, () => 0.999);
    expect(first.ids).not.toEqual(another.ids);
    expect(first.seenIds).toEqual([]);
  });

  it('counts only visible topics as seen on narrow screens', () => {
    const previous = nextHomeSuggestionBatch(null, 2, () => 0);
    const next = nextHomeSuggestionBatch(previous, 2, () => 0.999);
    expect(next.seenIds).toEqual(previous.ids.slice(0, 2));
  });

  it('remembers all four topics after shrinking a previously wide batch', () => {
    const previous = nextHomeSuggestionBatch(null, 4, () => 0);
    const next = nextHomeSuggestionBatch(previous, 2, () => 0);
    expect(next.seenIds).toEqual(previous.ids);
    expect(next.ids.some((id) => previous.ids.includes(id))).toBe(false);
    expect(next.displayedCount).toBe(2);
  });

  it('prioritizes the last unseen topic and resets history after all topics have been shown', () => {
    const previous = {
      ids: HOME_SUGGESTION_IDS.slice(0, 4),
      seenIds: HOME_SUGGESTION_IDS.filter((id) => id !== 'photoAlbumPage'),
      displayedCount: 4 as const,
    };
    expect(nextHomeSuggestionBatch(previous, 4, () => 0).ids[0]).toBe('photoAlbumPage');
    const reset = nextHomeSuggestionBatch(
      { ...previous, seenIds: [...HOME_SUGGESTION_IDS] },
      4,
      () => 0,
    );
    expect(reset.seenIds).toEqual([]);
    expect(reset.ids.some((id) => previous.ids.includes(id))).toBe(false);
  });

  it.each(['zh-CN', 'zh-TW', 'en', 'ja', 'ko'])(
    'has a complete localized title and prompt for every topic in %s',
    (locale) => {
      const resource = JSON.parse(
        readFileSync(
          new URL(`../../../i18n/locales/${locale}/common.json`, import.meta.url),
          'utf8',
        ),
      );
      const catalog = resource.newChat.homeSuggestions;
      expect(
        Object.keys(catalog)
          .filter((key) => !['shuffle', 'dismiss'].includes(key))
          .sort(),
      ).toEqual([...HOME_SUGGESTION_IDS].sort());
      for (const id of HOME_SUGGESTION_IDS) {
        expect(catalog[id].label.trim().length).toBeGreaterThan(0);
        expect(catalog[id].prompt.trim().length).toBeGreaterThan(0);
      }
      expect(catalog.stockDigest.prompt).toContain('2400.HK');
    },
  );

  it('applies category and plugin quotas independently', () => {
    const candidates = [
      { id: 'mail:inbox', category: 'email', pluginId: 'mail' },
      { id: 'mail:receipts', category: 'documents', pluginId: 'mail' },
      { id: 'other-mail:reply', category: 'email', pluginId: 'other-mail' },
      { id: 'summarize', category: 'documents' },
      { id: 'cleanup', category: 'computer' },
      { id: 'build', category: 'create' },
    ];
    expect(selectHomeSuggestionBatch(candidates).map(({ id }) => id)).toEqual([
      'mail:inbox',
      'summarize',
      'cleanup',
      'build',
    ]);
  });

  it.each([2, 4] as const)('counts a pinned new plugin against both quotas at size %i', (size) => {
    const candidates = [
      { id: 'old-mail:reply', category: 'email', pluginId: 'old-mail' },
      { id: 'new-mail:receipts', category: 'documents', pluginId: 'new-mail' },
      { id: 'summarize', category: 'documents' },
      { id: 'cleanup', category: 'computer' },
      { id: 'build', category: 'create' },
      { id: 'new-mail:inbox', category: 'email', pluginId: 'new-mail' },
    ];
    expect(
      selectHomeSuggestionBatch(candidates, { size, pinnedId: 'new-mail:inbox' }).map(
        ({ id }) => id,
      ),
    ).toEqual(['new-mail:inbox', 'summarize', 'cleanup', 'build'].slice(0, size));
  });

  it('applies the same quotas when filling a short batch from earlier suggestions', () => {
    expect(
      selectHomeSuggestionBatch([{ id: 'mail:inbox', category: 'email', pluginId: 'mail' }], {
        fallback: [
          { id: 'mail:receipts', category: 'documents', pluginId: 'mail' },
          { id: 'other-mail:reply', category: 'email', pluginId: 'other-mail' },
          { id: 'files:summarize', category: 'documents', pluginId: 'files' },
        ],
      }).map(({ id }) => id),
    ).toEqual(['mail:inbox', 'files:summarize']);
  });

  it('does not relax quotas to fill the batch when only one category is available', () => {
    const candidates = HOME_SUGGESTION_CATALOG.filter(({ category }) => category === 'computer');
    expect(selectHomeSuggestionBatch(candidates)).toEqual([candidates[0]]);
    expect(selectHomeSuggestionBatch([])).toEqual([]);
  });

  it('ignores withdrawn pins and does not mutate the ranked pool', () => {
    const candidates = Object.freeze([
      { id: 'cleanup', category: 'computer' },
      { id: 'build', category: 'create' },
    ]);
    expect(selectHomeSuggestionBatch(candidates, { pinnedId: 'removed' })).toEqual(candidates);
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
