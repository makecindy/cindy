import { app, nativeTheme } from 'electron';
import path from 'node:path';

import { appIconArtwork } from '@cindy/maker-shared/app-icons';
import type { AppearanceSettings } from '../shared/appearanceSettings.js';
import { readAppearanceSettings } from './appearance-settings-store.js';
import { resolveAppThemeIsDark } from './resolved-app-theme.js';

/**
 * Dock artwork relative to resources/. Every file already follows the Apple
 * icon grid (rounded corners and transparent margin) because `dock.setIcon`
 * shows images as-is: scripts/generate-app-icons.mjs bakes app-icons/ from the
 * shared artwork, scripts/generate-mac-icns.mjs the built-in icon.
 */
function dockIconPath(icon: AppearanceSettings['appIcon'], dark: boolean): string {
  const artwork = appIconArtwork(icon, dark);
  return artwork ? `app-icons/${artwork}.png` : 'icon-dock.png';
}

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
  const dark = isDark ?? resolveAppThemeIsDark(nativeTheme.shouldUseDarkColors);
  const relativePath = dockIconPath(settings.appIcon, dark);
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
