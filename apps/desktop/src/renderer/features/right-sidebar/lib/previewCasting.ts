/**
 * Preview-casting tab set (renderer mirror of main's `setCastingTabs`).
 *
 * Main pushes the FULL set of casting tabs this renderer hosts; we replace the
 * set wholesale. A casting tab must stay composited and non-zero-sized while
 * the UI hides it, so `PluginBodyHost` swaps `display:none` for a kept-size
 * transparent layer for tabs in this set (see `castingKeepAliveStyle`).
 */

import { useSyncExternalStore } from 'react';

let casting: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

export function setPreviewCastingTabs(tabIds: readonly string[]): void {
  const next = new Set(tabIds);
  if (sameSet(casting, next)) return;
  casting = next;
  for (const l of [...listeners]) l();
}

export function isPreviewCastingTab(tabId: string): boolean {
  return casting.has(tabId);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePreviewCastingTab(tabId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => casting.has(tabId),
    () => false,
  );
}

/** True while this renderer hosts at least one casting tab. */
export function usePreviewCastingActive(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => casting.size > 0,
    () => false,
  );
}

/** Test-only reset. */
export function _resetPreviewCastingForTests(): void {
  casting = new Set();
  listeners.clear();
}
