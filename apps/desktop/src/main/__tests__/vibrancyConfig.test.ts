import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vibrancyConfig 走 main 统一 logger(规则 12:禁止裸 console),测试对 logger.warn 断言。
// vi.hoisted 让 warnSpy 在 vi.mock 提升后仍可用(否则模块工厂里引用会命中 TDZ)。
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
  }),
}));

import type { BrowserWindow } from 'electron';
import {
  fitMacBackdropToWindow,
  fitWindowsBackdropToWindow,
  isMacTransparentWindow,
  isWindowsTransparentWindow,
  markMacTransparentWindow,
  markWindowsTransparentWindow,
  needsMacTransparentWindow,
  needsWindowsTransparentWindow,
  resolveMacWindowTransparent,
  resolveVibrancyConfig,
  resolveWindowVibrancyConfig,
  resolveWindowsWindowTransparent,
  setWindowWallpaperCovered,
  setWindowDesktopBlur,
} from '../vibrancyConfig';

const MATERIAL_VALUES = [
  'sidebar',
  'hud',
  'under-window',
  'fullscreen-ui',
  'popover',
  'menu',
  'none',
] as const;

describe('E4D resolveVibrancyConfig(familyId→vibrancy/backgroundColor 映射)', () => {
  // Regression: an opaque in-app wallpaper used to leave the hidden native backdrop running.
  it.each(['darwin', 'win32', 'linux'])(
    'wallpaper coverage disables native material on %s',
    (platform) => {
      for (const isDark of [false, true]) {
        const config = resolveVibrancyConfig('cindy', isDark, platform, {
          getSystemVersion: () => '10.0.22631',
          wallpaperCovered: true,
        });
        expect(config.vibrancy).toBeNull();
        expect(config.backgroundColor).toBe(isDark ? '#1f1f1e' : '#f8f8f6');
        if (platform === 'win32') expect(config.backgroundMaterial).toBe('none');
      }
    },
  );

  beforeEach(() => {
    delete process.env.XDT_VIBRANCY_MATERIAL;
    delete process.env.XDT_BACKDROP_MATERIAL;
  });

  it.each(['darwin', 'win32'])(
    'restores %s material per window without cross-window coverage leaks',
    (platform) => {
      const coveredWindow = {} as BrowserWindow;
      const loadingWindow = {} as BrowserWindow;
      const options = { getSystemVersion: () => '10.0.22631' };
      setWindowWallpaperCovered(coveredWindow, true);
      for (const isDark of [false, true]) {
        expect(
          resolveWindowVibrancyConfig(coveredWindow, 'cindy', isDark, platform, options),
        ).toEqual(resolveVibrancyConfig('default', isDark, platform, options));
        expect(
          resolveWindowVibrancyConfig(loadingWindow, 'cindy', isDark, platform, options),
        ).toEqual(resolveVibrancyConfig('cindy', isDark, platform, options));
      }
      setWindowWallpaperCovered(coveredWindow, false);
      expect(resolveWindowVibrancyConfig(coveredWindow, 'cindy', true, platform, options)).toEqual(
        resolveVibrancyConfig('cindy', true, platform, options),
      );
    },
  );

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.XDT_VIBRANCY_MATERIAL;
    delete process.env.XDT_BACKDROP_MATERIAL;
  });

  it('darwin × CINDY × 未设旋钮:缺省材质 = hud(用户定稿回写 2026-07-19)', () => {
    expect(resolveVibrancyConfig('cindy', false, 'darwin')).toEqual({
      vibrancy: 'hud',
      backgroundColor: '#00000000',
    });
  });

  it('darwin × CINDY × vibrancy 材质旋钮:保持原 macOS 映射', () => {
    for (const material of MATERIAL_VALUES) {
      process.env.XDT_VIBRANCY_MATERIAL = material;
      expect(resolveVibrancyConfig('cindy', false, 'darwin')).toEqual({
        vibrancy: material === 'none' ? null : material,
        backgroundColor: '#00000000',
      });
      expect(resolveVibrancyConfig('cindy', true, 'darwin')).toEqual({
        vibrancy: material === 'none' ? null : material,
        backgroundColor: '#00000000',
      });
    }
  });

  it('darwin × 非 CINDY × vibrancy 材质旋钮:保持原 macOS 不透明回退', () => {
    for (const material of MATERIAL_VALUES) {
      process.env.XDT_VIBRANCY_MATERIAL = material;
      expect(resolveVibrancyConfig('default', false, 'darwin')).toEqual({
        vibrancy: null,
        backgroundColor: '#f8f8f6',
      });
      expect(resolveVibrancyConfig('atom-one', true, 'darwin')).toEqual({
        vibrancy: null,
        backgroundColor: '#1f1f1e',
      });
    }
  });

  it('win32 × Win11 × CINDY:默认 acrylic + 浅色侧栏 backing', () => {
    expect(
      resolveVibrancyConfig('cindy', false, 'win32', {
        getSystemVersion: () => '10.0.22631',
      }),
    ).toEqual({
      vibrancy: null,
      backgroundColor: 'rgba(238, 238, 233, 0.85)',
      backgroundMaterial: 'acrylic',
    });
  });

  it('win32 × Win11 × CINDY:深色 acrylic 使用深色侧栏 backing', () => {
    expect(
      resolveVibrancyConfig('cindy', true, 'win32', {
        getSystemVersion: () => '10.0.22631',
      }),
    ).toEqual({
      vibrancy: null,
      backgroundColor: 'rgba(5, 5, 5, 0.85)',
      backgroundMaterial: 'acrylic',
    });
  });

  it('win32 × Win11 × CINDY:支持 mica 材质旋钮', () => {
    process.env.XDT_BACKDROP_MATERIAL = 'mica';
    expect(
      resolveVibrancyConfig('cindy', true, 'win32', {
        getSystemVersion: () => '10.0.22631.2861',
      }),
    ).toEqual({
      vibrancy: null,
      backgroundColor: '#00000000',
      backgroundMaterial: 'mica',
    });
  });

  it('win32 × Win11 × CINDY:支持 none 材质旋钮', () => {
    process.env.XDT_BACKDROP_MATERIAL = 'none';
    expect(
      resolveVibrancyConfig('cindy', false, 'win32', {
        getSystemVersion: () => '10.0.22621',
      }),
    ).toEqual({
      vibrancy: null,
      backgroundColor: '#00000000',
      backgroundMaterial: 'none',
    });
  });

  it('win32 × Win11 × CINDY:非法材质 warn 后回落 acrylic', () => {
    warnSpy.mockClear();
    process.env.XDT_BACKDROP_MATERIAL = 'glass';
    expect(
      resolveVibrancyConfig('cindy', true, 'win32', {
        getSystemVersion: () => '10.0.22631',
      }),
    ).toEqual({
      vibrancy: null,
      backgroundColor: 'rgba(5, 5, 5, 0.85)',
      backgroundMaterial: 'acrylic',
    });
    // 走统一 logger.warn,不再是裸 console.warn;文案不再带 [main] 前缀(scope 由 logger 注入)
    expect(warnSpy).toHaveBeenCalledWith(
      "Invalid XDT_BACKDROP_MATERIAL 'glass', falling back to acrylic.",
    );
  });

  it('win32 × Win10:回退不透明 surface', () => {
    process.env.XDT_BACKDROP_MATERIAL = 'mica';
    expect(
      resolveVibrancyConfig('cindy', false, 'win32', {
        getSystemVersion: () => '10.0.19045',
      }),
    ).toEqual({
      vibrancy: null,
      backgroundColor: '#f8f8f6',
      backgroundMaterial: 'none',
    });
    // Windows 11 21H2 has no Electron system backdrop: keep the opaque surface instead
    // of a translucent Acrylic backing without its material.
    expect(
      resolveVibrancyConfig('cindy', false, 'win32', {
        getSystemVersion: () => '10.0.22000',
      }),
    ).toEqual({
      vibrancy: null,
      backgroundColor: '#f8f8f6',
      backgroundMaterial: 'none',
    });
  });

  it('win32 × 非 CINDY:回退不透明 surface', () => {
    process.env.XDT_BACKDROP_MATERIAL = 'mica';
    expect(
      resolveVibrancyConfig('default', true, 'win32', {
        getSystemVersion: () => '10.0.22631',
      }),
    ).toEqual({
      vibrancy: null,
      backgroundColor: '#1f1f1e',
      backgroundMaterial: 'none',
    });
  });

  it('win32 × 版本读取异常/解析失败:回退不透明 surface', () => {
    expect(
      resolveVibrancyConfig('cindy', false, 'win32', {
        getSystemVersion: () => {
          throw new Error('boom');
        },
      }),
    ).toEqual({
      vibrancy: null,
      backgroundColor: '#f8f8f6',
      backgroundMaterial: 'none',
    });
    expect(
      resolveVibrancyConfig('cindy', true, 'win32', {
        getSystemVersion: () => 'Windows 11',
      }),
    ).toEqual({
      vibrancy: null,
      backgroundColor: '#1f1f1e',
      backgroundMaterial: 'none',
    });
  });

  it('linux:维持不透明 surface 且不读取 backgroundMaterial 旋钮', () => {
    process.env.XDT_BACKDROP_MATERIAL = 'mica';
    expect(resolveVibrancyConfig('cindy', false, 'linux')).toEqual({
      vibrancy: null,
      backgroundColor: '#f8f8f6',
    });
  });
});

