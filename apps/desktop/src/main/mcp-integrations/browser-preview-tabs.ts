import { isPreviewUrl } from './browser-backend/preview-guard.js';

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
 *
 * tabId → sessionId map (not a joined string: sessionId is an opaque string
 * and may contain colons — round 22, new Codex reviewer). Entries are added
 * only AFTER a preview navigation succeeded and removed on navigate-away /
 * manual close / successful revocation close, so a tab showing a normal
 * page is never closed by revocation.
 */
/**
 * Registrations carry the revocation generation they were made under. A
 * navigation that STARTED before a revocation but COMMITTED its registration
 * after the revoke sweep finished must not silently re-register and escape
 * the closure — the caller snapshots the generation before navigating and
 * compares after; a mismatch means the revoke swept while the navigation was
 * in flight, and the caller must close the tab instead of registering
 * (new Codex reviewer P1, round 23).
 */
const rsbPreviewTabs = new Map<string, { sessionId: string; generation: number }>();

let revocationGeneration = 0;

/** Mark a revocation in progress; registrations made under it carry this number. */
export function beginPreviewRevocation(): number {
  revocationGeneration += 1;
  return revocationGeneration;
}

export function getPreviewRevocationGeneration(): number {
  return revocationGeneration;
}

/** Test-only: reset the generation counter (module state is shared across tests). */
export function _resetPreviewRevocationGenerationForTests(): void {
  revocationGeneration = 0;
}

export function registerRsbPreviewTab(
  sessionId: string,
  tabId: string,
  generation = revocationGeneration,
): boolean {
  if (!sessionId || !tabId) return false;
  rsbPreviewTabs.set(tabId, { sessionId, generation });
  return true;
}

export function unregisterRsbPreviewTab(tabId: string): void {
  rsbPreviewTabs.delete(tabId);
}

/** Minimal event surface of an Electron WebContents we track navigation on. */
interface NavigationTrackTarget {
  on(event: 'did-navigate', listener: (event: unknown, url: string) => void): unknown;
  once(event: 'destroyed', listener: () => void): unknown;
  removeListener(event: 'did-navigate', listener: (event: unknown, url: string) => void): unknown;
}

/**
 * Track a tab's COMMITTED navigations and unregister it as soon as it leaves
 * the preview origin. The MCP navigate handler unregisters on its own MCP
 * request, but the user can navigate from the ADDRESS BAR — that path goes
 * renderer-direct loadURL (useBrowserWebview) and never reaches the MCP
 * request handlers, so a tab that used to show a preview page and was then
 * navigated to a normal page would keep its registration and revocation
 * would delete the NORMAL page's persisted row (new Codex reviewer P0,
 * round 23). did-navigate fires on the committed main-frame URL, which is
 * exactly the provenance source the reviewer asked for.
 */
export function trackPreviewTabNavigation(wc: NavigationTrackTarget, tabId: string): void {
  const onDidNavigate = (_event: unknown, url: string) => {
    if (!isPreviewUrl(url)) unregisterRsbPreviewTab(tabId);
  };
  wc.on('did-navigate', onDidNavigate);
  wc.once('destroyed', () => wc.removeListener('did-navigate', onDidNavigate));
}

/** Test-only: reset the registration set (module state is shared across tests). */
export function _resetRsbPreviewTabsForTests(): void {
  rsbPreviewTabs.clear();
}

export interface PreviewTabCloserDeps {
  /** Whether the vendored browser runtime was ever used this session. */
  everCalled(): boolean;
  /** List external-Chrome tabs (`action: 'tabs'` → `data.tabs`). */
  listVendoredTabs(): Promise<
    Array<{ targetId?: string; suggestedTargetId?: string; url?: string }> | null | undefined
  >;
  /**
   * Close one vendored tab by targetId. Resolves true when the close call
   * succeeded (the tab is expected to be gone); false when the call failed
   * or threw — the caller then re-sweeps to re-enumerate and retry, so a
   * preview tab whose close failed (or which appeared after the previous
   * snapshot) is not left trusting a stale preview origin
   * (Greptile P1, round 25). MUST NOT throw.
   */
  closeVendoredTab(targetId: string): Promise<boolean>;
  /** Enumerate RSB registry rows with a live WebContents handle. */
  listRsbTabs(): Array<{
    tabId: string;
    sessionId: string;
    wc: { getURL?(): string; isDestroyed(): boolean };
  }>;
  /**
   * Close an RSB tab through the renderer bridge (removes the persistent
   * store row). Resolves true when the row was removed; false on rejection
   * OR business failure (ok:false after the caller's retry) — a false
   * result keeps the registration so the next revocation retries it.
   * MUST NOT throw (round 22 contract).
   */
  closeRsbTab(sessionId: string, tabId: string): Promise<boolean>;
  isPreviewUrl(u: string): boolean;
}

