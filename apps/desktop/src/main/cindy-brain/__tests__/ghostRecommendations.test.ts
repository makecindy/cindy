import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../shared/ghost';
import { validateGhostManifest } from '../../../shared/ghost';
import { buildGhostRecommendationSnapshot } from '../ghostRecommendationSnapshot';

const state = vi.hoisted(() => ({
  owner: 'owner-a',
  buckets: new Map<string, Record<string, unknown>>(),
}));
vi.mock('../../appSessionState.js', () => ({ ownerScopedUserDataPath: () => state.owner }));
vi.mock('electron-store', () => ({
  default: class {
    constructor(private options: { cwd: string; defaults: Record<string, unknown> }) {
      if (!state.buckets.has(options.cwd))
        state.buckets.set(options.cwd, structuredClone(options.defaults));
    }
    get(key: string) {
      return state.buckets.get(this.options.cwd)?.[key];
    }
    set(key: string, value: unknown) {
      state.buckets.get(this.options.cwd)![key] = structuredClone(value);
    }
  },
}));
import {
  readGhostRecommendationEntries,
  replaceGhostRecommendations,
  markGhostRecommendationInstalled,
  consumeGhostRecommendationPriority,
  forgetGhostRecommendations,
} from '../ghostRecommendationStore';
const item = { id: 'one', label: 'Review email', prompt: 'Review email for me.' };
const ghost = {
  enabled: true,
  manifest: { id: 'example', recommendations: [item] },
} as unknown as InstalledGhost;
beforeEach(() => {
  state.owner = 'owner-a';
  state.buckets.set('owner-a', { entries: [] });
  state.buckets.set('owner-b', { entries: [] });
});
describe('plugin recommendation state', () => {
  it('replaces, withdraws, preserves install priority and isolates owners', () => {
    markGhostRecommendationInstalled('example');
    const installedAt = readGhostRecommendationEntries()[0].installedAt;
    expect(replaceGhostRecommendations('example', [item])).toEqual({ ok: true });
    expect(replaceGhostRecommendations('example', [])).toEqual({ ok: true });
    expect(readGhostRecommendationEntries()[0]).toEqual({ id: 'example', items: [], installedAt });
    expect(
      buildGhostRecommendationSnapshot(state.owner, [ghost], readGhostRecommendationEntries(), [])
        .sources[0].items,
    ).toEqual([]);
    state.owner = 'owner-b';
    expect(readGhostRecommendationEntries()).toEqual([]);
    state.owner = 'owner-a';
    expect(readGhostRecommendationEntries()[0].items).toEqual([]);
    consumeGhostRecommendationPriority('example');
    expect(
      buildGhostRecommendationSnapshot(state.owner, [ghost], readGhostRecommendationEntries(), [])
        .newlyInstalledId,
    ).toBeNull();
    forgetGhostRecommendations('example');
    expect(readGhostRecommendationEntries()).toEqual([]);
  });
  it('rejects invalid replacement without losing previous tasks', () => {
    replaceGhostRecommendations('example', [item]);
    expect(replaceGhostRecommendations('example', [{ ...item, pluginId: 'other' }]).ok).toBe(false);
    expect(readGhostRecommendationEntries()[0].items).toEqual([item]);
  });
  it('keeps no-field old plugins and uses only currently installed identities', () => {
    expect(
      buildGhostRecommendationSnapshot('a', [ghost], [], ['gone', 'example']).recentIds,
    ).toEqual(['example']);
    expect(
      buildGhostRecommendationSnapshot('a', [], [{ id: 'gone', installedAt: 1 }], [])
        .newlyInstalledId,
    ).toBeNull();
    const old = {
      schemaVersion: 2,
      id: 'old',
      name: 'Old',
      version: '1',
      entry: 'main.js',
      slots: [],
    };
    expect(validateGhostManifest(old).ok).toBe(true);
    const result = validateGhostManifest({ ...old, recommendations: [item] });
    expect(result.ok && result.manifest.recommendations).toEqual([item]);
  });
});
