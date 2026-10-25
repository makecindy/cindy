import { createSessionSnapshot } from "@cindy/runtime-db/sessionSnapshot";
import { createSessionListProjection } from "@cindy/runtime-db/sessionListProjection";
import { createProvisionalSessions } from "@cindy/runtime-db/provisionalSessions";
import { createHiddenSessionRegistry } from "@cindy/runtime-db/hiddenSessionRegistry";
import { createCindyMakeAttention } from "@cindy/runtime-db/cindyMakeAttention";
import { normalizeRemoteHostId } from "@cindy/runtime-db/remoteHostId";
import {
  createPersistedConversations,
  type PersistedConversationHost,
} from "./persistedConversations.js";
import { createSessionInterruptionBoot } from "./sessionInterruptionBoot.js";
import {
  createSessionNotifications,
  type SessionNotificationHost,
} from "./sessionNotifications.js";
import {
  createSessionOpening,
  type SessionOpeningHost,
} from "./sessionOpening.js";
import { createSessionQueries } from "./sessionQueries.js";
import { createSessionUserActivity } from "./sessionUserActivity.js";
import { createRecentWorkdirs } from "./recentWorkdirs.js";
import { createDialogueWorkspace } from "./dialogueWorkspace.js";
import { createSessionActiveTurn } from "./sessionActiveTurn.js";
import { createInterruptedResumeCandidates } from "./interruptedResumeCandidates.js";
import { createSessionRouteLock } from "./sessionRouteLock.js";
import { createSessionArchiveSync } from "./sessionArchiveSync.js";
import { createSessionRuntimeCleanup } from "./sessionRuntimeCleanup.js";
import { createToolResultCompaction } from "./toolResultCompaction.js";
import { createSessionService } from "./sessionService.js";
import type {
  SessionServiceHost,
  SessionLifecycleEffects,
} from "./sessionServiceHost.js";

type DialogueHost = Parameters<typeof createDialogueWorkspace>[0];
export interface PersistedSessionHost<InvokeEvent>
  extends
    Omit<
      PersistedConversationHost<InvokeEvent>,
      "getSessionInterruptionBootAt"
    >,
    SessionLifecycleEffects,
    DialogueHost,
    Pick<SessionNotificationHost, "localRecipients">,
    Pick<
      SessionOpeningHost,
      "readGitSafetySettings" | "ensureProjectGitInitialized"
    >,
    Pick<
      SessionServiceHost<InvokeEvent>,
      "senderId" | "imAttachmentsRoot" | "removeImSessionAttachmentDirs"
    > {
  admitModel: Parameters<
    ReturnType<typeof createSessionOpening>["setSessionOpeningModelAdmission"]
  >[0];
}

/** One owner lifetime for the original session, message, media and queue-facing APIs. */
export function createPersistedSessions<InvokeEvent>(
  host: PersistedSessionHost<InvokeEvent>,
) {
  const { database, logger } = host;
  const boot = createSessionInterruptionBoot();
  const conversations = createPersistedConversations({ ...host, ...boot });
  const provisional = createProvisionalSessions({
    currentDb: database,
    logger,
  });
  const hidden = createHiddenSessionRegistry({ currentDb: database, logger });
  const snapshot = createSessionSnapshot({ ...database, logger });
  const listProjection = createSessionListProjection(database.getDbClient);
  const queries = createSessionQueries(conversations.rowMapper.sessionToCamel);
  const dialogue = createDialogueWorkspace(host);
  const opening = createSessionOpening({
    ...host,
    ...database,
    ...conversations.rowMapper,
    ...dialogue,
  });
  opening.setSessionOpeningModelAdmission(host.admitModel);
  const notifications = createSessionNotifications({ ...host, ...provisional });
  const recent = createRecentWorkdirs({ ...host, ...database });
  const activity = createSessionUserActivity({
    ...database,
    ...recent,
    notifications,
  });
  const makeAttention = createCindyMakeAttention(database.getDbClient);
  const activeTurn = createSessionActiveTurn({
    ...database,
    ...makeAttention,
    boot,
    logger,
  });
  const interrupted = createInterruptedResumeCandidates({
    ...database,
    ...activeTurn,
  });
  const routeLock = createSessionRouteLock();
  const archiveSync = createSessionArchiveSync();
  const cleanup = createSessionRuntimeCleanup(
    archiveSync.requestSessionArchiveSync,
  );
  const compaction = createToolResultCompaction({
    ...conversations.persistence,
    logger,
  });
  const sessions = createSessionService({
    ...host,
    ...database,
    ...provisional,
    ...hidden,
    ...snapshot,
    ...listProjection,
    ...queries,
    ...conversations.rowMapper,
    ...conversations.prRefs,
    ...conversations.media,
    ...conversations.messages,
    ...conversations.persistence,
    ...conversations.subagentService,
    ...dialogue,
    ...opening,
    ...notifications,
    ...recent,
    ...activity,
    ...activeTurn,
    ...interrupted,
    ...routeLock,
    ...archiveSync,
    ...cleanup,
    ...compaction,
    currentDb: database,
    normalizeRemoteHostId,
    removeDeletedSessionMediaRefs:
      conversations.media.ledger.removeSessionRefsIfDeleted,
  });
  return {
    ...conversations,
    sessions,
    opening,
    queries,
    recent,
    provisional,
    hidden,
    snapshot,
    activeTurn,
    routeLock,
    archiveSync,
    cleanup,
    notifications,
    register(options: Parameters<typeof sessions.registerSessionIpc>[1] = {}) {
      conversations.messages.registerMessageIpc();
      conversations.subagentService.registerSubagentRunsIpc();
      recent.registerRecentWorkdirsIpc();
      sessions.registerSessionIpc(database.getCurrentDbClientUserId, options);
    },
    async drain(sessionId: string) {
      await conversations.persistence.drainPersistQueue();
      await activeTurn.drainSessionActiveTurnWrites(sessionId);
    },
  };
}
