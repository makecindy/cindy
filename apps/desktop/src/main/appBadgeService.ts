import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { createSessionAttention } from '@cindy/app-runtime/session-activity/attention';

import {
  SESSION_ATTENTION_CLEARED_CHANNEL,
  type SessionAttentionClearIntent,
} from '../shared/sessionAttention';
import { createLogger } from './logger';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer';
import { setWindowsTaskbarBadge } from './windowsTaskbarBadge';
import { t } from './i18n';
import { throwIpcError } from './utils/ipcValidate';
import { getActiveAppSession } from './appSessionState';

const log = createLogger('appBadgeService');
let getWindow: (() => BrowserWindow | null) | null = null;
export { SESSION_ATTENTION_CLEARED_CHANNEL, type SessionAttentionClearIntent };
export interface AppBadgeServiceDeps {
  getWindow: () => BrowserWindow | null;
  onSessionAttentionMarked?: (sessionId: string) => void;
  onSessionAttentionCleared?: (sessionId: string, intent: SessionAttentionClearIntent) => void;
}
const attention = createSessionAttention<BrowserWindow, IpcMainInvokeEvent>({
  ipcMain, assertTrustedAppRendererEvent, getActiveAppSession, throwIpcError, applyBadge,
  isMainWindowSender: (window, event) => event.sender === window?.webContents,
  broadcast(channel, payload) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try { win.webContents.send(channel, payload); }
      catch (err) { log.warn('[app-badge] broadcast session-attention-cleared failed:', err); }
    }
  },
});
export const { markSessionNeedsAttention, clearSessionAttention, clearAllSessionAttention, getAttentionCount, hasSessionAttention } = attention;
export function initAppBadgeService(deps: AppBadgeServiceDeps): void {
  getWindow = deps.getWindow;
  attention.initAppBadgeService(deps);
}
function applyBadge(): void {
  const count = getAttentionCount();
  if (process.platform === 'win32') {
    applyWindowsBadge(count);
    return;
  }
  applyCountBadge(count);
}

function applyCountBadge(count: number): void {
  try {
    app.setBadgeCount(count);
  } catch (err) {
    log.warn('[app-badge] setBadgeCount failed:', err);
  }

  if (process.platform !== 'darwin') return;
  try {
    app.dock?.setBadge(count > 0 ? String(count) : '');
  } catch (err) {
    log.warn('[app-badge] dock.setBadge failed:', err);
  }
}

/** 窗口就绪或语言变化时重绘当前角标，不依赖目录投影，也不重新触发闪烁。 */
export function refreshWindowsAppBadge(): void {
  if (process.platform === 'win32') applyWindowsBadge(getAttentionCount(), false);
}

function applyWindowsBadge(count: number, updateFlash = true): void {
  const win = getWindow?.();
  if (!win || win.isDestroyed()) return;
  try {
    if (updateFlash) win.flashFrame(count > 0);
    setWindowsTaskbarBadge(
      win,
      count,
      count > 0 ? t('appBadge.attentionCount').replace('{{count}}', String(count)) : '',
    );
  } catch (err) {
    log.warn('[app-badge] windows badge failed:', err);
  }
}
