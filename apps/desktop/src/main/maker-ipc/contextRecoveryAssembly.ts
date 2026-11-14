import type { ContextOverflowRolloverDeps } from './contextOverflowRollover.js';
import type { MakerSessionCreateOpts as CreateOpts } from './sessionRequest.js';
import type { AgentMeta } from '../../renderer/lib/ccAgent.types';

// Desktop supplies these ports at call time; no platform module is evaluated here.
export interface ReadContextRecoveryPorts {
  getDbClient: typeof import('../localDb/client/current.js').getDbClient;
  sessions: typeof import('../localDb/schema.js').sessions;
  botSessionLinks: typeof import('../localDb/schema.js').botSessionLinks;
  botProfiles: typeof import('../localDb/schema.js').botProfiles;
  eq(left: import('drizzle-orm').SQLWrapper, right: unknown): import('drizzle-orm').SQL;
}

export async function readContextRecoverySessionWithPorts(ports: ReadContextRecoveryPorts, sessionId: string) {
    const [row] = await ports.getDbClient()
      .drizzle.select({
        status: ports.sessions.status,
        source: ports.sessions.source,
        botRole: ports.botSessionLinks.role,
        botLinkArchivedAt: ports.botSessionLinks.archivedAt,
        botStatus: ports.botProfiles.status,
        botHiddenAt: ports.botProfiles.hiddenAt,
        agentKind: ports.sessions.agentKind,
        remoteHostId: ports.sessions.remoteHostId,
        agentDeviceId: ports.sessions.agentDeviceId,
        clearedAt: ports.sessions.clearedAt,
        sdkSessionId: ports.sessions.sdkSessionId,
        contextTokens: ports.sessions.contextTokens,
        contextWindow: ports.sessions.contextWindow,
        model: ports.sessions.model,
        providerId: ports.sessions.providerId,
        workingDir: ports.sessions.workingDir,
      })
      .from(ports.sessions)
      .leftJoin(ports.botSessionLinks, ports.eq(ports.botSessionLinks.sessionId, ports.sessions.id))
      .leftJoin(ports.botProfiles, ports.eq(ports.botProfiles.id, ports.botSessionLinks.botId))
      .where(ports.eq(ports.sessions.id, sessionId))
      .limit(1);
    if (!row) return null;
    return {
      ...row,
      botRole: row.botStatus === 'active' && !row.botHiddenAt && row.botLinkArchivedAt === null
        ? row.botRole : null,
    };
}

export interface ClassifyCodexHistoryPorts {
  captureDataOwnerBroadcastScope: typeof import('../device-link/broadcast-tap.js').captureDataOwnerBroadcastScope;
  getCurrentDbClientSnapshot: typeof import('../localDb/client/current.js').getCurrentDbClientSnapshot;
  readCodexThreadStorageReadOnly: typeof import('../maker-host/codex-thread-storage.js').readCodexThreadStorageReadOnly;
  classifyCodexHistoryOversized: typeof import('../maker-host/codex-local-sessions.js').classifyCodexHistoryOversized;
  isDataOwnerBroadcastScopeCurrent: typeof import('../device-link/broadcast-tap.js').isDataOwnerBroadcastScopeCurrent;
}

export async function classifyCodexHistoryWithPorts(ports: ClassifyCodexHistoryPorts, threadId: string) {
      const ownerScope = ports.captureDataOwnerBroadcastScope();
      const dbSnapshot = ports.getCurrentDbClientSnapshot();
      // 多账号线程的 rollout 在 codex-accounts 下,只有 thread-index 记着位置;
      // 记录读不出时不回退旧 HOME(可能是过期副本),按 unknown 处理。
      const storage = await ports.readCodexThreadStorageReadOnly(threadId).catch(() => null);
      const result = storage === null ? 'unknown' : await ports.classifyCodexHistoryOversized(threadId, storage);
      if (
        !dbSnapshot || !ports.isDataOwnerBroadcastScopeCurrent(ownerScope) ||
        ports.getCurrentDbClientSnapshot()?.clientEpoch !== dbSnapshot.clientEpoch
      ) {
        throw new Error('Codex history owner changed during inspection');
      }
      return result;
}

