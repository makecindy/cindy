import { and, eq, isNull } from "drizzle-orm";
import {
  createMessagePersistence,
  type MessagePersistencePorts,
} from "../../../desktop/src/main/messagePersistBroadcaster.js";
import { persistSessionStreamEventCore } from "../../../desktop/src/main/maker-ipc/sessionEventStreamCore.js";
import { createAssistantSamplingSettlementStore } from "../../../desktop/src/main/assistantSamplingStore.js";
import { ownerScopedPath } from "../../../desktop/src/main/ownerContext.js";
import {
  getDbClient,
  type CurrentDbClientSnapshot,
} from "../../../desktop/src/main/localDb/client/current.js";
import { messages } from "../../../desktop/src/main/localDb/schema.js";
import {
  messageToCamel,
  extractMessagePreview,
} from "../../../desktop/src/main/localDb/mapper.js";
import { latestVisiblePreviewRow } from "../../../desktop/src/main/localDb/latestMessageText.js";
import { removeSessionAttachmentRefIfUnreferencedByLiveMessage } from "../../../desktop/src/main/cindy-media/ledger.js";
import {
  writeMessageContentRow,
  rollbackAssistantMessageRow,
  patchMessageAgentMetaWithResultRow,
  findVisibleToolUseMessageByAliasesRow,
} from "../../../desktop/src/main/localDb/messageMutations.js";
import { createLogger } from "../../../desktop/src/main/logger.js";
import {
  hostChatAttachments,
  materializeHostToolMedia,
} from "../media-store.js";
import type { AgentEvent, Session } from "@cindy/maker-core";
import type { AgentMeta } from "../../../desktop/src/renderer/lib/ccAgent.types.js";

