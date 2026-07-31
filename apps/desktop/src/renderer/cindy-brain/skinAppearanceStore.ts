import { useSyncExternalStore } from 'react';

import type { GhostAppearancePresetSummary, GhostAppearanceSnapshot } from '../../shared/ghost';

type Snapshot = GhostAppearanceSnapshot | null | undefined;

let current: Snapshot;
let presets: GhostAppearancePresetSummary[] = [];
const listeners = new Set<() => void>();
const presetListeners = new Set<() => void>();

export function publishSkinAppearance(next: Snapshot): void {
  if (Object.is(current, next)) return;
  current = next;
  if (typeof document !== 'undefined') {
    if (next) document.documentElement.dataset.skinActive = 'true';
    else delete document.documentElement.dataset.skinActive;
  }
  for (const listener of listeners) listener();
}

export function publishSkinAppearanceState(
  next: Snapshot,
  nextPresets: GhostAppearancePresetSummary[],
): void {
  publishSkinAppearance(next);
  presets = nextPresets;
  for (const listener of presetListeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Snapshot {
  return current;
}

function subscribePresets(listener: () => void): () => void {
  presetListeners.add(listener);
  return () => presetListeners.delete(listener);
}

function getPresetsSnapshot(): GhostAppearancePresetSummary[] {
  return presets;
}

/** 给主题解析等非 React 路径读取同一份进程内快照。 */
export function getSkinAppearanceSnapshot(): Snapshot {
  return current;
}

/** Renderer 内共享当前皮肤快照；数据源由 SkinAppearanceRuntime 的宿主 IPC 提供。 */
export function useSkinAppearance(): Snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useSkinAppearancePresets(): GhostAppearancePresetSummary[] {
  return useSyncExternalStore(subscribePresets, getPresetsSnapshot, getPresetsSnapshot);
}
