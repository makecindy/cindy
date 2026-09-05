import { describe, expect, it } from 'vitest';
import type { HomePluginRecommendationsSnapshot } from '../../../../shared/homePluginRecommendations';
import {
  buildHomeTaskCatalog,
  nextHomeTaskBatch,
  pluginSuggestionCategory,
  type HomeTaskBatch,
} from '../pluginHomeSuggestions';

const empty: HomePluginRecommendationsSnapshot = {
  ownerId: 'a',
  sources: [],
  recentIds: [],
  newlyInstalledId: null,
};
const task = { id: 'one', label: 'Review email', prompt: 'Review email' };
const t = (key: string) => key;
function random(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

describe('host plugin recommendation selection', () => {
  it('includes curated installation tasks and respects an explicit empty author catalog', () => {
    expect(buildHomeTaskCatalog(empty, 'en', t).filter((x) => x.needsInstall)).toHaveLength(3);
    const snapshot = {
      ...empty,
      sources: [{ ghostId: 'google-gmail', name: 'Gmail', enabled: true, items: [] }],
    };
    expect(buildHomeTaskCatalog(snapshot, 'en', t)).toHaveLength(25);
    expect(buildHomeTaskCatalog({ ...empty, ownerId: null }, 'en', t)).toHaveLength(25);
    expect(buildHomeTaskCatalog(empty, 'en', t, false)).toHaveLength(25);
  });
  it('uses broad host categories across publishers', () => {
    expect(pluginSuggestionCategory(task)).toBe('email');
    expect(pluginSuggestionCategory({ ...task, label: '整理邮件' })).toBe('email');
    expect(
      pluginSuggestionCategory({ ...task, label: 'Unknown workflow', prompt: 'Help me' }),
    ).toBe('pluginTasks');
    expect(
      pluginSuggestionCategory({ ...task, label: '审查未提交改动', prompt: 'Review my changes' }),
    ).toBe('development');
  });
  it('pins a new install and never doubles a category or a plugin, including fallback', () => {
    const snapshot = {
      ...empty,
      newlyInstalledId: 'new-mail',
      sources: [
        { ghostId: 'new-mail', name: 'New', enabled: true, items: [task] },
        { ghostId: 'other-mail', name: 'Other', enabled: true, items: [task] },
      ],
    };
    const catalog = buildHomeTaskCatalog(snapshot, 'en', t);
    let batch: HomeTaskBatch | null = null;
    const rng = random(123);
    for (let i = 0; i < 40; i++) {
      batch = nextHomeTaskBatch(catalog, snapshot, batch, 4, rng);
      expect(batch.items[0].pluginId).toBe('new-mail');
      expect(new Set(batch.items.map((x) => x.category)).size).toBe(4);
      const plugins = batch.items.flatMap((x) => (x.pluginId ? [x.pluginId] : []));
      expect(new Set(plugins).size).toBe(plugins.length);
      expect(batch.items.filter((x) => x.needsInstall).length).toBeLessThanOrEqual(1);
      expect(batch.items.some((x) => x.builtinId)).toBe(true);
    }
  });
  it('does not multiply source tickets when a plugin contributes more tasks', () => {
    const count = (many: boolean) => {
      const sources = ['one', 'two'].map((ghostId) => ({
        ghostId,
        name: ghostId,
        enabled: true,
        items: Array.from({ length: many && ghostId === 'one' ? 24 : 1 }, (_, i) => ({
          ...task,
          id: `task-${i}`,
        })),
      }));
      const snapshot = { ...empty, sources };
      const catalog = buildHomeTaskCatalog(snapshot, 'en', t);
      const counts = { one: 0, two: 0 };
      const rng = random(2026);
      for (let i = 0; i < 1200; i++)
        for (const item of nextHomeTaskBatch(catalog, snapshot, null, 4, rng).items)
          if (item.pluginId === 'one' || item.pluginId === 'two') counts[item.pluginId]++;
      return counts;
    };
    const counts = count(true);
    expect(Math.abs(counts.one - counts.two)).toBeLessThan(100);
    expect(counts.one).toBeGreaterThan(100);
  });
  it('filters withdrawn ids and keeps unseen/adjacent rules for ordinary batches', () => {
    const snapshot = {
      ...empty,
      sources: [
        { ghostId: 'work', name: 'Work', enabled: true, items: [task, { ...task, id: 'two' }] },
      ],
    };
    const catalog = buildHomeTaskCatalog(snapshot, 'en', t);
    const rng = random(21);
    let batch: HomeTaskBatch | null = null;
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const next = nextHomeTaskBatch(catalog, snapshot, batch, 4, rng);
      expect(next.items.some((x) => batch?.items.some((y) => x.id === y.id))).toBe(false);
      next.items.forEach((x) => seen.add(x.id));
      batch = next;
    }
    expect(seen.size).toBe(catalog.length);
    const next = nextHomeTaskBatch(
      catalog.filter((x) => !x.pluginId),
      empty,
      batch,
      4,
      rng,
    );
    expect(next.items.every((x) => !x.pluginId)).toBe(true);
  });
});
