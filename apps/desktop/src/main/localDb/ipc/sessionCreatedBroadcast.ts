/**
 * 新建会话通知的唯一出口：tap + 本机广播。
 * 写代次由 DbClient 写路径推进，这里只负责通知 renderer / device-link。
 *
 * Maker / scheduler / plugin / IM / fork / hook / learn 必须走这里，
 * 不要再复制 tapWindowBroadcast + webContents.send 循环。
 */

import { BrowserWindow } from 'electron';

import { tapWindowBroadcast } from '../../device-link/broadcast-tap';

export function emitSessionCreated(sessionId: string): void {
  tapWindowBroadcast('local-db:sessions:created', { sessionId });
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('local-db:sessions:created', { sessionId });
    } catch {
      // best-effort UI refresh, 失败不影响业务
    }
  }
}