export async function closePreviewTabs(deps: PreviewTabCloserDeps): Promise<void> {
  // Mark this revocation: registrations committed by in-flight navigations
  // after this point carry the new generation, and the sweep below must not
  // leave them behind (new Codex reviewer P1, round 23).
  beginPreviewRevocation();
  // Skip the vendored tabs probe entirely when the runtime was never used:
  // a bare `tabs` call would BOOT the browser control service during quit —
  // the exact startup quit-time teardown exists to avoid (round 16). The RSB
  // registry sweep below stays unconditional (it boots nothing).
  if (deps.everCalled()) {
    // Bounded re-sweep (round 25, Greptile P1): a preview tab whose close
    // FAILED — or which appeared AFTER this pass's tabs snapshot — keeps its
    // vendored navigation guard trusting the OLD preview origin (the guard
    // captured it at goto time and cannot re-read the host policy), so a
    // freed loopback port seized by another local process could be loaded
    // into the survivor. Re-enumerate and retry closes until no preview tabs
    // remain, up to MAX_VENDORED_SWEEPS rounds (a close that keeps failing
    // must not spin forever; the stale-lock recovery on next launch covers
    // orphaned Chrome state).
    const MAX_VENDORED_SWEEPS = 3;
    for (let round = 0; round < MAX_VENDORED_SWEEPS; round++) {
      let tabs: Array<{ targetId?: string; suggestedTargetId?: string; url?: string }> | null | undefined;
      try {
        tabs = await deps.listVendoredTabs();
      } catch {
        break; // enumeration failed — nothing more we can do this round
      }
      // NOTE: no early `return` here — a failed/empty vendored response must
      // still fall through to the RSB registry sweep below (round 17).
      if (!Array.isArray(tabs)) break;
      // Stop once no preview tabs remain. A FAILED close keeps the tab in
      // the next enumeration, so it is retried up to MAX_VENDORED_SWEEPS
      // times; a tab that appeared after the previous snapshot is caught by
      // the re-enumeration. Permanently-failing closes are bounded by the
      // round cap (stale-lock recovery on next launch covers orphans).
      const previewTabs = tabs.filter((tab) => deps.isPreviewUrl(tab.url ?? ''));
      if (previewTabs.length === 0) break;
      for (const tab of previewTabs) {
        const targetId = tab.suggestedTargetId ?? tab.targetId;
        if (!targetId) continue;
        try {
          await deps.closeVendoredTab(targetId);
        } catch {
          /* next sweep retries */
        }
      }
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
    // Live registry sweep: rows WITH a live WebContents currently on a
    // preview URL. Also unregisters each closed row so the registration
    // sweep below does not close the same tab twice — the duplicated-close
    // smell (new Codex reviewer P1, round 23): a live close that succeeds
    // already removed the persistent row; closing it AGAIN from the
    // registration set wastes the caller's bounded quit budget.
    const liveRows = deps
      .listRsbTabs()
      .filter((row) => {
        const wc = row.wc;
        if (!wc || wc.isDestroyed()) return false;
        let url = '';
        try {
          url = wc.getURL?.() ?? '';
        } catch {
          return false;
        }
        return deps.isPreviewUrl(url);
      });
    const liveResults = await Promise.all(
      liveRows.map((row) => deps.closeRsbTab(row.sessionId, row.tabId).then((ok) => ({ row, ok }))),
    );
    for (const { row, ok } of liveResults) {
      if (ok) rsbPreviewTabs.delete(row.tabId);
    }
    // Registration-set sweep: rows with NO live WebContents (LRU-evicted /
    // detached-closed) never appear in the registry — close them from the
    // registration set; the bridge close deletes the persisted row
    // regardless of liveness (round 21). A failed close (false) KEEPS the
    // entry for the next revocation (round 22). The sweep is repeated while
    // new registrations arrive (a navigation that succeeded while this
    // revocation was in flight registers under the NEW generation and must
    // be closed in the same pass, not left behind — new Codex reviewer P1,
    // round 23).
    for (;;) {
      const entries = [...rsbPreviewTabs.entries()];
      if (entries.length === 0) break;
      const results = await Promise.all(
        entries.map(([tabId, { sessionId }]) => deps.closeRsbTab(sessionId, tabId)),
      );
      let anyDeleted = false;
      entries.forEach(([tabId], i) => {
        if (results[i]) {
          rsbPreviewTabs.delete(tabId);
          anyDeleted = true;
        }
      });
      // A failed close keeps the entry; without progress the loop would spin
      // forever on an unclosable tab. Stop when nothing more was closed.
      if (!anyDeleted) break;
    }
  } catch {
    /* best-effort */
  }
}
