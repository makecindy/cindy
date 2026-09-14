// @vitest-environment jsdom
/** 设置页布局缓存:仅保留高度,迁移时移除历史画面,保持 owner/版本隔离。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetGhostSettingsHeightCacheForTest,
  loadGhostSettingsHeight,
  pruneGhostSettingsHeights,
  saveGhostSettingsHeight,
} from '../ghostSettingsHeight';

const heightKey = 'ghostSettings.height.v1.owner-a:g1';
const legacyKey = 'ghostSettings.snapshot.v2.owner-a:g1';
const legacySnapshot = {
  height: 240,
  version: '1.0.0',
  dataUrl: 'data:image/png;base64,old-account-and-menu',
  width: 720,
  themeCss: ':root { --surface: #111; }',
};

beforeEach(() => {
  localStorage.clear();
  __resetGhostSettingsHeightCacheForTest();
});

afterEach(() => vi.restoreAllMocks());

describe('settings height cache', () => {
  it('persists only height and version and supports cold reads', () => {
    saveGhostSettingsHeight('owner-a', 'g1', '1.0.0', 240);
    expect(JSON.parse(localStorage.getItem(heightKey)!)).toEqual({ height: 240, version: '1.0.0' });
    __resetGhostSettingsHeightCacheForTest();
    expect(loadGhostSettingsHeight('owner-a', 'g1', '1.0.0')).toBe(240);
    expect(loadGhostSettingsHeight('owner-a', 'g1', '2.0.0')).toBeNull();
  });

  it('isolates owners and plugins without claiming unowned legacy data', () => {
    localStorage.setItem('ghostSettings.snapshot.g1', JSON.stringify(legacySnapshot));
    saveGhostSettingsHeight('owner-a', 'g1', '1.0.0', 240);
    saveGhostSettingsHeight('owner-a', 'g2', '1.0.0', 320);
    saveGhostSettingsHeight('owner-b', 'g1', '1.0.0', 432);
    expect(loadGhostSettingsHeight('owner-a', 'g1', '1.0.0')).toBe(240);
    expect(loadGhostSettingsHeight('owner-a', 'g2', '1.0.0')).toBe(320);
    expect(loadGhostSettingsHeight('owner-b', 'g1', '1.0.0')).toBe(432);
    expect(loadGhostSettingsHeight('owner-c', 'g1', '1.0.0')).toBeNull();
    expect(loadGhostSettingsHeight(null, 'g1', '1.0.0')).toBeNull();
    saveGhostSettingsHeight(null, 'g1', '1.0.0', 500);
    pruneGhostSettingsHeights(null, []);
    expect(localStorage.getItem('ghostSettings.snapshot.g1')).not.toBeNull();
    expect(loadGhostSettingsHeight('owner-a', 'g1', '1.0.0')).toBe(240);
  });

  it('migrates only layout fields and removes the obsolete bitmap', () => {
    localStorage.setItem(legacyKey, JSON.stringify(legacySnapshot));
    expect(loadGhostSettingsHeight('owner-a', 'g1', '1.0.0')).toBe(240);
    expect(localStorage.getItem(legacyKey)).toBeNull();
    expect(JSON.parse(localStorage.getItem(heightKey)!)).toEqual({ height: 240, version: '1.0.0' });
  });

  it('does not overwrite a newer height with legacy metadata', () => {
    localStorage.setItem(legacyKey, JSON.stringify(legacySnapshot));
    localStorage.setItem(heightKey, JSON.stringify({ height: 432, version: '2.0.0' }));
    expect(loadGhostSettingsHeight('owner-a', 'g1', '2.0.0')).toBe(432);
    expect(localStorage.getItem(legacyKey)).toBeNull();
  });

  it.each([
    '{oops',
    'null',
    '{"height":"240","version":"1.0.0"}',
    '{"height":-1,"version":"1.0.0"}',
  ])('ignores invalid metadata and clears corrupt old snapshots: %s', (raw) => {
    localStorage.setItem(heightKey, raw);
    localStorage.setItem(legacyKey, raw);
    expect(loadGhostSettingsHeight('owner-a', 'g1', '1.0.0')).toBeNull();
    expect(localStorage.getItem(legacyKey)).toBeNull();
  });

  it('clamps untrusted heights and ignores non-finite measurements', () => {
    saveGhostSettingsHeight('owner-a', 'g1', '1.0.0', 1);
    expect(loadGhostSettingsHeight('owner-a', 'g1', '1.0.0')).toBe(48);
    saveGhostSettingsHeight('owner-a', 'g1', '1.0.0', 10000);
    expect(loadGhostSettingsHeight('owner-a', 'g1', '1.0.0')).toBe(800);
    saveGhostSettingsHeight('owner-a', 'g1', '1.0.0', NaN);
    saveGhostSettingsHeight('owner-a', 'g1', '1.0.0', Infinity);
    expect(loadGhostSettingsHeight('owner-a', 'g1', '1.0.0')).toBe(800);
  });

  it('deduplicates unchanged measurements and retains memory when persistence fails', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    saveGhostSettingsHeight('owner-a', 'g1', '1.0.0', 432);
    saveGhostSettingsHeight('owner-a', 'g1', '1.0.0', 432);
    expect(write).toHaveBeenCalledTimes(1);
    expect(loadGhostSettingsHeight('owner-a', 'g1', '1.0.0')).toBe(432);
  });

  it('removes old screenshots even when migrating height cannot be persisted', () => {
    localStorage.setItem(legacyKey, JSON.stringify(legacySnapshot));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(loadGhostSettingsHeight('owner-a', 'g1', '1.0.0')).toBe(240);
    expect(localStorage.getItem(legacyKey)).toBeNull();
  });

  it('prunes only current-owner orphans and migrates installed plugins, including disabled ones', () => {
    const otherOwnerKey = 'ghostSettings.snapshot.v2.owner-a-extra:g1';
    localStorage.setItem(otherOwnerKey, JSON.stringify(legacySnapshot));
    localStorage.setItem(legacyKey, JSON.stringify(legacySnapshot));
    localStorage.setItem('ghostSettings.snapshot.v2.owner-a:old', JSON.stringify(legacySnapshot));
    saveGhostSettingsHeight('owner-a', 'orphan', '1.0.0', 432);
    saveGhostSettingsHeight('owner-b', 'orphan', '1.0.0', 500);

    pruneGhostSettingsHeights('owner-a', ['g1']);

    expect(localStorage.getItem(legacyKey)).toBeNull();
    expect(localStorage.getItem('ghostSettings.snapshot.v2.owner-a:old')).toBeNull();
    expect(localStorage.getItem('ghostSettings.height.v1.owner-a:orphan')).toBeNull();
    expect(loadGhostSettingsHeight('owner-a', 'g1', '1.0.0')).toBe(240);
    expect(loadGhostSettingsHeight('owner-a', 'orphan', '1.0.0')).toBeNull();
    expect(loadGhostSettingsHeight('owner-b', 'orphan', '1.0.0')).toBe(500);
    expect(localStorage.getItem(otherOwnerKey)).not.toBeNull();
  });

  it('uses the same encoded owner boundary for loading and pruning', () => {
    saveGhostSettingsHeight('owner:a/b', 'g1', '1.0.0', 432);
    __resetGhostSettingsHeightCacheForTest();
    expect(loadGhostSettingsHeight('owner:a/b', 'g1', '1.0.0')).toBe(432);
    pruneGhostSettingsHeights('owner:a', []);
    expect(loadGhostSettingsHeight('owner:a/b', 'g1', '1.0.0')).toBe(432);
    pruneGhostSettingsHeights('owner:a/b', []);
    expect(loadGhostSettingsHeight('owner:a/b', 'g1', '1.0.0')).toBeNull();
  });
});
