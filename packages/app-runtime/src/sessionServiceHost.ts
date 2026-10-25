import type { DbClient } from "@cindy/runtime-db";
import type { DbLogger } from "@cindy/runtime-db/logging";
import type { createCurrentDbClient } from "@cindy/runtime-db/client/current";
import type { createProvisionalSessions } from "@cindy/runtime-db/provisionalSessions";
import type { createSessionSnapshot } from "@cindy/runtime-db/sessionSnapshot";
import type { createSessionListProjection } from "@cindy/runtime-db/sessionListProjection";
import type { createMediaLedger } from "@cindy/runtime-db/mediaLedger";
import type { createPrRefsStore } from "@cindy/runtime-db/prRefsStore";
import type { createHiddenSessionRegistry } from "@cindy/runtime-db/hiddenSessionRegistry";
import type { createInboundFileStaging } from "@cindy/im-runtime/inboundFileStaging";
import type { createLegacyImageCache } from "@cindy/media-core/legacy-image-cache";
import type { MessageServiceHost } from "./messageServiceHost.js";
import type { createMessageService } from "./messageService.js";
import type { createMessagePersistence } from "./messagePersistBroadcaster.js";
import type { createSessionOpening } from "./sessionOpening.js";
import type { createSessionNotifications } from "./sessionNotifications.js";
import type { createSessionUserActivity } from "./sessionUserActivity.js";
import type { createSessionQueries } from "./sessionQueries.js";
import type { createRowMapper } from "./rowMapper.js";
import type { createDialogueWorkspace } from "./dialogueWorkspace.js";
import type { createRecentWorkdirs } from "./recentWorkdirs.js";
import type { createGeneratedImageRecovery } from "./generatedImageRecovery.js";
import type { createSessionActiveTurn } from "./sessionActiveTurn.js";
import type { createInterruptedResumeCandidates } from "./interruptedResumeCandidates.js";
import type { createSessionRouteLock } from "./sessionRouteLock.js";
import type { createSessionRuntimeCleanup } from "./sessionRuntimeCleanup.js";
import type { createSessionArchiveSync } from "./sessionArchiveSync.js";
import type { createSubagentService } from "./subagentService.js";
import type { createToolResultCompaction } from "./toolResultCompaction.js";

