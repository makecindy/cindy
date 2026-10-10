import { randomUUID } from 'node:crypto';

/** The actual workspace stays unchanged until the owning host can move safely. */
export interface DeferredProjectMoveTarget {
  workingDir: string | null;
  workspaceKind: 'project' | 'dialogue';
}

export interface DeferredProjectMoveIntent {
  id: string;
  sessionId: string;
  source: DeferredProjectMoveTarget;
  target: DeferredProjectMoveTarget;
}

/** Captured account generation; every journal operation must recheck it. */
export interface DeferredProjectMoveScope {
  key: string;
  assertCurrent(): void;
  read(sessionId: string): DeferredProjectMoveIntent | null;
  list(): DeferredProjectMoveIntent[];
  save(intent: DeferredProjectMoveIntent): void;
  remove(sessionId: string, expectedId: string): boolean;
}

export interface DeferredProjectMoveSettleOptions {
  /** The send transaction already owns this task's non-reentrant route lock. */
  lockHeld?: boolean;
  /** Busy probes must exclude the send transaction's own reserved queue item. */
  beforeSend?: boolean;
}

export type DeferredProjectMoveSettlement =
  'none' | 'busy' | 'applied' | 'cancelled' | 'superseded';

export interface DeferredProjectMoveDeps {
  captureScope(): DeferredProjectMoveScope;
  withSessionLock<T>(sessionId: string, run: () => Promise<T>): Promise<T>;
  readCurrentTarget(sessionId: string): Promise<DeferredProjectMoveTarget | null>;
  isBusy(sessionId: string, options: DeferredProjectMoveSettleOptions): Promise<boolean> | boolean;
  /** Owns normal move validation, transcript relocation and runtime closing. */
  applyMove(
    intent: DeferredProjectMoveIntent,
    options: { lockHeld: true; assertCurrent: () => void },
  ): Promise<void | 'busy'>;
  /** A display-only projection; never replace the runtime's workingDir. */
  publish(sessionId: string, target: { workingDir: string | null } | null): void;
  onFailure(sessionId: string, error: unknown): void;
}

export interface DeferredProjectMoveController {
  /** Caller holds the route lock and has validated the requested destination. */
  stage(
    sessionId: string,
    source: DeferredProjectMoveTarget,
    target: DeferredProjectMoveTarget,
  ): DeferredProjectMoveIntent | null;
  project(sessionId: string): { workingDir: string | null } | null;
  settle(
    sessionId: string,
    options?: DeferredProjectMoveSettleOptions,
  ): Promise<DeferredProjectMoveSettlement>;
  /** Startup and idle recovery; each task acquires only its own route lock. */
  drain(): Promise<void>;
}

function sameTarget(a: DeferredProjectMoveTarget, b: DeferredProjectMoveTarget): boolean {
  return a.workingDir === b.workingDir && a.workspaceKind === b.workspaceKind;
}

function projection(intent: DeferredProjectMoveIntent): { workingDir: string | null } {
  return {
    workingDir: intent.target.workspaceKind === 'dialogue' ? null : intent.target.workingDir,
  };
}

/**
 * Durable latest-choice reconciliation. The controller never stops a running
 * task or waits for one while holding its route lock. Failed moves clear only
 * their own intent; account changes and newer choices keep their own state.
 */
