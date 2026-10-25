import { createWorktreeResourceLocks } from "@cindy/worktree-core/resourceLock";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { createWorktreeRecycleEvents } from "@cindy/worktree-core/recycleEvents";
import { createWorktreeRecycleJournal } from "@cindy/worktree-core/recycleJournal";
import { createWorktreeRecycleRequests } from "@cindy/worktree-core/recycleRequests";
import { managedWorktreeRoot } from "@cindy/worktree-core/runtimeLeases";
import { withCrossProcessLock } from "@cindy/remote-agent/crossProcessLock";
import { TerminalWorktreeRegistry } from "../worktrees/registry.js";
import { desktopAppDataRoot } from "../worktrees/references.js";
import type { TerminalTaskStorage } from "./storage.js";
import {
  createSessionService,
  type RegisterSessionIpcOpts,
} from "@cindy/app-runtime/sessionService";
import { createSessionImport } from "@cindy/app-runtime/sessionImport";
import { createSessionQueries } from "@cindy/app-runtime/sessionQueries";
import { createSessionListProjection } from "@cindy/runtime-db/sessionListProjection";
import { normalizeRemoteHostId } from "@cindy/runtime-db/remoteHostId";
import { createInterruptedResumeCandidates } from "@cindy/app-runtime/interruptedResumeCandidates";
import { createToolResultCompaction } from "@cindy/app-runtime/toolResultCompaction";
import { createSessionRuntimeCleanup } from "@cindy/app-runtime/sessionRuntimeCleanup";
import { createSessionArchiveSync } from "@cindy/app-runtime/sessionArchiveSync";
import { createSessionRouteLock } from "@cindy/app-runtime/sessionRouteLock";
import { createSessionRemovalRecycle } from "@cindy/app-runtime/sessionRemovalRecycle";
import { createPiSubagentDeletion } from "@cindy/app-runtime/piSubagentDeletion";
import { createBotProfileDeletionStore } from "@cindy/app-runtime/botProfileDeletionStore";
import { createWritableDirectoryPickerGrants } from "@cindy/app-runtime/writableDirectoryPickerGrant";
import { assertRendererSessionSourceAllowed } from "@cindy/app-runtime/sessionSourceGuard";
import { formatIslandToolDetail } from "@cindy/app-runtime/session-activity/toolDetail";
import { createLocalizedToolRowWording } from "@cindy/app-runtime/session-activity/toolWording";
import {
  prepareSharedTasksForSession,
  rollbackPreparedSharedTasks,
  finalizePreparedSharedTasks,
  closeSharedTasksInJournalForSession,
} from "@cindy/runtime-db/sharedTasks";
import type { SessionLifecycleEffects } from "@cindy/app-runtime/sessionServiceHost";
import type { createSessionOpening } from "@cindy/app-runtime/sessionOpening";
import type { createDialogueWorkspace } from "@cindy/app-runtime/dialogueWorkspace";
import type { createSessionTaskSummary } from "@cindy/app-runtime/sessionTaskSummary";
import type { createInboundFileStaging } from "@cindy/im-runtime/inboundFileStaging";
import type { NodeDatabase } from "../database.js";
import type { TerminalConversations } from "./conversations.js";
import type { TerminalWorktrees } from "../worktrees/host.js";
import type { TaskInvocationContext } from "./host.js";
import type { createTerminalSessionActivity } from "./activity.js";
import type { DbLogger } from "@cindy/runtime-db/logging";

/** Node composition of the original session API. Lists, mutations, destructive
 * lifecycle ordering and notifications are owned by the shared service. */
