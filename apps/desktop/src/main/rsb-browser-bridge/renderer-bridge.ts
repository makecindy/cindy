/**
 * Main → renderer request/response bridge for tab operations.
 *
 * The RSB browser store is owned by the renderer (per-session bucket cache,
 * IPC writes to localDb, optimistic rollback). RsbWebviewBackend's `open` /
 * `focus` / `close` actions need to mutate that store from the main process,
 * which Electron doesn't natively support (no main → renderer invoke).
 *
 * Pattern: main sends a `request` with a fresh `reqId`, the renderer answers
 * via an `invoke` channel correlated by `reqId`. A pending-request map gates
 * resolution; timeouts and renderer destruction reject cleanly.
 *
 * Only one main-window renderer is in scope (no multi-window today). If a
 * renderer reload / crash happens mid-request the promise rejects via the
 * timeout; the backend turns that into an action-level error.
 */

import type { WebContents } from 'electron';
import { ipcMain } from 'electron';

import {
  RSB_BROWSER_BRIDGE_TAB_OP_REQUEST_CHANNEL,
  RSB_BROWSER_BRIDGE_TAB_OP_RESULT_CHANNEL,
  type RsbBrowserBridgeTabOp,
  type RsbBrowserBridgeTabOpRequest,
  type RsbBrowserBridgeTabOpResult,
} from '../../shared/rsbBrowserBridge.js';

interface BridgeLogger {
  warn(message: string, ...args: unknown[]): void;
}

interface PendingRequest {
  resolve: (result: RsbBrowserBridgeTabOpResult) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface RendererBridgeOptions {
  /** Resolves to the host renderer to talk to; null when no main window. */
  getHostWebContents: () => WebContents | null;
  /**
   * Optional pre-dispatch hook: awaited before resolving the host webContents.
   * Used by the detached right-sidebar window — when the user prefers the
   * sidebar in its own window but has it closed, this pops the window and
   * waits for its renderer's ready handshake so the tab-op has a live host.
   * Rejection fails the tab-op (no host to run it against).
   */
  ensureHost?: (sessionId?: string) => Promise<void>;
  /**
   * Whether the user currently prefers the sidebar in a detached window.
   * Consumers use it to decide if a tab-resolve miss is worth waiting on
   * (a detached window may be (re)opening and about to re-register its tabs)
   * or genuinely stale (embedded mode — the host main window never went away,
   * fail fast). Absent = embedded semantics.
   */
  isDetached?: () => boolean;
  logger: BridgeLogger;
  /** Per-request timeout (ms). Default 5000 — RSB store IPC is fast (<200ms typical). */
  timeoutMs?: number;
}

let registered = false;
const pending = new Map<string, PendingRequest>();

/**
 * Wire the renderer → main result handler. Idempotent.
 */
export function registerTabOpResultHandler(opts: RendererBridgeOptions): void {
  if (registered) return;
  registered = true;

  ipcMain.handle(RSB_BROWSER_BRIDGE_TAB_OP_RESULT_CHANNEL, (_e, payload: unknown) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, error: 'invalid result payload' };
    }
    const result = payload as RsbBrowserBridgeTabOpResult;
    if (typeof result.reqId !== 'string') {
      return { ok: false, error: 'missing reqId' };
    }
    const entry = pending.get(result.reqId);
    if (!entry) {
      // Timed-out request — renderer answered too late. Acknowledge and drop.
      opts.logger.warn('tab-op result for unknown reqId', { reqId: result.reqId });
      return { ok: true };
    }
    pending.delete(result.reqId);
    clearTimeout(entry.timeout);
    entry.resolve(result);
    return { ok: true };
  });
}

/**
 * Push a tab-op request to the renderer and await its result. Rejects on:
 *   - host webContents unavailable (no main window)
 *   - timeout (no answer within `timeoutMs`)
 *   - host webContents destroyed mid-flight
 *
 * Caller (RsbWebviewBackend) decides how to map errors back to the
 * `BrowserControlResult` shape.
 */
export async function dispatchTabOp(
  op: RsbBrowserBridgeTabOp,
  opts: RendererBridgeOptions,
  assertActive?: () => void,
  dispatchOptions: { ensureHost?: boolean } = {},
): Promise<RsbBrowserBridgeTabOpResult> {
  assertActive?.();
  if (dispatchOptions.ensureHost !== false && opts.ensureHost) {
    const sessionId = 'sessionId' in op ? op.sessionId : undefined;
    await opts.ensureHost(sessionId);
    assertActive?.();
  }
  const wc = opts.getHostWebContents();
  if (!wc || wc.isDestroyed()) {
    return Promise.reject(new Error('host renderer not available'));
  }

  // Cheap unique id; collision probability is astronomically small for the
  // ~1s lifetime of a request, no need for crypto-grade randomness.
  const reqId = `rsb-tab-op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  // Spreading op (a discriminated union) into the full request keeps the
  // resulting object's `op` discriminator intact for the renderer side.
  const fullReq = { reqId, ...op } as RsbBrowserBridgeTabOpRequest;
  const timeoutMs = opts.timeoutMs ?? 5000;

  return new Promise<RsbBrowserBridgeTabOpResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pending.delete(reqId)) {
        reject(new Error(`tab-op '${op.op}' timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    pending.set(reqId, { resolve, reject, timeout });
    try {
      assertActive?.();
      wc.send(RSB_BROWSER_BRIDGE_TAB_OP_REQUEST_CHANNEL, fullReq);
    } catch (err) {
      if (pending.delete(reqId)) {
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  });
}

/** Test-only reset of internal state. */
export function _resetRendererBridgeForTests(): void {
  registered = false;
  for (const entry of pending.values()) {
    clearTimeout(entry.timeout);
    entry.reject(new Error('bridge reset (test)'));
  }
  pending.clear();
}