// User decision 2026-11-08: None exposes the desktop for every theme. Existing
// coverage tests only exercise theme defaults. Unit: clear -> blur -> artwork -> clear.
it('keeps desktop blur per window and restores it after removing artwork', () => {
  const win = {} as BrowserWindow;
  const other = {} as BrowserWindow;
  setWindowDesktopBlur(win, 0);
  expect(resolveWindowVibrancyConfig(win, 'default', false, 'darwin')).toMatchObject({
    vibrancy: null, backgroundColor: '#00000000',
  });
  setWindowDesktopBlur(win, 7);
  expect(resolveWindowVibrancyConfig(win, 'default', true, 'darwin').desktopBlurRadius).toBe(7);
  expect(resolveWindowVibrancyConfig(win, 'default', true, 'darwin').vibrancy).toBe('under-window');
  expect(resolveWindowVibrancyConfig(other, 'default', true, 'darwin').vibrancy).toBeNull();
  setWindowWallpaperCovered(win, true);
  expect(resolveWindowVibrancyConfig(win, 'default', true, 'darwin').backgroundColor).toBe('#1f1f1e');
  setWindowWallpaperCovered(win, false);
  expect(resolveWindowVibrancyConfig(win, 'default', true, 'darwin').vibrancy).toBe('under-window');
  expect(resolveWindowVibrancyConfig(win, 'default', false, 'win32', {
    getSystemVersion: () => '10.0.22631',
  }).backgroundMaterial).toBe('acrylic');
  setWindowDesktopBlur(win, null);
  expect(resolveWindowVibrancyConfig(win, 'default', true, 'darwin').backgroundColor).toBe('#1f1f1e');
});

