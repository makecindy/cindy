/**
 * Coordinates best-effort turn boundary snapshot creation.
 *
 * This module is pure main-process logic with all side effects injected, so it
 * can be tested without Electron, maker, or a real Git repository.
 */

import type { AgentKind } from '@cindy/maker-core';

import { createAfterEditLabel } from './gitSnapshotLabeler';
import { enqueueGitRepoWrite } from './gitRepoWriteQueue';
import type {
  CreateShadowMarkerInput,
  CreateShadowSavepointInput,
  ShadowSavepointResult,
} from './gitSnapshotService';

interface CoordinatorLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  debug: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface GitSnapshotSessionContext {
  workingDir: string;
  agentKind: AgentKind;
  workspaceKind?: string | null;
  remoteHostId?: string | null;
}

export interface GitSnapshotCoordinatorDeps {
  /** Global auto-snapshot switch; turn-start decisions are reused at matching turn end. */
  readAutoSnapshotEnabled: () => boolean;
  /** Resolves a working directory to a Git repo root, or null for non-Git dirs. */
  detectRepoRoot: (workingDir: string) => Promise<string | null>;
  /** Best-effort bootstrap for local empty project dirs that are not Git repos yet. */
  initializeProjectGit?: (
    sessionId: string,
    context: GitSnapshotSessionContext,
    opts: { autoSnapshotEnabled: boolean },
  ) => Promise<{ repoRoot?: string | null } | null>;
  /** Session lookup used for workingDir detection and label-agent routing. */
  getSessionContext: (sessionId: string) => Promise<GitSnapshotSessionContext | null>;
  /** Optional message anchor attached to the savepoint trailer metadata. */
  resolveAnchor?: (sessionId: string) => Promise<string | undefined>;
  /** Optional last user prompt, used only as label context. */
  getLastUserPrompt?: (sessionId: string) => Promise<string | undefined>;
  /** Shadow savepoint kernel dependency, injected for tests. */
  createShadowSavepoint: (
    repoPath: string,
    input: CreateShadowSavepointInput,
  ) => Promise<ShadowSavepointResult>;
  /** Metadata-only chain marker dependency, injected for tests. */
  createShadowMarker: (
    repoPath: string,
    input: CreateShadowMarkerInput,
  ) => Promise<string | null>;
  /** Out-of-band label generation dependency. */
  oneShot: (agentKind: AgentKind, prompt: string) => Promise<string>;
  logger: CoordinatorLogger;
}

interface ResolvedSnapshotSession {
  repoRoot: string;
  agentKind: AgentKind;
}

interface TurnStartState {
  repoRoot: string;
  /** Turn-start savepoint on the shadow chain; unset when creation failed. */
  turnStartCommit: string;
  metadata: TurnStartMetadata;
}

interface TurnStartRecord extends Partial<TurnStartState> {
  autoSnapshotEnabled: boolean;
  promise: Promise<void>;
}

interface TurnStartMetadata {
  anchor?: string;
  userPrompt?: string;
}

export class GitSnapshotCoordinator {
  private readonly sessionCache = new Map<string, ResolvedSnapshotSession>();
  private readonly turnStartQueues = new Map<string, TurnStartRecord[]>();

  constructor(private readonly deps: GitSnapshotCoordinatorDeps) {}

  /**
   * Turn-start hook. Snapshots the current worktree state onto the session's
   * shadow savepoint chain as the baseline for this turn's file rewind.
   */
  async onTurnStart(sessionId: string): Promise<void> {
    const record: TurnStartRecord = {
      autoSnapshotEnabled: this.deps.readAutoSnapshotEnabled(),
      promise: Promise.resolve(),
    };
    this.pushTurnStartRecord(sessionId, record);
    record.promise = this.captureTurnStart(sessionId, record);
    await record.promise;
  }

  hasPendingTurnStart(sessionId: string): boolean {
    return (this.turnStartQueues.get(sessionId)?.length ?? 0) > 0;
  }

