/**
 * Preview-casting tab set (renderer mirror of main's `setCastingTabs`).
 *
 * Main pushes the FULL set of casting tabs this renderer hosts; we replace the
 * set wholesale. A casting tab must stay composited and non-zero-sized while
 * the UI hides it, so `PluginBodyHost` swaps `display:none` for a kept-size
 * transparent layer for tabs in this set (see `castingKeepAliveStyle`).
 */

import { useSyncExternalStore } from 'react';

/** The phone's picture shape (CSS px) a casting tab is laid out in. */
export interface PreviewCastingViewport {
  width: number;
  height: number;
}

let casting: ReadonlySet<string> = new Set();
let viewports: ReadonlyMap<string, PreviewCastingViewport> = new Map();
const listeners = new Set<() => void>();

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function sameViewports(
  a: ReadonlyMap<string, PreviewCastingViewport>,
  b: ReadonlyMap<string, PreviewCastingViewport>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, v] of a) {
    const other = b.get(id);
    if (!other || other.width !== v.width || other.height !== v.height) return false;
  }
  return true;
}

/**
 * Replace the casting set and the phone shapes together (both are full replacements; a tab
 * without a shape keeps its own layout). Shapes of tabs outside the set are dropped.
 */
export function setPreviewCastingTabs(
  tabIds: readonly string[],
  shapes?: Readonly<Record<string, PreviewCastingViewport>>,
): void {
  const next = new Set(tabIds);
  const nextViewports = new Map<string, PreviewCastingViewport>();
  for (const [id, v] of Object.entries(shapes ?? {}))
    if (next.has(id) && v && v.width > 0 && v.height > 0)
      nextViewports.set(id, { width: v.width, height: v.height });
  if (sameSet(casting, next) && sameViewports(viewports, nextViewports)) return;
  casting = next;
  viewports = nextViewports;
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

/** The phone shape this casting tab is laid out in, or null when it keeps its own layout. */
export function usePreviewCastingViewport(tabId: string): PreviewCastingViewport | null {
  return useSyncExternalStore(
    subscribe,
    // The stored object is replaced only by a new set, so the snapshot is stable between them.
    () => viewports.get(tabId) ?? null,
    () => null,
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
  viewports = new Map();
  listeners.clear();
}
