import { createContextRebuildCommit } from '@cindy/app-runtime/contextRebuildCommit';
import { createBotRemoteResourceInvalidation } from '@cindy/app-runtime/botRemoteResourceInvalidation';
import {createGoalInactiveNote} from '@cindy/app-runtime/goal/inactiveNote';
import { createSessionTitlePersistence } from '@cindy/app-runtime/sessionTitlePersistence';
import { createLatestMessageText } from '@cindy/app-runtime/latestMessageText';
import { createSessionActiveTurn } from '@cindy/app-runtime/sessionActiveTurn';
import { createCindyMakeAttention } from '@cindy/runtime-db/cindyMakeAttention';
import { createSessionQueries } from '@cindy/app-runtime/sessionQueries';
import { createSessionClearPersistence } from '@cindy/app-runtime/sessionClearPersistence';
import { createSessionSnapshot } from '@cindy/runtime-db/sessionSnapshot';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { createPersistedConversations, type PersistedConversationHost } from '@cindy/app-runtime/persistedConversations';
import { createSessionInterruptionBoot } from '@cindy/app-runtime/sessionInterruptionBoot';
import { createSessionNotifications } from '@cindy/app-runtime/sessionNotifications';
import { createSessionAgentSwitchPersistence } from '@cindy/app-runtime/sessionAgentSwitchPersistence';
import { createProvisionalSessions } from '@cindy/runtime-db/provisionalSessions';
import { createSessionUserActivity } from '@cindy/app-runtime/sessionUserActivity';
import { createRecentWorkdirs } from '@cindy/app-runtime/recentWorkdirs';
import { createReplyQuoteReader } from '@cindy/app-runtime/chatReplyQuoteNote';
import { withCrossProcessLock } from '@cindy/remote-agent/crossProcessLock';
import type { DbLogger } from '@cindy/runtime-db/logging';
import type { InvocationContext } from '../contracts.js';
import type { NodeDatabase } from '../database.js';
import type { TerminalTaskMedia } from './media.js';
import type { BroadcastLocal } from '@cindy/app-runtime/ownerBroadcast';

type ConversationHost = PersistedConversationHost<InvocationContext>;
type WorkPageReader = Parameters<ConversationHost['setHistoryWorkPageReader']>[0];

/** Node transport adapter. SQLite, native imports, message projection and media
 * persistence are the very same services registered by the graphical host. */
