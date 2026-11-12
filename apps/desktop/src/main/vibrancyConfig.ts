/**
 * 无壁纸时采用用户的桌面模糊数值；以下为没有桌面覆盖状态的主题默认值。
 * E4D 毛玻璃 vibrancy 配置(R1 audit,用户裁决透壁纸 2026-07-17)。
 * 仅 CINDY family 启用 macOS vibrancy + 透明底(透出桌面壁纸);其他 family 恢复
 * 不透明。Windows 11 22H2+ CINDY family 启用 Electron backgroundMaterial;Windows 10、
 * 较早 Windows 11 与 Linux 回退不透明。
 */
import type { BrowserWindow } from 'electron';
import { createLogger } from './logger.js';
import {
  CINDY_ACRYLIC_WINDOW_BACKING,
  isWindowsBackdropMaterial,
  type WindowsBackdropMaterial,
} from '../shared/windowBackdrop.js';

export type { WindowsBackdropMaterial } from '../shared/windowBackdrop.js';

const log = createLogger('vibrancyConfig');

export interface VibrancyConfig {
  vibrancy: string | null;
  backgroundColor: string;
  backgroundMaterial?: WindowsBackdropMaterial;
  desktopBlurRadius?: number;
  sidebarMaterial?: 'light' | 'dark';
}

export interface ResolveVibrancyConfigOptions {
  getSystemVersion?: () => string;
  wallpaperCovered?: boolean;
  desktopBlur?: number | null;
}

// Coverage belongs to the rendered window, not the shared wallpaper selection:
// another window may still be loading its canvas. Never persist this display state.
const wallpaperCoveredWindows = new WeakSet<BrowserWindow>();
const desktopBlurWindows = new WeakMap<BrowserWindow, number>();

export function setWindowDesktopBlur(win: BrowserWindow, blur: number | null): void {
  if (blur === null) desktopBlurWindows.delete(win);
  else desktopBlurWindows.set(win, blur);
}

export function setWindowWallpaperCovered(win: BrowserWindow, covered: boolean): void {
  if (covered) wallpaperCoveredWindows.add(win);
  else wallpaperCoveredWindows.delete(win);
}

export function resolveWindowVibrancyConfig(
  win: BrowserWindow,
  familyId: string,
  isDark: boolean,
  platform: string,
  options?: ResolveVibrancyConfigOptions,
): VibrancyConfig {
  return resolveVibrancyConfig(familyId, isDark, platform, {
    ...options,
    wallpaperCovered: wallpaperCoveredWindows.has(win),
    desktopBlur: desktopBlurWindows.get(win),
  });
}

function readWindowsSystemVersion(options?: ResolveVibrancyConfigOptions): string | null {
  try {
    if (options?.getSystemVersion) return options.getSystemVersion();
    const getSystemVersion = (process as NodeJS.Process & { getSystemVersion?: () => string })
      .getSystemVersion;
    return typeof getSystemVersion === 'function' ? getSystemVersion() : null;
  } catch {
    return null;
  }
}

function parseWindowsBuild(systemVersion: string | null): number | null {
  if (!systemVersion) return null;
  const parts = systemVersion.trim().split('.');
  if (parts.length < 3) return null;
  const build = Number.parseInt(parts[2] ?? '', 10);
  return Number.isFinite(build) ? build : null;
}

/** Electron applies Windows system backdrops only from Windows 11 22H2 (build 22621). */
const WINDOWS_SYSTEM_BACKDROP_MIN_BUILD = 22621;

function supportsWindowsSystemBackdrop(options?: ResolveVibrancyConfigOptions): boolean {
  const build = parseWindowsBuild(readWindowsSystemVersion(options));
  return build !== null && build >= WINDOWS_SYSTEM_BACKDROP_MIN_BUILD;
}

// Windows: a BrowserWindow created with `transparent: true` must never carry a system backdrop,
// neither at creation nor later through setBackgroundMaterial (fitWindowsBackdropToWindow).
// Measured on Windows 11 build 26200 (2026-11-11): whenever any window on the desktop is shown
// or hidden, DWM intermittently stops drawing what lies behind such a window, so the material
// blurs nothing and the translucent sidebar flips to a flat dark fill. A regular frameless
// window with the same material is stable, and so is a transparent window without a material.
// `transparent` is fixed at creation: choose it from what the window has to show, and keep a
// running window usable when that need changes before the next launch.
const windowsTransparentWindows = new WeakSet<BrowserWindow>();

export function markWindowsTransparentWindow(win: BrowserWindow): void {
  windowsTransparentWindows.add(win);
}

export function isWindowsTransparentWindow(win: BrowserWindow): boolean {
  return windowsTransparentWindows.has(win);
}

/** See-through with no system material behind it: only a transparent window can show this. */
export function needsWindowsTransparentWindow(config: VibrancyConfig): boolean {
  return config.backgroundMaterial === 'none' && config.backgroundColor === '#00000000';
}

/**
 * `rememberedNeed` is the last need the main window reported (writeWindowTransparencyHint).
 * Systems without a system backdrop have no material to conflict with, and clear desktop
 * transparency must stay available there without a restart.
 */
