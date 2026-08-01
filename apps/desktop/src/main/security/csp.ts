/**
 * csp.ts — Content-Security-Policy for the Cindy desktop app window(s).
 * ---------------------------------------------------------------------------
 * WHY: the main window renders untrusted content (agent output, markdown,
 * file previews, web-search results) while `preload` exposes highly privileged
 * capabilities (PTY spawn, shell:open-path, fileBrowser.writeFile, safeStorage,
 * …). With ZERO CSP any renderer XSS can inject an inline `<script>` / `eval`
 * and immediately reach those preload bridges. A CSP that forbids inline /
 * eval script (`script-src 'self'` in prod) removes that escalation path.
 *
 * HOW: we inject the `Content-Security-Policy` response header from the main
 * process via `session.webRequest.onHeadersReceived` (see
 * `installContentSecurityPolicy`) instead of a `<meta>` tag in index.html —
 * a single main-side chokepoint is more reliable, cannot be stripped by the
 * renderer, and also covers custom-protocol document responses.
 *
 * SCOPE: the injector attaches to ONE session (the app's `defaultSession`) and
 * only rewrites `mainFrame` document responses, so:
 *   - the RSB in-app browser `<webview>` (separate `BROWSER_PARTITION` session,
 *     hardened independently in webview-security.ts) is NOT affected — external
 *     sites keep their own CSP;
 *   - custom-protocol subresource responses (xdt-image:/-video:/-audio: with
 *     their manual 206 Range headers) are left byte-for-byte untouched.
 *
 * DEV vs PROD: the Vite dev server + React Fast Refresh need `'unsafe-eval'`
 * and an inline preamble `<script>` (so dev `script-src` must allow
 * `'unsafe-inline' 'unsafe-eval'`), plus the HMR WebSocket (`ws:`). The
 * packaged build serves the renderer from `file://` with only bundled module
 * scripts, so prod `script-src` is tightened to `'self'` (no inline;
 * unsafe-eval kept for vendored drawio).
 * "dev" is keyed off the Vite dev-server URL being present, which is exactly
 * the condition under which the renderer is served by Vite.
 */

import type { Session, OnHeadersReceivedListenerDetails } from 'electron';

import { createLogger } from '../logger.js';

const cspLog = createLogger('csp');

/** Header name we own. */
const CSP_HEADER = 'Content-Security-Policy';

/**
 * Privileged custom schemes registered in bootstrap-electron
 * (`registerSchemesAsPrivileged`). They back locally-cached / local-file media
 * rendered inside the app, so they must be allow-listed in img-src / media-src.
 */
const CUSTOM_IMG_SCHEMES = [
  'xdt-image:',
  'xdt-file:',
  'xdt-video:',
  'xdt-model:',
  'cindy-remote-media:',
  'cindy-media:',
];
const CUSTOM_MEDIA_SCHEMES = [
  'xdt-audio:',
  'xdt-video:',
  'xdt-image:',
  'cindy-remote-media:',
  'cindy-media:',
];

/** Inputs that shape the emitted policy. All origins are already normalized. */
export interface CspContext {
  /** True when the renderer is served by the Vite dev server (needs eval + ws). */
  isDev: boolean;
  /** Vite dev-server origin (dev only); added to connect-src. `null` in prod. */
  devServerOrigin: string | null;
}

/** Parse a URL string into its origin, returning `null` on any failure. */
export function parseOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Build the CSP header value (a single `; `-joined directive string).
 *
 * Pure function — no Electron / IO — so it is unit-testable in isolation.
 *
 * Deliberate permissiveness (see PR body for the tighten-later TODOs): img /
 * media / font allow remote `http(s):` because they render untrusted remote
 * media (avatars, markdown / web-search images) and cannot execute code — a
 * blocked image is a worse UX regression than the marginal risk. The real
 * hardening lives in `script-src` (no inline in prod; unsafe-eval kept for
 * vendored drawio) plus `object-src 'none'` and `frame-src 'none'`.
 */
