/**
 * Plugin-preview tabs that are waiting to be bound (process-local, not persisted).
 *
 * A preview opened by a plugin carries a `previewRequestId` that main only
 * accepts when the tab reports its guest. If the desktop is showing something
 * else (another tab, another task, Settings, a non-chat page) the tab would
 * stay un-materialized — browser tabs are lazy — and the phone could never see
 * it. A tab is "pending" from the moment this renderer opened it for a preview
 * until its first report goes out (or a short deadline passes); while pending it
 * is materialized in a hidden keep-alive layer even though nobody is looking.
 *
 * Deliberately in-memory only: a restored session also carries old
 * `previewRequestId`s in tab state, and those must not wake background tabs.
 */

import { useSyncExternalStore } from 'react';

/** Longer than a report normally takes; bounds a tab whose guest never loads. */
export const PENDING_PREVIEW_TAB_TTL_MS = 60_000;

const pending = new Map<string, ReturnType<typeof setTimeout>>();
let snapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function publish(): void {
  snapshot = new Set(pending.keys());
  for (const l of [...listeners]) l();
}

export function markPendingPreviewTab(tabId: string): void {
  const previous = pending.get(tabId);
  if (previous !== undefined) clearTimeout(previous);
  pending.set(
    tabId,
    setTimeout(() => clearPendingPreviewTab(tabId), PENDING_PREVIEW_TAB_TTL_MS),
  );
  publish();
}

export function clearPendingPreviewTab(tabId: string): void {
  const timer = pending.get(tabId);
  if (timer === undefined) return;
  clearTimeout(timer);
  pending.delete(tabId);
  publish();
}

export function getPendingPreviewTabIds(): ReadonlySet<string> {
  return snapshot;
}

export function subscribePendingPreviewTabs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePendingPreviewTab(tabId: string): boolean {
  return useSyncExternalStore(
    subscribePendingPreviewTabs,
    () => snapshot.has(tabId),
    () => false,
  );
}

export function usePendingPreviewActive(): boolean {
  return useSyncExternalStore(
    subscribePendingPreviewTabs,
    () => snapshot.size > 0,
    () => false,
  );
}

/** Test-only reset. */
export function _resetPendingPreviewTabsForTests(): void {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
  snapshot = new Set();
  listeners.clear();
}