/** Node presentation and IO around the SAME message event reducer as Desktop. */
export function createHostEventPersistence(deps: {
  getOwner?: () => CurrentDbClientSnapshot | null;
  isCurrent: () => boolean;
  persistMessage: MessagePersistencePorts["createDbMessage"];
  publish: (event: unknown) => void;
  onPersistenceError: (error: unknown) => void;
}) {
  const scopeKey = () => {
    const owner = deps.getOwner?.();
    return owner ? `${owner.userId}:${owner.clientEpoch}` : undefined;
  };
  const broadcastTap: MessagePersistencePorts["broadcastTap"] = {
    captureDataOwnerBroadcastScope: () => ({ ownerScopeKey: scopeKey() }),
    isDataOwnerBroadcastScopeCurrent: (scope) =>
      deps.isCurrent() && scope.ownerScopeKey === scopeKey(),
  };
  const publish: typeof deps.publish = (event) => {
    if (deps.isCurrent()) deps.publish(event);
  };
  const log = createLogger("host-message-stream");
  const broadcastMessageRow: MessagePersistencePorts["broadcastMessageRow"] = (
    sessionId,
    message,
    scope,
  ) => {
    if (scope && !broadcastTap.isDataOwnerBroadcastScopeCurrent(scope)) return;
    publish({
      type: "message_created",
      sessionId,
      messageId: message.id,
      message,
    });
  };
  const broadcastMessageDeleted: MessagePersistencePorts["broadcastMessageDeleted"] =
    (payload, scope) => {
      if (scope && !broadcastTap.isDataOwnerBroadcastScopeCurrent(scope))
        return;
      publish({ type: "message_deleted", ...payload });
    };
  const core = createMessagePersistence({
    broadcastTap,
    broadcastMessageRow,
    broadcastMessageDeleted,
    assistantSamplingSettlements: createAssistantSamplingSettlementStore(() =>
      ownerScopedPath("sampling-settlements"),
    ),
    onPersistenceError: deps.onPersistenceError,
    commitMessageMediaRefs: hostChatAttachments.commitMessageMediaRefs,
    materializeToolProcessMedia: materializeHostToolMedia,
    createDbMessage: deps.persistMessage,
    async updateDbMessageContent(
      sessionId,
      clientId,
      content,
      answer,
      finalSnapshot,
    ) {
      const owner = deps.getOwner?.();
      const client = owner?.client ?? getDbClient();
      const isCurrent = () =>
        deps.isCurrent() &&
        (!deps.getOwner || deps.getOwner() === owner) &&
        finalSnapshot?.isCurrent() !== false;
      if (!isCurrent()) return null;
      if (finalSnapshot) {
        const [original] = await client.drizzle
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.sessionId, sessionId),
              eq(messages.clientId, clientId),
              eq(messages.role, "assistant"),
              isNull(messages.rewindAt),
            ),
          )
          .limit(1);
        if (!original || !isCurrent()) return null;
      }
      const row = await writeMessageContentRow(
        client,
        sessionId,
        clientId,
        content,
        answer,
      );
      if (!row) return null;
      await hostChatAttachments.commitMessageMediaRefs(
        { sessionId, role: row.role, content: row.content },
        client.drizzle,
      );
      const message = messageToCamel(row);
      const latest = await latestVisiblePreviewRow(sessionId, client);
      if (isCurrent()) {
        publish({
          type: "session_changed",
          sessionId,
          patch: {
            preview: extractMessagePreview(latest?.content, latest?.role),
          },
        });
      }
      return message;
    },
    async discardPersistedAssistantMessage(sessionId, clientId, current) {
      const owner = deps.getOwner?.();
      const client = owner?.client ?? getDbClient();
      const row = await rollbackAssistantMessageRow(
        client,
        sessionId,
        clientId,
        () =>
          current() &&
          deps.isCurrent() &&
          (!deps.getOwner || deps.getOwner() === owner),
      );
      if (!row) return false;
      // The deletion has committed. Derived cleanup is best-effort, just as on
      // Desktop: retrying the deletion would now find no row and lose its receipt.
      try {
        for (const hash of hostChatAttachments.collectCindyMediaHashes(
          row.content,
        )) {
          await removeSessionAttachmentRefIfUnreferencedByLiveMessage(
            { sessionId, hash },
            client.drizzle,
          );
        }
        const latest = await latestVisiblePreviewRow(sessionId, client);
        if (deps.isCurrent() && (!deps.getOwner || deps.getOwner() === owner)) {
          publish({
            type: "session_changed",
            sessionId,
            patch: {
              preview: extractMessagePreview(latest?.content, latest?.role),
            },
          });
        }
      } catch (error) {
        log.warn("assistant retraction derived state refresh failed", {
          sessionId,
          clientId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    },
    findVisibleToolUseMessageByAliases: (id, aliases) =>
      findVisibleToolUseMessageByAliasesRow(getDbClient(), id, aliases),
    patchMessageAgentMetaWithResult: (id, clientId, patch) =>
      patchMessageAgentMetaWithResultRow(getDbClient(), id, clientId, patch),
    async broadcastMessageAgentMetaUpdate(sessionId, clientId, scope) {
      const [row] = await getDbClient()
        .drizzle.select()
        .from(messages)
        .where(
          and(
            eq(messages.sessionId, sessionId),
            eq(messages.clientId, clientId),
            isNull(messages.rewindAt),
          ),
        )
        .limit(1);
      if (
        !row ||
        (scope && !broadcastTap.isDataOwnerBroadcastScopeCurrent(scope))
      )
        return false;
      broadcastMessageRow(sessionId, messageToCamel(row), scope);
      return true;
    },
    onErrorPersisted: (sessionId, persistId) =>
      publish({ type: "error_persisted", sessionId, persistId }),
  });
  const media = new Set<Promise<void>>();
  const persistence = {
    ...core,
    persistToolProcessMedia(
      ...args: Parameters<typeof core.persistToolProcessMedia>
    ) {
      const promise = core.persistToolProcessMedia(...args);
      media.add(promise);
      void promise.then(
        () => media.delete(promise),
        () => media.delete(promise),
      );
      return promise;
    },
  };
  return {
    ...persistence,
    event(session: Session, event: AgentEvent) {
      const eventAgentMeta = (event.agentMeta as AgentMeta | null) ?? null;
      if (eventAgentMeta) persistence.noteAgentMeta(session.id, eventAgentMeta);
      return persistSessionStreamEventCore(
        {
          persistence,
          orcaTeamServiceForEvents: null,
          log,
          broadcastSubagentRunsChanged: (payload) =>
            publish({ type: "subagent_runs_changed", ...payload }),
        },
        session,
        { event, eventAgentMeta },
      );
    },
    async drain() {
      await Promise.all([...media]);
      await core.drainPersistQueue();
    },
  };
}
