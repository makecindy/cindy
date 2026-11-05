import { describe, expect, it } from 'vitest';
import { parsePluginAppearancePatch } from './pluginAppearance.js';

/* C11: untrusted requests must not become CSS, local file access or undeclared
 * preference writes. Existing appearance settings tests cover trusted sliders,
 * not plugin input. Minimal input: one field/resource. Tier: unit. */
describe('plugin appearance input', () => {
  it('accepts bounded role values and owned resource references', () => {
    const patch = { uiFont: { size: 16, resource: 'asset:regular', weight: 500, style: 'normal' },
      appIcon: { resource: 'asset:client-icon' },
      wallpaper: { resource: 'library:images/wall.webp', visibility: 0.6, blur: 3 },
      theme: { light: { text: '#123456' }, dark: { text: '#eeeeee' } },
      reading: { bodyLineHeight: 1.8, maxWidth: 760 } };
    expect(parsePluginAppearancePatch(patch)).toEqual(patch);
  });
  it.each([
    { windowZoom: 2 }, { uiFont: { size: 100 } }, { uiFont: { family: 'x; color:red' } },
    { uiFont: { resource: 'file:///private/font.ttf' } },
    { wallpaper: { resource: 'https://example.test/wall.png' } },
    { wallpaper: { resource: 'library:../secret' } },
    { wallpaper: { resource: 'library:a\\b' } },
    { wallpaper: { fallbackResource: 'asset:still' } },
    { theme: { light: { 'login-title': '#ffffff' } } },
    { theme: { light: { text: 'url(https://example.test)' } } },
    { reading: { maxWidth: Number.POSITIVE_INFINITY } },
    { contentStyle: { position: 'fixed' } },
    { appIcon: {} }, { appIcon: { resource: 'https://example.test/icon.png' } },
    { appIcon: { resource: 'library:../icon.png' } },
    { appIcon: { resource: 'asset:client-icon', path: '/private/icon.png' } },
  ])('rejects values outside the public surface: %j', input => {
    expect(parsePluginAppearancePatch(input)).toBeNull();
  });
});
