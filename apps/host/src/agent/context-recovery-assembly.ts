import { eq } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import {
  AUTO_REVIEW_SOURCE_CONTENT,
  AUTO_REVIEW_USER_INTENT,
  INHERITED_CAPABILITY_SELECTION,
  PI_CACHE_RECOVERY_EXPECTATION,
} from '@cindy/maker-core';
import {
  canContinueContextRecovery,
  createContextOverflowRollover,
  persistedUserContentToWireMessage,
  type ContextOverflowRolloverDeps,
} from '../../../desktop/src/main/maker-ipc/contextOverflowRollover.ts';
import {
  classifyCodexHistoryWithPorts,
  commitContextRecoveryWithPorts,
  contextRecoveryAbortSignal,
  contextRecoveryRebuilt,
  readContextRecoverySessionWithPorts,
  replayContextRecoveryWithPorts,
  type ClassifyCodexHistoryPorts,
  type CommitContextRecoveryPorts,
  type RecoveryCallbackPorts,
  type ReplayContextRecoveryPorts,
} from '../../../desktop/src/main/maker-ipc/contextRecoveryAssembly.ts';
import { readAutoReviewUserText, restoreAutoReviewUserIntent } from '../../../desktop/src/main/maker-ipc/autoReviewUserIntent.ts';
import { directoryGrantsForRuntime } from '../../../desktop/src/main/maker-ipc/extraDirsValidator.ts';
import { withSendToSessionLock } from '../../../desktop/src/main/maker-ipc/sendToSessionLock.ts';
import { withRehydrateCloseSuppressed } from '../../../desktop/src/main/maker-host/rehydrateCloseSuppression.ts';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from '../../../desktop/src/main/device-link/broadcast-tap.ts';
import { getCurrentDbClientSnapshot, getDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { botProfiles, botSessionLinks, sessions } from '../../../desktop/src/main/localDb/schema.ts';
import { commitContextRebuildWithPorts } from '../../../desktop/src/main/localDb/contextRebuildPersistence.ts';
import { findLatestContextRebuildMeta, findLatestUserMessageForRebuild } from '../../../desktop/src/main/localDb/contextRebuildQueries.ts';
import { listMessagesForAgentHandoff } from '../../../desktop/src/main/localDb/agentHandoffHistory.ts';
import { dbToMakerAgentKind } from '../../../desktop/src/shared/agentKindConversion.ts';
import { DEFAULT_MODEL_COMPACTION_PCT } from '../../../desktop/src/shared/modelContextLimit.ts';

type Log = ContextOverflowRolloverDeps['log'];

/** What the Host runtime around the factory provides (agent/runtime.ts, codex-runtime.ts, main.ts). */
export interface HostRecoveryPorts {
  getMaker(): {
    getSession(sessionId: string): ReturnType<ContextOverflowRolloverDeps['getLiveSession']>;
    closeSession(sessionId: string, reason?: string): Promise<void>;
  };
  /** The Host's message store (createDbMessage for the rebuild card). */
  persistMessage: CommitContextRecoveryPorts['createDbMessage'];
  /** Publishes a Host hub event (the rebuild's session patch). */
  publish(event: Record<string, unknown>): void;
  buildCreateOptsWithStderr: ReplayContextRecoveryPorts['buildCreateOptsWithStderr'];
  readSessionExtraDirsFromDb: ReplayContextRecoveryPorts['readSessionExtraDirsFromDb'];
  readSessionWritableDirsFromDb: ReplayContextRecoveryPorts['readSessionWritableDirsFromDb'];
  resolveVerifiedWindow?: ContextOverflowRolloverDeps['resolveVerifiedWindow'];
  /** Present only while oversized Codex history recovery is open (classifyCodexHistory). */
  codexHistory?: Pick<ClassifyCodexHistoryPorts, 'readCodexThreadStorageReadOnly' | 'classifyCodexHistoryOversized'>;
  /** Present only while Pi's unsupported request option recovery is open. */
  piCompat?: {
    read: NonNullable<ContextOverflowRolloverDeps['readPiNativeCompatOverride']>;
    record: NonNullable<ContextOverflowRolloverDeps['recordPiNativeCompatOverride']>;
  };
  /**
   * The Host's pending handoff registry (agentHandoff.ts createAgentHandoffPendingRegistry): the
   * rebuilt context's summary, sent once with the next accepted send. The desktop's singleton
   * (agentHandoffPendingSingleton.ts) cannot load on the Host.
   */
  pendingHandoff: {
    set: NonNullable<ContextOverflowRolloverDeps['setPendingHandoff']>;
    readGeneration: NonNullable<ContextOverflowRolloverDeps['readPendingHandoffGeneration']>;
  };
  log: Log;
}

/** What one input-queue runtime provides (input-queue.mjs, turn-executor.mjs). */
export interface HostRecoveryRuntimePorts {
  /** The replay turn (turn-executor.mjs replay); the recovery holds the task's send lock. */
  replay: ReplayContextRecoveryPorts['sendToAgentAcceptedUnlocked'];
  drainHistories(): Promise<void>;
  resetWireNotes(sessionId: string): void;
  readAutoReviewHistory: ReplayContextRecoveryPorts['readAutoReviewHistory'];
  /** The Host coordinator; its clear is the coordinator's, synchronous, as on the desktop (input-queue.mjs). */
  coordinator: NonNullable<ReturnType<RecoveryCallbackPorts['getCoordinator']>>;
  /** The replay was accepted: a shutdown no longer waits for this recovery (context-recovery.ts). */
  noteRebuilt(sessionId: string): void;
}

/**
 * The desktop's context overflow rollover (register.ts createContextOverflowRollover) on the Host's
 * ports: one instance per input-queue runtime, so its memory of continued inputs lasts as long as
 * that owner's runtime. Bindings that differ from the desktop are listed in the release table
 * (context recovery): no external recovery owner, native session handoff, companion recall or cold
 * Pi verification on the Host yet; Cindy Make's project fence runs nothing (the Host refuses Cindy
 * Make inputs).
 */
export function createHostContextRecoveryRollover(host: HostRecoveryPorts, runtime: HostRecoveryRuntimePorts) {
  const readSession = (sessionId: string) => readContextRecoverySessionWithPorts({
    getDbClient, sessions, botSessionLinks, botProfiles, eq: (left, right) => eq(left, right),
  }, sessionId);
  const callbacks: RecoveryCallbackPorts = {
    getCoordinator: () => runtime.coordinator,
    resetWireNotes: id => runtime.resetWireNotes(id),
  };
  return createContextOverflowRollover({
    // Plugin-owned and headless plugin setup turns: the Host refuses both inputs today.
    hasExternalRecoveryOwner: () => false,
    getSessionRow: readSession,
    ...(host.codexHistory ? {
      classifyCodexHistory: (threadId: string) => classifyCodexHistoryWithPorts({
        captureDataOwnerBroadcastScope, getCurrentDbClientSnapshot, isDataOwnerBroadcastScopeCurrent,
        ...host.codexHistory!,
      }, threadId),
    } : {}),
    getAutoCompactThresholdPct: () => DEFAULT_MODEL_COMPACTION_PCT,
    ...(host.resolveVerifiedWindow ? { resolveVerifiedWindow: host.resolveVerifiedWindow } : {}),
    listMessages: sessionId => listMessagesForAgentHandoff(sessionId, 400) as ReturnType<ContextOverflowRolloverDeps['listMessages']>,
    findLatestUser: sessionId => findLatestUserMessageForRebuild(sessionId) as ReturnType<NonNullable<ContextOverflowRolloverDeps['findLatestUser']>>,
    findLatestRebuildMeta: findLatestContextRebuildMeta,
    getLiveSession: sessionId => host.getMaker().getSession(sessionId),
    closeSession: sessionId => host.getMaker().closeSession(sessionId, 'runtime-refresh'),
    drainPersistQueue: () => runtime.drainHistories(),
    commitRebuild: (sessionId, handoff, meta, signal) => commitContextRecoveryWithPorts({
      captureDataOwnerBroadcastScope, getCurrentDbClientSnapshot, isDataOwnerBroadcastScopeCurrent,
      sessions, eq: (left, right) => eq(left, right),
      commitContextRebuild: (id, text, rebuildMeta) => commitContextRebuildWithPorts({
        now: () => Date.now(), createId: () => createId(), tx: (name, args) => getDbClient().tx(name, args),
      }, id, text, rebuildMeta),
      broadcastSessionPatched: (id, patch) => host.publish({ type: 'session_changed', sessionId: id, patch }),
      createDbMessage: host.persistMessage,
      createId: () => createId(),
      log: host.log,
    }, sessionId, handoff, meta, signal),
    setPendingHandoff: (sessionId, handoff, expectedGeneration) =>
      host.pendingHandoff.set(sessionId, handoff, expectedGeneration),
    readPendingHandoffGeneration: sessionId => host.pendingHandoff.readGeneration(sessionId),
    onRebuilt: sessionId => {
      contextRecoveryRebuilt(callbacks, sessionId);
      runtime.noteRebuilt(sessionId);
    },
    getRecoveryAbortSignal: sessionId => contextRecoveryAbortSignal(callbacks, sessionId),
    ...(host.piCompat ? {
      readPiNativeCompatOverride: host.piCompat.read,
      recordPiNativeCompatOverride: host.piCompat.record,
    } : {}),
    replayUserMessage: (sessionId, content, agentFacingWireContent, recovery) => replayContextRecoveryWithPorts({
      getDbClient, sessions, eq: (left, right) => eq(left, right),
      buildCreateOptsWithStderr: host.buildCreateOptsWithStderr,
      dbToMakerAgentKind,
      readSessionExtraDirsFromDb: host.readSessionExtraDirsFromDb,
      directoryGrantsForRuntime,
      log: host.log,
      readSessionWritableDirsFromDb: host.readSessionWritableDirsFromDb,
      restoreAutoReviewUserIntent,
      readAutoReviewHistory: runtime.readAutoReviewHistory,
      readContextRecoverySession: readSession,
      canContinueContextRecovery,
      isHeadlessGhostSetupTurn: () => false,
      bindingStore: { findByTarget: () => null },
      sendToAgentAcceptedUnlocked: runtime.replay,
      persistedUserContentToWireMessage,
      PI_CACHE_RECOVERY_EXPECTATION,
      INHERITED_CAPABILITY_SELECTION,
      AUTO_REVIEW_SOURCE_CONTENT,
      readAutoReviewUserText,
      AUTO_REVIEW_USER_INTENT,
      // The desktop fences Cindy Make project folders; the Host refuses Cindy Make inputs.
      withCindyMakeProjectUse: async (_userData, _workingDir, run) => run(),
      app: { getPath: () => '' },
    }, sessionId, content, agentFacingWireContent, recovery),
    withSessionLock: withSendToSessionLock,
    withCloseSuppressed: withRehydrateCloseSuppressed,
    log: host.log,
  });
}
