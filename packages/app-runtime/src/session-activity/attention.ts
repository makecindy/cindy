import { APP_ATTENTION_COUNT_CHANNEL, SESSION_ATTENTION_CLEARED_CHANNEL, type SessionAttentionClearIntent } from '@cindy/maker-shared/sessionAttention';
import { isDataOwnerPushStamp } from '@cindy/remote-agent/shared/dataOwnerPush';
export function createSessionAttention<Window, Event>(host: {
  ipcMain: { handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void };
  assertTrustedAppRendererEvent(event: Event): void;
  isMainWindowSender?(window: Window | null, event: Event): boolean;
  getActiveAppSession(): { dataOwnerId: string | null; generation: number };
  throwIpcError(code: 'INVALID_PARAMS' | 'PERMISSION_DENIED' | 'PRECONDITION_FAILED', message: string): never;
  broadcast(channel: string, payload: unknown): void;
  applyBadge(): void;
}) {
const { ipcMain, assertTrustedAppRendererEvent, getActiveAppSession, applyBadge } = host;
function throwIpcError(code: 'INVALID_PARAMS' | 'PERMISSION_DENIED' | 'PRECONDITION_FAILED', message: string): never { return host.throwIpcError(code, message); }
// 普通本地桶各限 1,000；给多设备目录留余量，同时约束单包与跨包累计内存。
const MAX_SNAPSHOT_SESSION_IDS = 10_000;
const MAX_SESSION_ID_LENGTH = 512;
const MAX_RETAINED_SESSION_IDS = 100_000;
const attentionSessionIds = new Set<string>();
// 侧栏就绪后目录内任务按当前状态计数；事件集合补齐伙伴等目录外任务，并服务灵动岛。
// 首份投影前保留事件计数，避免 renderer 尚未挂载时漏掉后台提醒。
let projectedAttentionCount: number | null = null;
const projectedSessionIds = new Set<string>();

// channel 常量与 intent 类型的正本在 shared/sessionAttention.ts(preload fan-out /
// renderer store 同源引用);这里 re-export 维持 main 侧既有引用面。


let getWindow: (() => Window | null) | null = null;
let onSessionAttentionMarked: ((sessionId: string) => void) | null = null;
let onSessionAttentionCleared:
  ((sessionId: string, intent: SessionAttentionClearIntent) => void) | null = null;

interface AppBadgeServiceDeps {
  getWindow: () => Window | null;
  onSessionAttentionMarked?: (sessionId: string) => void;
  onSessionAttentionCleared?: (sessionId: string, intent: SessionAttentionClearIntent) => void;
}

function initAppBadgeService(deps: AppBadgeServiceDeps): void {
  getWindow = deps.getWindow;
  onSessionAttentionMarked = deps.onSessionAttentionMarked ?? null;
  onSessionAttentionCleared = deps.onSessionAttentionCleared ?? null;
  if (host.isMainWindowSender) ipcMain.handle(APP_ATTENTION_COUNT_CHANNEL, async (event, snapshot: unknown): Promise<void> => {
    assertTrustedAppRendererEvent(event);
    if (!host.isMainWindowSender?.(getWindow?.() ?? null, event)) {
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

function markSessionNeedsAttention(sessionId: string): void {
  if (!sessionId || getActiveAppSession().dataOwnerId === null) return;
  const before = attentionSessionIds.size;
  attentionSessionIds.add(sessionId);
  if (attentionSessionIds.size !== before) {
    if (projectedAttentionCount === null || !projectedSessionIds.has(sessionId)) applyBadge();
    onSessionAttentionMarked?.(sessionId);
  }
}

function clearSessionAttention(
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
  host.broadcast(SESSION_ATTENTION_CLEARED_CHANNEL, { sessionId, intent });
}

function clearAllSessionAttention(): void {
  attentionSessionIds.clear();
  projectedAttentionCount = 0;
  projectedSessionIds.clear();
  applyBadge();
}

function getAttentionCount(): number {
  if (projectedAttentionCount === null) return attentionSessionIds.size;
  let count = projectedAttentionCount;
  // 伙伴等不在普通目录中的任务沿用逐任务通知；目录内的任务只按投影计数。
  for (const sessionId of attentionSessionIds) {
    if (!projectedSessionIds.has(sessionId)) count += 1;
  }
  return count;
}

function hasSessionAttention(sessionId: string): boolean {
  return attentionSessionIds.has(sessionId);
}


return { initAppBadgeService, markSessionNeedsAttention, clearSessionAttention, clearAllSessionAttention, getAttentionCount, hasSessionAttention };
}
