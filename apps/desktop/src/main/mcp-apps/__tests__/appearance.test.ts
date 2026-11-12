import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { normalizeAppearanceSettings } from '../../../shared/appearanceSettings.js';
const h = vi.hoisted(() => ({
  wallpaper: { url: '', pluginSource: undefined as { instanceId: string; key: string } | undefined },
  settings: { wallpaperId: 'custom' } as Record<string, unknown>,
  serviceLoads: 0,
  readResource: vi.fn(), publish: vi.fn(),
}));
vi.mock('../../custom-wallpaper-settings.js', () => ({ customWallpaperStore: { read: () => h.wallpaper } }));
vi.mock('../../appearance-settings-store.js', () => ({
  readAppearanceSettings: () => ({ ...h.settings, customWallpaperUrl: h.wallpaper.url }),
  updateAppearanceSettingsAtomic: async (updater: (current: unknown, overrides: unknown) => object) => {
    h.settings = { ...normalizeAppearanceSettings({ ...h.settings, ...updater(normalizeAppearanceSettings(h.settings), h.settings) }) };
    return { ...h.settings, customWallpaperUrl: h.wallpaper.url };
  },
}));
vi.mock('../../appearance-settings-ipc.js', () => ({ publishAppearanceFromOwner: h.publish }));
vi.mock('../../cindy-brain/pluginAppearanceResources.js', () => ({ loadPluginAppearanceResource: h.readResource }));
vi.mock('../../cindy-brain/pluginAppearanceService.js', async original => {
  h.serviceLoads++;
  return original<typeof import('../../cindy-brain/pluginAppearanceService.js')>();
});
vi.mock('../../custom-wallpaper.js', () => ({
  savePluginWallpaper: vi.fn(),
  revokePluginWallpaper: async (current: (source: NonNullable<typeof h.wallpaper.pluginSource>) => boolean) => {
    if (!h.wallpaper.pluginSource || current(h.wallpaper.pluginSource)) return false;
    h.wallpaper = { url: '', pluginSource: undefined }; return true;
  },
}));
import { configurePluginAppearanceFiles, reconcilePluginAppearanceSources, releasePluginAppearance } from '../appearance.js';

// PR #9496: service lifetime differs from the pure service tests. Simulate one
// fresh Main process: no selected resource, then only a persisted plugin wallpaper,
// a pending registry boundary, and revocation. Real bridge/service, IO at boundaries.
// This module-initialization lifecycle needs its own file; tier: unit, no resetModules.
it('releases a wallpaper-only persisted selection without eager resource work during a cold start', async () => {
  const describe = vi.fn(), read = vi.fn();
  configurePluginAppearanceFiles({ describe, read });
  await reconcilePluginAppearanceSources(() => undefined, () => true);
  expect(h.publish).not.toHaveBeenCalled();
  // A selected theme font belongs to the common owner, not the plugin registry.
  // It must not eagerly load the plugin resource service on registry refresh.
  h.settings.uiFontResource = { source: { themeId: 'paper-light-local', packageSha256: 'a'.repeat(64) },
    reference: 'asset:font', hash: 'b'.repeat(64), family: `CindyTheme_${'b'.repeat(64)}` };
  await reconcilePluginAppearanceSources(() => undefined, () => true);
  expect(h.serviceLoads).toBe(0);
  delete h.settings.uiFontResource;
  const source = { owner: 'owner', fingerprint: 'approved', ghost: { dir: '/unused' },
    host: { capabilities: ['appearance'], appearance: { fields: ['wallpaper'] } }, config: { plugin: { assertCurrent() {} } } };
  h.wallpaper = { url: `cindy-media://client-wallpaper/${'b'.repeat(64)}.webp`,
    pluginSource: { instanceId: 'example', key: createHash('sha256').update('owner:approved').digest('hex') } };
  await reconcilePluginAppearanceSources(() => source, () => false);
  expect(h.wallpaper.url).not.toBe('');
  await reconcilePluginAppearanceSources(() => source, () => true);
  expect(h.wallpaper.url).not.toBe('');
  releasePluginAppearance('example');
  await vi.waitFor(() => expect(h.wallpaper.url).toBe(''), { timeout: 100 });
  expect(h.settings.wallpaperId).toBe('none');
  expect(h.readResource).not.toHaveBeenCalled(); expect(describe).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});