// Regression (2026-11-11, Windows 11 build 26200): the main window was created transparent and
// carried Acrylic. Each time any desktop window was shown or hidden, DWM stopped drawing what was
// behind it for a few frames and the sidebar flashed to a flat dark fill. Earlier tests only
// covered the material and backing, never which kind of window carries them.
describe('Windows transparent window vs system backdrop', () => {
  const win11 = { getSystemVersion: () => '10.0.22631' };
  const win10 = { getSystemVersion: () => '10.0.19045' };
  const acrylic = resolveVibrancyConfig('cindy', true, 'win32', win11);
  const clearDesktop = resolveVibrancyConfig('cindy', true, 'win32', { ...win11, desktopBlur: 0 });
  const blurredDesktop = resolveVibrancyConfig('cindy', true, 'win32', { ...win11, desktopBlur: 8 });
  const opaque = resolveVibrancyConfig('eclipse', true, 'win32', win11);

  it('only a clear desktop needs a transparent window', () => {
    expect(needsWindowsTransparentWindow(acrylic)).toBe(false);
    expect(needsWindowsTransparentWindow(blurredDesktop)).toBe(false);
    expect(needsWindowsTransparentWindow(opaque)).toBe(false);
    expect(needsWindowsTransparentWindow(clearDesktop)).toBe(true);
  });

  it('creates a regular window whenever a system backdrop is shown', () => {
    expect(resolveWindowsWindowTransparent(acrylic, undefined)).toBe(false);
    expect(resolveWindowsWindowTransparent(acrylic, false)).toBe(false);
    expect(resolveWindowsWindowTransparent(opaque, undefined)).toBe(false);
  });

  it('creates a transparent window when the last session needed a clear desktop', () => {
    expect(resolveWindowsWindowTransparent(acrylic, true)).toBe(true);
    expect(resolveWindowsWindowTransparent(clearDesktop, undefined)).toBe(true);
  });

  it('keeps a regular window frosted when a clear desktop is requested mid-session', () => {
    expect(fitWindowsBackdropToWindow(clearDesktop, false, true, win11)).toEqual({
      ...clearDesktop,
      backgroundMaterial: 'acrylic',
    });
    expect(fitWindowsBackdropToWindow(clearDesktop, true, true, win11)).toBe(clearDesktop);
    expect(fitWindowsBackdropToWindow(acrylic, false, true, win11)).toBe(acrylic);
    expect(fitWindowsBackdropToWindow(opaque, false, true, win11)).toBe(opaque);
  });

  // Regression (2026-11-26, Windows 10 build 19045 + Komorebi 0.1.41): every Windows 10 window
  // was created transparent, which strips WS_CAPTION / WS_THICKFRAME (style 0x14030000), so the
  // tiling manager ignored Cindy. Earlier tests asserted that always-transparent behaviour.
  describe('without a system backdrop (Windows 10)', () => {
    const win10Default = resolveVibrancyConfig('cindy', true, 'win32', win10);
    const win10Clear = resolveVibrancyConfig('cindy', false, 'win32', { ...win10, desktopBlur: 0 });
    const win10BlurRequested = resolveVibrancyConfig('cindy', true, 'win32', {
      ...win10,
      desktopBlur: 8,
    });

    it('creates a regular window unless a clear desktop is needed', () => {
      expect(win10Default).toMatchObject({ backgroundMaterial: 'none', backgroundColor: '#1f1f1e' });
      expect(resolveWindowsWindowTransparent(win10Default, undefined)).toBe(false);
      expect(resolveWindowsWindowTransparent(win10Default, false)).toBe(false);
      expect(resolveWindowsWindowTransparent(win10Default, true)).toBe(true);
      // Desktop blur is unavailable here, so any desktop transparency is a clear desktop.
      expect(needsWindowsTransparentWindow(win10BlurRequested)).toBe(true);
      expect(resolveWindowsWindowTransparent(win10Clear, undefined)).toBe(true);
    });

    it('keeps a regular window opaque when a clear desktop is requested mid-session', () => {
      expect(fitWindowsBackdropToWindow(win10Clear, false, false, win10)).toEqual({
        ...win10Clear,
        backgroundColor: '#f8f8f6',
      });
      expect(fitWindowsBackdropToWindow(win10BlurRequested, false, true, win10)).toEqual({
        ...win10BlurRequested,
        backgroundColor: '#1f1f1e',
      });
      expect(fitWindowsBackdropToWindow(win10Clear, true, false, win10)).toBe(win10Clear);
      expect(fitWindowsBackdropToWindow(win10Default, false, true, win10)).toBe(win10Default);
    });
  });

  it('remembers which windows were created transparent', () => {
    const transparent = {} as BrowserWindow;
    const regular = {} as BrowserWindow;
    markWindowsTransparentWindow(transparent);
    expect(isWindowsTransparentWindow(transparent)).toBe(true);
    expect(isWindowsTransparentWindow(regular)).toBe(false);
  });
});

