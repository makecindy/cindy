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
    a.compactDetail === b.compactDetail &&
    a.interactionKind === b.interactionKind &&
    a.attention === b.attention
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

/**
 * 整张活动表。给「一次渲染里要看很多会话」的列表用(伙伴侧栏按 canonical 会话
 * 判断谁在说话),这类地方没法逐行调 useAgentIslandActivity。
 *
 * 直接返回内部 Map:它只在内容真的变了时才换引用(见 applyList),所以拿它当
 * useSyncExternalStore 的快照是安全的 —— 无变化的 publish 不会引发重渲染。
 * 调用方只读,不要改。
 */
export function useAgentIslandActivityMap(): ReadonlyMap<string, AgentIslandSessionActivity> {
  return useSyncExternalStore(subscribe, getActivityMap, getActivityMap);
}

function getActivityMap(): ReadonlyMap<string, AgentIslandSessionActivity> {
  return activityMap;
}

/** 测试缝:清掉进程内快照,避免用例之间互相看到对方的活动。 */
export function __resetAgentIslandActivityForTests(): void {
  activityMap = new Map();
  emit();
}
