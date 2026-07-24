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
    for (const listener of this.listeners.get(ghostId) ?? []) {
      try {
        listener(event);
      } catch (error) {
        // Configuration writes have already committed by the time they emit.
        // A broken waiter must not turn that successful write into a failure
        // or prevent the remaining waiters from observing the revision.
        this.logger?.warn('ghost setup change listener failed', {
          ghostId,
          source: change.source,
          revision: event.revision,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
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
}

const ghostSetupChangeBus = new GhostSetupChangeBus();

export function getGhostSetupChangeBus(): GhostSetupChangeBus {
  return ghostSetupChangeBus;
}
