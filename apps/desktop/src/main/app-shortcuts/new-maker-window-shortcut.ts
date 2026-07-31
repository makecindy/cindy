import type { BrowserWindow, WebContents } from 'electron';

import { matchesElectronInput } from '../../shared/appShortcuts.js';
import { getAppShortcutStore, isAppShortcutRecordingActive } from './index.js';
import { IPC_CHANNELS } from '@cindy/cindy-ipc';

/** Tracks WebContents already wired to prevent duplicate key dispatch. */
const installedWebContents = new WeakSet<WebContents>();

/**
 * Installs the Windows/Linux new-maker shortcut on one application window.
 * The effective combo and recording gate are read at keydown time so settings
 * changes apply immediately.
 */
export function installNewMakerWindowShortcut(
  window: Pick<BrowserWindow, 'webContents'>,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'darwin' || installedWebContents.has(window.webContents)) return;
  installedWebContents.add(window.webContents);

  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    if (isAppShortcutRecordingActive()) return;

    const combos = getAppShortcutStore().getEffectiveCombos('new-maker');
    if (!combos.some((combo) => matchesElectronInput(input, combo))) return;

    event.preventDefault();
    // Keep physical shortcuts distinct from Agent Island's semantic "New message" action.
    window.webContents.send(IPC_CHANNELS.APP_MENU.COMMAND, 'new-maker-shortcut');
  });
}
