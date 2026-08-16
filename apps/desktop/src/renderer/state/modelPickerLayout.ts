/**
 * modelPickerLayout —— 统一模型选择器的**列表样式**本机偏好(试用开关)。
 *
 *   - 'classic':现行样式(来源图标行首、引擎在行尾三元组)。默认。
 *   - 'badge'  :新样式试用(model-selector-unified v7 设计稿):行首 22px 引擎徽标、
 *               右缘常驻来源字签、粘性组头、价格串按实付比例上色。
 *
 * 纯呈现偏好,不进用户数据、不分账号、不跨端同步 —— 与 modelEnginePrefs 那类
 * 用户配置不同,这里丢了就丢了(回落 classic),所以不做 owner 分区与迁移。
 * 同步写 localStorage(与本目录其它 store 同取舍:热更 relaunch 走 app.exit(),
 * 异步写会丢最近一次切换)。
 */

import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'xdt:modelPickerLayout:v1';

export type ModelPickerLayout = 'classic' | 'badge';

let cache: ModelPickerLayout | null = null;
const listeners = new Set<() => void>();

function load(): ModelPickerLayout {
  if (cache !== null) return cache;
  try {
    cache = window.localStorage.getItem(STORAGE_KEY) === 'badge' ? 'badge' : 'classic';
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
