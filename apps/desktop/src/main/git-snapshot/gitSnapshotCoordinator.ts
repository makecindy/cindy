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
  SkippedFileFingerprint,
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
  /** Content-free fingerprints of paths the filter excluded at turn start. */
  turnStartSkippedFingerprints: SkippedFileFingerprint[];
  metadata: TurnStartMetadata;
}

interface TurnStartRecord extends Partial<TurnStartState> {
  autoSnapshotEnabled: boolean;
  promise: Promise<void>;
  /** Owning session, for same-repo concurrency checks across sessions. */
  ownerSessionId?: string;
  /**
   * Another session ran a turn on the same repository while this turn was in
   * flight. Full-worktree trees cannot attribute changes to sessions, so an
   * after-edit here would swallow the peer's files; the turn degrades to a
   * rewind gap instead. Overlapping turns of the *same* session stay fine:
   * their after-edits share one chain and conversation rewind drops them
   * together, so attribution is consistent by construction.
   */
  overlappedWithPeer?: boolean;
}

interface TurnStartMetadata {
  anchor?: string;
  userPrompt?: string;
}

export class GitSnapshotCoordinator {
  private readonly sessionCache = new Map<string, ResolvedSnapshotSession>();
  private readonly turnStartQueues = new Map<string, TurnStartRecord[]>();
  /** In-flight turn records per repo root, for same-repo concurrency checks. */
  private readonly activeTurnRecordsByRepo = new Map<string, Set<TurnStartRecord>>();

  constructor(private readonly deps: GitSnapshotCoordinatorDeps) {}

