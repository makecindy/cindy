import type { BrowserWindow } from 'electron';

type MaximizeStateWindow = Pick<
  BrowserWindow,
  'isDestroyed' | 'isMaximized' | 'on' | 'webContents'
>;

/** Keeps each renderer synchronized with the native maximize state of its own window. */
export function installWindowMaximizeStateBroadcast(window: MaximizeStateWindow): void {
  const publish = (): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed?.()) return;
    window.webContents.send('window-maximize-state-changed', window.isMaximized());
  };

  window.on('maximize', publish);
  window.on('unmaximize', publish);
}
