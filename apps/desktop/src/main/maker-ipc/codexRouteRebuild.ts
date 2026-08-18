import type { AgentCredentialMode, AgentKind } from '@cindy/maker-core';

import {
  isCredentialModeSwitchBusyError,
  isLocalSessionBusy,
  prepareLocalSessionCredentialModeSwitch,
} from '../maker-host/codex-credential-switch.js';
import {
  codexThreadRotationSnapshotFromSession,
  isCodexThreadRotationSupersededError,
  type CodexThreadRotationSnapshot,
  type PrepareCodexThreadRotation,
  type PreparedCodexThreadRotation,
} from './codexThreadRotation.js';

const DEFAULT_RETRY_DELAY_MS = 10_000;

export interface CodexRouteRebuildSession {
  id: string;
  instanceId: string;
  agentKind: AgentKind;
  remoteHostId?: string | null;
  model: string;
  sdkSessionId?: string | null;
  workDir?: string | null;
  providerId?: string | null;
  codexRouteRequiresCodeModeOnly?: boolean;
  codexRouteCredentialMode?: AgentCredentialMode;
  isTurnRunning?: () => boolean;
}

export interface CodexRouteRebuildDeps {
  maker: {
    listActiveSessions: () => CodexRouteRebuildSession[];
    closeSession: (sessionId: string) => Promise<void>;
  };
  /** Interrupt the current turn before its live proxy route can drift further. */
  abortSession: (sessionId: string) => Promise<void>;
  /** Serialize thread rotation/close with every local Session.send route decision. */
  withSessionLock: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>;
  isSessionInTurn?: (sessionId: string) => boolean;
  /** True while Provider routing is intentionally between committed snapshots. */
  isReconciliationBlocked?: () => boolean;
  /** Changes whenever a Provider route mutation starts, including transient ones. */
  getReconciliationGeneration?: () => number;
  resolveRequiresCodeModeOnly: (session: CodexRouteRebuildSession) => Promise<boolean>;
  getProviderId?: (sessionId: string) => string | null;
  prepareCodexThreadRotation?: PrepareCodexThreadRotation;
  onApplied?: (sessionId: string) => void;
  retryDelayMs?: number;
  logger?: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
  };
}

interface PendingRouteRebuild {
  instanceId: string;
  revision: number;
  abortRequested: boolean;
  /** Set only after the live catalog comparison confirms a capability change. */
  requiresThreadRotation?: boolean;
  /** A close arrived while the async capability comparison was still pending. */
  closeObserved?: boolean;
  threadRotation?: CodexThreadRotationSnapshot;
  preparedThreadRotation?: PreparedCodexThreadRotation;
}

/**
 * Rebuilds only local Codex sessions whose thread-frozen CodeModeOnly value no
 * longer matches the live catalog route. Busy sessions remain queue-gated
 * until their terminal boundary; provider/model persistence is untouched.
 */
export class CodexRouteRebuildService {
  private readonly pending = new Map<string, PendingRouteRebuild>();
  private readonly interrupting = new Set<string>();
  private readonly applying = new Set<string>();
  private readonly rotationTasks = new Set<Promise<boolean>>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reconcileGeneration = 0;
  private lifecycleGeneration = 0;
  private lifecycleAbortController = new AbortController();

  constructor(private readonly deps: CodexRouteRebuildDeps) {}

