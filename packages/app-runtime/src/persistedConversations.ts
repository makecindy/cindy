import {
  createPersistedMedia,
  type PersistedMediaHost,
} from "./persistedMedia.js";
import type { CindyRegion } from "@cindy/maker-shared/brand-identity";
import { createRegionalMoney } from "@cindy/maker-shared/regional-money";
import { createTurnUsageDetails } from "@cindy/maker-shared/turn-usage-details";
import { resolveStaleCodexSubscriptionValueEstimate } from "@cindy/maker-shared/codex-subscription-value";
import type { createCurrentDbClient } from "@cindy/runtime-db/client/current";
import { createPrRefsStore } from "@cindy/runtime-db/prRefsStore";
import { createSubagentRunStore } from "@cindy/runtime-db/subagentRuns";
import { createCodexPlanStore } from "@cindy/runtime-db/codexPlanState";
import { createBotTaskReplyResults } from "@cindy/runtime-db/botTaskReplyResults";
import { createMessagePreviewReader } from "@cindy/runtime-db/messagePreviewReader";
import { createNativeSessionMetadata } from "@cindy/runtime-db/nativeSessionMetadata";
import { createSqliteFactory } from "@cindy/runtime-db/betterSqliteFactory";
import type { DbLogger } from "@cindy/runtime-db/logging";
import { createRowMapper } from "./rowMapper.js";
import { createToolProcessMedia } from "./toolProcessMedia.js";
import { createMediaToolResultFallback } from "./mediaToolResultFallback.js";
import { createGeneratedImageRecovery } from "./generatedImageRecovery.js";
import { createImportedUserContent } from "./importedUserContent.js";
import { createClaudeLocalSessions } from "./claudeLocalSessions.js";
import { createCodexLocalSessions } from "./codexLocalSessions.js";
import { createMessageService } from "./messageService.js";
import { createMessagePersistence } from "./messagePersistBroadcaster.js";
import { createChatHistoryEmbedder } from "./chatHistoryEmbedder.js";
import { capReferenceMessageRows } from "./referenceHistoryCap.js";
import type { MessageServiceHost } from "./messageServiceHost.js";
import type { MessagePersistenceHost } from "./messagePersistenceHost.js";
import { createSubagentObservationFence } from "./subagentObservationRewindFence.js";
import {
  createSubagentService,
  type SubagentServiceHost,
} from "./subagentService.js";
import { createSessionStreamPersistence } from "./sessionEventStream.js";

/** Platform and live-runtime ports. Message, media and native-history behavior
 * belongs to the original services below, independently of the UI transport. */
export interface PersistedConversationHost<InvokeEvent>
  extends
    Pick<
      MessageServiceHost<InvokeEvent>,
      | "ipc"
      | "broadcastTap"
      | "broadcastLocal"
      | "assertTrustedAppRendererEvent"
      | "isDeviceLinkInvoke"
      | "getDeviceLinkInvokeContext"
      | "setHistoryWorkPageReader"
      | "scheduleBotRemoteResourceChangedForSession"
    >,
    Pick<
      SubagentServiceHost<InvokeEvent>,
      "broadcastTrustedLocal" | "getActiveDataOwnerPushStamp"
    > {
  database: Pick<
    ReturnType<typeof createCurrentDbClient>,
    "getDbClient" | "getCurrentDbClientSnapshot" | "getCurrentDbClientUserId"
  >;
  logger: DbLogger;
  region: CindyRegion;
  userDataDirectory(): string;
  /** Byte storage follows the active profile's existing media namespace. */
  mediaDirectory(): string;
  getSessionInterruptionBootAt(): number;
  owner: PersistedMediaHost["owner"];
  getSessionProvider: MessagePersistenceHost["getSessionProvider"];
  materializeSshRemoteMedia: Parameters<
    typeof createToolProcessMedia
  >[0]["materializeSshRemoteMedia"];
}

