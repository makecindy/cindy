import {createConversationSearch} from '@cindy/app-runtime/conversationSearch';
import path from "node:path";
import { createHash } from "node:crypto";
import { createWorkingDirHistoryFilter } from "@cindy/app-runtime/workingDirHistoryFilter";
import { createChatHistoryReader } from "@cindy/app-runtime/chatHistoryReader";
import { createChatHistorySearch } from "@cindy/app-runtime/chatHistorySearch";
import {
  createChatEmbeddingSettingsStore,
  type ChatEmbeddingDefaultContext,
} from "@cindy/app-runtime/chatEmbeddingSettingsStore";
import { createChatEmbeddingSettingsWatcher } from "@cindy/app-runtime/chatEmbeddingSettingsWatcher";
import { createSessionTerminalReader } from "@cindy/runtime-db/sessionTerminal";
import { createEmbeddingHost } from "@cindy/runtime-db/embedding/host";
import { createEmbeddingProviders } from "@cindy/runtime-db/embedding/providers";
import { EmbeddingService } from "@cindy/runtime-db/embedding/EmbeddingService";
import { isModelDisabled, isProviderDisabled } from "@cindy/model-providers";
import { isCindyEmbeddingModelAvailable } from "@cindy/model-providers/model-plane/provider-access-policy";
import type { DbLogger } from "@cindy/runtime-db/logging";
import type { XdtHelperHistoryDeps } from "@cindy/mcps";
import type { NodeDatabase } from "../database.js";
import type { TerminalModelConfig } from "../models/config.js";
import type { TerminalConversations } from "./conversations.js";

/** SQLite readers and the original optional index consumer, scoped to one host owner. */
export function createTerminalHistory(options: {
  database: NodeDatabase;
  conversations: TerminalConversations;
  models: TerminalModelConfig;
  profileDir: string;
  dataRoot: string;
  dialogueWorkspaceRoots():string[];
  logger: DbLogger;
  account(): ChatEmbeddingDefaultContext;
  assertCurrent(): void;
}) {
  const { database, conversations, models } = options;
  const getDbClient = () => {
    options.assertCurrent();
    return database.getDbClient();
  };
  const { chatEmbedding } = conversations;
  const providers = createEmbeddingProviders();
  const embedding = createEmbeddingHost({
    providers,
    createService: (deps) =>
      new EmbeddingService(deps, {
        providers,
        isProviderRouteSuspended: (provider) =>
          isProviderDisabled(models.snapshot().disabled ?? {}, provider),
        isProviderModelRouteDisabled: (provider, model) =>
          isProviderDisabled(models.snapshot().disabled ?? {}, provider) ||
          isModelDisabled(models.snapshot().disabled ?? {}, provider, model),
      }),
  });
  const owner = database.getCurrentDbClientSnapshot()!;
  let closed = false;
  const settings = createChatEmbeddingSettingsStore({
    userDataDirectory: () => options.dataRoot,
    createLogger: () => options.logger,
    activeOwnerScopeKey: () => owner.userId + ":" + owner.clientEpoch,
    dataOwnerStorageKey: (id) =>
      createHash("sha256").update(id).digest("hex").slice(0, 20),
    getActiveAppSession: () => {
      const account = options.account();
      return {
        mode: account.mode,
        dataOwnerId: account.userId ?? owner.userId,
      };
    },
    isAppSessionBoundaryPending: () =>
      closed || database.getCurrentDbClientSnapshot() !== owner,
    ownerScopedUserDataPath: (...parts) => {
      options.assertCurrent();
      return path.join(options.profileDir, ...parts);
    },
    hasExclusiveSharedLegacyUserDataAccess: () =>
      !closed && database.getCurrentDbClientSnapshot() === owner,
  });
  const available = () =>
    isCindyEmbeddingModelAvailable(
      models.activeCatalog(),
      chatEmbedding.CHAT_EMBED_MODEL_ID,
    );
  function start() {
    options.assertCurrent();
    const enabled =
      available() &&
      settings.readChatEmbeddingSettings(options.account()).enabled;
    embedding.setEmbeddingSourceSuspended("chat", !available());
    if (!enabled && !embedding.isPluginVectorConsumerActive()) return;
    const service = embedding.isEmbeddingHostStarted()
      ? embedding.getEmbeddingService()
      : embedding.startEmbeddingHost({
          getDbClient,
          isVecAvailable: () => getDbClient().vecAvailable,
          getApiKey: () => models.gatewayCredentials()?.apiKey,
          gatewayBaseUrl: () => models.gatewayCredentials()?.endpoint ?? "",
          log: options.logger,
        });
    if (enabled) {
      chatEmbedding.setupChatHistoryEmbedder({
        service,
        getDbClient,
        log: options.logger,
      });
      chatEmbedding.setChatEmbeddingEnabled(true);
    }
  }
  embedding.registerEmbeddingHostLazyStart(start);
  let reconciling = Promise.resolve();
  function reconcile() {
    reconciling = reconciling
      .catch(() => {})
      .then(async () => {
        if (closed) return;
        options.assertCurrent();
        const enabled =
          available() &&
          settings.readChatEmbeddingSettings(options.account()).enabled;
        embedding.setEmbeddingSourceSuspended("chat", !available());
        if (enabled) start();
        else {
          chatEmbedding.setChatEmbeddingEnabled(false);
          await embedding.stopEmbeddingHostIfNoPluginVectorConsumer();
        }
      });
    return reconciling;
  }
  const watcher = createChatEmbeddingSettingsWatcher(() => {
    void reconcile().catch((error) =>
      options.logger.warn("History index settings could not be applied", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });
  watcher.rebind(path.join(options.profileDir, "chat-embedding-settings.json"));
  const directories = createWorkingDirHistoryFilter({
    getDbClient,
    dialogueWorkspaceRoots: options.dialogueWorkspaceRoots,
  });
  const readers = createChatHistoryReader({
    ...directories,
    getDbClient,
    messageToCamel: conversations.rowMapper.messageToCamel,
  });
  const search = createChatHistorySearch({
    ...directories,
    ...chatEmbedding,
    getDbClient,
    messageToCamel: conversations.rowMapper.messageToCamel,
    getEmbeddingService: embedding.getEmbeddingService,
    createLogger: () => options.logger,
  });
  const deps: XdtHelperHistoryDeps = {
    listSessions: async (args) => ({
      ok: true,
      page: await readers.listSessionsForHistory(args),
    }),
    listWorkdirs: async (args) => ({
      ok: true,
      page: await readers.listWorkdirsForHistory(args),
    }),
    getMessages: async (args) => ({
      ok: true,
      page: await readers.getMessagesForHistory(args),
    }),
    searchChatHistory: async (args) => ({
      ok: true,
      result: await search.searchChatHistoryHybrid(args),
    }),
  };
  return {
    deps,
    readers,
    ...createConversationSearch({getDbClient,...search}),
    search,
    settings,
    embedding,
    reconcile,
    ...createSessionTerminalReader(getDbClient),
    async close() {
      closed = true;
      watcher.dispose();
      await reconciling.catch(() => {});
      chatEmbedding.setChatEmbeddingEnabled(false);
      await embedding.stopEmbeddingHost();
    },
  };
}