  /**
   * Turn-start hook. Snapshots the current worktree state onto the session's
   * shadow savepoint chain as the baseline for this turn's file rewind.
   */
  async onTurnStart(sessionId: string): Promise<void> {
    const record: TurnStartRecord = {
      autoSnapshotEnabled: this.deps.readAutoSnapshotEnabled(),
      promise: Promise.resolve(),
      ownerSessionId: sessionId,
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
      this.registerActiveTurn(resolved.repoRoot, record);
      const metadataPromise = this.resolveTurnStartMetadata(sessionId);
      await enqueueGitRepoWrite(resolved.repoRoot, async () => {
        const metadata = await metadataPromise;
        record.metadata = metadata;
        const turnStart = await this.createTurnStartSavepoint(
          sessionId,
          resolved.repoRoot,
          metadata,
        );
        record.turnStartCommit = turnStart.commit;
        record.turnStartSkippedFingerprints = turnStart.skippedFingerprints;
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
    // 未被 turn-end/abort 消费的 record(运行中关会话)必须逐条注销同仓并发
    // 记账,否则悬空 record 会让同仓其它会话的后续每一轮都被误判为并发。
    const queue = this.turnStartQueues.get(sessionId);
    if (queue) {
      for (const record of queue) {
        if (record.repoRoot) {
          this.unregisterActiveTurn(record.repoRoot, record);
        }
      }
    }
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

    if (turnStart?.overlappedWithPeer) {
      // 另一个 session 在同一仓库上与本轮并发跑了 turn:全工作区树无法把
      // 改动归属到 session,after-edit 会把对方的文件吞进本轮增量,回退时
      // 再把对方的文件退回本轮基线。降级为 gap,而不是记错账。
      this.deps.logger.warn('[git-snapshot] concurrent session turn on the same repo', {
        sessionId,
        repoRoot,
      });
      if (agentKind === 'codex' || agentKind === 'pi') {
        await this.createRewindBlockedMarker(
          sessionId,
          repoRoot,
          'File rewind gap: concurrent session activity in the same repository',
          '[git-snapshot] rewind gap marker created',
          metadata,
        );
      }
      return;
    }

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

    // 被过滤路径在本 turn 两端不一致时补 gap 标记,覆盖三种情形:
    // - after 新增(Agent 写入 .env、生成超限文件):本轮改动没进快照;
    // - baseline 消失(被过滤文件本轮被缩小到可纳入或被删):它在基线树里
    //   缺失,回退会删掉/改掉它,而 turn-start 时的原始内容从未被记录;
    // - 两端都被过滤但 lstat 指纹(大小/mtime,不含内容)变化:文件本轮被
    //   改写(如超限文件被 Agent 重写后仍超限),同样没有任何快照可恢复。
    // 指纹完全一致的常驻过滤文件不打 gap,否则文件回退会被永久禁用。
    if (agentKind === 'codex' || agentKind === 'pi') {
      const baseline = new Map(
        (turnStart?.turnStartSkippedFingerprints ?? []).map((fp) => [fp.path, fp]),
      );
      const after = new Map(result.skippedFingerprints.map((fp) => [fp.path, fp]));
      const changedSkips: string[] = [];
      for (const [skippedPath, fp] of after) {
        const base = baseline.get(skippedPath);
        if (
          !base ||
          base.sizeBytes !== fp.sizeBytes ||
          base.mtimeMs !== fp.mtimeMs ||
          // ctime 无法从用户态设定、inode 捕获 replace-by-rename:保留 mtime
          // 的等长改写靠这两个字段识别。
          base.ctimeMs !== fp.ctimeMs ||
          base.ino !== fp.ino
        ) {
          changedSkips.push(skippedPath);
        }
      }
      for (const skippedPath of baseline.keys()) {
        if (!after.has(skippedPath)) changedSkips.push(skippedPath);
      }
      if (changedSkips.length > 0) {
        this.deps.logger.warn('[git-snapshot] turn changes partially filtered', {
          sessionId,
          repoRoot,
          skipped: changedSkips.slice(0, 5),
        });
        await this.createRewindBlockedMarker(
          sessionId,
          repoRoot,
          'File rewind gap: turn changes were partially filtered',
          '[git-snapshot] rewind gap marker created',
          metadata,
        );
      }
    }
  }

  private async createTurnStartSavepoint(
    sessionId: string,
    repoRoot: string,
    metadata: TurnStartMetadata,
  ): Promise<{ commit: string | undefined; skippedFingerprints: SkippedFileFingerprint[] }> {
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
      return { commit: result.commit, skippedFingerprints: result.skippedFingerprints };
    }

    this.deps.logger.warn('[git-snapshot] turn-start baseline missing commit', {
      sessionId,
      repoRoot,
    });
    return { commit: undefined, skippedFingerprints: result.skippedFingerprints };
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
      // Marker tree could not be built (git fully unavailable); the failure
      // is logged by the kernel and the outer swallow keeps the turn alive.
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
    if (record?.repoRoot) {
      this.unregisterActiveTurn(record.repoRoot, record);
    }
    return record;
  }

  /**
   * Same-repo concurrency bookkeeping: two sessions running turns against one
   * repository make full-worktree trees unattributable, so every overlapping
   * in-flight turn (existing peers included) is flagged for gap degradation.
   */
  private registerActiveTurn(repoRoot: string, record: TurnStartRecord): void {
    const peers = this.activeTurnRecordsByRepo.get(repoRoot);
    if (!peers) {
      this.activeTurnRecordsByRepo.set(repoRoot, new Set([record]));
      return;
    }
    const foreignPeers = [...peers].filter(
      (peer) => peer.ownerSessionId !== record.ownerSessionId,
    );
    if (foreignPeers.length > 0) {
      record.overlappedWithPeer = true;
      for (const peer of foreignPeers) {
        peer.overlappedWithPeer = true;
      }
    }
    peers.add(record);
  }

  private unregisterActiveTurn(repoRoot: string, record: TurnStartRecord): void {
    const peers = this.activeTurnRecordsByRepo.get(repoRoot);
    if (!peers) return;
    peers.delete(record);
    if (peers.size === 0) {
      this.activeTurnRecordsByRepo.delete(repoRoot);
    }
  }
}
