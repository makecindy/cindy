// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyPluginAppearance } from '../usePluginAppearance';
import { normalizeAppearanceSettings } from '@/../shared/appearanceSettings';
import { applyFontSettings } from '@/hooks/useFontSettings';

/* C11: use the real renderer consumer, checking computed content styles and
 * stale font completion. Existing wallpaper/font tests do not exercise plugin
 * application acknowledgements. Tier: unit (DOM). */
afterEach(() => { document.head.querySelectorAll('[data-test-appearance]').forEach(node => node.remove()); document.body.replaceChildren();
  document.documentElement.removeAttribute('style'); delete document.documentElement.dataset.wallpaperActive; vi.unstubAllGlobals(); });
function options() {
  const style = document.createElement('style'); style.dataset.testAppearance = ''; document.head.appendChild(style);
  return { bridge: {} as typeof window.electronAPI.appearanceSettings, style, faces: new Map(), dark: () => false,
    current: () => true, applyFonts: applyFontSettings };
}
describe('plugin appearance renderer', () => {
  it('applies content values while leaving other page regions untouched', async () => {
    const content = document.createElement('div'); content.dataset.pluginAppearanceRegion = 'message'; content.dataset.pluginAppearanceSpeaker = 'user';
    const other = document.createElement('div'); document.body.append(content, other);
    const h = options(), settings = normalizeAppearanceSettings({ reading: { bodyLineHeight: 2 }, contentStyle: { messageRadius: 18, messagePadding: 10 },
      themeColors: { light: { userText: '#123456' } }, uiSize: 18 });
    expect(await applyPluginAppearance(settings, h)).toBe('applied');
    expect(getComputedStyle(content).borderRadius).toBe('18px'); expect(getComputedStyle(content).padding).toBe('10px');
    expect(getComputedStyle(content).getPropertyValue('--msg-user-text')).toBe('#123456');
    expect(getComputedStyle(other).borderRadius).not.toBe('18px');
    expect(document.documentElement.style.getPropertyValue('--app-ui-font-size')).toBe('18px');
  });
  it('does not claim a wallpaper was displayed before the existing wallpaper consumer applied it', async () => {
    const h = options(), url = `cindy-media://client-wallpaper/${'a'.repeat(64)}.webp`;
    const settings = normalizeAppearanceSettings({ wallpaperId: 'custom', customWallpaperUrl: url });
    expect(await applyPluginAppearance(settings, h)).toBe('saved');
    document.documentElement.style.setProperty('--app-wallpaper-image', `url("${url}")`);
    document.documentElement.style.setProperty('--app-wallpaper-veil', '63%');
    expect(await applyPluginAppearance(settings, h)).toBe('applied');
  });
  it('discards late font loads after the viewing generation changes', async () => {
    const h = options(); let resolve!: (value: { family: string; base64: string }) => void;
    h.bridge.loadPluginFont = () => new Promise(done => { resolve = done; });
    let current = true; h.current = () => current;
    const hash = 'b'.repeat(64), family = `CindyPlugin_${hash}`;
    const settings = normalizeAppearanceSettings({ uiFamily: family, uiFontResource: { family, hash, reference: 'asset:font', source: { instanceId: 'example', key: 'a'.repeat(64) } } });
    const pending = applyPluginAppearance(settings, h); current = false; resolve({ family, base64: '' });
    expect(await pending).toBe('saved'); expect(h.style.textContent).toBe(''); expect(h.faces.size).toBe(0);
  });
});
