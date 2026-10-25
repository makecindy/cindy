import type {OwnerBroadcastTap,DataOwnerBroadcastScope} from './ownerBroadcast.js';
import type {DataOwnerPushStamp} from '@cindy/remote-agent/shared/dataOwnerPush';
import type {DbLogger} from '@cindy/runtime-db/logging';
export type OwnerScope=DataOwnerBroadcastScope|null;
/** A host surface can be an authenticated local pipe client or a Desktop window. */
export interface LocalEventRecipient {isDestroyed():boolean;isTrusted():boolean;send(channel:string,payload:unknown,...stamp:[DataOwnerPushStamp?]|[]):void;}
export interface SessionNotificationHost {broadcastTap:OwnerBroadcastTap;logger:DbLogger;isProvisionalSession(id:string):boolean;localRecipients():LocalEventRecipient[];}
export function createSessionNotifications(host:SessionNotificationHost){
const {broadcastTap,logger:log,isProvisionalSession}=host;


function captureOwnerScope(): OwnerScope {
  try {
    const capture = broadcastTap.captureDataOwnerBroadcastScope;
    return capture ? capture() : null;
  } catch {
    // Narrow unit-test mocks may intentionally expose only the legacy tap API.
    return null;
  }
}

function isOwnerScopeCurrent(scope: OwnerScope): boolean {
  if (scope === null) return true;
  try {
    const isCurrent = broadcastTap.isDataOwnerBroadcastScopeCurrent;
    return isCurrent ? isCurrent(scope) : true;
  } catch {
    return true;
  }
}

function getSafeOwnerPushStamp(): ReturnType<typeof broadcastTap.getSafeDataOwnerPushStamp> {
  try {
    return broadcastTap.getSafeDataOwnerPushStamp?.();
  } catch {
    return undefined;
  }
}

/**
 * 广播 sessions:patched 到本机所有窗口 + device-link tap。tap 让该 patch 经 topic 路由
 * 转发给订阅了 `sessions` 的控制端(push 驱动:控制端 applyPatch 即时镜像,无需重拉)。
 */
function broadcastSessionPatched(
  sessionId: string,
  patch: Record<string, unknown>,
  ownerScope?: OwnerScope,
): void {
  if (ownerScope !== undefined && !isOwnerScopeCurrent(ownerScope)) return;
  const hasCapturedScope = ownerScope !== undefined && ownerScope !== null;
  const ownerStamp = hasCapturedScope ? ownerScope.ownerStamp : getSafeOwnerPushStamp();
  try {
    // 未发送任务只在本机可见，转正前不推给控制端。
    if (isProvisionalSession(sessionId)) {
      // local windows only
    } else if (hasCapturedScope) {
      broadcastTap.tapWindowBroadcast(
        'local-db:sessions:patched',
        { sessionId, patch },
        ownerStamp,
      );
    } else if (ownerStamp === undefined) {
      broadcastTap.tapWindowBroadcast('local-db:sessions:patched', { sessionId, patch });
    } else {
      broadcastTap.tapWindowBroadcast(
        'local-db:sessions:patched',
        { sessionId, patch },
        ownerStamp,
      );
    }
  } catch (error) {
    log.warn('session patch device-link broadcast failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  let windows: LocalEventRecipient[] = [];
  try {
    windows = host.localRecipients();
  } catch (error) {
    log.warn('session patch window enumeration failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  for (const w of windows) {
    try {
      if (!w.isTrusted()) continue;
      if (hasCapturedScope) {
        w.send('local-db:sessions:patched', { sessionId, patch }, ownerStamp);
      } else if (ownerStamp === undefined) {
        w.send('local-db:sessions:patched', { sessionId, patch });
      } else {
        w.send('local-db:sessions:patched', { sessionId, patch }, ownerStamp);
      }
    } catch (error) {
      log.warn('session patch window broadcast failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function broadcastRecentWorkdirsChanged(path: string, ownerScope: OwnerScope): void {
  if (!isOwnerScopeCurrent(ownerScope)) return;
  const hasCapturedScope = ownerScope !== null;
  const ownerStamp = hasCapturedScope ? ownerScope.ownerStamp : getSafeOwnerPushStamp();
  for (const window of host.localRecipients()) {
    if (!window.isTrusted()) continue;
    if (hasCapturedScope || ownerStamp !== undefined) {
      window.send('local-db:recent-workdirs:changed', { path }, ownerStamp);
    } else {
      window.send('local-db:recent-workdirs:changed', { path });
    }
  }
}

/**
 * worktree 回收真正跑完后通知本机所有窗口更新对应 session 的 worktree 缓存。
 *
 * 回收是下面 fire-and-forget 的异步链(动态 import → 关子进程 → git worktree remove →
 * 文件系统清理),store 条目被移除的时刻远晚于状态 IPC 返回。这条推送提供回收完成的
 * 权威时机；payload 保持为单个 sessionId，renderer 不需要重拉全表。
 *
 * 只广播给本机窗口、不进 device-link tap:控制端(手机/另一台桌面)的远程会话
 * worktree 元数据走 device-link 自己的镜像链路,不经本机 WorktreeContext。
 */
function broadcastWorktreeChanged(sessionId: string): void {
  for (const w of host.localRecipients()) {
    if (!w.isDestroyed()) w.send('worktree:changed', { sessionId });
  }
}
return {captureOwnerScope, isOwnerScopeCurrent, getSafeOwnerPushStamp, broadcastSessionPatched, broadcastRecentWorkdirsChanged, broadcastWorktreeChanged};
}
