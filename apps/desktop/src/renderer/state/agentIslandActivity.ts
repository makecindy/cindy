/**
 * agentIslandActivity —— 灵动岛 per-session 实时活动快照(renderer 侧镜像)。
 *
 * 主进程(agent-island/service.ts)每次 publish 把所有运行中会话的轻量活动快照
 * (phase / compactDetail / interactionKind / attention)经 IPC 广播过来;这里维护
 * 一份 Map<sessionId, activity> 供侧栏置顶卡片/列表显示"任务执行中的逐步活动 + 等待
 * 交互态"。与原生灵动岛同源数据,且不依赖灵动岛 UI 开关(主进程关闭岛时仍广播)。
 *
 * 性能:主进程每次都发全量新数组,这里做 diff —— 内容未变的会话**复用旧条目引用**,
 * 于是按 sessionId 选择的 hook 在该会话未变时拿到稳定引用,不会无谓重渲染(灵动岛
 * 动画计时器会让 publish 较频繁,这点很关键)。
 */

import { useCallback, useSyncExternalStore } from 'react';

import type { AgentIslandSessionActivity } from '../../shared/agentIsland';

let activityMap: ReadonlyMap<string, AgentIslandSessionActivity> = new Map();
const listeners = new Set<() => void>();
let subscribed = false;

function emit(): void {
  for (const l of listeners) l();
}

function sameActivity(a: AgentIslandSessionActivity, b: AgentIslandSessionActivity): boolean {
  return (
    a.phase === b.phase &&
    a.recordStatus === b.recordStatus &&
    a.compactDetail === b.compactDetail &&
    a.currentActionSummary === b.currentActionSummary &&
    a.interactionKind === b.interactionKind &&
    a.attention === b.attention &&
    a.startedAtMs === b.startedAtMs &&
    a.lastActivityAtMs === b.lastActivityAtMs &&
    a.workflow?.key === b.workflow?.key &&
    a.workflow?.label === b.workflow?.label &&
    a.workflow?.waitingOn === b.workflow?.waitingOn &&
    a.turnGeneration === b.turnGeneration &&
    a.gracefulStopState === b.gracefulStopState &&
    a.source === b.source
  );
}

/** 收到全量列表 → 构建新 Map,内容未变的条目复用旧引用;无实质变化则不通知。 */
function applyList(list: AgentIslandSessionActivity[]): void {
  const next = new Map<string, AgentIslandSessionActivity>();
  let changed = list.length !== activityMap.size;
  for (const incoming of list) {
    const prev = activityMap.get(incoming.sessionId);
    if (prev && sameActivity(prev, incoming)) {
      next.set(incoming.sessionId, prev); // 稳定引用
    } else {
      next.set(incoming.sessionId, incoming);
      changed = true;
    }
  }
  if (!changed) {
    for (const id of activityMap.keys()) {
      if (!next.has(id)) {
        changed = true;
        break;
      }
    }
  }
  if (!changed) return;
  activityMap = next;
  emit();
}

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  try {
    window.electronAPI.agentIsland.onSessionActivity(applyList);
  } catch {
    // preload 不可用(异常环境)——保持空 Map,卡片回退到现状显示。
  }
}

function subscribe(cb: () => void): () => void {
  ensureSubscribed();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 按 sessionId 取该会话的实时活动;无则 null。引用稳定(见上)。 */
export function useAgentIslandActivity(sessionId: string): AgentIslandSessionActivity | null {
  const getSnapshot = useCallback(() => activityMap.get(sessionId) ?? null, [sessionId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
