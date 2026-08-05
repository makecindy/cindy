import { useSyncExternalStore } from 'react';

import type { InstalledGhost } from '../../shared/ghost';

/**
 * 已装意识清单—— renderer 窗口级单例缓存。
 *
 * 历史问题:hook 早期版本在每个组件实例挂载时各自 listSync(sendSync 阻塞
 * renderer 主线程,main 端每次全量扫盘 + icon base64)。AgentActionRow 等
 * 聊天行组件无条件消费本 hook,切进大会话一帧挂上百行 = 上百次同步全量扫描,
 * 是整窗卡顿的确认成因之一。现在改为模块级共享 store:
 * - 整个窗口只在首个消费者出现时 listSync 一次(保留 sendSync 是为规则 7
 *   首帧无跳变——首帧就要有清单,不能闪 loading);
 * - 之后所有消费者读同一份缓存(引用稳定,天然满足 useSyncExternalStore
 *   的 getSnapshot 契约);
 * - ghosts:changed(main 广播到所有窗口,payload 自带全量清单)统一刷新
 *   缓存并 notify,无需重新扫盘。
 */
let cachedGhosts: InstalledGhost[] | null = null;
const storeListeners = new Set<() => void>();
let changedSubscribed = false;
let unsubscribeChanged: (() => void) | null = null;

function ensureLoaded(): InstalledGhost[] {
  if (cachedGhosts === null) {
    // 防御式首帧:本 hook 被聊天动作行(ghost_call 意识化渲染)无条件调用,
    // 某些精简渲染环境 / 单测 harness 未挂 ghosts 桥时 listSync 缺席——
    // 此时空清单兜底(意识行回退通用图形),绝不让缺 API 把整行渲染炸掉。
    try {
      cachedGhosts = window.electronAPI.ghosts.listSync().ghosts;
    } catch {
      cachedGhosts = [];
    }
  }
  if (!changedSubscribed) {
    changedSubscribed = true;
    // 模块实例只订阅一次;HMR dispose 会主动退订旧回调。桥缺席时静默:
    // 缓存维持首帧兜底值,不影响渲染。
    try {
      unsubscribeChanged = window.electronAPI.ghosts.onChanged(({ ghosts: next }) => {
        cachedGhosts = next;
        storeListeners.forEach((cb) => cb());
      });
    } catch {
      /* harness 无桥 —— 静态清单即可 */
    }
  }
  return cachedGhosts;
}

function getInstalledGhostsSnapshot(): InstalledGhost[] {
  return ensureLoaded();
}

function subscribeInstalledGhosts(cb: () => void): () => void {
  ensureLoaded();
  storeListeners.add(cb);
  return () => {
    storeListeners.delete(cb);
  };
}

function resetInstalledGhostsStore(): void {
  try {
    unsubscribeChanged?.();
  } catch {
    /* HMR 时 bridge 可能已销毁;旧模块仍需完成本地清理 */
  }
  unsubscribeChanged = null;
  cachedGhosts = null;
  changedSubscribed = false;
  storeListeners.clear();
}

/** 仅测试用:清空模块级缓存与订阅标记,让下个用例重新经历首载。 */
export function __resetInstalledGhostsStoreForTest(): void {
  resetInstalledGhostsStore();
}

/**
 * 已装意识清单:设置页导航子项 / 意识总览 / 单意识页 / 聊天动作行共用,
 * 所有消费者永远看到同一份清单(同一引用)。
 */
export function useInstalledGhosts(): InstalledGhost[] {
  return useSyncExternalStore(subscribeInstalledGhosts, getInstalledGhostsSnapshot);
}

if (import.meta.hot) {
  import.meta.hot.accept(() => {});
  import.meta.hot.dispose(resetInstalledGhostsStore);
}
