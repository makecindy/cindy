import { createSessionCapabilityRefreshCoordinator, type CapabilityRefreshSession } from './sessionCapabilityRefresh.js';

export interface CapabilityResourceSnapshot {
  /** Opaque digest only. Never publish resource contents or configuration. */
  revision: string;
  watchPaths: readonly string[];
  mcpRevision?: string;
  discoveryErrorRevision?: string;
}

/** Resource discovery is owned by the native adapters. This controller only
 * compares their snapshots and serializes reloads with the host send lease. */
export function createSessionCapabilityMonitor<T extends CapabilityRefreshSession>(deps: {
  isCurrent(session: T): boolean;
  isIdle(session: T): boolean;
  current?(sessionId: string): T | undefined;
  read(session: T): Promise<CapabilityResourceSnapshot>;
  reload(session: T, isCurrent: () => boolean): Promise<T>;
  changed(session: T): void;
}) {
  const snapshots = new WeakMap<T, Promise<CapabilityResourceSnapshot>>();
  const coordinator = createSessionCapabilityRefreshCoordinator<T>({
    isCurrent: deps.isCurrent,
    isIdle: deps.isIdle,
    onStateChanged: deps.changed,
    refresh: async (session, isCurrent) => {
      // Read before closing: a broken discovery/read leaves the old process intact.
      const target = await deps.read(session);
      const previous = await track(session);
      if (target.discoveryErrorRevision && target.discoveryErrorRevision !== previous.discoveryErrorRevision) {
        throw new Error('Changed native capability resources could not be discovered');
      }
      if (!isCurrent()) throw new Error('Capability refresh superseded');
      const replacement = await deps.reload(session, isCurrent);
      snapshots.set(replacement, Promise.resolve(target));
      return replacement;
    },
  });

  function track(session: T): Promise<CapabilityResourceSnapshot> {
    let snapshot = snapshots.get(session);
    if (!snapshot) {
      snapshot = deps.read(session);
      snapshots.set(session, snapshot);
      // Keep a failed baseline observable to beforeSend without an unhandled rejection.
      void snapshot.catch(() => {
        if (snapshots.get(session) !== snapshot) return;
        snapshots.delete(session);
        coordinator.markFailed(session);
        deps.changed(session);
      });
    }
    return snapshot;
  }

  async function check(session: T): Promise<void> {
    if (!deps.isCurrent(session)) return;
    try {
      const previous = await track(session);
      const current = await deps.read(session);
      if (deps.isCurrent(session) && previous.revision !== current.revision) {
        if (current.discoveryErrorRevision && current.discoveryErrorRevision !== previous.discoveryErrorRevision) {
          throw new Error('Changed native capability resources could not be discovered');
        }
        coordinator.markChanged(session);
        deps.changed(session);
      }
    } catch (error) {
      if (coordinator.state(session)?.phase !== 'failed') coordinator.markFailed(session);
      deps.changed(session);
      throw error;
    }
  }

  async function beforeSend(session: T) {
    let current = session;
    for (;;) {
      if (!deps.isCurrent(current)) return { kind: 'superseded' as const };
      try { await check(current); }
      catch (error) {
        coordinator.markFailed(current);
        deps.changed(current);
        return { kind: 'failed' as const, error };
      }
      const outcome = await coordinator.beforeSend(current);
      if (outcome.kind === 'superseded') {
        const replacement = deps.current?.(current.id);
        if (replacement && replacement !== current) { current = replacement; continue; }
      }
      if (outcome.kind !== 'refreshed') { deps.changed(current); return outcome; }
      current = outcome.session;
      try { await check(current); }
      catch (error) {
        coordinator.markFailed(current);
        deps.changed(current);
        return { kind: 'failed' as const, error };
      }
      const state = coordinator.state(current);
      if (state?.appliedRevision === state?.revision) { deps.changed(current); return outcome; }
    }
  }

  function markChanged(session: T): void {
    coordinator.markChanged(session);
    deps.changed(session);
  }

  function blocksInput(session: T): boolean {
    const phase = coordinator.state(session)?.phase;
    return phase === 'pending' || phase === 'refreshing';
  }

  return { track, check, beforeSend, markChanged, blocksInput, state: coordinator.state,
    adopt: (session: T, snapshot: CapabilityResourceSnapshot) => snapshots.set(session, Promise.resolve(snapshot)),
    forget: coordinator.forget, clear: coordinator.clear };
}
