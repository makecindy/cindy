import { useSyncExternalStore } from 'react';

import type { GhostAppearanceSnapshot } from '../../shared/ghost';

type Snapshot = GhostAppearanceSnapshot | null | undefined;

let current: Snapshot;
const listeners = new Set<() => void>();

export function publishSkinAppearance(next: Snapshot): void {
  if (Object.is(current, next)) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Snapshot {
  return current;
}

/** Renderer 内共享当前皮肤快照；数据源仍只有 SkinBackdrop 的宿主 IPC。 */
export function useSkinAppearance(): Snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
