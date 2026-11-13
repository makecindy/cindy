import { expect, it, vi } from 'vitest';
import type { PluginFontResource } from '../../../shared/pluginAppearance.js';
import { normalizeAppearanceSettings } from '../../../shared/appearanceSettings.js';

const h = vi.hoisted(() => ({
  settings: { wallpaperId: 'none' } as Record<string, unknown>,
  readResource: vi.fn(), publish: vi.fn(),
}));
vi.mock('../../custom-wallpaper-settings.js', () => ({ customWallpaperStore: { read: () => ({}) } }));
vi.mock('../../appearance-settings-store.js', () => ({
  readAppearanceSettings: () => ({ ...h.settings }),
  updateAppearanceSettingsAtomic: async (updater: (current: unknown, overrides: unknown) => object) => {
    h.settings = { ...normalizeAppearanceSettings({ ...h.settings, ...updater(normalizeAppearanceSettings(h.settings), h.settings) }) };
    return { ...h.settings };
  },
}));
vi.mock('../../appearance-settings-ipc.js', () => ({ publishAppearanceFromOwner: h.publish }));
vi.mock('../../cindy-brain/pluginAppearanceResources.js', () => ({ loadPluginAppearanceResource: h.readResource }));
vi.mock('../../custom-wallpaper.js', () => ({ savePluginWallpaper: vi.fn(), revokePluginWallpaper: async () => false }));
import { configurePluginAppearanceFiles, reconcilePluginAppearanceSources } from '../appearance.js';

// Real Main bridge/service; PR #9496 / discussion_r4536355442: font-only
// persisted selections must be reconciled when the registry becomes ready.
// appearance.test.ts starts the singleton with wallpaper instead. A separate
// module-initialization lifecycle preserves that cold-start coverage without
// resetModules. Minimum input: one stale font source, no wallpaper. tier: unit.
it('clears stale font-only selections on cold startup without reading font files', async () => {
  const describe = vi.fn(), read = vi.fn();
  configurePluginAppearanceFiles({ describe, read });
  await reconcilePluginAppearanceSources(() => undefined, () => true);
  expect(h.publish).not.toHaveBeenCalled();

  const hash = 'a'.repeat(64);
  const font: PluginFontResource = { source: { instanceId: 'removed', key: 'b'.repeat(64) },
    reference: 'asset:font', hash, family: `CindyPlugin_${hash}` };
  Object.assign(h.settings, { uiFontResource: font, codeFontResource: font, bodyFontResource: font,
    uiFamily: font.family, codeFamily: font.family, uiFontTraits: { weight: 500 },
    bodyFont: { family: font.family, size: 18, style: 'italic' } });
  await reconcilePluginAppearanceSources(() => undefined, () => false);
  expect(h.settings.uiFontResource).toEqual(font);
  expect(h.publish).not.toHaveBeenCalled();

  await reconcilePluginAppearanceSources(() => undefined, () => true);
  expect(h.settings.uiFontResource).toBeUndefined();
  expect(h.settings.codeFontResource).toBeUndefined();
  expect(h.settings.bodyFontResource).toBeUndefined();
  expect(h.settings.uiFamily).toBe(''); expect(h.settings.codeFamily).toBe('');
  expect(h.settings.uiFontTraits).toEqual({ weight: 500 });
  expect(h.settings.bodyFont).toEqual({ size: 18, style: 'italic' });
  expect(h.publish).toHaveBeenCalledTimes(1);
  expect(h.readResource).not.toHaveBeenCalled(); expect(describe).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});
