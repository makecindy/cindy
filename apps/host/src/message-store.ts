import { createMessageClearRecovery } from '../../desktop/src/main/localDb/messageClearRecovery.js';
import { readVisiblePiUserEntry, patchMessageAgentMetaWithResultRow } from '../../desktop/src/main/localDb/messageMutations.js';
import { removeRefs as removeMediaRefs, removeSessionAttachmentRefIfUnreferencedByLiveMessage } from '../../desktop/src/main/cindy-media/ledger.js';
import { recomputePrRefsForSession } from '../../desktop/src/main/git-context/prRefsStore.js';
import { createLogger } from '../../desktop/src/main/logger.js';
import { messageToCamel } from "../../desktop/src/main/localDb/mapper.js";
import {
  writeMessageRow,
  type MessageWriteOptions,
} from "../../desktop/src/main/localDb/messageWrite.js";
import type { CurrentDbClientSnapshot } from "../../desktop/src/main/localDb/client/current.js";
import type { AgentMeta } from "../../desktop/src/renderer/lib/ccAgent.types.js";
import { hostChatAttachments } from "./media-store.js";

/** HTTP/event presentation around the same durable insert used by Desktop. */
export function createHostMessageStore(deps: {
  getOwner: () => CurrentDbClientSnapshot | null;
  publish: (event: unknown) => void;
  commitMediaRefs?: typeof hostChatAttachments.commitMessageMediaRefs;
}) {
  const pendingPublication = new WeakMap<
    CurrentDbClientSnapshot["client"],
    Set<string>
  >();
  return async (
    sessionId: string,
    input: Record<string, unknown>,
    options?: MessageWriteOptions & {
      shouldBroadcast?: () => boolean;
    },
  ) => {
    const owner = deps.getOwner();
    if (!owner) throw new Error("DbClient not ready");
    const role = input.role;
    if (typeof input.clientId !== "string" || !input.clientId)
      throw new Error("clientId is required");
    if (
      role !== "user" &&
      role !== "assistant" &&
      role !== "error" &&
      role !== "tool_use" &&
      role !== "tool_result" &&
      role !== "thinking" &&
      role !== "ask_user" &&
      role !== "plan_review" &&
      role !== "agent_switch"
    ) {
      throw new Error("unsupported message role");
    }
    if (input.content === undefined) throw new Error("content is required");
    const createdAt =
      typeof input.createdAt === "string"
        ? Date.parse(input.createdAt)
        : input.createdAt;
    const agentKind =
      input.agentKind === "claude-code" ? "cc" : input.agentKind;
    const { row, created } = await writeMessageRow(
      owner.client,
      sessionId,
      {
        clientId: input.clientId,
        role,
        content: input.content,
        toolUseId:
          typeof input.toolUseId === "string" ? input.toolUseId : undefined,
        agentMeta: input.agentMeta as AgentMeta | null | undefined,
        agentKind:
          agentKind === "cc" || agentKind === "codex" || agentKind === "pi"
            ? agentKind
            : null,
        ...(typeof createdAt === "number" && Number.isFinite(createdAt)
          ? { createdAt }
          : {}),
      },
      options,
    );
    let pending = pendingPublication.get(owner.client);
    if (!pending) pendingPublication.set(owner.client, (pending = new Set()));
    if (created) pending.add(row.id);
    if (deps.getOwner() !== owner) throw new Error("message owner changed");
    await (deps.commitMediaRefs ?? hostChatAttachments.commitMessageMediaRefs)(
      { sessionId, role: row.role, content: row.content },
      owner.client.drizzle,
    );
    if (deps.getOwner() !== owner) throw new Error("message owner changed");
    const message = messageToCamel(row);
    if (pending.has(row.id) && options?.shouldBroadcast?.() !== false) {
      deps.publish({
        type: "message_created",
        sessionId,
        messageId: message.id,
        message,
      });
    }
    pending.delete(row.id);
    return message;
  };
}

/** Recovery uses the same row mutations as Desktop, with the initiating
 * account captured for every cleanup and publication after asynchronous IO. */
export function createHostMessageRecovery(deps: {
  getOwner: () => CurrentDbClientSnapshot | null;
  publish: (event: unknown) => void;
}) {
  const capture = () => {
    const owner = deps.getOwner();
    if (!owner) throw new Error("DbClient not ready");
    return owner;
  };
  const isCurrent = (owner: CurrentDbClientSnapshot) => deps.getOwner() === owner;
  const rewindPersistedUserMessageAfterClear = createMessageClearRecovery({
    captureOwnerBroadcastScope: capture,
    isOwnerBroadcastScopeCurrent: isCurrent,
    getDbClient: owner => owner.client,
    removeMediaRefs: (params, owner) => isCurrent(owner)
      ? removeMediaRefs(params, owner.client.drizzle) : Promise.resolve(0),
    collectCindyMediaHashes: hostChatAttachments.collectCindyMediaHashes,
    removeSessionAttachmentRefIfUnreferencedByLiveMessage: (params, owner) => isCurrent(owner)
      ? removeSessionAttachmentRefIfUnreferencedByLiveMessage(params, owner.client.drizzle) : Promise.resolve(0),
    broadcastMessageDeleted: (payload, owner) => {
      if (isCurrent(owner)) deps.publish({ type: 'message_deleted', ...payload });
    },
    recomputePrRefsForSession: (id, owner) => recomputePrRefsForSession(id, {
      dbClient: owner.client, isCurrent: () => isCurrent(owner),
    }),
    log: createLogger('localDb/messages'),
  });
  return {
    rewindPersistedUserMessageAfterClear,
    async readPiUserEntry(sessionId: string, clientId: string) {
      const owner = capture();
      const id = await readVisiblePiUserEntry(owner.client, sessionId, clientId);
      if (!isCurrent(owner)) throw new Error('message owner changed');
      return id;
    },
    async linkPiUserEntry(sessionId: string, clientId: string, piEntryId: string) {
      const owner = capture();
      const result = await patchMessageAgentMetaWithResultRow(owner.client, sessionId, clientId, { piEntryId });
      if (!isCurrent(owner)) throw new Error('message owner changed');
      return result !== null;
    },
  };
}
