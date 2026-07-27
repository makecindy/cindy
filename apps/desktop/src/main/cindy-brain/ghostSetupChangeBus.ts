/**
 * GhostSetupChangeBus is the process-local wake-up channel for plugin setup.
 *
 * Events deliberately contain only identity and revision metadata. Consumers
 * must re-read the manifest and credential stores after every event instead
 * of treating a successful write as proof that the whole setup is ready.
 */

export type GhostSetupChangeSource =
  | 'oauth'
  | 'kv'
  | 'secret'
  | 'connection'
  | 'manifest'
  | 'host_config'
  | 'workdir_policy'
  // 运行期探测(networkSlot 凭证被拒、健康探活):不携带配置已变的承诺,
  // 订阅方重新评估后自行判断 readiness 是否变化。
  | 'runtime_probe'
  | 'focus';

export interface GhostSetupChangeEvent {
  ghostId: string;
  source: GhostSetupChangeSource;
  ref?: string;
  revision: number;
}

export type GhostSetupChangeListener = (event: GhostSetupChangeEvent) => void;

export class GhostSetupChangeBus {
  private readonly revisions = new Map<string, number>();
  private readonly listeners = new Map<string, Set<GhostSetupChangeListener>>();

  constructor(
    private readonly logger?: {
      warn: (message: string, context?: Record<string, unknown>) => void;
    },
  ) {}

  currentRevision(ghostId: string): number {
    return this.revisions.get(ghostId) ?? 0;
  }

  emit(
    ghostId: string,
    change: { source: GhostSetupChangeSource; ref?: string },
  ): GhostSetupChangeEvent {
    const event: GhostSetupChangeEvent = {
      ghostId,
      source: change.source,
      ...(change.ref ? { ref: change.ref } : {}),
      revision: this.currentRevision(ghostId) + 1,
    };
    this.revisions.set(ghostId, event.revision);
    this.notify(event);
    return event;
  }

  /**
   * Re-assess one pending plugin without claiming that configuration changed.
   * This is for external-completion probes such as returning focus after an
   * OAuth flow. The current revision is preserved so an accepted setup plan
   * does not become stale merely because the app regained focus.
   */
  wake(
    ghostId: string,
    change: { source: GhostSetupChangeSource; ref?: string },
  ): GhostSetupChangeEvent {
    const event: GhostSetupChangeEvent = {
      ghostId,
      source: change.source,
      ...(change.ref ? { ref: change.ref } : {}),
      revision: this.currentRevision(ghostId),
    };
    this.notify(event);
    return event;
  }

  /**
   * Wake every currently waiting plugin after a shared Host configuration
   * change. Subscribers re-assess their own manifest-declared requirements;
   * the event carries no plugin/provider routing table.
   */
  emitAll(change: { source: GhostSetupChangeSource; ref?: string }): GhostSetupChangeEvent[] {
    return Array.from(this.listeners.keys()).map((ghostId) => this.emit(ghostId, change));
  }

  subscribe(ghostId: string, listener: GhostSetupChangeListener): () => void {
    let listeners = this.listeners.get(ghostId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(ghostId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.listeners.delete(ghostId);
    };
  }

  /**
   * Subscribe to every plugin's change events(e.g. the lifecycle projection
   * broadcaster, which re-reads all stores on any signal). Distinct from
   * emitAll: this receives events for ghostIds that have no keyed subscriber.
   */
  subscribeAll(listener: GhostSetupChangeListener): () => void {
    this.wildcardListeners.add(listener);
    return () => {
      this.wildcardListeners.delete(listener);
    };
  }

  private notify(event: GhostSetupChangeEvent): void {
    const targets = [
      ...(this.listeners.get(event.ghostId) ?? []),
      ...this.wildcardListeners,
    ];
    for (const listener of targets) {
      try {
        listener(event);
      } catch (error) {
        // A wake follows either an already committed write or a metadata-only
        // probe. A broken waiter must not affect other subscribers.
        this.logger?.warn('ghost setup change listener failed', {
          ghostId: event.ghostId,
          source: event.source,
          revision: event.revision,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private readonly wildcardListeners = new Set<GhostSetupChangeListener>();
}

const ghostSetupChangeBus = new GhostSetupChangeBus();

export function getGhostSetupChangeBus(): GhostSetupChangeBus {
  return ghostSetupChangeBus;
}
