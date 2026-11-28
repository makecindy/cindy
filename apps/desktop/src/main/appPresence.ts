import { app, BrowserWindow } from 'electron';

import { restoreDockIconAfterShow } from './app-icon.js';
import { createLogger } from './logger.js';

const log = createLogger('app-presence');

/**
 * Keeps the primary desktop app visible in platform-native launch surfaces.
 *
 * Design rule:
 * - Main app presence is an app-level invariant, not a voice-input detail.
 * - Feature windows may be transient/tool-like, but they must never make the
 *   primary app disappear from the Dock/taskbar.
 * - Any code that needs to restore or intentionally change app presence should
 *   go through this module, so platform behavior stays auditable.
 *
 * Platform mapping:
 * - macOS Dock visibility is controlled by the process activation policy.
 * - Windows taskbar visibility is window-level, so we keep the main window out
 *   of skip-taskbar mode while allowing tool overlays to hide themselves.
 *
 * Global voice input uses transient, non-activating overlay windows. Those
 * windows must not leak their tool-window behavior into the whole Electron
 * process: macOS should keep the app as a regular Dock app, while Windows
 * should keep the main window visible in the taskbar.
 */
export async function ensureMainAppPresence(
  reason: string,
  mainWindow?: BrowserWindow | null,
): Promise<void> {
  try {
    if (process.platform === 'darwin') {
      if (app.dock?.isVisible()) return;
      // Do not re-apply the activation policy on every overlay show/close.
      // Even setting the same policy can make macOS briefly remove and
      // reinsert the Dock tile. Only do the expensive restore when the app has
      // actually fallen out of the Dock.
      app.setActivationPolicy('regular');
      await app.dock?.show();
      restoreDockIconAfterShow();
      return;
    }

    if (process.platform === 'win32' && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setSkipTaskbar(false);
    }
  } catch (error) {
    log.warn('failed to restore app presence', {
      reason,
      platform: process.platform,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function scheduleMainAppPresenceRestore(
  reason: string,
  mainWindow?: BrowserWindow | null,
): void {
  // Some macOS window style changes settle asynchronously after the overlay is
  // shown/closed. Run once immediately for responsiveness and once shortly after
  // to preserve the invariant if Electron/macOS applies delayed activation
  // policy side effects.
  void ensureMainAppPresence(reason, mainWindow);
  setTimeout(() => {
    void ensureMainAppPresence(`${reason}:delayed`, mainWindow);
  }, 250);
}
