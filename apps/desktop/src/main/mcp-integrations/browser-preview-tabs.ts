/**
 * Close still-open preview tabs on BOTH browser backends (vendored external
 * Chrome + RSB webview) when a preview origin is revoked.
 *
 * Extracted from browser.ts for unit testing with injected deps — the
 * function is the product of five review rounds (11/13/15/16/17) and has
 * several branches (usage gate, malformed tabs responses, destroyed
 * WebContents, uninitialized registry) that deserve direct coverage.
 *
 * After the preview listener is gone and its origin revoked, a still-open
 * preview tab keeps its persistent navigation guard alive (it was created
 * with the then-valid grant) and would keep allowing same-origin document
 * navigations — a local process seizing the freed port could then serve
 * untrusted content into that tab. The vendored guard cannot re-read the
 * live policy (policy is passed per-call), so the host closes the tabs:
 * the guard dies with the tab, closing the window.
 */
/**
 * RSB preview tabs registered at open/navigate time. Survives LRU eviction
 * of the live WebContents: evicted tabs drop out of TabRegistry but keep
 * their PERSISTENT store row, so revocation must close them from this set —
 * the bridge close deletes the row regardless of liveness
 * (codex-connector P1, round 21).
 */
const rsbPreviewTabs = new Set<string>(); // `${sessionId}:${tabId}`

export function registerRsbPreviewTab(sessionId: string, tabId: string): void {
  if (sessionId && tabId) rsbPreviewTabs.add(`${sessionId}:${tabId}`);
}

export interface PreviewTabCloserDeps {
  /** Whether the vendored browser runtime was ever used this session. */
  everCalled(): boolean;
  /** List external-Chrome tabs (`action: 'tabs'` → `data.tabs`). */
  listVendoredTabs(): Promise<
    Array<{ targetId?: string; suggestedTargetId?: string; url?: string }> | null | undefined
  >;
  /** Close one vendored tab by targetId. */
  closeVendoredTab(targetId: string): Promise<void>;
  /** Enumerate RSB registry rows with a live WebContents handle. */
  listRsbTabs(): Array<{
    tabId: string;
    sessionId: string;
    wc: { getURL?(): string; isDestroyed(): boolean };
  }>;
  /** Close an RSB tab through the renderer bridge (removes the persistent store row). */
  closeRsbTab(sessionId: string, tabId: string): Promise<void>;
  isPreviewUrl(u: string): boolean;
}

export async function closePreviewTabs(deps: PreviewTabCloserDeps): Promise<void> {
  // Skip the vendored tabs probe entirely when the runtime was never used:
  // a bare `tabs` call would BOOT the browser control service during quit —
  // the exact startup quit-time teardown exists to avoid (round 16). The RSB
  // registry sweep below stays unconditional (it boots nothing).
  if (deps.everCalled()) {
    try {
      const tabs = await deps.listVendoredTabs();
      // NOTE: no early `return` here — a failed/empty vendored response must
      // still fall through to the RSB registry sweep below (round 17).
      if (Array.isArray(tabs)) {
        for (const tab of tabs) {
          if (!deps.isPreviewUrl(tab.url ?? '')) continue;
          const targetId = tab.suggestedTargetId ?? tab.targetId;
          if (targetId) {
            await deps.closeVendoredTab(targetId);
          }
        }
      }
    } catch {
      /* best-effort: the origin grant is already revoked; stale-lock recovery
         on next launch covers orphaned Chrome state */
    }
  }
  // RSB webview tabs (round 15): revocation must cover BOTH backends — an
  // RSB preview tab surviving revocation would reload its old URL on a
  // seized port without the preview server's CSP, and the shape-matching
  // guard would still let it through. Closing through the renderer bridge
  // (round 18) also removes the PERSISTENT tab store row — wc.close() alone
  // only drops the in-memory registry record, and the tab would be
  // recreated with the stale loopback URL on hydrate/restart.
  try {
    for (const row of deps.listRsbTabs()) {
      const wc = row.wc;
      if (!wc || wc.isDestroyed()) continue;
      let url = '';
      try {
        url = wc.getURL?.() ?? '';
      } catch {
        continue;
      }
      if (!deps.isPreviewUrl(url)) continue;
      await deps.closeRsbTab(row.sessionId, row.tabId);
    }
    // Rows with NO live WebContents (LRU-evicted / detached-closed) never
    // appear in the registry: close them from the registration set — the
    // bridge close deletes the persisted row regardless of liveness
    // (codex-connector P1, round 21).
    for (const key of rsbPreviewTabs) {
      const sep = key.indexOf(':');
      if (sep > 0) {
        await deps.closeRsbTab(key.slice(0, sep), key.slice(sep + 1));
      }
    }
    rsbPreviewTabs.clear();
  } catch {
    /* best-effort */
  }
}
