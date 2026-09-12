import { app, BrowserWindow, ipcMain } from 'electron';

import {
  APP_ATTENTION_COUNT_CHANNEL,
  SESSION_ATTENTION_CLEARED_CHANNEL,
  type SessionAttentionClearIntent,
} from '../shared/sessionAttention';
import { createLogger } from './logger';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer';
import { createWindowsBadgeIcon } from './windowsBadgeIcon';
import { t } from './i18n';

const log = createLogger('appBadgeService');
const attentionSessionIds = new Set<string>();
// 侧栏就绪后以当前状态总数为准；旧事件集合仅继续服务灵动岛的逐任务确认。
// 首份投影前保留事件计数，避免 renderer 尚未挂载时漏掉后台提醒。
let projectedAttentionCount: number | null = null;

// channel 常量与 intent 类型的正本在 shared/sessionAttention.ts(preload fan-out /
// renderer store 同源引用);这里 re-export 维持 main 侧既有引用面。
export { SESSION_ATTENTION_CLEARED_CHANNEL, type SessionAttentionClearIntent };

let getWindow: (() => BrowserWindow | null) | null = null;
let onSessionAttentionMarked: ((sessionId: string) => void) | null = null;
let onSessionAttentionCleared:
  ((sessionId: string, intent: SessionAttentionClearIntent) => void) | null = null;

export interface AppBadgeServiceDeps {
  getWindow: () => BrowserWindow | null;
  onSessionAttentionMarked?: (sessionId: string) => void;
  onSessionAttentionCleared?: (sessionId: string, intent: SessionAttentionClearIntent) => void;
}

export function initAppBadgeService(deps: AppBadgeServiceDeps): void {
  getWindow = deps.getWindow;
  onSessionAttentionMarked = deps.onSessionAttentionMarked ?? null;
  onSessionAttentionCleared = deps.onSessionAttentionCleared ?? null;
  ipcMain.handle(APP_ATTENTION_COUNT_CHANNEL, async (event, count: unknown): Promise<void> => {
    assertTrustedAppRendererEvent(event);
    if (event.sender !== getWindow?.()?.webContents) {
      throw new Error('App attention count must come from the main window');
    }
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new TypeError('App attention count must be a non-negative safe integer');
    }
    if (projectedAttentionCount === count) return;
    projectedAttentionCount = count;
    applyBadge();
  });
  ipcMain.handle(
    'notification:mark-session-attention',
    async (_event, sessionId: unknown): Promise<void> => {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return;
      markSessionNeedsAttention(sessionId);
    },
  );
  ipcMain.handle(
    'notification:clear-session-attention',
    async (_event, sessionId: unknown, intent: unknown): Promise<void> => {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return;
      clearSessionAttention(sessionId, intent === 'explicit' ? 'explicit' : 'passive');
    },
  );
  applyBadge();
}

export function markSessionNeedsAttention(sessionId: string): void {
  if (!sessionId) return;
  const before = attentionSessionIds.size;
  attentionSessionIds.add(sessionId);
  if (attentionSessionIds.size !== before) {
    if (projectedAttentionCount === null) applyBadge();
    onSessionAttentionMarked?.(sessionId);
  }
}

export function clearSessionAttention(
  sessionId: string,
  intent: SessionAttentionClearIntent = 'passive',
): void {
  if (!sessionId) return;
  const hadAppBadgeAttention = attentionSessionIds.delete(sessionId);
  if (hadAppBadgeAttention && projectedAttentionCount === null) applyBadge();
  onSessionAttentionCleared?.(sessionId, intent);
  broadcastSessionAttentionCleared(sessionId, intent);
}

/** 把「会话已读」同步给本机所有窗口(远程控制端清除时,本机侧栏红绿点靠这条收敛)。 */
function broadcastSessionAttentionCleared(
  sessionId: string,
  intent: SessionAttentionClearIntent,
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(SESSION_ATTENTION_CLEARED_CHANNEL, { sessionId, intent });
    } catch (err) {
      log.warn('[app-badge] broadcast session-attention-cleared failed:', err);
    }
  }
}

export function clearAllSessionAttention(): void {
  attentionSessionIds.clear();
  projectedAttentionCount = 0;
  applyBadge();
}

export function getAttentionCount(): number {
  return projectedAttentionCount ?? attentionSessionIds.size;
}

export function hasSessionAttention(sessionId: string): boolean {
  return attentionSessionIds.has(sessionId);
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

function applyWindowsBadge(count: number): void {
  const win = getWindow?.();
  if (!win || win.isDestroyed()) return;
  try {
    win.flashFrame(count > 0);
    win.setOverlayIcon(
      createWindowsBadgeIcon(count),
      count > 0 ? t('appBadge.attentionCount').replace('{{count}}', String(count)) : '',
    );
  } catch (err) {
    log.warn('[app-badge] windows badge failed:', err);
  }
}
