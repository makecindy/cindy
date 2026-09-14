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

  probeActiveControl(options?: { ensureHost?: boolean }): Promise<void> {
    return this.router.probeActiveControl(options);
  }

  setKind(
    kind: BackendKind,
    persistKind: ((kind: BackendKind) => void | Promise<void>) | undefined = this.opts.persistKind,
  ): Promise<boolean> {
    return this.enqueue(async () => {
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
    return this.enqueue(async () => {
      if (this.router.getCurrentBackendKind() !== 'rsb-webview') return false;
      await this.router.restartBackend(this.createBackend('rsb-webview'));
      return true;
    });
  }

  dispose(): Promise<void> {
    return this.enqueue(() => this.router.dispose());
  }

  private createBackend(kind: BackendKind): BrowserBackend {
    const backend = kind === 'external' ? this.opts.externalBackend : this.opts.createRsbBackend();
    if (backend.kind !== kind) {
      throw new Error(`browser backend factory returned ${backend.kind} for ${kind}`);
    }
    return backend;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transition.then(operation, operation);
    this.transition = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
