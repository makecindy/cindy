/**
 * ghostSidebarWidgetStore.ts — 侧栏状态条(sidebarWidget)的 renderer 侧状态源。
 * main 每次推全量,这里整表替换;首帧异步读一次,读到之前按没有状态条处理。
 */

import { useSyncExternalStore } from 'react';

import type { GhostSidebarWidgetEntry } from '../../shared/ghost';

interface SidebarWidgetApi {
  onSidebarWidget?: (cb: (p: { entries: GhostSidebarWidgetEntry[] }) => void) => () => void;
  sidebarWidgets?: () => Promise<{ entries: GhostSidebarWidgetEntry[] }>;
}

const EMPTY: readonly GhostSidebarWidgetEntry[] = [];
let entries = EMPTY;
let ready = false;
let pushed = false;
const listeners = new Set<() => void>();

function api(): SidebarWidgetApi | undefined {
  return (window as unknown as { electronAPI?: { ghosts?: SidebarWidgetApi } }).electronAPI?.ghosts;
}

function apply(next: readonly GhostSidebarWidgetEntry[]): void {
  entries = next.length === 0 ? EMPTY : next;
  for (const cb of [...listeners]) cb();
}

function ensureReady(): void {
  if (ready) return;
  ready = true;
  const ghosts = api();
  ghosts?.onSidebarWidget?.((payload) => {
    pushed = true;
    apply(payload.entries);
  });
  // 读取返回前已有推送时以推送为准:推送更新。
  void ghosts?.sidebarWidgets?.().then((snapshot) => {
    if (!pushed) apply(snapshot.entries);
  });
}

function subscribe(cb: () => void): () => void {
  ensureReady();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useGhostSidebarWidgets(): readonly GhostSidebarWidgetEntry[] {
  return useSyncExternalStore(subscribe, () => entries);
}