export interface CommitContextRecoveryPorts {
  captureDataOwnerBroadcastScope: typeof import('../device-link/broadcast-tap.js').captureDataOwnerBroadcastScope;
  getCurrentDbClientSnapshot: typeof import('../localDb/client/current.js').getCurrentDbClientSnapshot;
  sessions: typeof import('../localDb/schema.js').sessions;
  eq(left: import('drizzle-orm').SQLWrapper, right: unknown): import('drizzle-orm').SQL;
  isDataOwnerBroadcastScopeCurrent: typeof import('../device-link/broadcast-tap.js').isDataOwnerBroadcastScopeCurrent;
  commitContextRebuild: typeof import('../localDb/ipc/messages.js').commitContextRebuild;
  broadcastSessionPatched: typeof import('../localDb/ipc/sessions.js').broadcastSessionPatched;
  createDbMessage: typeof import('../localDb/ipc/messages.js').createMessage;
  createId: typeof import('@paralleldrive/cuid2').createId;
  log: Pick<ReturnType<typeof import('../logger.js').createLogger>, 'info' | 'warn'>;
}

export async function commitContextRecoveryWithPorts(ports: CommitContextRecoveryPorts, ...args: Parameters<ContextOverflowRolloverDeps['commitRebuild']>) {
  const [sessionId, handoff, meta, signal] = args;
      // Read projection metadata before the transaction: after a successful
      // context.rebuild there must be no fallible step before the zero-usage push.
      const ownerScope = ports.captureDataOwnerBroadcastScope();
      const dbSnapshot = ports.getCurrentDbClientSnapshot();
      if (!dbSnapshot) throw new Error('context rebuild requires an active Profile database');
      const [sessionKindRow] = await dbSnapshot.client.drizzle
        .select({
          agentKind: ports.sessions.agentKind,
          contextWindow: ports.sessions.contextWindow,
        })
        .from(ports.sessions)
        .where(ports.eq(ports.sessions.id, sessionId))
        .limit(1);
      if (
        !ports.isDataOwnerBroadcastScopeCurrent(ownerScope) ||
        ports.getCurrentDbClientSnapshot()?.clientEpoch !== dbSnapshot.clientEpoch
      ) {
        throw new Error('context rebuild owner changed before commit');
      }
      signal?.throwIfAborted();
      const { updatedAt } = await ports.commitContextRebuild(sessionId, handoff, meta);
      if (
        !ports.isDataOwnerBroadcastScopeCurrent(ownerScope) ||
        ports.getCurrentDbClientSnapshot()?.clientEpoch !== dbSnapshot.clientEpoch
      ) {
        throw new Error('context rebuild owner changed after commit');
      }
      const projectionContextWindow =
        typeof sessionKindRow?.contextWindow === 'number' &&
        Number.isFinite(sessionKindRow.contextWindow) &&
        sessionKindRow.contextWindow > 0
          ? sessionKindRow.contextWindow
          : undefined;
      const cardAgentKind =
        sessionKindRow?.agentKind === 'codex'
          ? 'codex'
          : sessionKindRow?.agentKind === 'pi'
            ? 'pi'
            : 'cc';
      ports.broadcastSessionPatched(
        sessionId,
        {
          sdkSessionId: null,
          contextTokens: 0,
          ...(meta.replacementRoute ? {
            model: meta.replacementRoute.model,
            providerId: meta.replacementRoute.providerId,
            effort: meta.replacementRoute.effort,
            fastMode: meta.replacementRoute.fastMode,
          } : {}),
          ...(projectionContextWindow === undefined
            ? {}
            : { contextWindow: projectionContextWindow }),
          updatedAt: new Date(updatedAt).toISOString(),
        },
        ownerScope,
      );
      try {
        await ports.createDbMessage(
          sessionId,
          {
            clientId: `context-rebuild-card:${ports.createId()}`,
            role: 'assistant',
            content: '',
            agentKind: cardAgentKind,
            agentMeta: { contextRebuild: { reason: meta.reason, handoff } } as AgentMeta,
          },
          {
            broadcastOwnerScope: ownerScope,
            shouldBroadcast: () =>
              ports.isDataOwnerBroadcastScopeCurrent(ownerScope) &&
              ports.getCurrentDbClientSnapshot()?.clientEpoch === dbSnapshot.clientEpoch,
          },
        );
      } catch (error) {
        // The hidden marker and zero-usage session state are already committed.
        // A derived visual card must not turn that successful rebuild into a
        // failed switch or strand control projections on the source route.
        ports.log.warn('context rebuild card creation failed after commit', {
          sessionId,
          reason: meta.reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
}

export interface ReplayContextRecoveryPorts {
  getDbClient: typeof import('../localDb/client/current.js').getDbClient;
  sessions: typeof import('../localDb/schema.js').sessions;
  eq(left: import('drizzle-orm').SQLWrapper, right: unknown): import('drizzle-orm').SQL;
  buildCreateOptsWithStderr: ReturnType<typeof import('./sessionRequest.js').createSessionStderrOptions>;
  dbToMakerAgentKind: typeof import('../../shared/agentKindConversion.js').dbToMakerAgentKind;
  readSessionExtraDirsFromDb: typeof import('../maker-host/session-storage.js').readSessionExtraDirsFromDb;
  directoryGrantsForRuntime: typeof import('./extraDirsValidator.js').directoryGrantsForRuntime;
  log: Pick<ReturnType<typeof import('../logger.js').createLogger>, 'info' | 'warn'>;
  readSessionWritableDirsFromDb: typeof import('../maker-host/session-storage.js').readSessionWritableDirsFromDb;
  restoreAutoReviewUserIntent: typeof import('./autoReviewUserIntent.js').restoreAutoReviewUserIntent;
  readAutoReviewHistory: (sessionId: string) => ReturnType<typeof import('../localDb/ipc/messages.js').listMessagesForAgentHandoff>;
  readContextRecoverySession: (sessionId: string) => ReturnType<typeof readContextRecoverySessionWithPorts>;
  canContinueContextRecovery: typeof import('./contextOverflowRollover.js').canContinueContextRecovery;
  isHeadlessGhostSetupTurn: (sessionId: string) => boolean;
  bindingStore: { findByTarget(sessionId: string): unknown };
  sendToAgentAcceptedUnlocked: ReturnType<typeof import('./makerSendTransaction.js').createMakerSendTransaction>['sendToAgentAccepted'];
  persistedUserContentToWireMessage: typeof import('./contextOverflowRollover.js').persistedUserContentToWireMessage;
  PI_CACHE_RECOVERY_EXPECTATION: typeof import('@cindy/maker-core').PI_CACHE_RECOVERY_EXPECTATION;
  INHERITED_CAPABILITY_SELECTION: typeof import('@cindy/maker-core').INHERITED_CAPABILITY_SELECTION;
  AUTO_REVIEW_SOURCE_CONTENT: typeof import('@cindy/maker-core').AUTO_REVIEW_SOURCE_CONTENT;
  readAutoReviewUserText: typeof import('./autoReviewUserIntent.js').readAutoReviewUserText;
  AUTO_REVIEW_USER_INTENT: typeof import('@cindy/maker-core').AUTO_REVIEW_USER_INTENT;
  withCindyMakeProjectUse: typeof import('../cindy-make/projectAccess.js').withCindyMakeProjectUse;
  app: { getPath(name: 'userData'): string };
}

export async function replayContextRecoveryWithPorts(ports: ReplayContextRecoveryPorts, ...args: Parameters<ContextOverflowRolloverDeps['replayUserMessage']>) {
  const [sessionId, content, agentFacingWireContent, recovery] = args;
      const [row] = await ports.getDbClient()
        .drizzle.select()
        .from(ports.sessions)
        .where(ports.eq(ports.sessions.id, sessionId))
        .limit(1);
      if (!row?.workingDir) return { accepted: false };
      if (recovery?.signal?.aborted) return { accepted: false };
      const createOpts = ports.buildCreateOptsWithStderr({
        id: sessionId,
        agentKind: ports.dbToMakerAgentKind(row.agentKind),
        workingDir: row.workingDir,
        model: row.model ?? undefined,
        providerId: row.providerId,
        effort: (row.effort ?? undefined) as CreateOpts['effort'],
        fastMode: (row.fastMode ?? false),
        permissionMode: (row.permissionMode ?? 'ask') as CreateOpts['permissionMode'],
        planMode: !!row.planModeEnabled,
        title: row.title ?? undefined,
        remoteHostId: row.remoteHostId ?? undefined,
      });
      if (createOpts.extraDirs === undefined) {
        try {
          const extraDirs = await ports.readSessionExtraDirsFromDb(sessionId);
          if (extraDirs.length > 0) Object.assign(createOpts, ports.directoryGrantsForRuntime(extraDirs));
        } catch (err) {
          ports.log.warn('overflow replay: read extra_dirs from DB failed (non-fatal)', {
            sessionId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (createOpts.writableDirs === undefined) {
        const writableDirs = await ports.readSessionWritableDirsFromDb(sessionId).catch(() => []);
        if (writableDirs.length > 0) createOpts.writableDirs = writableDirs;
      }
      const recoveryIntent = recovery?.continueFromHistory
        ? ports.restoreAutoReviewUserIntent(await ports.readAutoReviewHistory(sessionId), {
            clientId: recovery.sourceUserClientId,
            content: recovery.sourceUserContent,
          })
        : undefined;
      if (recovery?.continueFromHistory) {
        const current = await ports.readContextRecoverySession(sessionId);
        if (!current || !ports.canContinueContextRecovery(current) || current.status !== 'active'
          || ports.isHeadlessGhostSetupTurn(sessionId) || ports.bindingStore.findByTarget(sessionId)) {
          return { accepted: false };
        }
      }
      const sendReplay = () => ports.sendToAgentAcceptedUnlocked(
        sessionId,
        ports.persistedUserContentToWireMessage(agentFacingWireContent ?? content),
        createOpts,
        recovery?.continueFromHistory
          ? {
              signal: recovery.signal,
              [ports.PI_CACHE_RECOVERY_EXPECTATION]: recovery.piCacheCompatibility,
              ...(recovery.piCacheCompatibility ? { retryUserClientId: recovery.sourceUserClientId } : {}),
              [ports.INHERITED_CAPABILITY_SELECTION]: recovery.sourceCapabilitySelectionText,
              // The internal continuation is not fresh user authorization. Restore
              // intent from authored history, never attachment/quote projections.
              [ports.AUTO_REVIEW_SOURCE_CONTENT]: ports.readAutoReviewUserText(recovery.sourceUserContent) ?? '',
              [ports.AUTO_REVIEW_USER_INTENT]: recoveryIntent,
            }
          : { signal: recovery?.signal },
      );
      const result = row.remoteHostId ? await sendReplay()
        : await ports.withCindyMakeProjectUse(ports.app.getPath('userData'), row.workingDir, sendReplay);
      return { accepted: result.accepted === true };
}

export interface RecoveryCallbackPorts {
  getCoordinator(): {
    clearError(sessionId: string): void;
    hasPendingQueuedWork(sessionId: string): boolean;
    getInputAbortSignal(sessionId: string): AbortSignal;
  } | null;
  resetWireNotes(sessionId: string): void;
}

export function contextRecoveryRebuilt(
  ports: RecoveryCallbackPorts, sessionId: string,
): void {
  // overflow 终态已先走 coordinator onTurnEvent('error')，会留下 active-turn
  // recovery 和错误横幅。重放绕开 coordinator，随后的 done 会被 recovery 吃掉。
  ports.getCoordinator()?.clearError(sessionId);
  // 新原生上下文没看过任何环境说明:下一轮整体重发(重放路径不经 send 事务)。
  ports.resetWireNotes(sessionId);
}

export function contextRecoveryAbortSignal(
  ports: RecoveryCallbackPorts, sessionId: string,
): AbortSignal {
  const coordinator = ports.getCoordinator()!;
  if (coordinator.hasPendingQueuedWork(sessionId)) {
    // The terminal error may have installed recovery after this input was
    // queued. Release that old error so the queued input can actually drain.
    coordinator.clearError(sessionId);
    return AbortSignal.abort();
  }
  return coordinator.getInputAbortSignal(sessionId);
}