type Result<T extends (...args: any[]) => any> = ReturnType<T>;
export type SharedTaskClosurePreparation = {
  sessionId: string;
  marker: number;
  rowIds: number[];
};
export interface SessionLifecycleEffects {
  userDataDirectory(): string;
  piAgentHomeForSession(sessionId: string): string;
  piSubagentRunHomes(): Promise<string[]>;
  physicalWorktreeKey(value: string): Promise<string>;
  withWorktreeResourceLocks<T>(
    resources: readonly string[],
    task: () => Promise<T>,
  ): Promise<T>;
  managedWorktreeRoot(value: string): string | null;
  notifyWorktreeRecycleOpportunity(resource: string): void;
  clearSessionAttention(
    sessionId: string,
    intent?: "explicit" | "passive",
  ): void;
  commitBotProfileDeletion(input: {
    botId: string;
    sessionIds: string[];
    keepTaskHistory: boolean;
  }): Promise<{ sessionIds: string[]; status: "archived" | "deleted" }>;
  bindDeletedPiSubagentCleanupCancel(fn: (sessionId: string) => void): void;
  emitSessionCreated(sessionId: string): void;
  emitSessionListChangedLocally(sessionId: string): void;
  assertRendererSessionSourceAllowed(input: {
    source: unknown;
    workingDir: string | undefined;
    remoteHostId: unknown;
    userData: string;
  }): void;
  notifyAgentIslandSessionPatch(
    sessionId: string,
    patch: {
      status?: unknown;
      title?: unknown;
      workingDir?: unknown;
      workspaceKind?: unknown;
      hiddenAt?: unknown;
    },
  ): void;
  formatInterruptedToolDetail(toolName: string, input: unknown): string | null;
  removeTurnChangeSetsForSession(sessionId: string): Promise<void>;
  settleMakeTasksForSession(sessionId: string): Promise<void>;
  recycleCindyMakeTask(
    sessionId: string,
    db: DbClient["drizzle"],
    isOwnerCurrent: () => boolean,
  ): Promise<void>;
  consumeWritableDirectoryPickerGrants(input: {
    scopeId: string;
    senderId: number;
    requestedDirs: readonly string[];
    previousDirs: readonly string[];
  }): Promise<void>;
  loadSharedTasks(): Promise<{
    prepareSharedTaskClosureForTask(
      sessionId: string,
      db: DbClient,
    ): Promise<SharedTaskClosurePreparation | null>;
    rollbackPreparedSharedTaskClosure(
      db: DbClient,
      prepared: SharedTaskClosurePreparation,
    ): Promise<void>;
    finalizePreparedSharedTaskClosure(
      db: DbClient,
      prepared: SharedTaskClosurePreparation,
    ): Promise<void>;
    closeSharedTaskForTask(sessionId: string, db: DbClient): Promise<void>;
  }>;
  loadMaker(): Promise<{
    getMakerIfReady():
      | {
          isSessionAlive(id: string): boolean;
          closeSession(id: string): Promise<void>;
        }
      | null
      | undefined;
  }>;
  loadWorktreeRecycle(): Promise<{
    isSessionStillRemovable(
      sessionId: string,
      db: DbClient["drizzle"],
    ): Promise<boolean>;
    hasRegisteredWorktreeForSession(sessionId: string): boolean;
    recycleWorktreeForRemovedSession(
      sessionId: string,
      opts: {
        scanOwners?: boolean;
        db?: DbClient["drizzle"];
        isOwnerCurrent?: () => boolean;
        isSessionRuntimeAlive?: (id: string) => boolean | undefined;
        recycleOwner?: (id: string) => Promise<void>;
      },
    ): Promise<void>;
  }>;
  loadPluginNotifications(): Promise<{
    notifyGhostSessionEvent(
      event: "created" | "archived",
      input: { sessionId: string; workdir?: string },
    ): unknown;
  }>;
  loadSummaries(): Promise<{
    backfillPinnedSessionSummaries(): unknown;
    setPinnedSectionCardMode(value: boolean): void;
    maybeGenerateSessionTaskSummary(
      sessionId: string,
      opts: { force: boolean },
    ): unknown;
  }>;
  loadTranscriptRelocation(): Promise<{
    relocateClaudeTranscriptsForSessionMove(
      sessionId: string,
      oldDir: string,
      newDir: string,
      scope?: { client: DbClient; assertCurrent: () => void },
    ): Promise<{ persistedSdkSessionId: string | null }>;
  }>;
}
/** UI authorization/notifications are ports; session mutations stay in the original service. */
export interface SessionServiceHost<InvokeEvent>
  extends
    SessionLifecycleEffects,
    Pick<
      Result<typeof createProvisionalSessions>,
      | "claimOwnedProvisionalSession"
      | "configureProvisionalSessions"
      | "deleteUnsentSessionRow"
      | "forgetProvisionalSession"
      | "isProvisionalSession"
      | "markProvisionalSession"
      | "provisionalManagedDir"
      | "removeEmptyDialogueDir"
      | "sweepLeftoverProvisionalSessions"
    >,
    Result<typeof createSessionSnapshot>,
    Result<typeof createSessionNotifications>,
    Result<typeof createSessionUserActivity>,
    Pick<
      Result<typeof createSessionOpening>,
      "ensureOpenedProjectGit" | "openSession"
    >,
    Pick<
      Result<typeof createSessionQueries>,
      | "selectSessionListRows"
      | "selectSessionWithCount"
      | "selectSessionsByIds"
      | "flattenSessionReadRow"
      | "projectSessionReadResult"
    >,
    Pick<
      Result<typeof createRowMapper>,
      | "sessionToCamel"
      | "sessionUsageToCamel"
      | "sessionCreateToRow"
      | "sessionPatchToRow"
      | "persistableSessionEffort"
      | "projectSessionRuntimeFields"
      | "finalizePlainPreview"
    >,
    Pick<
      Result<typeof createSessionListProjection>,
      "persistSessionListProjectionBatch"
    >,
    Pick<Result<typeof createDialogueWorkspace>, "ensureDialogueWorkspaceDir">,
    Pick<Result<typeof createPrRefsStore>, "recomputePrRefsForSession">,
    Pick<
      Result<typeof createInboundFileStaging>,
      "imAttachmentsRoot" | "removeImSessionAttachmentDirs"
    >,
    Pick<Result<typeof createRecentWorkdirs>, "upsertRecentWorkdir">,
    Pick<
      Result<typeof createHiddenSessionRegistry>,
      "ensureHiddenSessionRegistryLoaded"
    >,
    Pick<
      Result<typeof createGeneratedImageRecovery>,
      "recoverGeneratedImagesForHistory"
    >,
    Pick<Result<typeof createMessagePersistence>, "noteSessionClearBoundary">,
    Pick<
      Result<typeof createSessionActiveTurn>,
      | "ackSessionTurnEndedDurable"
      | "ackSessionTurnEndedIfUnchanged"
      | "listErrorTailPendingRows"
      | "listErrorTailPendingSessionIds"
      | "listInterruptedPendingRows"
      | "listInterruptedPendingSessionIds"
      | "setOnSessionTurnEndedPersisted"
    >,
    Result<typeof createInterruptedResumeCandidates>,
    Pick<
      Result<typeof createMessageService>,
      "dismissErrorMessage" | "rebroadcastAgentSwitchBoundary"
    >,
    Pick<
      Result<typeof createSessionRouteLock>,
      "withSessionRouteLock" | "withSessionRouteLocks"
    >,
    Result<typeof createSessionRuntimeCleanup>,
    Pick<Result<typeof createSessionArchiveSync>, "requestSessionArchiveSync">,
    Pick<
      Result<typeof createSubagentService>,
      "broadcastSubagentRunsInvalidated"
    >,
    Result<typeof createToolResultCompaction>,
    Pick<
      MessageServiceHost<InvokeEvent>,
      "ipc" | "assertTrustedAppRendererEvent" | "isDeviceLinkInvoke"
    > {
  logger: DbLogger;
  currentDb: Pick<
    Result<typeof createCurrentDbClient>,
    "getDbClient" | "getCurrentDbClientSnapshot" | "getCurrentDbClientUserId"
  >;
  getDbClient(): DbClient;
  normalizeRemoteHostId: typeof import("@cindy/runtime-db/remoteHostId").normalizeRemoteHostId;
  senderId(event: InvokeEvent): number;
  imageCacheStore: Pick<Result<typeof createLegacyImageCache>, "removeSession">;
  removeDeletedSessionMediaRefs: Result<
    typeof createMediaLedger
  >["removeSessionRefsIfDeleted"];
}
