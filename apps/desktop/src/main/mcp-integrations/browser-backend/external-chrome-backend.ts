// External Chrome backend — delegates to the vendored `BrowserControlRuntime`.
//
// This is the existing (and, in Phase 1, only) backend. It exists so the host
// can talk to *any* control target through the same `BrowserBackend` contract,
// with an explicit backend identity added to status results. Other calls are
// passed through, and `dispose` reuses the existing electron-free
// `stopRuntimeForQuit` (which already swallows errors per the quit-path
// contract — see browser-dispose.ts).

import { stopRuntimeForQuit } from '../browser-dispose.js';
import type {
  BackendRequest,
  BackendResult,
  BackendRuntimeShape,
  BrowserBackend,
} from './types.js';

/** Minimal logger surface used here — matches the unified logger's `warn`. */
interface BackendLogger {
  warn(message: string, ...args: unknown[]): void;
}

export class ExternalChromeBackend implements BrowserBackend {
  readonly kind = 'external' as const;

  constructor(
    private readonly runtime: BackendRuntimeShape,
    private readonly logger: BackendLogger,
  ) {}

  async call(request: BackendRequest): Promise<BackendResult> {
    const result = await this.runtime.call(request);
    if (request.action !== 'status') return result;
    // Both backends identify themselves explicitly; the agent must not confuse
    // the Cindy Chrome profile with the sidebar's embedded browser.
    const data = result.data && typeof result.data === 'object' ? result.data : {};
    return { ...result, data: { ...data, backend: this.kind } };
  }

  /**
   * Quit-time cleanup. Stops the managed Chrome process so it does not outlive
   * the app. Delegates to `stopRuntimeForQuit`, which logs-and-swallows so the
   * disposer chain cannot stall here.
   *
   * Idempotent: a follow-up `stop` against an already-stopped runtime is a
   * no-op at the vendored layer; safe to call multiple times across backend
   * switches and app quit.
   */
  dispose(): Promise<void> {
    return stopRuntimeForQuit(this.runtime, this.logger);
  }
}
