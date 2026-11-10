import { app, type BrowserWindow } from 'electron';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createLogger } from './logger';
import type { VibrancyConfig } from './vibrancyConfig';

interface NativeDesktopBlur {
  apply(handle: Buffer, radius: number): boolean;
}
const log = createLogger('macosDesktopBlur');
const requireNative = createRequire(__filename);
let native: NativeDesktopBlur | null | undefined;
function load(): NativeDesktopBlur | null {
  if (native !== undefined) return native;
  try {
    const base = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
    native = requireNative(path.join(base, 'tools/desktop-blur/cindy-desktop-blur.node')) as NativeDesktopBlur;
  } catch {
    log.warn('Native desktop blur unavailable; retaining system material');
    native = null;
  }
  return native;
}

const activeWindows = new WeakSet<BrowserWindow>();
const appliedRadii = new WeakMap<BrowserWindow, number>();
const backgroundColors = new WeakMap<BrowserWindow, string>();
const materials = new WeakMap<BrowserWindow, string | null>();
const warnedWindows = new WeakSet<BrowserWindow>();

function setMaterial(win: BrowserWindow, material: string | null): void {
  if (materials.has(win) && materials.get(win) === material) return;
  win.setVibrancy(material as 'under-window' | null);
  materials.set(win, material);
}

/** Main and secondary windows use the same radius path. The radius covers the
 * whole window, sidebar included, so both follow the user's blur. Artwork clears
 * the native radius before restoring the normal theme material. Only macOS calls this. */
export function applyMacWindowBackdrop(
  win: BrowserWindow,
  config: VibrancyConfig,
  getNative: () => NativeDesktopBlur | null = load,
): void {
  if (win.isDestroyed()) return;
  // Own this write as well as native effects. A redundant clear-color write
  // would erase the addon's tiny alpha backing that preserves AppKit corners.
  if (backgroundColors.get(win) !== config.backgroundColor) {
    win.setBackgroundColor(config.backgroundColor);
    backgroundColors.set(win, config.backgroundColor);
    appliedRadii.delete(win);
  }
  applyBackdrop(win, config, getNative);
}

function applyBackdrop(
  win: BrowserWindow,
  config: VibrancyConfig,
  getNative: () => NativeDesktopBlur | null,
): void {
  const radius = config.desktopBlurRadius;
  if (radius === undefined && !activeWindows.has(win)) {
    setMaterial(win, config.vibrancy);
    return;
  }
  if (radius !== undefined && appliedRadii.get(win) === radius) return;
  // A system material would stack its own fixed blur over the adjustable radius.
  setMaterial(win, null);
  try {
    if (getNative()?.apply(win.getNativeWindowHandle(), radius ?? 0)) {
      if (radius !== undefined) {
        activeWindows.add(win);
        appliedRadii.set(win, radius);
      }
      else {
        activeWindows.delete(win);
        appliedRadii.delete(win);
        setMaterial(win, config.vibrancy);
      }
      return;
    }
  } catch {
    // A missing/changed private SPI must not prevent rendering or theme changes.
  }
  // Failed writes are never cached as applied: a later notification can retry.
  appliedRadii.delete(win);
  if (!warnedWindows.has(win)) {
    warnedWindows.add(win);
    log.warn('Desktop blur radius could not be applied; retaining system material');
  }
  setMaterial(win, config.vibrancy);
}