  has(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  async reconcile(revision: number): Promise<void> {
    if (this.deps.isReconciliationBlocked?.() === true) return;
    const routeGeneration = this.deps.getReconciliationGeneration?.();
    const generation = ++this.reconcileGeneration;
    let sessions: CodexRouteRebuildSession[];
    try {
      sessions = this.deps.maker
        .listActiveSessions()
        .filter(
          (session) =>
            session.agentKind === 'codex' &&
            !session.remoteHostId &&
            typeof session.codexRouteRequiresCodeModeOnly === 'boolean',
        );
    } catch (error) {
      this.deps.logger?.warn('catalog route rebuild scan failed', {
        revision,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    // The proxy observes the new catalog immediately, while capability
    // resolution can await connected Provider state. Gate every candidate
    // before that await so no later tool round can reuse the old thread
    // profile against the new live route.
    for (const session of sessions) {
      const previous = this.pending.get(session.id);
      if (previous?.instanceId === session.instanceId) {
        previous.revision = revision;
        if (!previous.abortRequested) {
          // A new catalog revision invalidates the prior comparison. Keep the
          // candidate gated, but do not let a close race reuse the old result.
          previous.requiresThreadRotation = undefined;
          previous.closeObserved = false;
        }
      } else {
        this.pending.set(session.id, {
          instanceId: session.instanceId,
          revision,
          abortRequested: false,
          threadRotation: this.snapshotFor(session),
        });
      }
      this.scheduleRetry(session.id);
    }

    const comparisons = await Promise.all(
      sessions.map(async (session) => {
        let current: boolean;
        try {
          current = await this.deps.resolveRequiresCodeModeOnly(session);
        } catch (error) {
          this.deps.logger?.warn('catalog route capability resolve failed', {
            revision,
            sessionId: session.id,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
        if (
          generation !== this.reconcileGeneration ||
          this.deps.isReconciliationBlocked?.() === true ||
          this.deps.getReconciliationGeneration?.() !== routeGeneration
        ) {
          return null;
        }
        await this.applyComparison(session, current, revision);
        return { session, current } as const;
      }),
    );
    if (generation !== this.reconcileGeneration) return;
    if (this.deps.isReconciliationBlocked?.() === true) return;
    if (this.deps.getReconciliationGeneration?.() !== routeGeneration) return;

    const scannedIds = new Set(sessions.map((session) => session.id));
    for (const [sessionId, pending] of [...this.pending]) {
      if (
        !scannedIds.has(sessionId) &&
        !this.interrupting.has(sessionId) &&
        !this.applying.has(sessionId)
      ) {
        this.finish(sessionId, pending.instanceId, 'session no longer eligible');
      }
    }
    // A session can close while its comparison is in flight. If that lookup
    // failed, retire the gate without rotating; there is no positive evidence
    // that the thread crossed a CodeModeOnly boundary.
    const comparedIds = new Set(
      comparisons.filter((comparison): comparison is { session: CodexRouteRebuildSession; current: boolean } =>
        comparison !== null,
      ).map(({ session }) => session.id),
    );
    for (const session of sessions) {
      const pending = this.pending.get(session.id);
      if (
        pending?.instanceId === session.instanceId &&
        pending.closeObserved &&
        !comparedIds.has(session.id)
      ) {
        this.finish(session.id, pending.instanceId, 'capability comparison failed after session close');
      }
    }
  }

  onTurnSettled(sessionId: string): Promise<void> {
    return this.tryApply(sessionId);
  }

  onSessionClosed(sessionId: string): void {
    if (this.interrupting.has(sessionId) || this.applying.has(sessionId)) return;
    const pending = this.pending.get(sessionId);
    if (!pending) return;
    // The close may race the asynchronous catalog comparison. Do not fork a
    // new thread until that comparison has positively confirmed a capability
    // change; a failed or still-pending lookup must not rotate an unchanged
    // session as a side effect of an unrelated close.
    if (pending.requiresThreadRotation === false) {
      this.finish(sessionId, pending.instanceId, 'catalog capability unchanged');
      return;
    }
    pending.closeObserved = true;
    if (pending.requiresThreadRotation !== true) return;
    this.applying.add(sessionId);
    void (async () => {
      await this.deps.withSessionLock(sessionId, async () => {
        if (this.pending.get(sessionId) !== pending) return;
        if (!(await this.prepareThreadRotation(sessionId, pending))) return;
        if (this.deps.isReconciliationBlocked?.() === true) {
          this.scheduleRetry(sessionId);
          return;
        }
        this.finish(sessionId, pending.instanceId, 'session closed');
      });
    })()
      .catch((error) => {
        this.deps.logger?.warn('catalog route rebuild close-boundary rotation failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        this.scheduleRetry(sessionId);
      })
      .finally(() => {
        this.applying.delete(sessionId);
      });
  }

  clear(): void {
    void this.clearAsync();
  }

  async clearAsync(): Promise<void> {
    this.reconcileGeneration += 1;
    this.lifecycleGeneration += 1;
    this.lifecycleAbortController.abort();
    this.lifecycleAbortController = new AbortController();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.interrupting.clear();
    const prepared = [...this.pending.values()]
      .map((pending) => pending.preparedThreadRotation)
      .filter((rotation): rotation is PreparedCodexThreadRotation => rotation !== undefined);
    this.pending.clear();
    await Promise.allSettled([
      ...prepared.map((rotation) => rotation.rollback()),
      ...this.rotationTasks,
    ]);
  }

  private async tryApply(sessionId: string): Promise<void> {
    const pending = this.pending.get(sessionId);
    if (!pending || this.interrupting.has(sessionId) || this.applying.has(sessionId)) return;
    if (!pending.abortRequested && this.deps.isReconciliationBlocked?.() === true) {
      this.scheduleRetry(sessionId);
      return;
    }
    const routeGeneration = this.deps.getReconciliationGeneration?.();
    const lifecycleGeneration = this.lifecycleGeneration;
    const signal = this.lifecycleAbortController.signal;

    let session: CodexRouteRebuildSession | undefined;
    try {
      session = this.deps.maker
        .listActiveSessions()
        .find((candidate) => candidate.id === sessionId);
    } catch (error) {
      this.deps.logger?.warn('catalog route rebuild live-session read failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleRetry(sessionId);
      return;
    }
    if (!session) {
      pending.closeObserved = true;
      if (pending.requiresThreadRotation !== true) {
        if (pending.requiresThreadRotation === false) {
          this.finish(sessionId, pending.instanceId, 'catalog capability unchanged');
        } else {
          this.scheduleRetry(sessionId);
        }
        return;
      }
      await this.deps.withSessionLock(sessionId, async () => {
        if (this.pending.get(sessionId) !== pending) return;
        const currentSession = this.deps.maker
          .listActiveSessions()
          .find((candidate) => candidate.id === sessionId);
        if (currentSession) {
          if (currentSession.instanceId !== pending.instanceId) {
            this.finish(sessionId, pending.instanceId, 'session incarnation changed');
          } else {
            this.scheduleRetry(sessionId);
          }
          return;
        }
        if (pending.threadRotation && !pending.preparedThreadRotation) {
          if (!(await this.prepareThreadRotation(sessionId, pending))) return;
        }
        if (
          this.deps.isReconciliationBlocked?.() === true ||
          this.deps.getReconciliationGeneration?.() !== routeGeneration
        ) {
          this.scheduleRetry(sessionId);
          return;
        }
        this.finish(sessionId, pending.instanceId, 'session already closed');
      });
      return;
    }
    if (
      session.instanceId !== pending.instanceId ||
      session.agentKind !== 'codex' ||
      session.remoteHostId ||
      typeof session.codexRouteRequiresCodeModeOnly !== 'boolean'
    ) {
      this.finish(sessionId, pending.instanceId, 'session incarnation changed');
      return;
    }

    if (!pending.abortRequested) {
      let current: boolean;
      try {
        current = await this.deps.resolveRequiresCodeModeOnly(session);
      } catch (error) {
        this.deps.logger?.warn('catalog route rebuild revalidation failed', {
          sessionId,
          revision: pending.revision,
          error: error instanceof Error ? error.message : String(error),
        });
        this.scheduleRetry(sessionId);
        return;
      }
      if (
        lifecycleGeneration !== this.lifecycleGeneration ||
        signal.aborted ||
        this.pending.get(sessionId) !== pending
      )
        return;
      if (this.deps.isReconciliationBlocked?.() === true) {
        this.scheduleRetry(sessionId);
        return;
      }
      if (this.deps.getReconciliationGeneration?.() !== routeGeneration) {
        this.scheduleRetry(sessionId);
        return;
      }
      if (current === session.codexRouteRequiresCodeModeOnly) {
        pending.requiresThreadRotation = false;
        this.finish(sessionId, pending.instanceId, 'catalog capability reverted');
        return;
      }
      pending.requiresThreadRotation = true;
    }
    if (isLocalSessionBusy(session, this.deps.isSessionInTurn)) {
      // The proxy reads the live catalog on every request, while CodeModeOnly
      // is sticky on the thread. Do not let later tool rounds in this turn mix
      // the new route with the old thread capability: interrupt once, keep the
      // queue gated, then close/rebuild at the terminal boundary.
      if (!pending.abortRequested) {
        pending.abortRequested = true;
        this.interrupting.add(sessionId);
        let abortSucceeded = false;
        try {
          await this.deps.abortSession(sessionId);
          abortSucceeded = true;
        } catch (error) {
          if (this.pending.get(sessionId) === pending) {
            pending.abortRequested = false;
            this.deps.logger?.warn('catalog route rebuild abort failed; will retry', {
              sessionId,
              revision: pending.revision,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } finally {
          this.interrupting.delete(sessionId);
        }
        if (abortSucceeded && this.pending.has(sessionId)) {
          await this.tryApply(sessionId);
          return;
        }
      }
      if (this.pending.get(sessionId) !== pending) return;
      this.scheduleRetry(sessionId);
      return;
    }
    if (!pending.abortRequested && this.deps.isReconciliationBlocked?.() === true) {
      this.scheduleRetry(sessionId);
      return;
    }
    // Multiple terminal/status/retry signals can finish the same async
    // revalidation together. Claim the close only after the await boundary.
    if (this.applying.has(sessionId)) return;

    this.applying.add(sessionId);
    try {
      await this.deps.withSessionLock(sessionId, async () => {
        if (this.pending.get(sessionId) !== pending || signal.aborted) return;
        const currentSession = this.deps.maker
          .listActiveSessions()
          .find((candidate) => candidate.id === sessionId);
        if (
          currentSession &&
          (currentSession.instanceId !== pending.instanceId ||
            currentSession.agentKind !== 'codex' ||
            currentSession.remoteHostId ||
            typeof currentSession.codexRouteRequiresCodeModeOnly !== 'boolean')
        ) {
          this.finish(sessionId, pending.instanceId, 'session incarnation changed');
          return;
        }
        if (!(await this.prepareThreadRotation(sessionId, pending, currentSession ?? session))) return;
        await prepareLocalSessionCredentialModeSwitch({
          maker: this.deps.maker,
          sessionId,
          isSessionInTurn: this.deps.isSessionInTurn,
          signal,
        });
        if (this.pending.get(sessionId) !== pending) return;
        // Provider mutation can start while closeSession is awaiting teardown.
        // The old thread is already gone, but waking the queue before the new
        // route snapshot commits could recreate it against an intermediate route.
        if (
          this.deps.isReconciliationBlocked?.() === true ||
          this.deps.getReconciliationGeneration?.() !== routeGeneration
        ) {
          this.scheduleRetry(sessionId);
          return;
        }
        this.finish(sessionId, pending.instanceId, 'catalog capability changed');
      });
    } catch (error) {
      if (pending.preparedThreadRotation) {
        await pending.preparedThreadRotation.rollback().catch((rollbackError) => {
          this.deps.logger?.warn('catalog route rebuild thread rotation rollback failed', {
            sessionId,
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          });
        });
        pending.preparedThreadRotation = undefined;
      }
      if (!isCredentialModeSwitchBusyError(error)) {
        this.deps.logger?.warn('catalog route rebuild close failed; will retry', {
          sessionId,
          revision: pending.revision,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (this.pending.get(sessionId) === pending) this.scheduleRetry(sessionId);
    } finally {
      this.applying.delete(sessionId);
    }
  }

  private async applyComparison(
    session: CodexRouteRebuildSession,
    current: boolean,
    revision: number,
  ): Promise<void> {
    const previous = this.pending.get(session.id);
    if (current === session.codexRouteRequiresCodeModeOnly) {
      if (previous?.instanceId === session.instanceId) {
        previous.requiresThreadRotation = false;
      }
      // Once a busy turn has been interrupted, keep its queue boundary and
      // rebuild at the abort terminal. A later catalog flip cannot undo an
      // abort that is already in flight.
      if (previous?.instanceId === session.instanceId && previous.abortRequested) {
        previous.revision = revision;
        this.scheduleRetry(session.id);
        await this.tryApply(session.id);
        return;
      }
      this.finish(session.id, session.instanceId, 'catalog capability converged');
      return;
    }
    if (previous?.instanceId === session.instanceId) {
      // Keep the same object while abort is in flight. Its completion/error
      // path uses object identity to avoid mutating a replacement instance.
      previous.revision = revision;
      previous.requiresThreadRotation = true;
    } else {
      this.pending.set(session.id, {
        instanceId: session.instanceId,
        revision,
        abortRequested: false,
        requiresThreadRotation: true,
        threadRotation: this.snapshotFor(session),
      });
    }
    this.scheduleRetry(session.id);
    await this.tryApply(session.id);
  }

  private snapshotFor(session: CodexRouteRebuildSession): CodexThreadRotationSnapshot | undefined {
    if (!this.deps.prepareCodexThreadRotation) return undefined;
    return codexThreadRotationSnapshotFromSession(
      {
        id: session.id,
        agentKind: session.agentKind,
        remoteHostId: session.remoteHostId,
        sdkSessionId: session.sdkSessionId,
        model: session.model,
        workDir: session.workDir,
      },
      this.deps.getProviderId?.(session.id) ?? session.providerId ?? null,
    ) ?? undefined;
  }

  private async prepareThreadRotation(
    sessionId: string,
    pending: PendingRouteRebuild,
    session?: CodexRouteRebuildSession,
  ): Promise<boolean> {
    if (!pending.threadRotation && session) pending.threadRotation = this.snapshotFor(session);
    if (!pending.threadRotation || pending.preparedThreadRotation) return true;
    if (!this.deps.prepareCodexThreadRotation) {
      this.deps.logger?.warn('catalog route rebuild: Codex thread rotation unavailable; will retry', {
        sessionId,
      });
      this.scheduleRetry(sessionId);
      return false;
    }
    const task = (async (): Promise<boolean> => {
      try {
        const prepared = await this.deps.prepareCodexThreadRotation!(pending.threadRotation!);
        if (this.pending.get(sessionId) !== pending) {
          await prepared.rollback();
          return false;
        }
        pending.preparedThreadRotation = prepared;
        return true;
      } catch (error) {
        if (isCodexThreadRotationSupersededError(error)) {
          // The DB binding moved to a newer lifecycle while the fork was in
          // flight. Retire this stale rebuild instead of retrying forever.
          this.finish(sessionId, pending.instanceId, 'thread rotation superseded');
          return false;
        }
        this.deps.logger?.warn('catalog route rebuild thread rotation failed; will retry', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        this.scheduleRetry(sessionId);
        return false;
      }
    })();
    this.rotationTasks.add(task);
    try {
      return await task;
    } finally {
      this.rotationTasks.delete(task);
    }
  }

  private finish(sessionId: string, instanceId: string, reason: string): void {
    const pending = this.pending.get(sessionId);
    if (!pending || pending.instanceId !== instanceId) return;
    this.pending.delete(sessionId);
    const timer = this.retryTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(sessionId);
    this.deps.logger?.info('catalog route rebuild settled', { sessionId, reason });
    try {
      this.deps.onApplied?.(sessionId);
    } catch (error) {
      this.deps.logger?.warn('catalog route rebuild wake failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private scheduleRetry(sessionId: string): void {
    if (!this.pending.has(sessionId) || this.retryTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(sessionId);
      void this.tryApply(sessionId);
    }, this.deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.retryTimers.set(sessionId, timer);
  }
}