/** Compose the same services used by Desktop, with one database/owner lifetime. */
export function createPersistedConversations<InvokeEvent>(
  host: PersistedConversationHost<InvokeEvent>,
  media = createPersistedMedia(host),
) {
  const { database, logger } = host;
  const money = createRegionalMoney(host.region);
  const usage = createTurnUsageDetails(money);
  const rowMapper = createRowMapper({
    getSessionInterruptionBootAt: host.getSessionInterruptionBootAt,
    money,
  });
  const { blobStore, imageCacheStore, ledger, journal } = media;
  const toolMedia = createToolProcessMedia({
    ingestMedia: media.ingestMedia,
    materializeSshRemoteMedia: host.materializeSshRemoteMedia,
    logger,
  });
  const mediaFallback = createMediaToolResultFallback(logger);
  const generatedImages = createGeneratedImageRecovery();
  const prRefs = createPrRefsStore({ ...database, logger });
  const subagents = createSubagentRunStore(database.getDbClient);
  const codexPlan = createCodexPlanStore(database.getDbClient);
  const botReplies = createBotTaskReplyResults(database.getDbClient);
  const preview = createMessagePreviewReader(database.getDbClient);
  const nativeMetadata = createNativeSessionMetadata(
    database.getCurrentDbClientSnapshot,
  );
  const importedUserContent = createImportedUserContent({
    imageCacheStore,
    logger,
  });
  const nativeHost = {
    ...database,
    ...nativeMetadata,
    ...prRefs,
    ...media,
    importedUserContent,
    logger,
  };
  const claudeHistory = createClaudeLocalSessions(nativeHost);
  const codexHistory = createCodexLocalSessions({
    ...nativeHost,
    region: host.region,
    userDataDirectory: host.userDataDirectory,
    ...createSqliteFactory({ logger, maskPath: () => "<private>" }),
  });
  const chatEmbedding = createChatHistoryEmbedder();
  // Calls occur only after composition. The two original modules intentionally
  // share this lazy port to avoid an eager message-service/persistence cycle.
  const messages = createMessageService<InvokeEvent>({
    ...host,
    ...database,
    ...money,
    ...usage,
    ...preview,
    ...media,
    ...generatedImages,
    ...prRefs,
    ...claudeHistory,
    ...codexHistory,
    logger,
    extractMessagePreview: rowMapper.extractMessagePreview,
    capReferenceMessageRows,
    removeMediaRefs: ledger.removeRefs,
    removeSessionAttachmentRefIfUnreferencedByLiveMessage:
      ledger.removeSessionAttachmentRefIfUnreferencedByLiveMessage,
    resolveStaleCodexSubscriptionValueEstimate,
    onChatMessageCreatedForEmbedding: chatEmbedding.onMessageCreated,
    whenTurnErrorPersisted: (...args) =>
      persistence.whenTurnErrorPersisted(...args),
  });
  const persistence = createMessagePersistence({
    ...host,
    ...database,
    ...messages,
    ...media,
    ...toolMedia,
    ...botReplies,
    ...subagents,
    logger,
    codexPlan,
    takeMediaToolResult: mediaFallback.takeMediaToolResult,
    createDbMessage: messages.createMessage,
    updateDbMessageContent: messages.updateMessageContent,
  });
  const subagentFence = createSubagentObservationFence();
  const subagentService = createSubagentService({
    ...host,
    store: subagents,
    activeOwnerScopeKey: host.owner.activeOwnerScopeKey,
  });
  const stream = createSessionStreamPersistence({
    persistence,
    fence: subagentFence,
    persistSubagentTaskUpdate: subagents.persistSubagentTaskUpdate,
    broadcastSubagentRunsChanged: subagentService.broadcastSubagentRunsChanged,
  });
  return {
    messages,
    persistence,
    stream,
    subagentFence,
    subagentService,
    rowMapper,
    money,
    usage,
    chatEmbedding,
    prRefs,
    subagents,
    codexPlan,
    media: { ...media, ...toolMedia, ...mediaFallback, ...generatedImages },
    nativeHistory: { ...claudeHistory, ...codexHistory },
  };
}
