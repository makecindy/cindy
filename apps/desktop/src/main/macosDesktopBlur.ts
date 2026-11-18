import { app, type BrowserWindow } from 'electron';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createLogger } from './logger';
import type { VibrancyConfig } from './vibrancyConfig';

interface NativeDesktopBlur {
  apply(handle: Buffer, radius: number): boolean;
  setSidebar(handle: Buffer, width: number, dark: boolean): boolean;
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
const sidebarWidths = new WeakMap<BrowserWindow, number>();
const backdropConfigs = new WeakMap<BrowserWindow, VibrancyConfig>();
const activeSidebars = new WeakMap<BrowserWindow, { width: number; dark: boolean }>();
const sidebarNeedsSync = new WeakSet<BrowserWindow>();

function setMaterial(win: BrowserWindow, material: string | null): void {
  if (materials.has(win) && materials.get(win) === material) return;
  win.setVibrancy(material as 'under-window' | null);
  materials.set(win, material);
  // Electron can replace the effect view. Reapply the mask even if its geometry
  // did not change; retain the marker until the native sidebar is cleared.
  if (activeSidebars.has(win)) sidebarNeedsSync.add(win);
}

function syncSidebar(win: BrowserWindow, getNative: () => NativeDesktopBlur | null): void {
  const config = backdropConfigs.get(win);
  const material = config?.sidebarMaterial;
  // A radius that could not be applied leaves the whole-window system material as
  // the fallback; a masked sidebar must neither replace nor clear it.
  const radiusFailed = config?.desktopBlurRadius !== undefined && !appliedRadii.has(win);
  const cssWidth = material && !radiusFailed ? sidebarWidths.get(win) ?? 0 : 0;
  if (!cssWidth && !activeSidebars.has(win)) return;
  const width = Math.min(cssWidth * win.webContents.getZoomFactor(), win.getContentBounds().width, 16384);
  const dark = material === 'dark';
  try {
    // Let Electron own placement/lifecycle in Chromium's native view host. The
    // addon only masks this material to the sidebar; it never hosts an overlay.
    if (width > 0) {
      setMaterial(win, 'hud');
      const previous = activeSidebars.get(win);
      if (previous?.width === width && previous.dark === dark && !sidebarNeedsSync.has(win)) return;
    } else if (config?.desktopBlurRadius !== undefined && !radiusFailed) setMaterial(win, null);
    if (getNative()?.setSidebar(win.getNativeWindowHandle(), width, dark)) {
      if (width > 0) activeSidebars.set(win, { width, dark });
      else activeSidebars.delete(win);
      sidebarNeedsSync.delete(win);
      return;
    }
  } catch { /* An unavailable native material keeps the readable CSS tint. */ }
  // Never leave an unmasked fixed material over the adjustable main backdrop.
  if (width > 0) setMaterial(win, null);
  if (!warnedWindows.has(win)) {
    warnedWindows.add(win);
    log.warn('Sidebar material unavailable; retaining sidebar tint');
  }
}

/** Local renderer geometry only; no window ID, theme or native handle is accepted. */
export function setMacSidebarWidth(
  win: BrowserWindow,
  rawWidth: unknown,
  getNative: () => NativeDesktopBlur | null = load,
): void {
  if (win.isDestroyed() || typeof rawWidth !== 'number' || !Number.isFinite(rawWidth)
    || rawWidth < 0 || rawWidth > 16384) return;
  sidebarWidths.set(win, rawWidth);
  syncSidebar(win, getNative);
}

/** Page zoom changes the physical sidebar width without changing its CSS width. */
export function refreshMacSidebarGeometry(
  win: BrowserWindow,
  getNative: () => NativeDesktopBlur | null = load,
): void {
  if (!win.isDestroyed()) syncSidebar(win, getNative);
}

/** Main and secondary windows use the same radius path. Artwork clears the
 * native radius before restoring the normal theme material. Only macOS calls this. */
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
    if (activeSidebars.has(win)) sidebarNeedsSync.add(win);
  }
  backdropConfigs.set(win, config);
  applyBackdrop(win, config, getNative);
  syncSidebar(win, getNative);
}

function applyBackdrop(
  win: BrowserWindow,
  config: VibrancyConfig,
  getNative: () => NativeDesktopBlur | null,
): void {
  const radius = config.desktopBlurRadius;
  // Leaving desktop mode must release the masked HUD, including when the next
  // theme also requests HUD: that next view must be unmasked.
  if (radius === undefined && activeSidebars.has(win)) setMaterial(win, null);
  if (radius === undefined && !activeWindows.has(win)) {
    setMaterial(win, config.vibrancy);
    return;
  }
  if (radius !== undefined && appliedRadii.get(win) === radius) return;
  // Keep the existing masked sidebar during radius-only updates. A fixed,
  // unmasked fallback material still needs clearing before the native retry.
  if (!activeSidebars.has(win)) setMaterial(win, null);
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
