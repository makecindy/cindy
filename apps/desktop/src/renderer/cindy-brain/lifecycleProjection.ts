/**
 * 插件生命周期投影的 renderer 侧只读镜像。
 *
 * 数据流:main 在投影内容变化时推送 ghosts:lifecycle-changed(全量条目);
 * 首帧另拉一次快照(徽章可能在变化发生后才挂载)。消费方:插件列表卡 /
 * 详情页的 readiness 徽章。测试/无桥环境没有 ghosts 桥:恒为空表,所有
 * 插件视同 ready(不渲染徽章)。
 */

import { useSyncExternalStore } from 'react';

import type { GhostLifecycleEntry, GhostReadiness } from '../../shared/ghostLifecycle';

let entries = new Map<string, GhostLifecycleEntry>();
const listeners = new Set<() => void>();
let initialized = false;

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  const api = window.electronAPI?.ghosts;
  if (!api?.onLifecycleChanged || !api.lifecycle) return;
  api.onLifecycleChanged(({ entries: next }) => {
    entries = new Map(next.map((entry) => [entry.id, entry]));
    listeners.forEach((listener) => listener());
  });
  void api
    .lifecycle()
    .then(({ entries: next }) => {
      entries = new Map(next.map((entry) => [entry.id, entry]));
      listeners.forEach((listener) => listener());
    })
    .catch(() => {
      /* main 未注册(理论不发生)时保持空表 */
    });
}

function subscribe(listener: () => void): () => void {
  ensureInitialized();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 某插件的就绪态;无桥 / 未装载 = ready(不渲染徽章,与旧 UI 口径一致)。 */
export function useGhostReadiness(id: string): GhostReadiness {
  return useSyncExternalStore(subscribe, () => entries.get(id)?.readiness ?? 'ready');
}

/** 某插件的完整生命周期条目(详情页需要 setup / runtimeState 时使用)。 */
export function useGhostLifecycleEntry(id: string): GhostLifecycleEntry | undefined {
  return useSyncExternalStore(subscribe, () => entries.get(id));
}

/** 仅测试用:重置模块状态。 */
export function __resetLifecycleProjectionForTest(): void {
  entries = new Map();
  listeners.clear();
  initialized = false;
}
