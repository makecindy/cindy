import { app, BrowserWindow, ipcMain } from 'electron';

import {
  APP_ATTENTION_COUNT_CHANNEL,
  SESSION_ATTENTION_CLEARED_CHANNEL,
  type SessionAttentionClearIntent,
} from '../shared/sessionAttention';
import { createLogger } from './logger';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer';
import { setWindowsTaskbarBadge } from './windowsTaskbarBadge';
import { t } from './i18n';
import { throwIpcError } from './utils/ipcValidate';
import { getActiveAppSession } from './appSessionState';
import { isDataOwnerPushStamp } from '../shared/dataOwnerPush';

const log = createLogger('appBadgeService');
// 普通本地桶各限 1,000；给多设备目录留余量，同时约束单包与跨包累计内存。
const MAX_SNAPSHOT_SESSION_IDS = 10_000;
const MAX_SESSION_ID_LENGTH = 512;
const MAX_RETAINED_SESSION_IDS = 100_000;
const attentionSessionIds = new Set<string>();
// 侧栏就绪后目录内任务按当前状态计数；目录外的 id 既不在界面上出现，也没有
// 「读到 / 删除」这类清除入口，计入只会让角标停在用户点不掉的数字上，因此只在
// 首份投影前用事件集合兜底，避免 renderer 尚未挂载时漏掉后台提醒。事件集合本身
// 不随投影收缩：灵动岛靠 hasSessionAttention() 水合未读，目录外的 id 也要留着。
let projectedAttentionCount: number | null = null;
const projectedSessionIds = new Set<string>();

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
  ipcMain.handle(APP_ATTENTION_COUNT_CHANNEL, async (event, snapshot: unknown): Promise<void> => {
    assertTrustedAppRendererEvent(event);
    if (event.sender !== getWindow?.()?.webContents) {
      throwIpcError('PERMISSION_DENIED', 'App attention count must come from the main window');
    }
    if (!isDataOwnerPushStamp(snapshot)) {
      throwIpcError('INVALID_PARAMS', 'App attention snapshot requires an owner stamp');
    }
    const { count, sessionIds } = snapshot as typeof snapshot & {
      count?: unknown;
      sessionIds?: unknown;
    };
    if (
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > MAX_SNAPSHOT_SESSION_IDS
    ) {
      throwIpcError('INVALID_PARAMS', 'App attention count exceeds the supported inventory range');
    }
    if (!Array.isArray(sessionIds) || sessionIds.length > MAX_SNAPSHOT_SESSION_IDS) {
      throwIpcError('INVALID_PARAMS', 'App attention snapshot requires session IDs');
    }
    for (const id of sessionIds) {
      if (typeof id !== 'string' || id.length === 0 || id.length > MAX_SESSION_ID_LENGTH) {
        throwIpcError('INVALID_PARAMS', 'App attention snapshot contains an invalid session ID');
      }
    }
    const owner = getActiveAppSession();
    if (
      owner.dataOwnerId !== snapshot.dataOwnerId ||
      owner.generation !== snapshot.ownerGeneration ||
      owner.dataOwnerId === null
    )
      return;
    const uniqueSessionIds = new Set<string>(sessionIds);
    let retainedSize = projectedSessionIds.size;
    for (const id of uniqueSessionIds) {
      if (!projectedSessionIds.has(id)) retainedSize += 1;
    }
    if (retainedSize > MAX_RETAINED_SESSION_IDS) {
      throwIpcError('INVALID_PARAMS', 'App attention snapshot exceeds retained session ID limit');
    }
    const previousCount = getAttentionCount();
    projectedAttentionCount = count;
    // 曾进入普通目录的任务始终归投影管理，删除/断连后不能被旧通知重新计入。
    for (const sessionId of uniqueSessionIds) projectedSessionIds.add(sessionId);
    if (getAttentionCount() !== previousCount) applyBadge();
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
  if (!sessionId || getActiveAppSession().dataOwnerId === null) return;
  const before = attentionSessionIds.size;
  attentionSessionIds.add(sessionId);
  if (attentionSessionIds.size !== before) {
    if (projectedAttentionCount === null || !projectedSessionIds.has(sessionId)) applyBadge();
    onSessionAttentionMarked?.(sessionId);
  }
}

export function clearSessionAttention(
  sessionId: string,
  intent: SessionAttentionClearIntent = 'passive',
): void {
  if (!sessionId) return;
  const hadAppBadgeAttention = attentionSessionIds.delete(sessionId);
  if (
    hadAppBadgeAttention &&
    (projectedAttentionCount === null || !projectedSessionIds.has(sessionId))
  )
    applyBadge();
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
  // 回到「尚无投影」状态：新 owner / 退出后 renderer 还没推快照，这段窗口里
  // 逐任务通知必须还能自己撑起角标（写成 0 会让 mark 永远算成空投影）。
  projectedAttentionCount = null;
  projectedSessionIds.clear();
  applyBadge();
}

export function getAttentionCount(): number {
  // 首份投影前只有事件集合可用；此后目录就是界面的权威清单，逐任务通知不再叠加。
  if (projectedAttentionCount === null) return attentionSessionIds.size;
  return projectedAttentionCount;
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
