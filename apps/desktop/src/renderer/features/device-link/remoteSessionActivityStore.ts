/**
 * remoteSessionActivityStore —— 控制端 device-link 远程会话的实时活动镜像。
 * ---------------------------------------------------------------------------
 * 被控端灵动岛 relay 经 `sessions` topic 推送 `local-db:sessions:activity`
 * (phase / attention / interactionKind),由 makerChatStore 的 onRemotePush 路由喂进来。
 * 侧边栏远程会话行(SessionItem)右侧状态槽据此点亮与本地会话同一套指示:
 * error 红点 / awaiting TapTap 蓝点 / running spinner / 完成未读绿点。
 *
 * 保留语义与手机端 remoteSessionStore.applySessionActivity 完全一致:
 *   - running / needs-interaction → 写入(活跃态)
 *   - completed / error 且 attention=true → 写入(未读终态;被控端真实展示后 relay
 *     会重发 attention=false 的收尾包)
 *   - 其余(已读收尾包)→ 删除条目,行回落时间显示
 *
 * 不喂系统级 attention(dock 角标 / 通知)—— 通知职责归被控端本机,控制端只做行内可视。
 *
 * ⚠️ 性能不变量(与 sessionAttentionStore 同款):SessionItem 逐行挂载,订阅必须是
 * 按 deviceId + sessionId 的稳定引用精准订阅(条目对象未替换时快照引用不变),禁止整表订阅。
 */

import { useMemo, useSyncExternalStore } from 'react';

export type RemoteSessionActivityPhase = 'running' | 'needs-interaction' | 'completed' | 'error';

/** 镜像 @cindy/device-link 的 SessionActivityPayload(renderer 不直接依赖该包)。 */
export interface RemoteSessionActivity {
  sessionId: string;
  phase: RemoteSessionActivityPhase;
  compactDetail: string;
  interactionKind?: string;
  attention: boolean;
}

/** Active remote turns must win over the persisted "started without ended" heuristic. */
export function isRemoteSessionActivityActive(
  activity: RemoteSessionActivity | undefined,
): boolean {
  return activity?.phase === 'running' || activity?.phase === 'needs-interaction';
}

const listeners = new Set<(deviceId?: string, sessionId?: string) => void>();
/** deviceId → sessionId → 活动条目；本地任务没有 deviceId，不读取远程缓存。 */
const activityByDevice = new Map<string, Map<string, RemoteSessionActivity>>();
/** 整表变更版本号(聚合消费方作依赖用;activityMap 本体是可变引用,不能当快照)。 */
let revision = 0;

function emit(deviceId?: string, sessionId?: string): void {
  revision++;
  for (const l of listeners) l(deviceId, sessionId);
}

function isPhase(value: unknown): value is RemoteSessionActivityPhase {
  return (
    value === 'running' ||
    value === 'needs-interaction' ||
    value === 'completed' ||
    value === 'error'
  );
}

function sameActivity(a: RemoteSessionActivity, b: RemoteSessionActivity): boolean {
  return (
    a.phase === b.phase &&
    a.compactDetail === b.compactDetail &&
    a.interactionKind === b.interactionKind &&
    a.attention === b.attention
  );
}

