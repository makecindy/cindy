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

  private notify(event: GhostSetupChangeEvent): void {
    for (const listener of this.listeners.get(event.ghostId) ?? []) {
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
}

const ghostSetupChangeBus = new GhostSetupChangeBus();

export function getGhostSetupChangeBus(): GhostSetupChangeBus {
  return ghostSetupChangeBus;
}
