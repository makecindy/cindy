import { app, nativeTheme } from 'electron';
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
  if (process.platform !== 'darwin' || !app.dock) return;
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
    appliedIconPath = iconPath;
  } catch {
    // Dock updates are cosmetic and must not block startup or settings writes.
  }
}
