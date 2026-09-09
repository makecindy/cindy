/**
 * SessionAttentionUrgencyContext — 侧栏"额外 urgent attention"来源。
 *
 * sessionAttentionStore 已经承担了主流程 attention 语义(kind: done / awaiting / error),
 * 由 useSessionRunningStatus 边缘触发写入。但有些 urgent 信号不属于 attention store 的
 * 生命周期,又不适合直接跨 store 写入(会污染 dock badge 与 auto-clear 语义),典型例子:
 * "定时任务未读且失败/中断"的 session —— 该信号来自 useAutomationScheduleSessionIndex
 * 的 hasUnreadFailedRun,只想让侧栏右侧涂红,不想触发系统级 attention 广播。
 *
 * 本 context 由 CCAgentSidebarUpper 在其子树顶部 provide,SessionItem 用
 * useSessionAttentionUrgency(session.id) 消费。默认空 store,不 Provide 时语义是
 * "没有额外 urgent",不影响主流程。
 *
 * 走 context 而非 prop drilling:避免穿过 SessionEntryList / PinnedSection /
 * DateGroupedSessionsSection / ProjectsSection / DialogueSection / ProjectNode /
 * UnclassifiedSection / AutomationSessionGroupItem 等 6-8 个中间层的 mechanical 加参。
 *
 * ⚠️ 性能不变量(sessionRowRenderIsolation.test 钉住,不要退回旧实现):
 * context 的 value 是一个**引用永远稳定的 store**,不是 Set 本身。set 内容变化通过
 * store 内部的订阅广播,useSessionAttentionUrgency(id) 用 useSyncExternalStore 取
 * "本行是否 urgent"的 boolean 快照 —— 其它行的 urgent 翻转不会惊动本行。若把 value
 * 换回裸 Set,任何一次 set 变化都会让**所有**会话行重渲染(几百行 × 每次变化),
 * 正是 2026-07 切换卡顿的根源之一。
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

/** 引用稳定的 urgent-set 容器:内容变化走订阅广播,不换容器引用。 */
interface UrgencyStore {
  getSet(): ReadonlySet<string>;
  subscribe(listener: () => void): () => void;
  /** 内容级去重:引用不同但成员相同的 set 不广播(上游 useMemo 每次可能产新 Set)。 */
  replace(next: ReadonlySet<string>): void;
}

function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

function createUrgencyStore(initial: ReadonlySet<string>): UrgencyStore {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    getSet: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    replace: (next) => {
      if (next === current) return;
      if (sameMembers(next, current)) {
        current = next;
        return;
      }
      current = next;
      for (const listener of listeners) listener();
    },
  };
}

/** 未 Provide 时的兜底:空 set、永不广播 —— 语义 = "没有额外 urgent"。 */
const FALLBACK_STORE = createUrgencyStore(new Set());

const SessionAttentionUrgencyContext = createContext<UrgencyStore>(FALLBACK_STORE);

export function SessionAttentionUrgencyProvider({
  urgentSessionIds,
  children,
}: {
  urgentSessionIds: ReadonlySet<string>;
  children: ReactNode;
}) {
  // store 实例与 Provider 同生命周期,context value 引用永远不变 ——
  // 消费组件不会因 Provider 重渲染被整体唤醒,更新只走 store 订阅。
  const storeRef = useRef<UrgencyStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createUrgencyStore(urgentSessionIds);
  }
  useEffect(() => {
    storeRef.current?.replace(urgentSessionIds);
  }, [urgentSessionIds]);
  return (
    <SessionAttentionUrgencyContext.Provider value={storeRef.current}>
      {children}
    </SessionAttentionUrgencyContext.Provider>
  );
}

/** @returns 目标 session 是否被上游标记为 urgent 需要红点。
 *  快照是 boolean primitive:只有**本行**的 urgent 状态翻转才重渲染。 */
export function useSessionAttentionUrgency(sessionId: string): boolean {
  const store = useContext(SessionAttentionUrgencyContext);
  return useSyncExternalStore(
    store.subscribe,
    () => store.getSet().has(sessionId),
    () => store.getSet().has(sessionId),
  );
}

/**
 * @returns 整个 urgent-session 集合 —— 用于 CollapsedView.renderItem 这类"在
 * callback 里按 sessionId 循环查表"的场景(不能在 callback 内调 per-item hook)。
 * 集合成员变化时消费组件整体重渲染,只应在聚合视图使用,不要进逐行组件。
 */
export function useSessionAttentionUrgencySet(): ReadonlySet<string> {
  const store = useContext(SessionAttentionUrgencyContext);
  return useSyncExternalStore(store.subscribe, store.getSet, store.getSet);
}

/** @returns 一组 session 里是否存在 urgent —— 组头聚合场景(自动化分组等)。
 *  快照是 boolean primitive:组外成员变化、或组内变化但聚合结果没翻转,都不重渲染。 */
export function useSessionsAttentionUrgencyAny(sessionIds: readonly string[]): boolean {
  const store = useContext(SessionAttentionUrgencyContext);
  const getSnapshot = () => {
    const set = store.getSet();
    return sessionIds.some((id) => set.has(id));
  };
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/**
 * @returns 一组 session 里命中 urgent 的**子集** —— 折叠容器既要汇总红点、又要指出
 * 是哪几条时用(定时任务分组头收起态把告警行提上来,见
 * sidebar/projectCollapsedAttention.ts 的 errorSessionIds)。
 * 快照是序列化 key(primitive),Set 由 useMemo 派生:组外成员变化、组内成员变化但
 * 本组命中结果不变时都不重渲染 —— 不要改成直接返回新 Set(等同退回整集订阅)。
 * 只需要布尔的场景用更省的 useSessionsAttentionUrgencyAny。
 */
export function useSessionsAttentionUrgencyIdSet(
  sessionIds: readonly string[],
): ReadonlySet<string> {
  const store = useContext(SessionAttentionUrgencyContext);
  const getSnapshot = () => {
    const set = store.getSet();
    let key = '';
    for (const id of sessionIds) {
      if (set.has(id)) key += `${id}|`;
    }
    return key;
  };
  const key = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
  return useMemo(() => new Set(key.split('|').filter(Boolean)), [key]);
}
