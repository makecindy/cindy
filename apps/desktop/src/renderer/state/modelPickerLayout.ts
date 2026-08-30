/**
 * modelPickerLayout —— 模型选择器的**形态**本机偏好(三档并存试用,Chris 2026-08-17
 * 裁决:保留最原始选择器供回退；2026-08-27 起新用户默认使用 A 版)。
 *
 *   - 'original':最原始的选择器(unifiedPanel 之前的浏览式面板,含旧 harness 分段
 *                切换)。footer 右侧「尝试新选择器」切到 'classic'。
 *   - 'classic' :新选择器 A 版(统一面板现行样式:来源图标行首、引擎在行尾三元组)。**默认**。
 *   - 'badge'   :新选择器 B 版(v7 设计稿:行首 22px 引擎徽标、右缘来源字签、
 *                滚动题头、价格按实付比例上色)。
 *   新选择器 footer 右侧两个文字按钮:A/B 互切 + 切回老版('original')。
 *
 * 纯呈现偏好,不进用户数据、不分账号、不跨端同步 —— 与 modelEnginePrefs 那类
 * 用户配置不同,这里丢了就丢了(回落 classic),所以不做 owner 分区与迁移。
 * 同步写 localStorage(与本目录其它 store 同取舍:热更 relaunch 走 app.exit(),
 * 异步写会丢最近一次切换)。
 */

import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'xdt:modelPickerLayout:v1';

export type ModelPickerLayout = 'original' | 'classic' | 'badge';

let cache: ModelPickerLayout | null = null;
const listeners = new Set<() => void>();

function load(): ModelPickerLayout {
  if (cache !== null) return cache;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    cache = raw === 'badge' || raw === 'classic' || raw === 'original' ? raw : 'classic';
  } catch {
    cache = 'classic';
  }
  return cache;
}

export function getModelPickerLayout(): ModelPickerLayout {
  return load();
}

export function setModelPickerLayout(layout: ModelPickerLayout): void {
  if (load() === layout) return;
  cache = layout;
  try {
    window.localStorage.setItem(STORAGE_KEY, layout);
  } catch {
    // 私密窗口禁写等 —— 内存态照常生效。
  }
  for (const listener of listeners) listener();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// 多窗口:另一个窗口切了形态,本窗口的进程内缓存不会自己失效 —— 不听 storage 事件的话
// 两个窗口会一直显示两套选择器。与 modelFavorites 同一套写法:**重读 localStorage**
// 而不是采信 event.newValue(迟到事件带旧值,采信会把本窗口刚做的切换回滚)。
const removeStorageListener = (() => {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return null;
  const onStorage = (event: StorageEvent): void => {
    // key === null 表示 storage.clear();其余只认本 store 的 key。
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    const prev = cache;
    cache = null;
    if (load() === prev) return;
    for (const listener of listeners) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
})();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    removeStorageListener?.();
  });
}

export function useModelPickerLayout(): ModelPickerLayout {
  return useSyncExternalStore(subscribe, load, () => 'classic' as const);
}

/** 测试用:重置缓存与存储。 */
export function __resetForTest(): void {
  cache = null;
  listeners.clear();
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