export async function openTerminalConversations(options: {
  database: NodeDatabase;
  media: TerminalTaskMedia;
  profileDir: string;
  logger: DbLogger;
  region: 'cn' | 'global';
  isCurrent(): boolean;
  isSessionRunning(id: string): boolean;
  isParentPiSessionLive(id: string): boolean;
  emit(channel: string, payload: unknown): void;
  emitLocal: BroadcastLocal;
  emitRemote(channel: string, payload: unknown): void;
  getSessionProvider: ConversationHost['getSessionProvider'];
  sessionPatched?(id: string, patch: { title?: unknown; workingDir?: unknown; workspaceKind?: unknown }): void;
  historyChanged: ConversationHost['scheduleBotRemoteResourceChangedForSession'];
  botChanged?(botId: string): void;
  removeTurnChangeSetsForSession(id: string): Promise<void>;
  materializeSshRemoteMedia: ConversationHost['materializeSshRemoteMedia'];
}) {
  const database = options.database;
  const owner = database.getCurrentDbClientSnapshot();
  if (!owner) throw new Error('TASK_DATABASE_OWNER_UNAVAILABLE');
  const current = () => options.isCurrent() && database.getCurrentDbClientSnapshot() === owner;
  const assertCurrent = () => { if (!current()) throw new Error('TASK_OWNER_CHANGED'); };
  const ownerScopeKey = owner.userId + ':' + owner.clientEpoch;
  const ownerStamp = { dataOwnerId: owner.userId, ownerGeneration: owner.clientEpoch };
  const context = new AsyncLocalStorage<InvocationContext>();
  const handlers = new Map<string, (event: InvocationContext, ...args: any[]) => unknown>();
  let workPageReader: WorkPageReader | undefined;
  const publish = (channel: string, payload: unknown) => { if (current()) options.emit(channel, payload); };
  const broadcastLocal: BroadcastLocal = (channel, payload, ...stamp) => { if (current()) options.emitLocal(channel, payload, ...stamp); };
  const broadcastTap = {
    captureDataOwnerBroadcastScope: () => ({ ownerScopeKey, ownerStamp }),
    isDataOwnerBroadcastScopeCurrent: (scope: { ownerScopeKey?: string | null }) => current() && scope.ownerScopeKey === ownerScopeKey,
    getSafeDataOwnerPushStamp: () => current() ? ownerStamp : undefined,
    tapWindowBroadcast: (channel: string, payload: unknown) => { if (current()) options.emitRemote(channel, payload); },
  };
  const botInvalidation = createBotRemoteResourceInvalidation({
    ...broadcastTap, getDbClient: () => { assertCurrent(); return database.getDbClient(); },
    activeOwnerScopeKey: () => ownerScopeKey, isAppSessionBoundaryPending: () => !current(),
    broadcastLocal, log: options.logger,
  });
  if(options.botChanged)botInvalidation.onBotRemoteResourceChanged(options.botChanged);
  const boot = createSessionInterruptionBoot();
  const runtime = createPersistedConversations<InvocationContext>({
    database, logger: options.logger, region: options.region,
    ...boot,
    userDataDirectory: () => options.profileDir,
    mediaDirectory: () => options.profileDir,
    ipc: { handle(channel, handler) {
      if (handlers.has(channel)) throw new Error('DUPLICATE_CONVERSATION_CHANNEL');
      handlers.set(channel, handler);
    } },
    broadcastLocal,
    broadcastTrustedLocal: broadcastLocal,
    broadcastTap,
    getActiveDataOwnerPushStamp: () => { assertCurrent(); return ownerStamp; },
    owner: {
      activeOwnerScopeKey: () => current() ? ownerScopeKey : 'closed',
      getActiveAppSession: () => ({ dataOwnerId: current() ? owner.userId : null }),
      isAppSessionBoundaryPending: () => !current(),
      dataOwnerStorageKey: id => createHash('sha256').update(id).digest('hex').slice(0, 20),
      withCrossProcessLock,
    },
    assertTrustedAppRendererEvent(event) {
      assertCurrent(); event.assertCurrent?.();
      if (context.getStore() !== event) throw new Error('UNTRUSTED_TASK_INVOCATION');
    },
    isDeviceLinkInvoke: () => context.getStore()?.source === 'remote',
    getDeviceLinkInvokeContext: () => context.getStore(),
    setHistoryWorkPageReader: reader => { workPageReader = reader; },
    scheduleBotRemoteResourceChangedForSession: (id, scope) => {
      options.historyChanged(id, scope);
      botInvalidation.scheduleBotRemoteResourceChangedForSession(id, scope);
    },
    getSessionProvider: options.getSessionProvider,
    materializeSshRemoteMedia: options.materializeSshRemoteMedia,
  }, await options.media.persisted());
  runtime.messages.registerMessageIpc(options.isSessionRunning);
  runtime.subagentService.registerSubagentRunsIpc({
    enqueueDurableWrite: runtime.persistence.enqueueDurableWrite,
    isParentPiSessionLive: options.isParentPiSessionLive,
  });
  const provisional = createProvisionalSessions({ currentDb: database, logger: options.logger });
  const notifications = createSessionNotifications({ ...provisional, broadcastTap, logger: options.logger, localRecipients: () => [{ isDestroyed: () => !current(), isTrusted: current, send: broadcastLocal }] });
  const agentSwitch = createSessionAgentSwitchPersistence({
    ...notifications, ...runtime.messages, ...runtime.rowMapper,
    getDbClient: () => { assertCurrent(); return database.getDbClient(); },
    logger: options.logger,
  });
  const getDbClient = () => { assertCurrent(); return database.getDbClient(); };
  const latest = createLatestMessageText({ getDbClient, ...runtime.rowMapper });
  const activeTurn = createSessionActiveTurn({ getDbClient, ...createCindyMakeAttention(getDbClient), boot, logger: options.logger });
  const recent = createRecentWorkdirs<InvocationContext>({
    getDbClient, logger: options.logger, broadcastLocal: (channel, payload, ..._stamp) => publish(channel, payload),
    ipc: { handle(channel, handler) { handlers.set(channel, handler); } },
  });
  recent.registerRecentWorkdirsIpc();
  const activity = createSessionUserActivity({ getDbClient, notifications, ...recent });
  const snapshot = createSessionSnapshot({ getDbClient, logger: options.logger });
  const clear = createSessionClearPersistence({ ...notifications, ...runtime.persistence, ...runtime.media, ...runtime.prRefs, ...runtime.subagentService,
    getDbClient, logger: options.logger, removeTurnChangeSetsForSession: options.removeTurnChangeSetsForSession });
  const contextRebuild = createContextRebuildCommit({
    ...broadcastTap, ...notifications, ...runtime.messages,
    getCurrentDbClientSnapshot: () => current() ? owner : null,
    createDbMessage: runtime.messages.createMessage, logger: options.logger,
  });
  const replyQuote = createReplyQuoteReader(getDbClient);
  const titles = createSessionTitlePersistence({
    ...notifications, ...runtime.rowMapper, ...createSessionQueries(runtime.rowMapper.sessionToCamel), getDbClient,
    notifyAgentIslandSessionPatch: (id, patch) => options.sessionPatched?.(id, patch),
  });
  return {
    ...runtime,
    get channels(){return [...handlers.keys()];},
    broadcastLocal: options.emitLocal,
    contextRebuild, recent, provisional, notifications, agentSwitch, activity, replyQuote, snapshot, clear, titles, broadcastTap, latest, activeTurn, botInvalidation,
    goalInactive:createGoalInactiveNote({getDbClient,...latest}),
    hasChannel: (channel: string) => handlers.has(channel),
    invoke(channel: string, args: unknown[], invocation: InvocationContext) {
      assertCurrent(); invocation.assertCurrent?.();
      const handler = handlers.get(channel);
      if (!handler) throw new Error('UNKNOWN_CONVERSATION_CHANNEL');
      return context.run(invocation, () => handler(invocation, ...args));
    },
    readWorkPage(...args: Parameters<WorkPageReader>) {
      assertCurrent();
      if (!workPageReader) throw new Error('CONVERSATION_HISTORY_NOT_READY');
      return workPageReader(...args);
    },
  };
}

export type TerminalConversations = Awaited<ReturnType<typeof openTerminalConversations>>;
