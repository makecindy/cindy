/**
 * Preview-page route guard — pure URL judgment + the persistent per-WebContents
 * guard for sandboxed local HTML previews.
 *
 * Lives in its own module with NO value import of @cindy/browser-control-runtime:
 * webview-security.ts attaches this guard at webview-creation time, which runs
 * BEFORE browser.ts initializes the browser runtime environment. Importing the
 * vendored runtime from here would freeze CONFIG_DIR to its default path before
 * browser-runtime-env.js sets XDT_BROWSER_RUNTIME_DIR, breaking every user's
 * managed-Chrome profile / login state (codex-connector P1, round 12).
 */

import type { WebContents } from 'electron';

/** True when `u` is a sandboxed preview URL issued by the local preview server. */
export function isPreviewUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return (
      parsed.protocol === 'http:' &&
      parsed.hostname === '127.0.0.1' &&
      // The preview server NEVER issues userinfo URLs — reject them
      // fail-closed so a `http://x@127.0.0.1:<port>/preview/...` variant
      // (which keeps an authorized origin but changes the document's
      // serialized href) is not treated as a preview page anywhere
      // (codex-connector P1, round 27).
      parsed.username === '' &&
      parsed.password === '' &&
      /^\/preview\/[a-f0-9]{64}\//.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * The origin the CURRENT preview server round actually authorizes, or null
 * when no preview server is live. Kept in sync by the host (browser.ts) via
 * `setLivePreviewOrigin` on every grant change.
 *
 * Shape-only checks (`isPreviewUrl`) are NOT enough to decide whether a URL
 * is a live preview page: after a restart the registration set is gone while
 * PERSISTENT RSB tab rows survive, and the port may have been seized by
 * another local process — a restored tab pointed at a stale preview URL would
 * load the SEIZER's content. Treating such a URL as a guarded preview page
 * (or worse, stop-and-replaying it) would let that content in
 * (new Codex reviewer P0, round 23).
 */
let livePreviewOrigin: string | null = null;

export function setLivePreviewOrigin(origin: string | null): void {
  livePreviewOrigin = origin;
}

/**
 * True when `u` is a preview-shaped URL AND its origin is the one the current
 * preview server actually authorizes. Fail-closed: no live server → nothing
 * is an authorized preview URL.
 */
export function isPreviewUrlAuthorized(u: string): boolean {
  if (!isPreviewUrl(u)) return false;
  if (!livePreviewOrigin) return false;
  try {
    return new URL(u).origin === livePreviewOrigin;
  } catch {
    return false;
  }
}

function currentUrlOf(wc: WebContents): string {
  try {
    return wc.getURL?.() ?? '';
  } catch {
    return '';
  }
}

function originOf(u: string): string | null {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

/** WebContents that already have the preview-page navigation guard attached. */
const previewGuardedContents = new WeakSet<WebContents>();

/**
 * WebContents currently in PREVIEW IDENTITY — the page is a sandboxed
 * preview page, so the navigation guard must keep blocking page-initiated
 * escapes.
 *
 * Bound to the WebContents, NOT to the current URL's pathname: an untrusted
 * preview script can rewrite the path via `history.replaceState('/')` or
 * `pushState` (an in-page navigation that does NOT fire will-navigate), which
 * would make `wc.getURL()` no longer match the preview shape and silently
 * disarm a shape-based guard. The identity is only cleared when a REAL
 * navigation (isInPlace=false) commits away from a preview URL
 * (codex-connector P1, round 27i).
 */
const previewActiveContents = new WeakSet<WebContents>();

/** Minimal structural shape of the webContents debugger transport. */
interface PreviewDebuggerTransport {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>;
}

/** WebContents whose main-world WebRTC kill-script is installed. */
const previewWebRtcKilled = new WeakSet<WebContents>();

/** A stop-and-replay preview navigation is in flight for this WebContents. */
const previewGuardReplaying = new WeakSet<WebContents>();

/**
 * Kill WebRTC in the PAGE MAIN WORLD via CDP `Page.addScriptToEvaluateOnNewDocument`.
 * Runs before ANY page script on every navigation, including the first —
 * required because Electron's contextIsolation puts session preloads in an
 * isolated world where shadowing `window.RTCPeerConnection` does NOT affect
 * the page (codex-connector P1, round 9). The debugger stays attached;
 * RsbWebviewAutomation.withDebugger leases externally-owned attachments and
 * reuses them without detaching, so snapshot/act keep working.
 *
 * Resolves true when the kill-script is in place (already installed, or the
 * CDP install succeeded); false when the install failed (debugger occupied,
 * sendCommand error). Callers MUST treat false as "refuse the preview
 * navigation" — fail-closed (codex-connector P1, round 12); a failed install
 * is NOT marked as done so the next preview navigation retries.
 */
export async function killPreviewWebRtc(wc: WebContents): Promise<boolean> {
  if (previewWebRtcKilled.has(wc)) return true;
  try {
    const transport = (wc as unknown as { debugger?: PreviewDebuggerTransport }).debugger;
    if (!transport) return false;
    if (!transport.isAttached()) transport.attach('1.3');
    await transport.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      // Scoped to the preview origin (round-10 P2): the script runs on EVERY
      // navigation of this target, so non-preview pages (e.g. after the tab
      // was navigated to a WebRTC-dependent site) must keep RTCPeerConnection.
      source:
        'try {' +
        // Judge the PARSED URL, not the raw href: a userinfo variant
        // (`http://x@127.0.0.1:<port>/preview/...`) keeps an authorized
        // origin but its serialized href does not match an anchored regex,
        // so an href-based test would silently skip the kill and leave
        // RTCPeerConnection alive on a page that still counts as a preview
        // (codex-connector P1, round 27).
        'var __u = new URL(location.href);' +
        "if (__u.protocol === 'http:' && __u.hostname === '127.0.0.1' && /^\\/preview\\/[a-f0-9]{64}\\//.test(__u.pathname)) {" +
        "Object.defineProperty(window, 'RTCPeerConnection', { value: undefined, configurable: true });" +
        "Object.defineProperty(window, 'webkitRTCPeerConnection', { value: undefined, configurable: true });" +
        '}' +
        '} catch (e) { /* best-effort */ }',
    });
    // Mark ONLY after the install succeeded (Worker review #1).
    previewWebRtcKilled.add(wc);
    return true;
  } catch {
    /* retried on the next preview navigation */
    return false;
  }
}

