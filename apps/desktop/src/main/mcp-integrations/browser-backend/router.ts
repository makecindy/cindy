// BackendRouter — routes `BrowserControlRuntime.call` to the active backend.
//
// The router is itself a `BrowserBackend` (and therefore a `BrowserControlRuntime`,
// since `.call` matches verbatim). Handing the router to @cindy/mcps as
// `getRuntime()` means the MCP tool layer never sees the backend split — the
// abstraction sits entirely inside the host.
//
// Concurrency note: `setBackend` is async (it disposes the outgoing backend),
// but `.call` is synchronous-dispatch — it reads `this.current` at call time
// and delegates. An in-flight `.call` against the outgoing backend completes
// against that backend's still-live resources; the dispose runs only after the
// new backend is installed. The exact handoff semantics (drain vs. abort
// in-flight calls) become product-relevant once the toggle UI ships in Phase 5;
// for Phase 1 there is only one backend so the path is exercised but never
// switches.

import type { BackendKind, BackendRequest, BackendResult, BrowserBackend } from './types.js';

interface RouterLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

export class BackendRouter implements BrowserBackend {
  /**
   * Proxy to the active backend's kind. Same value as `getCurrentBackendKind()` —
   * both exist because `BrowserBackend.kind` is part of the contract (so the
   * router can transparently nest behind another router someday) while
   * `getCurrentBackendKind()` is the explicit API surface for diagnostics /
   * Settings UI to read.
   */
  get kind(): BackendKind {
    return this.current.kind;
  }

  private current: BrowserBackend;

  constructor(initial: BrowserBackend, private readonly logger: RouterLogger) {
    this.current = initial;
  }

  call(request: BackendRequest): Promise<BackendResult> {
    return this.current.call(request);
  }

  /**
   * Read the active backend kind. Synchronous — Settings UI / diagnostics use
   * this to render the current state.
   */
  getCurrentBackendKind(): BackendKind {
    return this.current.kind;
  }

  /** Verify the active backend's real control path when it exposes a probe. */
  async probeActiveControl(options?: { ensureHost?: boolean }): Promise<void> {
    await this.current.probeControl?.(options);
  }

  /**
   * Hot-swap the active backend.
   *
   * Disposes the OUTGOING backend after the new one is installed so any
   * `.call` racing the swap completes against a still-live target. Disposal
   * errors are logged and swallowed — the swap itself must always succeed
   * from the caller's perspective (the new backend is already in place).
   *
   * Same-instance swaps are a no-op (idempotent on repeated toggles).
   */
  async setBackend(next: BrowserBackend): Promise<void> {
    if (this.current === next) return;
    const previous = this.current;
    this.current = next;
    this.logger.info('browser backend switched', {
      from: previous.kind,
      to: next.kind,
    });
    try {
      await previous.dispose();
    } catch (err) {
      this.logger.warn('outgoing backend dispose threw (ignored)', err);
    }
  }

  /**
   * Rebuild a backend without overlapping two instances of the same kind.
   *
   * RSB instances share Electron debugger attachments on the user's existing
   * webview tabs. Installing the replacement before the old instance releases
   * those attachments lets late old cleanup detach the new monitor. A
   * same-kind recovery therefore disposes first; calls during the short grace
   * period still hit the old backend and receive its actionable restarting
   * result, then all later calls reach the replacement.
   */
  async restartBackend(next: BrowserBackend): Promise<void> {
    if (this.current === next) return;
    const previous = this.current;
    if (previous.kind !== next.kind) {
      throw new Error(`browser backend restart kind mismatch: ${previous.kind} -> ${next.kind}`);
    }
    try {
      await previous.dispose();
    } catch (err) {
      this.logger.warn('restarted backend dispose threw (ignored)', err);
    }
    this.current = next;
    this.logger.info('browser backend restarted', { kind: next.kind });
  }

  /**
   * App-quit cleanup. Disposes the currently-active backend.
   *
   * Backend `dispose` is contractually no-throw, but a future backend
   * implementation could violate that — and a throw here would stall the
   * lifecycle disposer chain (the exact thing that contract is meant to
   * prevent). Belt-and-suspenders: catch + warn here so this stays safe even
   * if a contract violation slips in.
   */
  async dispose(): Promise<void> {
    try {
      await this.current.dispose();
    } catch (err) {
      this.logger.warn('active backend dispose threw (ignored on quit path)', err);
    }
  }
}
