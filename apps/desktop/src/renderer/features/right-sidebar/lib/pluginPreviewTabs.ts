/**
 * Plugin-preview tabs opened by this renderer (process-local, not persisted).
 *
 * A preview opened by a plugin carries a `previewRequestId` that main only
 * accepts when the tab reports its guest, and the phone can attach to the
 * resulting tab at any time afterwards. Two things follow:
 *
 *  - PENDING (until the first report goes out, with a short deadline): the tab
 *    must be materialized even though nobody is looking — browser tabs are lazy,
 *    and the desktop may be showing another tab, another task, Settings or a
 *    non-chat page. While pending it lives in a transparent keep-alive layer.
 *  - TRACKED (for the tab's whole life, until it is closed): its body must stay
 *    mounted and its guest alive, otherwise leaving the chat route unmounts the
 *    right sidebar, Electron destroys the guest and main drops the binding. A
 *    tracked tab that is not being cast hides like any background tab
 *    (display:none) — cheap, and a game / video does not keep rendering. It is
 *    also protected from LRU eviction.
 *
 * Deliberately in-memory only: a restored session also carries old
 * `previewRequestId`s in tab state, and those must not wake background tabs.
 */

import { useSyncExternalStore } from 'react';

import { browserWebviewPool } from './browserWebviewPool';

/** Longer than a report normally takes; bounds a tab whose guest never loads. */
export const PENDING_PREVIEW_TAB_TTL_MS = 60_000;

const pending = new Map<string, ReturnType<typeof setTimeout>>();
const tracked = new Set<string>();
/** tabId → 开它的插件实例 id(主机在推送里填的;仅进程内,用于同一插件的预览互相取代)。 */
const ghostByTab = new Map<string, string>();
let pendingSnapshot: ReadonlySet<string> = new Set();
let trackedSnapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function publish(): void {
  pendingSnapshot = new Set(pending.keys());
  trackedSnapshot = new Set(tracked);
  for (const l of [...listeners]) l();
}

/** The renderer just created a plugin-preview tab: pending + tracked + eviction-protected. */
export function markPluginPreviewTab(tabId: string, ghostId?: string): void {
  const previous = pending.get(tabId);
  if (previous !== undefined) clearTimeout(previous);
  pending.set(
    tabId,
    setTimeout(() => clearPendingPreviewTab(tabId), PENDING_PREVIEW_TAB_TTL_MS),
  );
  tracked.add(tabId);
  if (ghostId) ghostByTab.set(tabId, ghostId);
  browserWebviewPool.protectFromEviction(tabId);
  publish();
}

/** First report went out (or the deadline passed): no longer needs forced materialization. */
export function clearPendingPreviewTab(tabId: string): void {
  const timer = pending.get(tabId);
  if (timer === undefined) return;
  clearTimeout(timer);
  pending.delete(tabId);
  publish();
}

/** The tab was closed: forget it entirely. */
export function unmarkPluginPreviewTab(tabId: string): void {
  const timer = pending.get(tabId);
  if (timer !== undefined) clearTimeout(timer);
  const wasPending = pending.delete(tabId);
  const wasTracked = tracked.delete(tabId);
  ghostByTab.delete(tabId);
  browserWebviewPool.unprotectFromEviction(tabId);
  if (wasPending || wasTracked) publish();
}

/** 开这个预览标签的插件实例 id;不是本 renderer 里插件预览槽开的标签返回 undefined。 */
export function getPluginPreviewGhostId(tabId: string): string | undefined {
  return ghostByTab.get(tabId);
}

export function getPendingPreviewTabIds(): ReadonlySet<string> {
  return pendingSnapshot;
}

export function getPluginPreviewTabIds(): ReadonlySet<string> {
  return trackedSnapshot;
}

export function subscribePluginPreviewTabs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePendingPreviewTab(tabId: string): boolean {
  return useSyncExternalStore(
    subscribePluginPreviewTabs,
    () => pendingSnapshot.has(tabId),
    () => false,
  );
}

/** True while this renderer has at least one live plugin-preview tab. */
export function usePluginPreviewActive(): boolean {
  return useSyncExternalStore(
    subscribePluginPreviewTabs,
    () => trackedSnapshot.size > 0,
    () => false,
  );
}

/** Test-only reset. */
export function _resetPluginPreviewTabsForTests(): void {
  for (const timer of pending.values()) clearTimeout(timer);
  for (const tabId of tracked) browserWebviewPool.unprotectFromEviction(tabId);
  pending.clear();
  tracked.clear();
  ghostByTab.clear();
  pendingSnapshot = new Set();
  trackedSnapshot = new Set();
  listeners.clear();
}
