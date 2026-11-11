/**
 * sessionBackgroundActivityStore —— 「turn 已结束但 CC 子进程仍在调模型」会话
 * 集合的全局响应式 store(2026-07-13 假停止治理的侧边栏可见性补全)。
 *
 * 背景:后台子任务的信号此前只有会话内消费(useSessionBackgroundActivity 按
 * sessionId 订阅),用户切到别的会话就完全看不到"某会话还在后台烧用量"。这里
 * 把 main 的全局广播收敛成一份跨会话集合,供侧边栏把后台活跃会话点亮成与
 * running 相同的呼吸指示(Lizi 拍板:不新增视觉,复用呼吸)。
 *
 * 数据流:首个订阅者到达时惰性初始化 —— 先拉一次全量快照(补挂载前已活跃的
 * 会话),随后靠 push(payload = { sessionId, active })增量维护;快照只在集合
 * 真实变化时重建引用(useSyncExternalStore 契约)。纯视觉消费:不参与
 * makerChatStore 的 running 语义(done 通知 / 归档守卫 / LRU 驱逐都不受影响)。
 *
 * 同一套接线承载第二个集合:「回合已结束但后台命令仍在工作」(跑测试、构建这类会自己
 * 结束的后台命令,不含长驻服务)。后台命令不调模型,上面的信号看不到它;任务其实没做完
 * (命令结束后 CLI 会自动开新一轮),所以同样点亮成运行中。
 */

import { useSyncExternalStore } from 'react';

type MakerApi = NonNullable<NonNullable<Window['electronAPI']>['maker']>;
type FlipPayload = { sessionId: string; active: boolean };

interface SessionIdSetSource {
  onChanged: (api: MakerApi) => ((cb: (payload: FlipPayload) => void) => unknown) | undefined;
  list: (api: MakerApi) => (() => Promise<{ sessionIds: string[] }>) | undefined;
}

function createSessionIdSetStore(source: SessionIdSetSource) {
  const listeners = new Set<() => void>();
  const activeIds = new Set<string>();
  /** 不可变快照,只在 emit 时重建 —— 无变化时返回同一引用。 */
  let snapshot: ReadonlySet<string> = new Set();
  let initialized = false;

  function emit(): void {
    snapshot = new Set(activeIds);
    for (const l of listeners) l();
  }

  function applyChange(sessionId: string, active: boolean): void {
    const has = activeIds.has(sessionId);
    if (active === has) return;
    if (active) activeIds.add(sessionId);
    else activeIds.delete(sessionId);
    emit();
  }

  /** 惰性接线:首个订阅者到达时拉初始快照 + 挂 push 订阅(常驻,不随订阅者清空)。 */
  function ensureInitialized(): void {
    if (initialized || typeof window === 'undefined') return;
    const api = window.electronAPI?.maker;
    const onChanged = api ? source.onChanged(api) : undefined;
    if (!api || !onChanged) return;
    initialized = true;
    onChanged((payload) => {
      applyChange(payload.sessionId, payload.active);
    });
    void source
      .list(api)?.()
      .then(({ sessionIds }) => {
        // 只做并集:快照请求在飞期间到达的 push 是更新的事实,不能被旧全量覆盖掉。
        // 已知取舍:若 false 翻转 push 恰好落在快照请求在飞的毫秒级窗口内,旧全量会把
        // 刚熄灭的会话重新点亮,且 main 只在翻转沿广播、不会再推一次 false —— stale
        // 呼吸点会留到该会话下次点亮/熄灭或 reload。窗口极窄 + 后果纯视觉,接受。
        let changed = false;
        for (const id of sessionIds) {
          if (!activeIds.has(id)) {
            activeIds.add(id);
            changed = true;
          }
        }
        if (changed) emit();
      })
      .catch(() => {
        // maker 未 init 等瞬态:保持空集,push 到达时自然补上。
      });
  }

  return {
    subscribe(listener: () => void): () => void {
      ensureInitialized();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: (): ReadonlySet<string> => snapshot,
    reset(): void {
      activeIds.clear();
      snapshot = new Set();
      listeners.clear();
      initialized = false;
    },
  };
}

const modelActivityStore = createSessionIdSetStore({
  onChanged: (api) => api.onSessionBackgroundActivityChanged,
  list: (api) => api.listSessionBackgroundActivity,
});

const commandWorkStore = createSessionIdSetStore({
  onChanged: (api) => api.onSessionBackgroundWorkChanged,
  list: (api) => api.listSessionBackgroundWork,
});

/** 当前存在后台活动(turn 已结束但仍在调模型)的会话 id 集合。 */
export function useBackgroundActivitySessionIds(): ReadonlySet<string> {
  return useSyncExternalStore(
    modelActivityStore.subscribe,
    modelActivityStore.getSnapshot,
    modelActivityStore.getSnapshot,
  );
}

/** 当前「回合已结束但后台命令仍在工作」的会话 id 集合(不含只留了长驻服务的会话)。 */
export function useBackgroundCommandWorkSessionIds(): ReadonlySet<string> {
  return useSyncExternalStore(
    commandWorkStore.subscribe,
    commandWorkStore.getSnapshot,
    commandWorkStore.getSnapshot,
  );
}

/** 测试收尾:清空状态与接线标记。 */
export function resetSessionBackgroundActivityStoreForTests(): void {
  modelActivityStore.reset();
  commandWorkStore.reset();
}