  private async captureTurnStart(sessionId: string, record: TurnStartRecord): Promise<void> {
    try {
      if (!record.autoSnapshotEnabled) {
        return;
      }

      const resolved = await this.resolveSession(sessionId, record.autoSnapshotEnabled);
      if (!resolved) {
        return;
      }

      record.repoRoot = resolved.repoRoot;
      const metadataPromise = this.resolveTurnStartMetadata(sessionId);
      await enqueueGitRepoWrite(resolved.repoRoot, async () => {
        const metadata = await metadataPromise;
        record.metadata = metadata;
        record.turnStartCommit = await this.createTurnStartSavepoint(
          sessionId,
          resolved.repoRoot,
          metadata,
        );
      });
      record.metadata ??= await metadataPromise;
    } catch (err) {
      this.deps.logger.warn('[git-snapshot] onTurnStart failed (swallowed)', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Turn-end hook. Callers may fire-and-forget this; all errors are swallowed
   * after logging so agent turns are never blocked by snapshot failures.
   */
  async onTurnEnd(sessionId: string): Promise<void> {
    const turnStart = this.shiftTurnStartRecord(sessionId);
    try {
      const autoSnapshotEnabled = turnStart?.autoSnapshotEnabled ?? this.deps.readAutoSnapshotEnabled();
      if (!autoSnapshotEnabled) return;
      if (turnStart && !turnStart.repoRoot) {
        await turnStart.promise;
      }

      const resolved = await this.resolveSession(sessionId, autoSnapshotEnabled);
      if (!resolved) return;

      await enqueueGitRepoWrite(resolved.repoRoot, async () => {
        await turnStart?.promise;
        await this.snapshotAfterEdit(sessionId, resolved, turnStart);
      });
    } catch (err) {
      this.deps.logger.warn('[git-snapshot] onTurnEnd failed (swallowed)', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Consumes one turn-start baseline when a turn ends without a successful done event. */
  onTurnAbort(sessionId: string): void {
    this.shiftTurnStartRecord(sessionId);
  }

  /** Clears per-session repo detection when the session is closed. */
  onSessionClosed(sessionId: string): void {
    this.sessionCache.delete(sessionId);
    this.turnStartQueues.delete(sessionId);
  }

  private async resolveSession(
    sessionId: string,
    autoSnapshotEnabled: boolean = this.deps.readAutoSnapshotEnabled(),
  ): Promise<ResolvedSnapshotSession | null> {
    const cached = this.sessionCache.get(sessionId);
    if (cached) return cached;

    const ctx = await this.deps.getSessionContext(sessionId);
    if (!ctx?.workingDir) return null;

    let repoRoot = await this.deps.detectRepoRoot(ctx.workingDir);
    if (!repoRoot && this.deps.initializeProjectGit) {
      const bootstrap = await this.deps.initializeProjectGit?.(sessionId, ctx, { autoSnapshotEnabled });
      repoRoot = bootstrap?.repoRoot ?? null;
      if (!repoRoot) {
        repoRoot = await this.deps.detectRepoRoot(ctx.workingDir);
      }
    }
    if (!repoRoot) return null;

    const resolved = { repoRoot, agentKind: ctx.agentKind };
    this.sessionCache.set(sessionId, resolved);
    return resolved;
  }

  private async snapshotAfterEdit(
    sessionId: string,
    { repoRoot, agentKind }: ResolvedSnapshotSession,
    turnStart: TurnStartRecord | undefined,
  ): Promise<void> {
    const baseline =
      turnStart?.repoRoot === repoRoot ? turnStart.turnStartCommit : undefined;
    if (!baseline) {
      this.deps.logger.debug('[git-snapshot] missing turn-start baseline, skip', {
        sessionId,
        repoRoot,
      });
      // Without a baseline this turn's delta is unrecoverable; append a gap
      // marker so the file-rewind planner truncates ranges that cross it.
      // Only codex/pi consume the savepoint chain for file rewind.
      if (agentKind === 'codex' || agentKind === 'pi') {
        await this.createRewindBlockedMarker(
          sessionId,
          repoRoot,
          'File rewind gap: turn-start baseline unavailable',
          '[git-snapshot] rewind gap marker created',
          turnStart?.metadata ?? {},
        );
      }
      return;
    }

    const metadata = turnStart?.metadata ?? await this.resolveTurnStartMetadata(sessionId);

    // Dirty detection is tree equality against the turn-start baseline: with
    // shadow savepoints the worktree stays dirty relative to HEAD, so a
    // status-based check would create an empty after-edit every turn.
    let result: ShadowSavepointResult;
    try {
      result = await this.deps.createShadowSavepoint(repoRoot, {
        sessionId,
        label: (diff) =>
          createAfterEditLabel(
            { diff, userPrompt: metadata.userPrompt },
            { oneShot: (prompt) => this.deps.oneShot(agentKind, prompt) },
          ),
        meta: {
          kind: 'after-edit',
          baselineCommit: baseline,
          ...(metadata.anchor ? { anchor: metadata.anchor } : {}),
        },
        skipIfTreeEquals: baseline,
      });
    } catch (err) {
      this.deps.logger.warn('[git-snapshot] after-edit savepoint failed', {
        sessionId,
        repoRoot,
        error: err instanceof Error ? err.message : String(err),
      });
      // This turn's delta is unrecorded; without a gap marker a later rewind
      // across this turn would restore to a newer baseline and silently keep
      // the failed turn's file changes while dropping its conversation.
      if (agentKind === 'codex' || agentKind === 'pi') {
        await this.createRewindBlockedMarker(
          sessionId,
          repoRoot,
          'File rewind gap: after-edit savepoint failed',
          '[git-snapshot] rewind gap marker created',
          metadata,
        );
      }
      return;
    }

    if (result.commit) {
      this.deps.logger.info('[git-snapshot] after-edit savepoint created', {
        sessionId,
        repoRoot,
        commit: result.commit.slice(0, 8),
      });
    } else {
      this.deps.logger.debug('[git-snapshot] worktree unchanged since turn start, skip', {
        sessionId,
        repoRoot,
      });
    }
  }

  private async createTurnStartSavepoint(
    sessionId: string,
    repoRoot: string,
    metadata: TurnStartMetadata,
  ): Promise<string | undefined> {
    // Always created, dirty or clean, so every turn has a uniform restore
    // baseline; an unchanged tree costs almost nothing thanks to object reuse.
    const result = await this.deps.createShadowSavepoint(repoRoot, {
      sessionId,
      label: '本轮开始时的工作区基线',
      meta: {
        kind: 'turn-start',
        ...(metadata.anchor ? { anchor: metadata.anchor } : {}),
      },
    });

    if (result.commit) {
      this.deps.logger.info('[git-snapshot] turn-start baseline created', {
        sessionId,
        repoRoot,
        commit: result.commit.slice(0, 8),
        ...(metadata.anchor ? { anchor: metadata.anchor } : {}),
      });
      return result.commit;
    }

    this.deps.logger.warn('[git-snapshot] turn-start baseline missing commit', {
      sessionId,
      repoRoot,
    });
    return undefined;
  }

  private async resolveTurnStartMetadata(sessionId: string): Promise<TurnStartMetadata> {
    const [anchor, userPrompt] = await Promise.all([
      this.resolveOptional(sessionId, 'resolveAnchor', this.deps.resolveAnchor),
      this.resolveOptional(sessionId, 'getLastUserPrompt', this.deps.getLastUserPrompt),
    ]);
    return {
      ...(anchor ? { anchor } : {}),
      ...(userPrompt ? { userPrompt } : {}),
    };
  }

  private async resolveOptional<T>(
    sessionId: string,
    name: string,
    fn: ((sessionId: string) => Promise<T | undefined>) | undefined,
  ): Promise<T | undefined> {
    if (!fn) return undefined;
    try {
      return await fn(sessionId);
    } catch (err) {
      this.deps.logger.debug('[git-snapshot] optional metadata unavailable, continuing', {
        sessionId,
        name,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  private async createRewindBlockedMarker(
    sessionId: string,
    repoRoot: string,
    label: string,
    logMessage: string,
    metadata: TurnStartMetadata,
  ): Promise<void> {
    const commit = await this.deps.createShadowMarker(repoRoot, {
      sessionId,
      label,
      meta: {
        kind: 'rewind-blocked',
        ...(metadata.anchor ? { anchor: metadata.anchor } : {}),
      },
    });
    if (!commit) {
      // Empty chain: nothing to truncate, the planner already falls back when
      // it finds no savepoints for the range.
      return;
    }
    this.deps.logger.info(logMessage, {
      sessionId,
      repoRoot,
      commit: commit.slice(0, 8),
      ...(metadata.anchor ? { anchor: metadata.anchor } : {}),
    });
  }

  private pushTurnStartRecord(sessionId: string, record: TurnStartRecord): void {
    const queue = this.turnStartQueues.get(sessionId);
    if (queue) {
      queue.push(record);
    } else {
      this.turnStartQueues.set(sessionId, [record]);
    }
  }

  private shiftTurnStartRecord(sessionId: string): TurnStartRecord | undefined {
    const queue = this.turnStartQueues.get(sessionId);
    const record = queue?.shift();
    if (queue && queue.length === 0) {
      this.turnStartQueues.delete(sessionId);
    }
    return record;
  }
}
