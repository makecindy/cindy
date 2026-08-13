import type { BrowserWindow, WebContents } from 'electron';

/** 只允许完整应用窗口打开资源用量：主窗口或已登记的会话副窗口。 */
export function isResourceUsageOpenSender(params: {
  sender: WebContents;
  mainWindow: BrowserWindow | null;
  senderWindow: BrowserWindow | null;
  isSecondaryAppWindow: (win: BrowserWindow | null | undefined) => boolean;
}): boolean {
  const { sender, mainWindow, senderWindow, isSecondaryAppWindow } = params;
  if (mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents) return true;
  return isSecondaryAppWindow(senderWindow);
}
