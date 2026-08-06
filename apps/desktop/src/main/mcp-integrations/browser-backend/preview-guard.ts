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
      /^\/preview\/[a-f0-9]{64}\//.test(parsed.pathname)
    );
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
        "if (/^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/preview\\/[a-f0-9]{64}\\//.test(location.href)) {" +
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
    const current = currentUrlOf(wc);
    if (!isPreviewUrl(current)) return; // not a preview page — leave it alone
    const currentOrigin = originOf(current);
    if (!currentOrigin || originOf(url) !== currentOrigin || !isPreviewUrl(url)) {
      event.preventDefault();
    }
  });
  // did-start-navigation fires for EVERY navigation — including renderer
  // / webContents.loadURL, which does NOT emit will-navigate (round 10).
  wc.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
    if (!isMainFrame || !isPreviewUrl(url)) return;
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
}