// Regression (#11670, macOS 27.2.1 + 4K HiDPI): creating every macOS BrowserWindow with
// `transparent: true` forced NSWindow.backgroundColor to clearColor, causing ~7-10x higher
// WindowServer GPU usage even for default CINDY vibrancy and opaque themes. Earlier tests only
// covered vibrancyConfig outputs and Windows window transparency, never macOS window creation
// or mid-session desktop-blur fallback on a regular window.
describe('macOS transparent window vs system vibrancy (#11670)', () => {
  const hud = resolveVibrancyConfig('cindy', true, 'darwin');
  const opaque = resolveVibrancyConfig('eclipse', true, 'darwin');
  const wallpaper = resolveVibrancyConfig('cindy', true, 'darwin', { wallpaperCovered: true });
  const clearDesktop = resolveVibrancyConfig('cindy', true, 'darwin', { desktopBlur: 0 });
  const blurredDesktop = resolveVibrancyConfig('cindy', true, 'darwin', { desktopBlur: 8 });

  it('only custom desktop-blur or unblurred see-through modes need a transparent window', () => {
    expect(needsMacTransparentWindow(hud)).toBe(false);
    expect(needsMacTransparentWindow(opaque)).toBe(false);
    expect(needsMacTransparentWindow(wallpaper)).toBe(false);
    expect(needsMacTransparentWindow(clearDesktop)).toBe(true);
    expect(needsMacTransparentWindow(blurredDesktop)).toBe(true);

    process.env.XDT_VIBRANCY_MATERIAL = 'none';
    try {
      const noMaterial = resolveVibrancyConfig('cindy', true, 'darwin');
      expect(needsMacTransparentWindow(noMaterial)).toBe(true);
    } finally {
      delete process.env.XDT_VIBRANCY_MATERIAL;
    }
  });

  it('creates a regular window by default for system vibrancy and opaque themes', () => {
    expect(resolveMacWindowTransparent(hud, undefined)).toBe(false);
    expect(resolveMacWindowTransparent(hud, false)).toBe(false);
    expect(resolveMacWindowTransparent(opaque, undefined)).toBe(false);
  });

  it('creates a transparent window when the last session or creation config needs desktop blur', () => {
    expect(resolveMacWindowTransparent(hud, true)).toBe(true);
    expect(resolveMacWindowTransparent(clearDesktop, undefined)).toBe(true);
    expect(resolveMacWindowTransparent(blurredDesktop, false)).toBe(true);
  });

  it('falls back to system vibrancy when desktop blur is requested mid-session on a regular window', () => {
    expect(fitMacBackdropToWindow(clearDesktop, false)).toEqual({
      vibrancy: 'under-window',
      backgroundColor: '#00000000',
    });
    expect(fitMacBackdropToWindow(blurredDesktop, false)).toEqual({
      vibrancy: 'under-window',
      backgroundColor: '#00000000',
    });
    expect(fitMacBackdropToWindow(clearDesktop, true)).toBe(clearDesktop);
    expect(fitMacBackdropToWindow(blurredDesktop, true)).toBe(blurredDesktop);
    expect(fitMacBackdropToWindow(hud, false)).toBe(hud);
    expect(fitMacBackdropToWindow(opaque, false)).toBe(opaque);
  });

  it('remembers which macOS windows were created transparent', () => {
    const transparent = {} as BrowserWindow;
    const regular = {} as BrowserWindow;
    markMacTransparentWindow(transparent);
    expect(isMacTransparentWindow(transparent)).toBe(true);
    expect(isMacTransparentWindow(regular)).toBe(false);
  });
});
