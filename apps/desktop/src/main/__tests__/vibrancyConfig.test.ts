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
  resolveVibrancyConfig,
  resolveWindowVibrancyConfig,
  setWindowWallpaperCovered,
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

  // Regression: Acrylic samples windows behind Cindy, producing a moving color
  // boundary in the task list. Mica samples the wallpaper instead (DESIGN §15.12).
  it('win32 × Win11 × CINDY:默认 mica，浅色侧栏由 CSS 染色', () => {
    expect(
      resolveVibrancyConfig('cindy', false, 'win32', {
        getSystemVersion: () => '10.0.22631',
      }),
    ).toEqual({
      vibrancy: null,
      backgroundColor: '#00000000',
      backgroundMaterial: 'mica',
    });
  });

  it('win32 × Win11 × CINDY:默认 mica，深色侧栏由 CSS 染色', () => {
    expect(
      resolveVibrancyConfig('cindy', true, 'win32', {
        getSystemVersion: () => '10.0.22631',
      }),
    ).toEqual({
      vibrancy: null,
      backgroundColor: '#00000000',
      backgroundMaterial: 'mica',
    });
  });

  it.each([
    [false, 'rgba(238, 238, 233, 0.85)'],
    [true, 'rgba(5, 5, 5, 0.85)'],
  ] as const)(
    'win32 × Win11 × CINDY:显式 acrylic 保留原生 backing (dark=%s)',
    (isDark, backgroundColor) => {
      process.env.XDT_BACKDROP_MATERIAL = 'acrylic';
      expect(
        resolveVibrancyConfig('cindy', isDark, 'win32', {
          getSystemVersion: () => '10.0.22631.2861',
        }),
      ).toEqual({
        vibrancy: null,
        backgroundColor,
        backgroundMaterial: 'acrylic',
      });
    },
  );

  it('win32 × Win11 × CINDY:支持 none 材质旋钮', () => {
    process.env.XDT_BACKDROP_MATERIAL = 'none';
    expect(
      resolveVibrancyConfig('cindy', false, 'win32', {
        getSystemVersion: () => '10.0.22000',
      }),
    ).toEqual({
      vibrancy: null,
      backgroundColor: '#00000000',
      backgroundMaterial: 'none',
    });
  });

  it('win32 × Win11 × CINDY:非法材质 warn 后回落 mica', () => {
    warnSpy.mockClear();
    process.env.XDT_BACKDROP_MATERIAL = 'glass';
    expect(
      resolveVibrancyConfig('cindy', true, 'win32', {
        getSystemVersion: () => '10.0.22631',
      }),
    ).toEqual({
      vibrancy: null,
      backgroundColor: '#00000000',
      backgroundMaterial: 'mica',
    });
    // 走统一 logger.warn,不再是裸 console.warn;文案不再带 [main] 前缀(scope 由 logger 注入)
    expect(warnSpy).toHaveBeenCalledWith(
      "Invalid XDT_BACKDROP_MATERIAL 'glass', falling back to mica.",
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