export function subscribeRemoteSessionActivity(
  listener: (deviceId?: string, sessionId?: string) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getRemoteSessionActivity(
  sessionId: string,
  deviceId: string | null | undefined,
): RemoteSessionActivity | undefined {
  return deviceId ? activityByDevice.get(deviceId)?.get(sessionId) : undefined;
}

/** Hook —— 按 sessionId 精准订阅(本地会话恒为 undefined,零开销)。 */
export function useRemoteSessionActivity(
  sessionId: string,
  deviceId: string | null | undefined,
): RemoteSessionActivity | undefined {
  return useSyncExternalStore(
    subscribeRemoteSessionActivity,
    () => getRemoteSessionActivity(sessionId, deviceId),
    () => getRemoteSessionActivity(sessionId, deviceId),
  );
}

/** Hook —— 一组 sessionId 的 phase 子映射(无远程活动条目的不进结果)。
 *  给"折叠容器按同一份判据汇总整组"的场景用(定时任务分组头,组内可能含
 *  device-link 远程运行)。快照是序列化 key(primitive),Map 由 useMemo 派生:
 *  组外条目变化、以及组内 detail 类变化都不会触发重渲染 —— 别改成整表 revision
 *  逐行用(会退化成整表订阅,违反文件头的性能不变量)。 */
export function useRemoteSessionsPhaseMap(
  sessions: readonly { id: string; deviceLinkDeviceId?: string | null }[],
): ReadonlyMap<string, RemoteSessionActivityPhase> {
  const getSnapshot = (): string => {
    let key = '';
    for (const { id, deviceLinkDeviceId } of sessions) {
      const phase = getRemoteSessionActivity(id, deviceLinkDeviceId)?.phase;
      if (phase) key += `${id}:${phase}|`;
    }
    return key;
  };
  const key = useSyncExternalStore(subscribeRemoteSessionActivity, getSnapshot, getSnapshot);
  return useMemo(() => {
    const map = new Map<string, RemoteSessionActivityPhase>();
    for (const pair of key.split('|')) {
      if (!pair) continue;
      const sep = pair.lastIndexOf(':');
      map.set(pair.slice(0, sep), pair.slice(sep + 1) as RemoteSessionActivityPhase);
    }
    return map;
  }, [key]);
}

function getRevision(): number {
  return revision;
}

/** Hook —— 整表版本号订阅,给**单例聚合消费方**(rail 折叠入口灯要跨全部远程
 *  条目聚合)。以返回值作 memo 依赖、逐 id 用 getRemoteSessionActivity 取值。
 *  ⚠️ 逐行组件(SessionItem)仍必须走 useRemoteSessionActivity 精准订阅,
 *  拿这个 hook 逐行用会退化成整表订阅、违反上面的性能不变量。 */
export function useRemoteSessionActivityRevision(): number {
  return useSyncExternalStore(subscribeRemoteSessionActivity, getRevision, getRevision);
}

/** onRemotePush 路由入口:按上述保留语义写入 / 删除。非法 payload 静默忽略。 */
export function applyRemoteSessionActivity(deviceId: string, payload: unknown): void {
  if (typeof payload !== 'object' || payload === null) return;
  const p = payload as Record<string, unknown>;
  const sessionId = typeof p.sessionId === 'string' ? p.sessionId : '';
  if (!deviceId || !sessionId || !isPhase(p.phase)) return;
  const attention = p.attention === true;
  const keep = p.phase === 'running' || p.phase === 'needs-interaction' || attention;
  if (!keep) {
    removeRemoteSessionActivityEntry(sessionId, deviceId);
    return;
  }
  const next: RemoteSessionActivity = {
    sessionId,
    phase: p.phase,
    compactDetail: typeof p.compactDetail === 'string' ? p.compactDetail : '',
    interactionKind: typeof p.interactionKind === 'string' ? p.interactionKind : undefined,
    attention,
  };
  let activityMap = activityByDevice.get(deviceId);
  if (!activityMap) {
    activityMap = new Map();
    activityByDevice.set(deviceId, activityMap);
  }
  const current = activityMap.get(sessionId);
  if (current && sameActivity(current, next)) return;
  activityMap.set(sessionId, next);
  emit(deviceId, sessionId);
}

/** 刚发送时丢掉上一轮 completed/error 镜像。running / needs-interaction 是本轮活档,保留。 */
export function dropStaleRemoteTerminalActivity(
  sessionId: string,
  deviceId: string | null | undefined,
): void {
  const activity = getRemoteSessionActivity(sessionId, deviceId);
  if (!activity) return;
  if (activity.phase !== 'completed' && activity.phase !== 'error') return;
  removeRemoteSessionActivityEntry(sessionId, deviceId);
}

/** 单会话清除(被控端删除 / 归档该会话时由 sessions:patched 路由调用)。 */
export function removeRemoteSessionActivityEntry(
  sessionId: string,
  deviceId: string | null | undefined,
): void {
  if (!deviceId) return;
  const activityMap = activityByDevice.get(deviceId);
  if (!activityMap?.delete(sessionId)) return;
  if (activityMap.size === 0) activityByDevice.delete(deviceId);
  emit(deviceId, sessionId);
}

/** 设备移除时只清理该设备；瞬时断线仍保留快照。 */
export function removeRemoteSessionActivityForDevice(deviceId: string): void {
  if (activityByDevice.delete(deviceId)) emit(deviceId);
}

/** 全清(登出 / device-link stopped)。 */
export function clearRemoteSessionActivity(): void {
  if (activityByDevice.size === 0) return;
  activityByDevice.clear();
  emit();
}