export function buildContentSecurityPolicy(ctx: CspContext): string {
  const { isDev, devServerOrigin } = ctx;

  // script-src is the crown jewel. The XSS→preload escalation path is an
  // attacker getting THEIR script to run — via an injected inline <script>
  // (blocked in prod: no 'unsafe-inline') or a remote script (blocked: not
  // 'self'). Both stay blocked in prod, which is the primary protection.
  //
  // 'unsafe-eval' (prod + dev): the vendored drawio viewer
  // (vendor/drawio/viewer-static.min.js) calls real JS eval() from within
  // createViewerForElement and runs in THIS renderer; without 'unsafe-eval' any
  // .drawio file preview deterministically throws EvalError and degrades to the
  // unrenderable placeholder (a shipped-feature regression). We accept
  // 'unsafe-eval' as a deliberate trade-off: it only lets code reach an existing
  // eval() sink — a far narrower surface than inline/remote injection, both of
  // which remain forbidden. Dev additionally needs 'unsafe-inline' (React Fast
  // Refresh injects an inline preamble). Future hardening: move drawio into an
  // isolated <iframe sandbox> with its own CSP so prod can drop 'unsafe-eval'.
  //
  // 'wasm-unsafe-eval' (both): @google/model-viewer's DRACO / KTX2 decoders
  // compile WebAssembly; this token permits ONLY wasm compilation.
  const scriptSrc = isDev
    ? ["'self'", "'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'"]
    : ["'self'", "'unsafe-eval'", "'wasm-unsafe-eval'"];

  // connect-src: most backend traffic goes through main over IPC, but the
  // renderer DOES make a few direct exits — TapDB analytics XHR to
  // https://e.tapdb.com (cn) / https://e.tapdb.ap-sg.tapapis.com (global),
  // model-viewer decoder fetches to https://www.gstatic.com,
  // and <model-viewer> fetch()-ing models over the xdt-model: / cindy-media:
  // schemes (mivo 老缓存与媒体总仓 GLB 各走各的协议). https: covers the first
  // two; the privileged schemes are listed explicitly (a privileged scheme
  // is its own origin and does not match https:/'self'). Allowing https:/wss:
  // is also a non-breaking hedge for any future direct fetch — safe because a
  // tight script-src stops an attacker from running code to abuse egress in
  // the first place. (The explicit apiBaseUrl origin entry was removed in the
  // 2026-07 apiBaseUrl cleanup: the https:(prod)/http:(dev) wildcards already
  // covered it, so the entry never changed the effective policy.)
  //
  // blob:: three.js GLTFLoader decodes GLB-embedded textures by wrapping the
  // bufferView bytes in URL.createObjectURL(blob) and loading it through
  // ImageBitmapLoader — which uses fetch(), governed by connect-src (NOT
  // img-src). Without blob: here the fetch is CSP-blocked, GLTFLoader swallows
  // the texture failure (`.catch(() => null)`), and every textured GLB renders
  // as an untextured white model. blob: URLs can only reference objects the
  // renderer itself created, so this grants no new network egress.
  const connectSrc = ["'self'", 'blob:', 'xdt-model:', 'cindy-media:'];
  if (isDev) {
    // Dev is not the attack surface (remote-debugging-port is already open in
    // dev); be permissive so HMR / dev tooling never breaks.
    if (devServerOrigin) connectSrc.push(devServerOrigin);
    connectSrc.push('ws:', 'wss:', 'http:', 'https:');
  } else {
    connectSrc.push('https:', 'wss:');
  }

  // Insertion order is preserved in the emitted string; default-src leads.
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': scriptSrc,
    // 'unsafe-inline': CodeMirror / ProseMirror (style-mod) and Vite inject
    // runtime <style> tags; fonts.googleapis.com: drawio viewer loads Google
    // Font stylesheets for sketch-font diagrams. Styles cannot execute JS.
    'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    'img-src': ["'self'", 'data:', 'blob:', 'https:', 'http:', ...CUSTOM_IMG_SCHEMES],
    'media-src': ["'self'", 'data:', 'blob:', 'https:', 'http:', ...CUSTOM_MEDIA_SCHEMES],
    'font-src': ["'self'", 'data:', 'https:'],
    'connect-src': connectSrc,
    // highlight.worker / pdfjs worker are same-origin module workers; blob:
    // covers bundler-emitted blob workers.
    'worker-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    // No <iframe> in the app renderer; the RSB <webview> is not governed by
    // frame-src. 'none' blocks an XSS-injected iframe.
    'frame-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
  };

  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}

/**
 * Attach the CSP injector to a session. Only top-level (`mainFrame`) document
 * responses get the header rewritten; every other response type is passed
 * through unmodified so custom-protocol Range/streaming responses are untouched.
 *
 * NOTE: Electron allows only one `onHeadersReceived` listener per session (a
 * later call REPLACES the earlier, silently). We guard our own side below —
 * double-installing on the same session is a no-op + warn. Electron exposes no
 * API to detect a *third-party* registration overwriting ours, so this must
 * stay the sole `onHeadersReceived` caller on `defaultSession`; any new consumer
 * must compose into this handler rather than register its own.
 */
const cspInstalledSessions = new WeakSet<Session>();

export function installContentSecurityPolicy(session: Session, ctx: CspContext): void {
  if (cspInstalledSessions.has(session)) {
    // Re-installing would silently replace our own listener — and hint that
    // some caller may be racing onHeadersReceived. Skip + warn instead.
    cspLog.warn('installContentSecurityPolicy called twice on the same session — ignoring the second call');
    return;
  }
  cspInstalledSessions.add(session);
  const policy = buildContentSecurityPolicy(ctx);
  session.webRequest.onHeadersReceived((details: OnHeadersReceivedListenerDetails, callback) => {
    // Only enforce on the app's own top-level document. Subresources (images,
    // media, scripts, styles) inherit protection from the document's CSP; a CSP
    // header on a non-document response is ignored by the engine anyway.
    if (details.resourceType !== 'mainFrame') {
      callback({});
      return;
    }
    // Only inject our CSP for app-owned documents (file:// in prod, dev-server
    // in dev). External URLs (e.g. the Feishu OAuth page loaded in the auth
    // window via defaultSession) must keep their own headers — our prod policy
    // has no 'unsafe-inline' and would silently break those third-party pages.
    const url = details.url ?? '';
    // Exact-origin match (not startsWith) so e.g. http://localhost:51730
    // cannot piggyback on a http://localhost:5173 dev origin.
    const isAppDocument =
      url.startsWith('file://') ||
      (ctx.devServerOrigin !== null && parseOrigin(url) === ctx.devServerOrigin);
    if (!isAppDocument) {
      callback({});
      return;
    }
    const responseHeaders: Record<string, string | string[]> = {
      ...(details.responseHeaders ?? {}),
    };
    // Drop any upstream CSP header (case-insensitive) so the engine does not
    // intersect two policies and silently over-tighten.
    for (const key of Object.keys(responseHeaders)) {
      const lower = key.toLowerCase();
      if (
        lower === 'content-security-policy' ||
        lower === 'content-security-policy-report-only'
      ) {
        delete responseHeaders[key];
      }
    }
    responseHeaders[CSP_HEADER] = [policy];
    callback({ responseHeaders });
  });
}
