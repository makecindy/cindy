import { app, nativeTheme, BrowserWindow, nativeImage, type NativeImage } from 'electron';
import { createHash } from 'node:crypto';
import { isAppContentWindow } from './windowFocusClassifier.js';
import path from 'node:path';

import type { AppIcon, AppearanceSettings } from '../shared/appearanceSettings.js';
import { readAppearanceSettings } from './appearance-settings-store.js';
import { resolveAppThemeIsDark } from './resolved-app-theme.js';

/**
 * Dock artwork relative to resources/. Every file already follows the Apple
 * icon grid (rounded corners and transparent margin, see
 * scripts/generate-mac-icns.mjs) because `dock.setIcon` shows images as-is.
 */
const DOCK_ICONS: Record<AppIcon, { light: string; dark: string }> = {
  default: { light: 'icon-dock.png', dark: 'icon-dock.png' },
  mark: { light: 'app-icons/mark-light.png', dark: 'app-icons/mark-dark.png' },
  wordmark: { light: 'app-icons/wordmark-light.png', dark: 'app-icons/wordmark-dark.png' },
  cat: { light: 'app-icons/cat.png', dark: 'app-icons/cat.png' },
};

let appliedIconPath: string | null = null;
let pluginIcon: NativeImage | null = null;
let pluginWindows = new WeakSet<BrowserWindow>();

export function applyPluginAppIconToWindow(window: BrowserWindow): void {
  if (process.platform === 'darwin' || !pluginIcon || !isAppContentWindow(window) || pluginWindows.has(window)) return;
  window.setIcon(pluginIcon); pluginWindows.add(window);
}

/** Explicit resource selection only. No default startup invocation or image placeholder. */
export function applyPluginAppIcon(bytes: Buffer | null): void {
  if (!bytes) {
    if (!pluginIcon) return;
    pluginIcon = null; pluginWindows = new WeakSet();
    if (process.platform === 'darwin') applyDockIcon({ ...readAppearanceSettings(), appIconResource: undefined });
    else {
      const icon = app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(__dirname, '../../resources/icon.png');
      for (const window of BrowserWindow.getAllWindows()) if (isAppContentWindow(window)) window.setIcon(icon);
      appliedIconPath = null;
    }
    return;
  }
  const identity = `plugin:${createHash('sha256').update(bytes).digest('hex')}`;
  if (appliedIconPath === identity && pluginIcon) return;
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error('APP_ICON_INVALID_IMAGE');
  if (process.platform === 'darwin') {
    if (!app.dock) throw new Error('APP_ICON_UNAVAILABLE');
    app.dock.setIcon(image);
  }
  pluginIcon = image; pluginWindows = new WeakSet(); appliedIconPath = identity;
  if (process.platform !== 'darwin') for (const window of BrowserWindow.getAllWindows()) applyPluginAppIconToWindow(window);
}

/**
 * Show the chosen icon in the macOS Dock for this run. Finder and Launchpad
 * keep the bundle icon, and other platforms have no runtime equivalent.
 *
 * Packaged builds already show the bundle icon, so the default choice only
 * needs applying after another icon replaced it during this run.
 */
export function applyDockIcon(
  settings: AppearanceSettings = readAppearanceSettings(),
  isDark?: boolean,
): void {
  if (settings.appIconResource) {
    if (!pluginIcon) void import('./mcp-apps/appearance.js').then(module => module.restorePluginAppearanceIcon()).catch(() => {});
    return;
  }
  if (process.platform !== 'darwin') { if (pluginIcon) applyPluginAppIcon(null); return; }
  if (!app.dock) return;
  if (settings.appIcon === 'default' && app.isPackaged && appliedIconPath === null) return;
  const artwork = DOCK_ICONS[settings.appIcon];
  const dark = isDark ?? resolveAppThemeIsDark(nativeTheme.shouldUseDarkColors);
  const relativePath = dark ? artwork.dark : artwork.light;
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, relativePath)
    : path.join(__dirname, '../../resources', relativePath);
  if (iconPath === appliedIconPath) return;
  try {
    app.dock.setIcon(iconPath);
    pluginIcon = null;
    appliedIconPath = iconPath;
  } catch {
    // Dock updates are cosmetic and must not block startup or settings writes.
  }
}
