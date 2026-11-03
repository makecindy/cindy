import type { BackendKind, BackendRequest, BackendResult, BrowserBackend } from './types.js';
import { BackendRouter } from './router.js';

interface ControllerLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

export interface BrowserBackendControllerOptions {
  initialKind: BackendKind;
  externalBackend: BrowserBackend;
  createRsbBackend: () => BrowserBackend;
  /** 用户浏览器(经扩展)后端工厂;实例无状态可重建,桥接归插件槽所有。缺省 = 该目标不可选。 */
  createUserBrowserBackend?: () => BrowserBackend;
  /** Save explicit selections inside the existing transition queue. */
  persistKind?: (kind: BackendKind) => void;
  logger: ControllerLogger;
}

/**
 * Owns the process-wide backend lifecycle above `BackendRouter`.
 *
 * `RsbWebviewBackend.dispose()` is terminal: its listeners and helper state are
 * deliberately torn down and the instance must never be installed again. The
 * controller therefore keeps the reusable external wrapper but treats every
 * RSB activation/recovery as a factory operation. Transitions are serialized so
 * two Settings actions cannot dispose a backend that a later action just made
 * active.
 */
export class BrowserBackendController implements BrowserBackend {
  private readonly router: BackendRouter;
  private transition: Promise<void> = Promise.resolve();

  constructor(private readonly opts: BrowserBackendControllerOptions) {
    this.router = new BackendRouter(this.createBackend(opts.initialKind), opts.logger);
  }

  get kind(): BackendKind {
    return this.router.kind;
  }

  call(request: BackendRequest): Promise<BackendResult> {
    return this.router.call(request);
  }

  getCurrentBackendKind(): BackendKind {
    return this.router.getCurrentBackendKind();
  }

  /** Reuse existing lifecycle references; no second generation counter or queue. */
  getBackendScope(): { lifecycle: object; backend: object } {
    return { lifecycle: this.transition, backend: this.router.getBackendIdentity() };
  }

  probeActiveControl(options?: { ensureHost?: boolean }): Promise<void> {
    return this.router.probeActiveControl(options);
  }

  setKind(
    kind: BackendKind,
    persistKind: ((kind: BackendKind) => void | Promise<void>) | undefined = this.opts.persistKind,
  ): Promise<boolean> {
    return this.runLifecycle(async () => {
      const changed = this.router.getCurrentBackendKind() !== kind;
      const next = changed ? this.createBackend(kind) : undefined;
      // Save before activation: a disk failure must leave the old backend live.
      // Factories are lazy; router swaps cannot fail on outgoing disposal.
      // Reset supplies its clear-override operation in this same queue.
      await persistKind?.(kind);
      if (next) await this.router.setBackend(next);
      return changed;
    });
  }

  /** Replace the active embedded backend even though its kind is unchanged. */
  restartEmbedded(): Promise<boolean> {
    return this.runLifecycle(async () => {
      if (this.router.getCurrentBackendKind() !== 'rsb-webview') return false;
      await this.router.restartBackend(this.createBackend('rsb-webview'));
      return true;
    });
  }

  dispose(): Promise<void> {
    return this.runLifecycle(() => this.router.dispose());
  }

  private createBackend(kind: BackendKind): BrowserBackend {
    const backend =
      kind === 'external'
        ? this.opts.externalBackend
        : kind === 'user-browser'
          ? this.createUserBrowserBackend()
          : this.opts.createRsbBackend();
    if (backend.kind !== kind) {
      throw new Error(`browser backend factory returned ${backend.kind} for ${kind}`);
    }
    return backend;
  }

  /**
   * One owner for backend and copied-login identity changes. Callers that also
   * need the profile queue acquire it inside this operation, matching reset.
   * Ordinary page calls bypass this lifecycle queue.
   */
  private createUserBrowserBackend(): BrowserBackend {
    if (!this.opts.createUserBrowserBackend)
      throw new Error('user browser backend factory not configured');
    return this.opts.createUserBrowserBackend();
  }

  runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transition.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.transition = settled;
    return result.finally(() => {
      // Evidence produced during a same-kind change must expire on settlement,
      // including when another change is still queued. Preserve that entire
      // queue in the new tail instead of resetting it to an already-done promise.
      this.transition = this.transition.then(() => undefined);
    });
  }
}

/**
 * Resolve the `profile` a browser request addresses for the active backend.
 *
 * - rsb-webview has exactly one profile.
 * - external Chrome falls back to the managed profile when the agent names none.
 * - The user's own browser has no managed profile: `profile` there is an
 *   extension connection id chosen by the agent, so the managed Chrome profile
 *   name must never be substituted (it would match no connection).
 */
export function resolveBackendProfile(
  kind: BackendKind,
  profile: string | undefined,
  managedProfile: () => string,
): string | undefined {
  if (kind === 'rsb-webview') return 'rsb';
  if (kind === 'user-browser') return profile;
  return profile || managedProfile();
}
