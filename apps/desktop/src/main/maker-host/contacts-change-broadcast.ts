/** 把通讯录变更广播给 renderer，并按来源通知设备同步驱动。 */

import { BrowserWindow } from 'electron';

import { emitLocalContactsChanged } from './contacts-change-events.js';

export const CONTACTS_CHANGED_CHANNEL = 'maker:contacts:changed';

export function broadcastContactsChanged(options: { origin?: 'local' | 'remote' } = {}): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(CONTACTS_CHANGED_CHANNEL);
  }
  if ((options.origin ?? 'local') === 'local') emitLocalContactsChanged();
}
