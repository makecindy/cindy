/**
 * 模型选择器里收藏的插件路由模型（GhostPickerModel）：只记 pluginId + id，按账号分开存在这台电脑的
 * localStorage。插件模型仅在本机新任务草稿里列出，所以收藏也不跨设备同步、不进模型收藏的同步协议。
 * 插件卸载或模型下架后，显示时按现有列表过滤，不报错。
 */
import { useSyncExternalStore } from 'react';

import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { GhostPickerModel } from '../../../shared/ghost';

const STORAGE_KEY = 'cindy:pluginModelFavorites:v1';
const MAX_FAVORITES = 64;

const listeners = new Set<() => void>();
let cache: { key: string; keys: readonly string[] } | null = null;

function storageKey(): string {
  const owner = getDataOwnerGeneration().dataOwnerId;
  return owner ? `${STORAGE_KEY}:${encodeURIComponent(owner)}` : STORAGE_KEY;
}

/** 唯一标识一个插件路由模型（pluginId + model id）。 */
export function pluginModelFavoriteKey(model: Pick<GhostPickerModel, 'pluginId' | 'id'>): string {
  return `${model.pluginId}\n${model.id}`;
}

function read(key: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((item): item is string => typeof item === 'string' && item.includes('\n')))]
      .slice(0, MAX_FAVORITES);
  } catch {
    return [];
  }
}

function snapshot(): readonly string[] {
  const key = storageKey();
  if (!cache || cache.key !== key) cache = { key, keys: read(key) };
  return cache.keys;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
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

/** 收藏或取消收藏一个插件路由模型；写失败只影响这次，不打断选择器。 */
export function togglePluginModelFavorite(model: Pick<GhostPickerModel, 'pluginId' | 'id'>): void {
  const key = storageKey();
  const itemKey = pluginModelFavoriteKey(model);
  const current = read(key);
  const next = current.includes(itemKey)
    ? current.filter((item) => item !== itemKey)
    : [...current, itemKey].slice(-MAX_FAVORITES);
  cache = { key, keys: next };
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // 写不进去时这次收藏只在本窗口生效。
  }
  emit();
}

/** 收藏的插件路由模型键，按收藏先后。 */
export function usePluginModelFavorites(): readonly string[] {
  return useSyncExternalStore(subscribe, snapshot, () => []);
}

/** 「收藏」里有几个当前可用的收藏插件模型（已移除的不算）。 */
export function useFavoritePluginModelCount(models: readonly GhostPickerModel[]): number {
  const favorites = usePluginModelFavorites();
  return models.filter((model) => favorites.includes(pluginModelFavoriteKey(model))).length;
}
