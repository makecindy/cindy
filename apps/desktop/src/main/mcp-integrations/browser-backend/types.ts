// Browser backend abstraction (host-only).
//
// Why this layer exists
// ---------------------
// The vendored `@cindy/browser-control-runtime` drives a managed external Chrome
// via Playwright. We want to add a second control target — the RSB sidebar's
// embedded `<webview>` — without touching the vendored runtime (upstream sync
// stays clean) and without rewriting the MCP browser tool (@cindy/mcps keeps its
// single `runtime.call(req)` contract).
//
// The solution is a thin host-side router that implements `BrowserControlRuntime`
// itself and delegates each call to the currently-selected backend. Adding the
// RSB backend later is a self-contained drop-in — implement `BrowserBackend`,
// register it with the router, flip the toggle.
//
// Phase 1 scope: define the contract + an `ExternalChromeBackend` that wraps the
// vendored runtime 1:1 (zero behavior change). The router has exactly one backend
// registered; the toggle UI and the RSB backend land in Phase 3 / Phase 5.

import type {
  BrowserControlRequest,
  BrowserControlResult,
  BrowserControlRuntime,
} from '@cindy/browser-control-runtime';

/**
 * Discriminator for the active control target.
 *  - `'external'`: managed external Chromium (current product default).
 *  - `'rsb-webview'`: the sidebar's embedded `<webview>` tabs. Reserved — the
 *    backend itself lands in Phase 3.
 */
export type BackendKind = 'external' | 'rsb-webview';

/**
 * A swappable browser control target.
 *
 * Intentionally a superset of `BrowserControlRuntime`:
 *  - `call` matches the runtime contract verbatim so a backend (or the router)
 *    can be handed to @cindy/mcps as `getRuntime()` with no adapter shim.
 *  - `kind` lets the host introspect the active target (Settings UI, diagnostics).
 *  - `dispose` is the cleanup hook the router invokes when switching backends or
 *    on app quit. Idempotent + must never throw — runs inside the disposer chain.
 */
export interface BrowserBackend {
  readonly kind: BackendKind;
  call(request: BrowserControlRequest): Promise<BrowserControlResult>;
  dispose(): Promise<void>;
}

/**
 * Re-export the runtime contract under a neutral name so backend implementations
 * type their `.call` against the same shape @cindy/mcps consumes — without each
 * file having to import from the vendored package directly.
 */
export type BackendRequest = BrowserControlRequest;
export type BackendResult = BrowserControlResult;
export type BackendRuntimeShape = BrowserControlRuntime;