export async function createTerminalSessions(host: {
  database: NodeDatabase;
  conversations: TerminalConversations;
  opening: ReturnType<typeof createSessionOpening>;
  dialogue: ReturnType<typeof createDialogueWorkspace>;
  dialogueWorkspaceRoots(): string[];
  activity: Awaited<ReturnType<typeof createTerminalSessionActivity>>;
  summaries: ReturnType<typeof createSessionTaskSummary>;
  attachments: ReturnType<typeof createInboundFileStaging>;
  profileDir: string;
  logger: DbLogger;
  storage: TerminalTaskStorage;
  current(): boolean;
  assertCurrent(): void;
  context(): TaskInvocationContext;
  worktrees(): TerminalWorktrees | undefined;
  emit(channel: string, payload: unknown): void;
  emitLocal(channel: string, payload: unknown): void;
  withRouteLock<T>(id: string, action: () => Promise<T>): Promise<T>;
  cleanupRuntime(id: string): void;
  isAlive(id: string): boolean;
  closeTask(id: string): Promise<void>;
  closeSharedTask?(id: string): Promise<void>;
  notifyGhostSessionEvent: Awaited<
    ReturnType<SessionLifecycleEffects["loadPluginNotifications"]>
  >["notifyGhostSessionEvent"];
  removeTurnChangeSetsForSession: SessionLifecycleEffects["removeTurnChangeSetsForSession"];
  settleMakeTasksForSession: SessionLifecycleEffects["settleMakeTasksForSession"];
  recycleCindyMakeTask: SessionLifecycleEffects["recycleCindyMakeTask"];
  transcriptRelocation: Awaited<
    ReturnType<SessionLifecycleEffects["loadTranscriptRelocation"]>
  >;
  options: RegisterSessionIpcOpts;
  t(key: string): string;
}) {
  const { conversations: c, database } = host;
  const handlers = new Map<
    string,
    (event: TaskInvocationContext, ...args: unknown[]) => unknown
  >();
  const getDbClient = () => {
    host.assertCurrent();
    return database.getDbClient();
  };
  const currentDb = {
    getDbClient,
    getCurrentDbClientSnapshot: () => {
      host.assertCurrent();
      return database.getCurrentDbClientSnapshot();
    },
    getCurrentDbClientUserId: () => {
      host.assertCurrent();
      return database.getCurrentDbClientUserId();
    },
  };
  const owner = database.getCurrentDbClientSnapshot()!;
  const grants = createWritableDirectoryPickerGrants();
  const piRoot = path.join(host.profileDir, "engines", "pi");
  const piAgentHomeForSession = (id: string) => path.join(piRoot, id);
  const deletion = createPiSubagentDeletion(piAgentHomeForSession);
  const archive = createSessionArchiveSync();
  const cleanup = createSessionRuntimeCleanup(
    archive.requestSessionArchiveSync,
  );
  cleanup.setSessionRuntimeCleanup(host.cleanupRuntime);
  const routes = createSessionRouteLock();
  routes.setSessionRouteLockImplementation(host.withRouteLock);
  const worktrees = () => {
    const value = host.worktrees();
    if (!value) throw new Error("WORKTREE_HOST_UNAVAILABLE");
    return value;
  };
  const registry = new TerminalWorktreeRegistry({
    root: host.profileDir,
    tasks: host.storage,
    guard: host.assertCurrent,
    logger: host.logger,
  });
  await registry.ready;
  const locks = createWorktreeResourceLocks({ withCrossProcessLock });
  const events = createWorktreeRecycleEvents(locks.worktreeResourceId);
  const journal = createWorktreeRecycleJournal({
    ...locks,
    ...events,
    log: host.logger,
    userDataRoot: () => host.profileDir,
    appDataRoot: desktopAppDataRoot,
  });
  const requests = createWorktreeRecycleRequests({
    ...locks,
    ...journal,
    store: registry.store,
  });
  const recycle = createSessionRemovalRecycle({
    getDbClient,
    logger: host.logger,
    store: {
      get: (id) => (host.worktrees()?.store ?? registry.store).get(id),
      getAll: () => (host.worktrees()?.store ?? registry.store).getAll(),
    },
    removeWorktreeForSession: (...args) =>
      worktrees().manager.removeWorktreeForSession(...args),
    auditRegisteredWorktrees: () =>
      worktrees().maintenance.auditRegisteredWorktrees(),
  });
  const botDeletion = createBotProfileDeletionStore({
    getDbClient,
    activeOwnerScopeKey: () => `${owner.userId}:${owner.clientEpoch}`,
    isAppSessionBoundaryPending: () => !host.current(),
    ownerScopedUserDataPath: () => host.profileDir,
  });
  const service = createSessionService<TaskInvocationContext>({
    ...c.snapshot,
    ...c.provisional,
    ...c.notifications,
    ...c.activity,
    ...c.rowMapper,
    ...c.prRefs,
    ...c.persistence,
    ...c.messages,
    ...c.activeTurn,
    ...c.subagentService,
    ...host.dialogue,
    ...host.opening,
    ...c.recent,
    ...c.media,
    ...createSessionQueries(c.rowMapper.sessionToCamel),
    ...createSessionListProjection(getDbClient),
    ...createInterruptedResumeCandidates({ getDbClient, ...c.activeTurn }),
    ...createToolResultCompaction({ ...c.persistence, logger: host.logger }),
    ...host.activity.hidden,
    ...botDeletion,
    ...deletion,
    ...grants,
    ...routes,
    ...archive,
    ...cleanup,
    currentDb,
    getDbClient,
    normalizeRemoteHostId,
    logger: host.logger,
    ipc: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    assertTrustedAppRendererEvent: (event) => {
      host.assertCurrent();
      event.assertCurrent?.();
      if (event.source !== "local" || event.sharedTask)
        throw new Error("LOCAL_ONLY_COMMAND");
    },
    isDeviceLinkInvoke: () => host.context().source === "remote",
    // Node has no renderer IDs. Only the locally authenticated terminal may
    // obtain grants, and they are consumed under this owner and task scope.
    senderId: (event) => {
      if (event.source !== "local") throw new Error("LOCAL_ONLY_COMMAND");
      return 0;
    },
    userDataDirectory: () => host.profileDir,
    piAgentHomeForSession,
    piSubagentRunHomes: async () => {
      try {
        return (await readdir(piRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(piRoot, entry.name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    imageCacheStore: c.media.imageCacheStore,
    removeDeletedSessionMediaRefs: c.media.ledger.removeSessionRefsIfDeleted,
    imAttachmentsRoot: host.attachments.imAttachmentsRoot,
    removeImSessionAttachmentDirs:
      host.attachments.removeImSessionAttachmentDirs,
    physicalWorktreeKey: (value) =>
      (host.worktrees()?.locks ?? locks).physicalWorktreeKey(value),
    withWorktreeResourceLocks: (resources, action) =>
      (host.worktrees()?.locks ?? locks).withWorktreeResourceLocks(
        resources,
        async () => {
          try {
            return await action();
          } finally {
            await host.storage.reconcileWorktreeResourceReferences(resources);
          }
        },
      ),
    managedWorktreeRoot,
    notifyWorktreeRecycleOpportunity: (resource) =>
      (host.worktrees()?.events ?? events).notifyWorktreeRecycleOpportunity(
        resource,
      ),
    clearSessionAttention: host.activity.attention.clearSessionAttention,
    emitSessionCreated: (sessionId) =>
      (c.provisional.isProvisionalSession(sessionId)
        ? host.emitLocal
        : host.emit)("local-db:sessions:created", { sessionId }),
    emitSessionListChangedLocally: (sessionId) =>
      host.emitLocal("local-db:sessions:created", { sessionId }),
    assertRendererSessionSourceAllowed,
    notifyAgentIslandSessionPatch: host.activity.metadata,
    formatInterruptedToolDetail: (name, input) =>
      formatIslandToolDetail(name, input, {
        wording: createLocalizedToolRowWording(host.t),
      }),
    removeTurnChangeSetsForSession: host.removeTurnChangeSetsForSession,
    settleMakeTasksForSession: host.settleMakeTasksForSession,
    recycleCindyMakeTask: host.recycleCindyMakeTask,
    loadMaker: async () => ({
      getMakerIfReady: () => ({
        isSessionAlive: host.isAlive,
        closeSession: host.closeTask,
      }),
    }),
    loadWorktreeRecycle: async () => recycle,
    loadSummaries: async () => host.summaries,
    loadPluginNotifications: async () => ({
      notifyGhostSessionEvent: host.notifyGhostSessionEvent,
    }),
    loadTranscriptRelocation: async () => host.transcriptRelocation,
    loadSharedTasks: async () => ({
      prepareSharedTaskClosureForTask: async (id, client) =>
        client === database.getDbClient() && host.current()
          ? prepareSharedTasksForSession(client, id)
          : null,
      rollbackPreparedSharedTaskClosure: rollbackPreparedSharedTasks,
      finalizePreparedSharedTaskClosure: finalizePreparedSharedTasks,
      closeSharedTaskForTask: async (id, client) => {
        if (client !== database.getDbClient() || !host.current()) return;
        if (host.closeSharedTask) await host.closeSharedTask(id);
        else await closeSharedTasksInJournalForSession(client, id);
      },
    }),
  });
  service.setSessionWorktreeBindingLookup(
    (id) => (host.worktrees()?.store ?? registry.store).get(id)?.path ?? null,
  );
  service.setSessionWorktreeRecycle((...args) =>
    (host.worktrees()?.recycle ?? requests).requestWorktreeRecycle(...args),
  );
  service.setOnUserSessionTitleWritten(c.titles.noteUserTitleWritten);
  service.registerSessionIpc(currentDb.getCurrentDbClientUserId, host.options);
  const imports = createSessionImport<TaskInvocationContext>({
    ...currentDb,
    ...c.nativeHistory,
    dialogueWorkspaceRoots: host.dialogueWorkspaceRoots,
    userDataDirectory: () => host.profileDir,
    logger: host.logger,
    ipc: {
      handle(channel, handler) {
        handlers.set(channel, (event, ...args) => {
          host.assertCurrent();
          event.assertCurrent?.();
          if (event.source !== "local" || event.sharedTask)
            throw new Error("LOCAL_ONLY_COMMAND");
          return handler(event, args[0]);
        });
      },
    },
  });
  imports.registerSessionImportIpc();
  return {
    service,
    archive,
    routes,
    deletion,
    recycle,
    channels: [...handlers.keys()],
    has: (channel: string) => handlers.has(channel),
    invoke(channel: string, args: unknown[], context: TaskInvocationContext) {
      host.assertCurrent();
      context.assertCurrent?.();
      const handler = handlers.get(channel);
      if (!handler) throw new Error("UNKNOWN_SESSION_CHANNEL");
      return handler(context, ...args);
    },
    issueWritableDirectoryGrant: (scopeId: string, directory: string) => {
      host.assertCurrent();
      if (host.context().source !== "local")
        throw new Error("LOCAL_ONLY_COMMAND");
      return grants.issueWritableDirectoryPickerGrant({
        scopeId,
        directory,
        senderId: 0,
      });
    },
  };
}