/**
 * Parity with the vendored persistent route guard used for external Chrome
 * (LOCAL PATCH in pw-session.ts): once a tab is on a sandboxed preview page,
 * forbid PAGE-INITIATED navigation away from the preview ORIGIN and deny
 * popups, so a previewed page cannot exfiltrate its DOM/CSSOM content or
 * probe other loopback services via location.href / window.open. The agent's
 * own navigate action uses wc.loadURL, which does NOT emit `will-navigate`,
 * so driving the tab normally stays unaffected.
 *
 * Exact-origin comparison (round-6 review): the target must share the
 * CURRENT page's origin AND keep the preview path shape — a port-agnostic
 * shape check alone would let a preview page jump to another loopback
 * service whose path happens to match /preview/<token>/.
 *
 * Renderer-initiated preview navigations (open path / reuse-existing-tab)
 * only surface here via did-start-navigation — the document may be created
 * before an async CDP install resolves. Such navigations are stopped and
 * re-issued via loadURL once the kill-script is in place; a failed install
 * is fail-closed and the preview navigation is NOT replayed
 * (codex-connector P1, round 12).
 */
export function guardPreviewPageNavigation(wc: WebContents): void {
  if (previewGuardedContents.has(wc)) return;
  previewGuardedContents.add(wc);
  wc.on('will-navigate', (event, url) => {
    // PREVIEW IDENTITY check, not a pathname-shape check (round 27i,
    // codex-connector P1): an untrusted script can rewrite the path with
    // history.replaceState/pushState (an in-page navigation that does NOT
    // fire will-navigate), which would make `wc.getURL()` stop matching the
    // preview shape and disarm a shape-based guard. The identity survives
    // such rewrites and is only cleared when a REAL navigation commits away
    // (see did-start-navigation below). After the origin is revoked,
    // `livePreviewOrigin` is cleared — but a preview tab whose close FAILED
    // (round 22 keeps the registration for retry) still shows workspace
    // content, and it must STILL be barred from escaping to an external
    // origin (Greptile P1, round 24). The authorization check stays on the
    // did-start-navigation LOAD path (below).
    // Block if the page has preview identity OR its current URL still has the
    // preview shape. The identity survives history.pushState/replaceState
    // rewrites (round 27i); the shape fallback keeps round-24 Greptile P1
    // semantics — a revocation survivor (close failed, registration kept)
    // whose origin is no longer authorized but whose URL still looks like a
    // preview must NOT be allowed to escape and exfiltrate its DOM.
    if (!previewActiveContents.has(wc) && !isPreviewUrl(currentUrlOf(wc))) return;
    const current = currentUrlOf(wc);
    const currentOrigin = originOf(current);
    if (!currentOrigin || originOf(url) !== currentOrigin || !isPreviewUrl(url)) {
      event.preventDefault();
    }
  });
  // did-start-navigation fires for EVERY navigation — including renderer
  // / webContents.loadURL, which does NOT emit will-navigate (round 10).
  wc.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    // NOTE: the preview identity is NOT cleared here. did-start-navigation
    // fires at navigation START; a loadURL that later fails/times out/stops
    // leaves the OLD preview document alive, so deleting the identity here
    // would disarm the guard while the preview page still lives (Greptile
    // P1 XzI5E / codex-connector P1 XzOZH, round 27l). Identity is cleared
    // only on did-navigate (committed), below. In-page navigations
    // (history.pushState/replaceState) never fire did-navigate and keep the
    // same document — identity stays, and will-navigate keeps blocking.
    if (!isPreviewUrl(url)) return;
    // Fail-closed on stale preview URLs (restart / port reuse): never
    // stop-and-replay a URL the current server does not authorize — the port
    // may now serve another local process's content (new Codex reviewer P0,
    // round 23). Park on about:blank instead of loading the URL at all.
    if (!isPreviewUrlAuthorized(url)) {
      try {
        wc.stop();
      } catch {
        /* ignore */
      }
      if (!previewGuardReplaying.has(wc)) {
        previewGuardReplaying.add(wc);
        void wc.loadURL('about:blank').catch(() => {}).finally(() => previewGuardReplaying.delete(wc));
      }
      return;
    }
    // Authorized preview load → enter preview identity (survives
    // history.pushState/replaceState rewrites; cleared only by a real
    // cross-document navigation away, round 27i).
    previewActiveContents.add(wc);
    if (previewWebRtcKilled.has(wc)) return; // kill-script already in place
    if (previewGuardReplaying.has(wc)) return; // replay already in flight
    previewGuardReplaying.add(wc);
    void (async () => {
      try {
        wc.stop();
        const installed = await Promise.race([
          killPreviewWebRtc(wc),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 3000)),
        ]);
        // loadURL re-fires did-start-navigation; the kill-script is now in
        // place, so the replayed navigation is let through. On failure the
        // tab is parked on about:blank instead (fail-closed).
        await wc.loadURL(installed ? url : 'about:blank').catch(() => {});
      } finally {
        previewGuardReplaying.delete(wc);
      }
    })();
  });
  // did-navigate fires when a MAIN-FRAME navigation COMMITS. This is the
  // correct moment to drop the preview identity: the old preview document has
  // been replaced, so the guard no longer needs to block its escapes. Cleared
  // ONLY on commit — a loadURL that fails/times out/stops never commits, the
  // old preview document survives, and the identity stays armed (Greptile
  // P1 XzI5E / codex-connector P1 XzOZH, round 27l).
  wc.on('did-navigate', (_event, url) => {
    if (!isPreviewUrl(url)) {
      previewActiveContents.delete(wc);
    }
  });
}
