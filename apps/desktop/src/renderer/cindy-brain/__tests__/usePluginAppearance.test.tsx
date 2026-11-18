// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyPluginAppearance, applyPluginAppearanceInWindow, usePluginAppearance } from '../usePluginAppearance';
import { normalizeAppearanceSettings } from '@/../shared/appearanceSettings';
import { applyFontSettings } from '@/hooks/useFontSettings';
import { installAppearancePresenter, presentTheme } from '@/appearance/AppearancePresenter';
const themeFailureNotice = vi.hoisted(() => vi.fn());
vi.mock('../../lib/toast', () => ({ toast: { error: themeFailureNotice } }));
vi.mock('../../i18n', () => ({ default: { t: (key: string) => key } }));

// Real preference consumer: scoped CSS, stale resource completion and no font/style
// work for the default profile. FontFace replaces only the browser font loader.
afterEach(() => {
  cleanup(); document.head.querySelectorAll('[data-test-appearance]').forEach(node => node.remove());
  document.body.replaceChildren(); document.documentElement.removeAttribute('style');
  delete document.documentElement.dataset.wallpaperActive; vi.unstubAllGlobals(); vi.restoreAllMocks();
  themeFailureNotice.mockClear();
});
function options() {
  const style = document.createElement('style'); style.dataset.testAppearance = ''; document.head.appendChild(style);
  return { bridge: {} as typeof window.electronAPI.appearanceSettings, style,
    faces: new Map<string, { key: string; face: FontFace }>(), pending: new Map(), dark: () => false,
    current: () => true, applyFonts: applyFontSettings };
}
describe('plugin appearance renderer', () => {
  // Unit: an async package failure that arrives after switching back must not
  // report the obsolete selection as the current theme's failure.
  it('discards a late package failure after returning to a builtin theme', async () => {
    let reject!: (error: Error) => void;
    const selectTheme = vi.fn().mockResolvedValue(normalizeAppearanceSettings({}));
    selectTheme.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    window.electronAPI = { appearanceSettings: { selectTheme } } as never;
    presentTheme({ id: 'late-local', name: 'Late', type: 'light', colors: {},
      packageSha256: 'a'.repeat(64), appearance: { density: 0.9 } });
    presentTheme({ id: 'default', name: 'Default', type: 'light', colors: {} });
    await act(async () => { reject(new Error('Old resource failed')); await vi.dynamicImportSettled(); });
    expect(themeFailureNotice).not.toHaveBeenCalled();
    expect(selectTheme).toHaveBeenLastCalledWith(null);
  });

  // Package-only startup contract, unit through the real presenter: restoration
  // failure logs without a toast; explicitly retrying that same family notifies.
  // Font decode tests below do not exercise selection rejection or readonly hosts.
  it('keeps cold package restore quiet and reports a rejected explicit reselection', async () => {
    const theme = { id: 'paper-light-local', family: 'paper', name: 'Paper', type: 'light' as const,
      colors: {}, packageSha256: 'a'.repeat(64), appearance: { density: 0.9 } };
    window.electronAPI = { appearanceSettings: { getSync: () => normalizeAppearanceSettings({}) } } as never;
    expect(() => presentTheme(theme, false)).not.toThrow(); // A read-only utility never prepares resources.
    const selectTheme = vi.fn().mockRejectedValue(new Error('Resource unavailable'));
    const logToMain = vi.fn();
    window.electronAPI = { appearanceSettings: { selectTheme }, logToMain } as never;
    presentTheme(theme, false);
    await act(async () => {});
    expect(logToMain).toHaveBeenCalledExactlyOnceWith('warn', 'renderer/appearance', expect.stringContaining('saved selection retained'));
    expect(themeFailureNotice).not.toHaveBeenCalled();
    presentTheme(theme);
    await waitFor(() => expect(themeFailureNotice).toHaveBeenCalledExactlyOnceWith('settings.appearance.themeApplyFailed'));
    expect(selectTheme.mock.calls).toEqual([
      [{ mode: 'light', familyId: 'paper-local' }], [{ mode: 'light', familyId: 'paper-local' }],
    ]);
    selectTheme.mockResolvedValue(normalizeAppearanceSettings({}));
    presentTheme({ id: 'default', name: 'Default', type: 'light', colors: {} });
    await act(async () => {});
  });

  // Unit, real shared consumer: one browser decode failure must not leave the
  // previous theme's CSS or prevent another valid font role from loading.
  it('falls back only the rejected theme font and still applies other roles and styles', async () => {
    const h = options(), bad = `CindyTheme_${'b'.repeat(64)}`, good = `CindyTheme_${'c'.repeat(64)}`;
    const fonts = { add: vi.fn(), delete: vi.fn() }, descriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
    vi.stubGlobal('FontFace', class {
      constructor(readonly family: string) {}
      load = async () => { if (this.family === bad) throw new Error('Font decode failed'); return this; };
    });
    h.bridge.loadPluginFont = vi.fn(async role => ({ family: role === 'uiFont' ? bad : good, bytes: new ArrayBuffer(4) }));
    const source = { themeId: 'theme', packageSha256: 'a'.repeat(64) };
    const message = document.createElement('div'); message.dataset.pluginAppearanceRegion = 'message'; document.body.append(message);
    h.style.textContent = ':root{--old-theme-style:1}';
    try {
      const settings = normalizeAppearanceSettings({ uiFamily: bad, terminalFamily: good, density: 0.9,
        reading: { bodyLineHeight: 1.9 }, contentStyle: { messagePadding: 16 },
        uiFontResource: { family: bad, hash: 'b'.repeat(64), reference: 'asset:ui', source },
        terminalFontResource: { family: good, hash: 'c'.repeat(64), reference: 'asset:terminal', source } });
      expect(await applyPluginAppearance(settings, h)).toBe('failed');
      expect(h.faces.get('terminalFont')?.face.family).toBe(good);
      expect(fonts.add).toHaveBeenCalledWith(h.faces.get('terminalFont')?.face);
      expect(getComputedStyle(message).lineHeight).toBe('1.9');
      expect(getComputedStyle(message).padding).toBe('16px');
      expect(h.style.textContent).not.toContain('--old-theme-style');
    } finally {
      if (descriptor) Object.defineProperty(document, 'fonts', descriptor);
      else Reflect.deleteProperty(document, 'fonts');
    }
  });

  // A structurally valid packaged font can still fail Chromium's final decode.
  // Real shared consumer: a failed replacement must release the old face so
  // the existing CSS fallback is reachable. Resource-read errors retain it. Unit.
  it('rejects a corrupt theme font face and reports the default-font fallback', async () => {
    const h = options(), hash = 'b'.repeat(64), family = `CindyTheme_${hash}`;
    const previousHash = 'c'.repeat(64), previousFamily = `CindyTheme_${previousHash}`;
    let loadedFamily = previousFamily;
    const fonts = { add: vi.fn(), delete: vi.fn() }, descriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
    vi.stubGlobal('FontFace', class {
      constructor(readonly family: string) {}
      load = async () => { if (this.family === family) throw new Error('Font decode failed'); return this; };
    });
    h.bridge.loadPluginFont = vi.fn(async () => ({ family: loadedFamily, bytes: new Uint8Array([0]).buffer }));
    const settings = normalizeAppearanceSettings({ uiFamily: family, uiFontResource: {
      family, hash, reference: 'asset:font', source: { themeId: 'paper-light-local', packageSha256: 'a'.repeat(64) },
    } });
    try {
      expect(await applyPluginAppearance(normalizeAppearanceSettings({ uiFamily: previousFamily, uiFontResource: {
        family: previousFamily, hash: previousHash, reference: 'asset:font', source: settings.uiFontResource!.source,
      } }), h)).toBe('applied');
      const previousFace = h.faces.get('uiFont')!.face;
      loadedFamily = family;
      vi.mocked(h.bridge.loadPluginFont!).mockRejectedValueOnce(new Error('Resource unavailable'));
      expect(await applyPluginAppearance(settings, h)).toBe('failed');
      await act(async () => {});
      expect(themeFailureNotice).not.toHaveBeenCalled();
      expect(h.faces.get('uiFont')!.face).toBe(previousFace); expect(fonts.delete).not.toHaveBeenCalled();
      expect(await applyPluginAppearance(settings, h)).toBe('failed');
      expect(fonts.add).toHaveBeenCalledExactlyOnceWith(previousFace); expect(h.faces.size).toBe(0);
      expect(fonts.delete).toHaveBeenCalledExactlyOnceWith(previousFace);
      await waitFor(() => expect(themeFailureNotice).toHaveBeenCalledExactlyOnceWith('settings.appearance.themeFontFailed'));
    } finally {
      if (descriptor) Object.defineProperty(document, 'fonts', descriptor);
      else Reflect.deleteProperty(document, 'fonts');
    }
  });
  // Opus F2：大字体逐字节 base64 解码阻塞 UI；原覆盖只验证字体加载次数。
  // 最小输入：含非 ASCII 字节的字体读取结果，观察 FontFace 收到原二进制。tier: unit。
  it('passes binary font bytes directly to the browser without base64 decoding', async () => {
    const h = options(), hash = 'b'.repeat(64), family = `CindyPlugin_${hash}`;
    const bytes = new Uint8Array([0, 1, 127, 255]).buffer, create = vi.fn();
    const decode = vi.spyOn(globalThis, 'atob');
    vi.stubGlobal('FontFace', class {
      constructor(...args: unknown[]) { create(...args); }
      load = async () => ({} as FontFace);
    });
    h.bridge.loadPluginFont = vi.fn(async () => ({ family, bytes }));
    const descriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', { configurable: true, value: { add: vi.fn(), delete: vi.fn() } });
    const settings = normalizeAppearanceSettings({ uiFamily: family,
      uiFontResource: { family, hash, reference: 'asset:font', source: { instanceId: 'example', key: 'a'.repeat(64) } } });
    try {
      expect(await applyPluginAppearance(settings, h)).toBe('applied');
      expect(create).toHaveBeenCalledWith(family, bytes);
      expect(decode).not.toHaveBeenCalled();
    } finally {
      if (descriptor) Object.defineProperty(document, 'fonts', descriptor);
      else Reflect.deleteProperty(document, 'fonts');
    }
  });
  it('applies light and dark content styles without changing unrelated page regions', async () => {
    const content = document.createElement('div'); content.dataset.pluginAppearanceRegion = 'message';
    const other = document.createElement('div'); document.body.append(content, other);
    const h = options(), settings = normalizeAppearanceSettings({ reading: { bodyLineHeight: 2 },
      contentStyle: { messageRadius: 18, messagePadding: 10 },
      themeColors: { light: { userText: '#123456' }, dark: { userText: '#abcdef' } }, uiSize: 18 });
    expect(await applyPluginAppearance(settings, h)).toBe('applied');
    expect(getComputedStyle(content).borderRadius).toBe('18px'); expect(getComputedStyle(content).padding).toBe('10px');
    expect(getComputedStyle(content).getPropertyValue('--msg-user-text')).toBe('#123456');
    h.dark = () => true; await applyPluginAppearance(settings, h);
    expect(getComputedStyle(content).getPropertyValue('--msg-user-text')).toBe('#abcdef');
    expect(getComputedStyle(other).borderRadius).not.toBe('18px');
    expect(document.documentElement.style.getPropertyValue('--app-ui-font-size')).toBe('18px');
  });
  it('reports a wallpaper as applied only after the existing wallpaper consumer displays it', async () => {
    const h = options(), url = `cindy-media://client-wallpaper/${'a'.repeat(64)}.webp`;
    const settings = normalizeAppearanceSettings({ wallpaperId: 'custom', customWallpaperUrl: url });
    expect(await applyPluginAppearance(settings, h)).toBe('saved');
    document.documentElement.style.setProperty('--app-wallpaper-image', `url("${url}")`);
    document.documentElement.style.setProperty('--app-wallpaper-veil', '63%');
    expect(await applyPluginAppearance(settings, h)).toBe('applied');
  });
  // Current PR: the hook's wallpaper-only shortcut bypassed the lower-level
  // application check. Exercise the public receipt with browser media state;
  // default preferences must still allocate no plugin resources. Tier: unit.
  it.each([
    ['pending image', 'webp', false, 'saved'],
    ['displayed image', 'webp', true, 'applied'],
    ['pending video', 'mp4', 0, 'saved'],
    ['failed video', 'mp4', 'error', 'failed'],
    ['ready video', 'mp4', 2, 'applied'],
  ] as const)('reports actual wallpaper-only state for %s without font or style work', async (_name, extension, ready, status) => {
    const url = `cindy-media://client-wallpaper/${'a'.repeat(64)}.${extension}`;
    const settings = normalizeAppearanceSettings({ wallpaperId: 'custom', customWallpaperUrl: url });
    document.documentElement.style.setProperty('--app-wallpaper-veil', '63%');
    if (extension === 'mp4') {
      const video = document.createElement('video'); video.src = url;
      Object.defineProperty(video, 'readyState', { value: typeof ready === 'number' ? ready : 2 });
      Object.defineProperty(video, 'error', { value: ready === 'error' ? { code: 4 } : null });
      document.body.append(video);
    } else if (ready) document.documentElement.style.setProperty('--app-wallpaper-image', `url("${url}")`);
    const loadPluginFont = vi.fn(), observe = vi.fn();
    vi.stubGlobal('MutationObserver', class { observe = observe; disconnect() {} });
    window.electronAPI = { appearanceSettings: { getSync: () => settings,
      onChanged: () => () => {}, loadPluginFont } } as unknown as typeof window.electronAPI;
    const hook = renderHook(() => usePluginAppearance(vi.fn()));
    try {
      await act(async () => {
        expect(await applyPluginAppearanceInWindow(settings)).toEqual({ status });
      });
      expect(document.querySelector('[data-cindy-appearance]')).toBeNull();
      expect(observe).not.toHaveBeenCalled(); expect(loadPluginFont).not.toHaveBeenCalled();
    } finally { hook.unmount(); }
  });
  it('discards a late font read after the viewing generation changes', async () => {
    const h = options(); let resolve!: (value: { family: string; bytes: ArrayBuffer }) => void;
    h.bridge.loadPluginFont = () => new Promise(done => { resolve = done; });
    let current = true; h.current = () => current;
    const hash = 'b'.repeat(64), family = `CindyPlugin_${hash}`;
    const settings = normalizeAppearanceSettings({ uiFamily: family,
      uiFontResource: { family, hash, reference: 'asset:font', source: { instanceId: 'example', key: 'a'.repeat(64) } } });
    const pending = applyPluginAppearance(settings, h); current = false; resolve({ family, bytes: new ArrayBuffer(0) });
    expect(await pending).toBe('saved'); expect(h.style.textContent).toBe(''); expect(h.faces.size).toBe(0);
  });
  it('reuses the loaded font across other appearance changes and releases it on reset', async () => {
    const h = options(), hash = 'b'.repeat(64), family = `CindyPlugin_${hash}`;
    const fonts = { add: vi.fn(), delete: vi.fn() };
    const descriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
    const load = vi.fn(async () => ({} as FontFace));
    vi.stubGlobal('FontFace', class { load = load; });
    h.bridge.loadPluginFont = vi.fn(async () => ({ family, bytes: new Uint8Array([0]).buffer }));
    try {
      const settings = normalizeAppearanceSettings({ uiFamily: family,
        uiFontResource: { family, hash, reference: 'asset:font', source: { instanceId: 'example', key: 'a'.repeat(64) } } });
      await applyPluginAppearance(settings, h);
      await applyPluginAppearance({ ...settings, contentStyle: { messageRadius: 12 } }, h);
      expect(h.bridge.loadPluginFont).toHaveBeenCalledTimes(1); expect(load).toHaveBeenCalledTimes(1);
      await applyPluginAppearance(normalizeAppearanceSettings({}), h);
      expect(fonts.delete).toHaveBeenCalledTimes(1); expect(h.faces.size).toBe(0);
    } finally {
      if (descriptor) Object.defineProperty(document, 'fonts', descriptor);
      else Reflect.deleteProperty(document, 'fonts');
    }
  });
  it('creates no style, observer or font request for default preferences', async () => {
    const loadPluginFont = vi.fn(), observe = vi.fn();
    vi.stubGlobal('MutationObserver', class { observe = observe; disconnect() {} });
    window.electronAPI = { appearanceSettings: { getSync: () => normalizeAppearanceSettings({}),
      onChanged: () => () => {}, loadPluginFont } } as unknown as typeof window.electronAPI;
    const applyFonts = vi.fn();
    const hook = renderHook(() => usePluginAppearance(applyFonts));
    await act(async () => {});
    expect(document.querySelector('[data-cindy-appearance]')).toBeNull();
    expect(observe).not.toHaveBeenCalled(); expect(loadPluginFont).not.toHaveBeenCalled();
    expect(applyFonts).not.toHaveBeenCalled(); hook.unmount();
  });
  // 本轮新字体消费者：已有缓存只覆盖加载完成后，连续样式更新会重复读取和解码同一字体。
  // 生产 hook + 原设置推送，字体在途时改变消息圆角；只替换浏览器字体加载器。tier: unit。
  it.each(['read', 'decode'])('shares an in-flight font %s across unrelated appearance updates', async phase => {
    const hash = 'b'.repeat(64), family = `CindyPlugin_${hash}`;
    const settings = normalizeAppearanceSettings({ uiFamily: family,
      uiFontResource: { family, hash, reference: 'asset:font', source: { instanceId: 'example', key: 'a'.repeat(64) } } });
    let publish!: (next: typeof settings) => void;
    let finishRead!: (value: { family: string; bytes: ArrayBuffer }) => void;
    const read = new Promise<{ family: string; bytes: ArrayBuffer }>(resolve => { finishRead = resolve; });
    let finishLoad!: () => void;
    const decoding = new Promise<FontFace>(resolve => { finishLoad = () => resolve({} as FontFace); });
    const loadPluginFont = vi.fn(() => read), load = vi.fn(() => decoding);
    vi.stubGlobal('FontFace', class { load = load; });
    const descriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
    const fonts = { add: vi.fn(), delete: vi.fn() };
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
    window.electronAPI = { appearanceSettings: { getSync: () => settings,
      onChanged: vi.fn(), loadPluginFont } } as unknown as typeof window.electronAPI;
    const applyFonts = vi.fn();
    try {
      const hook = renderHook(() => usePluginAppearance(applyFonts));
      publish = hook.result.current;
      if (phase === 'decode') await act(async () => finishRead({ family, bytes: new Uint8Array([0]).buffer }));
      await act(async () => {
        for (let messageRadius = 1; messageRadius <= 3; messageRadius++) publish({ ...settings, contentStyle: { messageRadius } });
      });
      expect(loadPluginFont).toHaveBeenCalledTimes(1);
      if (phase === 'read') await act(async () => finishRead({ family, bytes: new Uint8Array([0]).buffer }));
      await act(async () => finishLoad());
      expect(load).toHaveBeenCalledTimes(1); expect(fonts.add).toHaveBeenCalledTimes(1);
      expect(applyFonts).toHaveBeenLastCalledWith(expect.objectContaining({ contentStyle: { messageRadius: 3 } }));
      const fontApplications = applyFonts.mock.calls.length;
      await act(async () => publish({ ...settings, contentStyle: { messageRadius: 4 } }));
      expect(applyFonts).toHaveBeenCalledTimes(fontApplications);
      hook.unmount(); expect(fonts.delete).toHaveBeenCalledTimes(1);
    } finally {
      if (descriptor) Object.defineProperty(document, 'fonts', descriptor);
      else Reflect.deleteProperty(document, 'fonts');
    }
  });

  // Performance: theme class notifications may include unrelated classes. Only
  // a dark/light change may rewrite the extended CSS, once per change. Unit.
  it('does not rewrite extended CSS for unrelated or repeated class changes', async () => {
    const settings = normalizeAppearanceSettings({ density: 0.9 });
    window.electronAPI = { appearanceSettings: { getSync: () => settings,
      onChanged: () => () => {} } } as unknown as typeof window.electronAPI;
    document.documentElement.classList.remove('dark');
    const release = installAppearancePresenter(vi.fn());
    try {
      const style = document.querySelector<HTMLStyleElement>('[data-cindy-appearance]')!;
      const write = vi.spyOn(style, 'textContent', 'set');
      await act(async () => document.documentElement.classList.add('performance-probe'));
      expect(write).not.toHaveBeenCalled();
      await act(async () => document.documentElement.classList.add('dark'));
      expect(write).toHaveBeenCalledTimes(1);
      write.mockClear();
      await act(async () => document.documentElement.classList.add('performance-probe-2'));
      expect(write).not.toHaveBeenCalled();
    } finally {
      release();
      document.documentElement.classList.remove('dark', 'performance-probe', 'performance-probe-2');
    }
  });

  // Complete-theme contract: startup and React share one document presenter;
  // density/motion derive from foundation tokens and restore without compounding.
  // Unit, real installer + settings events, observing CSSOM and subscription lifecycle.
  it('shares one presenter and applies then restores density and motion', async () => {
    let current = normalizeAppearanceSettings({ density: 0.9, motion: 0.5 });
    let publish!: (settings: typeof current) => void;
    const unsubscribe = vi.fn(), subscribe = vi.fn((receive: typeof publish) => {
      publish = receive; return unsubscribe;
    });
    window.electronAPI = { appearanceSettings: { getSync: () => current, onChanged: subscribe } } as unknown as typeof window.electronAPI;
    const releaseStartup = installAppearancePresenter(applyFontSettings);
    const releaseReact = installAppearancePresenter(applyFontSettings);
    try {
      expect(subscribe).toHaveBeenCalledTimes(1);
      const style = () => document.querySelector<HTMLStyleElement>('[data-cindy-appearance]');
      const spacing = () => (style()?.sheet?.cssRules[0] as CSSStyleRule).style.getPropertyValue('--space-2');
      expect(spacing()).toBe('0.45rem');
      const motion = style()!.sheet!.cssRules[1] as CSSMediaRule;
      expect(motion.conditionText).toBe('(prefers-reduced-motion:no-preference)');
      expect((motion.cssRules[0] as CSSStyleRule).style.getPropertyValue('--motion-fast')).toBe('75ms');
      await act(async () => {
        current = normalizeAppearanceSettings({ density: 0.8, motion: 0 }); publish(current);
      });
      expect(spacing()).toBe('0.4rem');
      expect(document.documentElement.dataset.cindyReducedMotion).toBe('true');
      await act(async () => { current = normalizeAppearanceSettings({}); publish(current); });
      expect(style()).toBeNull();
      expect(document.documentElement.dataset.cindyReducedMotion).toBeUndefined();
      releaseStartup(); expect(unsubscribe).not.toHaveBeenCalled();
      releaseReact(); expect(unsubscribe).toHaveBeenCalledTimes(1);
    } finally { releaseStartup(); releaseReact(); }
  });
});
