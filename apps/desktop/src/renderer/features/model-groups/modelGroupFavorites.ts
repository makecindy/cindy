/**
 * 模型选择器里收藏的模式(model-groups.md §5)：只记模式的 id，按账号分开存在这台电脑的 localStorage。
 * 模式本身只存在这台电脑(设置里的 model-groups.json)，所以收藏也不跨设备同步，不进模型收藏的同步协议。
 * 模式被删后，收藏里留下的 id 在显示时按现有配置过滤，不报错。
 */
import { useSyncExternalStore } from 'react';

import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

const STORAGE_KEY = 'cindy:modelGroupFavorites:v1';
const MAX_FAVORITES = 64;

const listeners = new Set<() => void>();
let cache: { key: string; ids: readonly string[] } | null = null;

function storageKey(): string {
  const owner = getDataOwnerGeneration().dataOwnerId;
  return owner ? `${STORAGE_KEY}:${encodeURIComponent(owner)}` : STORAGE_KEY;
}

function read(key: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0))].slice(0, MAX_FAVORITES);
  } catch {
    return [];
  }
}

function snapshot(): readonly string[] {
  const key = storageKey();
  if (!cache || cache.key !== key) cache = { key, ids: read(key) };
  return cache.ids;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  // 没人订阅时本窗口不听别的窗口的改动：重新有人订阅时先丢掉缓存，补上这段时间别处的收藏变化。
  if (listeners.size === 0) cache = null;
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== storageKey()) return;
    cache = null;
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** 收藏或取消收藏一个模式；写失败只影响这次，不打断选择器。 */
export function toggleModelGroupFavorite(id: string): void {
  const key = storageKey();
  const current = read(key);
  const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id].slice(-MAX_FAVORITES);
  cache = { key, ids: next };
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // 写不进去时这次收藏只在本窗口生效。
  }
  emit();
}

/** 收藏的模式 id，按收藏的先后。 */
export function useModelGroupFavorites(): readonly string[] {
  return useSyncExternalStore(subscribe, snapshot, () => []);
}