export function resolveWindowsWindowTransparent(
  creationConfig: VibrancyConfig,
  rememberedNeed: boolean | undefined,
  options?: ResolveVibrancyConfigOptions,
): boolean {
  if (!supportsWindowsSystemBackdrop(options)) return true;
  return rememberedNeed === true || needsWindowsTransparentWindow(creationConfig);
}

/**
 * `transparent` is fixed at creation, so a running window keeps the kind it was created as
 * until the next launch:
 * - A regular window cannot be clear, so it keeps the frosted desktop.
 * - A transparent window never takes a system material (it would flicker). It stays
 *   see-through without a material; the sidebar paints its own tint over the desktop
 *   (globals.css), so it keeps its translucency instead of turning opaque.
 */
export function fitWindowsBackdropToWindow(
  config: VibrancyConfig,
  windowIsTransparent: boolean,
  options?: ResolveVibrancyConfigOptions,
): VibrancyConfig {
  if (!supportsWindowsSystemBackdrop(options)) return config;
  if (windowIsTransparent) {
    if (!config.backgroundMaterial || config.backgroundMaterial === 'none') return config;
    return { ...config, backgroundColor: '#00000000', backgroundMaterial: 'none' };
  }
  if (!needsWindowsTransparentWindow(config)) return config;
  return { ...config, backgroundMaterial: 'acrylic' };
}

function resolveBackdropMaterial(): WindowsBackdropMaterial {
  const raw = process.env.XDT_BACKDROP_MATERIAL;
  if (!raw) return 'acrylic';
  if (isWindowsBackdropMaterial(raw)) return raw;
  log.warn(`Invalid XDT_BACKDROP_MATERIAL '${raw}', falling back to acrylic.`);
  return 'acrylic';
}

function resolveWindowsBackdropColor(material: WindowsBackdropMaterial, isDark: boolean): string {
  if (material !== 'acrylic') return '#00000000';
  return withZeroAlpha(
    isDark ? CINDY_ACRYLIC_WINDOW_BACKING.dark : CINDY_ACRYLIC_WINDOW_BACKING.light,
  );
}

/**
 * The sidebar paints its 85% tint in CSS (globals.css), so the native backing must not add a
 * second coat over Acrylic (two 85% layers cover 97.75% and hide the blur). Keep the tint's RGB:
 * Electron also uses it as the Win32 class brush, which fills newly exposed area during a fast
 * resize before Chromium paints; alpha 0 leaves the composed window without an extra layer.
 */
function withZeroAlpha(rgba: string): string {
  return rgba.replace(/,\s*[\d.]+\s*\)$/, ', 0)');
}

export function resolveVibrancyConfig(
  familyId: string,
  isDark: boolean,
  platform: string,
  options?: ResolveVibrancyConfigOptions,
): VibrancyConfig {
  if (!options?.wallpaperCovered && typeof options?.desktopBlur === 'number') {
    return {
      vibrancy: platform === 'darwin' && options.desktopBlur ? 'under-window' : null,
      backgroundColor: '#00000000',
      ...(platform === 'darwin' ? { desktopBlurRadius: options.desktopBlur } : {}),
      ...(platform === 'darwin' && familyId === 'cindy'
        ? { sidebarMaterial: isDark ? 'dark' as const : 'light' as const } : {}),
      ...(platform === 'win32' ? {
        backgroundMaterial: options.desktopBlur && supportsWindowsSystemBackdrop(options)
          ? 'acrylic' : 'none',
      } : {}),
    };
  }
  const isCindy = familyId === 'cindy' && !options?.wallpaperCovered;
  const opaqueBg = isDark ? '#1f1f1e' : '#f8f8f6';
  if (platform === 'darwin') {
    // 材质 A/B 旋钮(dev 调参用):XDT_VIBRANCY_MATERIAL=sidebar|hud|under-window|fullscreen-ui|
    // popover|menu|none('none'=无材质纯透明,壁纸不模糊直透)。缺省 'hud'(用户实测定稿,2026-07-19 回写)。
    const material = process.env.XDT_VIBRANCY_MATERIAL || 'hud';
    return {
      vibrancy: isCindy && material !== 'none' ? material : null,
      backgroundColor: isCindy ? '#00000000' : opaqueBg,
    };
  }
  if (platform === 'win32') {
    // Earlier Windows 11 builds have no system backdrop: a translucent Acrylic backing
    // without its material would leave the window see-through, so keep the opaque surface.
    if (isCindy && supportsWindowsSystemBackdrop(options)) {
      const backgroundMaterial = resolveBackdropMaterial();
      return {
        vibrancy: null,
        // 侧栏染色只由 CSS 提供；原生 backing 保留同色 RGB（快速扩窗时的 Win32 窗口类刷子）、
        // alpha 为 0，不再在 Acrylic 上叠第二层 85%。
        // live resize 全程保持同一材质；连续尺寸变化交给 Renderer 的 CSS 布局处理。
        backgroundColor: resolveWindowsBackdropColor(backgroundMaterial, isDark),
        backgroundMaterial,
      };
    }
    return { vibrancy: null, backgroundColor: opaqueBg, backgroundMaterial: 'none' };
  }
  // Linux:无 vibrancy,不透明底
  return { vibrancy: null, backgroundColor: opaqueBg };
}