export function createDeferredProjectMoveController(
  deps: DeferredProjectMoveDeps,
): DeferredProjectMoveController {
  let projectionScope = '';
  let projections = new Map<string, DeferredProjectMoveIntent>();
  const backgroundSettlements = new Map<string, Promise<DeferredProjectMoveSettlement>>();
  const cached = (scope: DeferredProjectMoveScope) => {
    scope.assertCurrent();
    if (projectionScope !== scope.key) {
      const next = new Map(scope.list().map((intent) => [intent.sessionId, intent]));
      scope.assertCurrent();
      projections = next;
      projectionScope = scope.key;
    }
    return projections;
  };
  const isCurrent = (
    scope: DeferredProjectMoveScope,
    intent: DeferredProjectMoveIntent,
  ): boolean => {
    try {
      scope.assertCurrent();
    } catch {
      return false;
    }
    // Journal read failures are not proof that another request replaced this
    // one. Let them reject the send gate instead of dispatching in the old cwd.
    return scope.read(intent.sessionId)?.id === intent.id;
  };
  const clear = (scope: DeferredProjectMoveScope, intent: DeferredProjectMoveIntent): boolean => {
    scope.assertCurrent();
    if (!scope.remove(intent.sessionId, intent.id)) return false;
    cached(scope).delete(intent.sessionId);
    deps.publish(intent.sessionId, null);
    return true;
  };

  const settle: DeferredProjectMoveController['settle'] = async (sessionId, options = {}) => {
    const scope = deps.captureScope();
    const run = async (): Promise<DeferredProjectMoveSettlement> => {
      scope.assertCurrent();
      const intent = scope.read(sessionId);
      if (!intent) return 'none';
      cached(scope).set(sessionId, intent);
      const assertCurrent = () => {
        scope.assertCurrent();
        if (scope.read(sessionId)?.id !== intent.id) {
          throw new Error('PROJECT_MOVE_SUPERSEDED');
        }
      };
      try {
        const current = await deps.readCurrentTarget(sessionId);
        assertCurrent();
        if (current === null) {
          return clear(scope, intent) ? 'cancelled' : 'superseded';
        }
        // A crash after the DB commit but before clearing the intent must not
        // relocate transcripts again or close a freshly restored runtime.
        if (sameTarget(current, intent.target)) {
          return clear(scope, intent) ? 'applied' : 'superseded';
        }
        if (!sameTarget(current, intent.source)) {
          throw new Error('PROJECT_MOVE_SOURCE_CHANGED');
        }
        if (await deps.isBusy(sessionId, options)) {
          assertCurrent();
          return 'busy';
        }
        assertCurrent();
        const result = await deps.applyMove(intent, { lockHeld: true, assertCurrent });
        assertCurrent();
        if (result === 'busy') return 'busy';
        return clear(scope, intent) ? 'applied' : 'superseded';
      } catch (error) {
        if (!isCurrent(scope, intent)) return 'superseded';
        // Existing move handlers can fail in a notification after committing
        // the DB write. Do not announce a rollback that did not happen.
        const committed = await deps.readCurrentTarget(sessionId);
        if (!isCurrent(scope, intent)) return 'superseded';
        if (committed && sameTarget(committed, intent.target)) {
          return clear(scope, intent) ? 'applied' : 'superseded';
        }
        if (!clear(scope, intent)) return 'superseded';
        deps.onFailure(sessionId, error);
        return 'cancelled';
      }
    };
    // Do not coalesce with an in-flight idle settle here: that settle may be
    // waiting for the very route lock the caller already owns.
    return options.lockHeld ? run() : deps.withSessionLock(sessionId, run);
  };

  return {
    stage(sessionId, source, target) {
      const scope = deps.captureScope();
      const map = cached(scope);
      if (sameTarget(source, target)) {
        const previous = scope.read(sessionId);
        if (previous) clear(scope, previous);
        return null;
      }
      const intent: DeferredProjectMoveIntent = {
        id: randomUUID(),
        sessionId,
        source: { ...source },
        target: { ...target },
      };
      scope.save(intent);
      map.set(sessionId, intent);
      deps.publish(sessionId, projection(intent));
      return intent;
    },
    project(sessionId) {
      try {
        const scope = deps.captureScope();
        const intent = cached(scope).get(sessionId);
        return intent ? projection(intent) : null;
      } catch {
        // A display-only override must not make ordinary session reads fail
        // during sign-in/owner teardown or when its private journal is damaged.
        // Actual move/send paths still fail closed against the same record.
        return null;
      }
    },
    settle,
    async drain() {
      const scope = deps.captureScope();
      const intents = scope.list();
      const previous = cached(scope);
      const latest = new Map(intents.map((intent) => [intent.sessionId, intent]));
      for (const sessionId of new Set([...previous.keys(), ...latest.keys()])) {
        const old = previous.get(sessionId);
        const next = latest.get(sessionId);
        if (old?.id !== next?.id) deps.publish(sessionId, next ? projection(next) : null);
      }
      projections = latest;
      // Independent route locks must not turn one slow task into a global
      // migration queue. All settlements still validate their captured owner.
      const started: Promise<DeferredProjectMoveSettlement>[] = [];
      for (const intent of intents) {
        scope.assertCurrent();
        const key = `${scope.key}\0${intent.sessionId}`;
        // An earlier scan may still be waiting for this task's route lock.
        // New scans must remain free to start other tasks and new owners.
        if (backgroundSettlements.has(key)) continue;
        const settling = settle(intent.sessionId).finally(() => {
          if (backgroundSettlements.get(key) === settling) backgroundSettlements.delete(key);
        });
        backgroundSettlements.set(key, settling);
        started.push(settling);
      }
      const results = await Promise.allSettled(started);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    },
  };
}
