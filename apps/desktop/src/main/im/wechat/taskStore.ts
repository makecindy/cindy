import type { DbClient } from '../../localDb/client/DbClient.js';
import type {
  WechatActivateBindingEpochResult,
  WechatCancelForCommandResult,
  WechatCommitPollBatchResult,
  WechatCommitTerminalResult,
  WechatMarkOutboxDeliveredResult,
  WechatOutboxChunkInput,
  WechatOutboxKind,
  WechatPollFileAttachmentInput,
  WechatPollMediaBlobInput,
  WechatPollMediaRefInput,
  WechatRecordOutboxFailureResult,
  WechatPromoteTaskAttachmentsResult,
  WechatStopAllResult,
  WechatUnbindCleanupResult,
} from '../../localDb/client/tx/types.js';
import { decryptWechatContextToken, encryptWechatContextToken } from './contextCrypto.js';

const DEFAULT_TASK_TTL_MS = 30 * 60_000;
const DEFAULT_LEASE_MS = 60_000;

export interface WechatInboundTaskInput {
  id: string;
  platformMessageId: string;
  platformSeq: number;
  peerId: string;
  receivedAt: number;
  platformCreatedAt: number;
  sessionId: string;
  conversationEpoch: number;
  payloadJson: string;
  contextToken: string;
  overloadReply?: {
    outboxId: string;
    clientId: string;
    text: string;
  };
}

export interface WechatCommitBatchInput {
  bindingEpoch: string;
  expectedCursor: string;
  nextCursor: string;
  now: number;
  messages: WechatInboundTaskInput[];
  mediaBlobs?: WechatPollMediaBlobInput[];
  mediaRefs?: WechatPollMediaRefInput[];
  fileAttachments?: WechatPollFileAttachmentInput[];
  maxQueuedTasks?: number;
}

export interface WechatTask {
  id: string;
  bindingEpoch: string;
  peerId: string;
  sessionId: string;
  conversationEpoch: number;
  payloadJson: string;
  contextToken: string;
  attempts: number;
  receivedAt: number;
  expiresAt: number;
}

export interface WechatOutboxRecord {
  id: string;
  taskId: string;
  clientId: string;
  kind: WechatOutboxKind;
  chunkIndex: number;
  text: string;
  mediaJson: string;
  attempts: number;
  contextToken: string;
}

export interface WechatActiveBinding {
  bindingEpoch: string;
  cursor: string;
}

interface WechatOutboxRow extends Omit<WechatOutboxRecord, 'contextToken'> {
  bindingEpoch: string;
  contextNonce: string;
  contextCiphertext: string;
  contextTag: string;
}

export class WechatTaskStore {
  readonly #db: DbClient;
  readonly #dataKey: Buffer;

  constructor(db: DbClient, dataKey: Uint8Array) {
    if (dataKey.byteLength !== 32) throw new Error('WeChat data key must be 32 bytes.');
    this.#db = db;
    this.#dataKey = Buffer.from(dataKey);
  }

  destroy(): void {
    this.#dataKey.fill(0);
  }

  async getActiveBinding(): Promise<WechatActiveBinding | null> {
    const row = await this.#db.queryOne<{ bindingEpoch: string; cursor: string }>(
      `SELECT binding_epoch AS bindingEpoch, sync_cursor AS cursor
       FROM wechat_sync_state
       WHERE is_active = 1
       LIMIT 1`,
    );
    return row ?? null;
  }

  async getConversationEpoch(bindingEpoch: string, peerId: string): Promise<number> {
    const row = await this.#db.queryOne<{ conversationEpoch: number }>(
      `SELECT COALESCE(MAX(conversation_epoch), 0) AS conversationEpoch
       FROM wechat_inbox
       WHERE binding_epoch = ? AND peer_id = ?`,
      [bindingEpoch, peerId],
    );
    return row?.conversationEpoch ?? 0;
  }

  /**
   * Return the most recently received context for a peer. Context tokens are
   * encrypted at rest and are intentionally only addressable through the
   * currently active binding epoch, so proactive sends cannot target an
   * arbitrary WeChat id or a stale binding.
   */
  async getLatestPeerContext(args: {
    bindingEpoch: string;
    peerId: string;
  }): Promise<{ contextToken: string; sessionId: string | null } | null> {
    const row = await this.#db.queryOne<{
      taskId: string;
      sessionId: string | null;
      contextNonce: string;
      contextCiphertext: string;
      contextTag: string;
    }>(
      `SELECT id AS taskId,
              session_id AS sessionId,
              context_nonce AS contextNonce,
              context_ciphertext AS contextCiphertext,
              context_tag AS contextTag
       FROM wechat_inbox
       WHERE binding_epoch = ? AND peer_id = ?
       ORDER BY received_at DESC, rowid DESC
       LIMIT 1`,
      [args.bindingEpoch, args.peerId],
    );
    if (!row) return null;
    return {
      contextToken: decryptWechatContextToken(
        {
          nonce: row.contextNonce,
          ciphertext: row.contextCiphertext,
          tag: row.contextTag,
        },
        this.#dataKey,
        args.bindingEpoch,
        row.taskId,
      ),
      sessionId: row.sessionId,
    };
  }

  async getMostRecentPeer(bindingEpoch: string): Promise<string | null> {
    const row = await this.#db.queryOne<{ peerId: string }>(
      `SELECT peer_id AS peerId
       FROM wechat_inbox
       WHERE binding_epoch = ?
       ORDER BY received_at DESC, rowid DESC
       LIMIT 1`,
      [bindingEpoch],
    );
    return row?.peerId ?? null;
  }

  async advanceConversationEpoch(
    bindingEpoch: string,
    taskId: string,
    peerId: string,
  ): Promise<number> {
    const current = await this.getConversationEpoch(bindingEpoch, peerId);
    const next = current + 1;
    const result = await this.#db.exec(
      `UPDATE wechat_inbox
       SET conversation_epoch = ?
       WHERE binding_epoch = ? AND id = ? AND peer_id = ?`,
      [next, bindingEpoch, taskId, peerId],
    );
    if (result.changes !== 1) throw new Error('WECHAT_CONVERSATION_EPOCH_STALE');
    return next;
  }

  async countQueuedTasks(bindingEpoch: string): Promise<number> {
    const row = await this.#db.queryOne<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM wechat_inbox
       WHERE binding_epoch = ?
         AND status IN ('pending', 'dispatching', 'accepted_running', 'waiting_desktop')`,
      [bindingEpoch],
    );
    return row?.count ?? 0;
  }

  activateBindingEpoch(args: {
    bindingEpoch: string;
    expectedActiveEpoch: string | null;
    initialCursor?: string;
    now: number;
  }): Promise<WechatActivateBindingEpochResult> {
    return this.#db.tx('wechatActivateBindingEpoch', {
      bindingEpoch: args.bindingEpoch,
      expectedActiveEpoch: args.expectedActiveEpoch,
      initialCursor: args.initialCursor ?? '',
      now: args.now,
    });
  }

  commitPollBatch(input: WechatCommitBatchInput): Promise<WechatCommitPollBatchResult> {
    return this.#db.tx('wechatCommitPollBatch', {
      bindingEpoch: input.bindingEpoch,
      expectedCursor: input.expectedCursor,
      nextCursor: input.nextCursor,
      now: input.now,
      messages: input.messages.map((message) => ({
        id: message.id,
        platformMessageId: message.platformMessageId,
        platformSeq: message.platformSeq,
        peerId: message.peerId,
        receivedAt: message.receivedAt,
        platformCreatedAt: message.platformCreatedAt,
        expiresAt: message.receivedAt + DEFAULT_TASK_TTL_MS,
        sessionId: message.sessionId,
        conversationEpoch: message.conversationEpoch,
        payloadJson: message.payloadJson,
        context: encryptWechatContextToken(
          message.contextToken,
          this.#dataKey,
          input.bindingEpoch,
          message.id,
        ),
        overloadReply: message.overloadReply,
      })),
      mediaBlobs: input.mediaBlobs ?? [],
      mediaRefs: input.mediaRefs ?? [],
      fileAttachments: input.fileAttachments ?? [],
      maxQueuedTasks: input.maxQueuedTasks,
    });
  }

  async leaseNextTask(args: {
    bindingEpoch: string;
    now: number;
    leaseMs?: number;
  }): Promise<WechatTask | null> {
    const leased = await this.#db.tx('wechatLeaseNextTask', {
      bindingEpoch: args.bindingEpoch,
      now: args.now,
      leaseUntil: args.now + (args.leaseMs ?? DEFAULT_LEASE_MS),
    });
    if (!leased) return null;
    return {
      id: leased.id,
      bindingEpoch: leased.bindingEpoch,
      peerId: leased.peerId,
      sessionId: leased.sessionId,
      conversationEpoch: leased.conversationEpoch,
      payloadJson: leased.payloadJson,
      contextToken: decryptWechatContextToken(
        leased.context,
        this.#dataKey,
        leased.bindingEpoch,
        leased.id,
      ),
      attempts: leased.attempts,
      receivedAt: leased.receivedAt,
      expiresAt: leased.expiresAt,
    };
  }

  markAccepted(bindingEpoch: string, taskId: string): Promise<boolean> {
    return this.#db.tx('wechatMarkAccepted', { bindingEpoch, taskId });
  }

  promoteTaskAttachments(args: {
    bindingEpoch: string;
    taskId: string;
    sessionId: string;
    now: number;
  }): Promise<WechatPromoteTaskAttachmentsResult> {
    return this.#db.tx('wechatPromoteTaskAttachments', args);
  }

  async refreshPendingOutboxContext(args: {
    bindingEpoch: string;
    peerId: string;
    contextToken: string;
    now: number;
  }): Promise<void> {
    const rows = await this.#db.query<{ taskId: string }>(
      `SELECT DISTINCT i.id AS taskId
       FROM wechat_inbox i
       INNER JOIN wechat_outbox o
         ON o.binding_epoch = i.binding_epoch AND o.task_id = i.id
       WHERE i.binding_epoch = ? AND i.peer_id = ? AND i.status = 'delivery_pending'
         AND o.status = 'pending'`,
      [args.bindingEpoch, args.peerId],
    );
    if (rows.length === 0) return;
    await this.#db.tx('wechatRefreshOutboxContexts', {
      bindingEpoch: args.bindingEpoch,
      peerId: args.peerId,
      now: args.now,
      contexts: rows.map(({ taskId }) => ({
        taskId,
        context: encryptWechatContextToken(
          args.contextToken,
          this.#dataKey,
          args.bindingEpoch,
          taskId,
        ),
      })),
    });
  }

  releaseDispatch(bindingEpoch: string, taskId: string): Promise<boolean> {
    return this.#db.tx('wechatReleaseDispatch', { bindingEpoch, taskId });
  }

  setWaitingDesktop(bindingEpoch: string, taskId: string, waiting: boolean): Promise<boolean> {
    return this.#db.tx('wechatSetWaitingDesktop', { bindingEpoch, taskId, waiting });
  }

  commitInterrupted(args: {
    bindingEpoch: string;
    taskId: string;
    now: number;
    errorCode: string;
    outbox?: WechatOutboxChunkInput[];
    contextToken?: string;
  }): Promise<boolean> {
    const { contextToken, ...txArgs } = args;
    return this.#db.tx('wechatCommitInterrupted', {
      ...txArgs,
      context:
        contextToken === undefined
          ? undefined
          : encryptWechatContextToken(contextToken, this.#dataKey, args.bindingEpoch, args.taskId),
    });
  }

  commitPreDispatchFailure(args: {
    bindingEpoch: string;
    taskId: string;
    now: number;
    errorCode: string;
    outbox: WechatOutboxChunkInput[];
  }): Promise<boolean> {
    return this.#db.tx('wechatCommitPreDispatchFailure', args);
  }

  cancelForCommand(args: {
    bindingEpoch: string;
    commandTaskId: string;
    peerId?: string;
    now: number;
  }): Promise<WechatCancelForCommandResult> {
    return this.#db.tx('wechatCancelForCommand', args);
  }

  commitTerminal(args: {
    bindingEpoch: string;
    taskId: string;
    now: number;
    outbox: WechatOutboxChunkInput[];
  }): Promise<WechatCommitTerminalResult> {
    return this.#db.tx('wechatCommitTerminal', args);
  }

  async listDueOutbox(
    bindingEpoch: string,
    now: number,
    limit = 20,
  ): Promise<WechatOutboxRecord[]> {
    const rows = await this.#db.query<WechatOutboxRow>(
      `SELECT
         o.id,
         o.binding_epoch AS bindingEpoch,
         o.task_id AS taskId,
         o.client_id AS clientId,
         o.kind,
         o.chunk_index AS chunkIndex,
         o.text,
         o.media_json AS mediaJson,
         o.attempts,
         i.context_nonce AS contextNonce,
         i.context_ciphertext AS contextCiphertext,
         i.context_tag AS contextTag
       FROM wechat_outbox o
       INNER JOIN wechat_inbox i
         ON i.binding_epoch = o.binding_epoch AND i.id = o.task_id
       WHERE o.binding_epoch = ? AND o.status = 'pending' AND o.next_retry_at <= ?
       ORDER BY o.created_at ASC, o.chunk_index ASC
       LIMIT ?`,
      [bindingEpoch, now, Math.max(1, Math.min(100, Math.floor(limit)))],
    );
    return rows.map(({ contextNonce, contextCiphertext, contextTag, ...row }) => ({
      ...row,
      contextToken: decryptWechatContextToken(
        {
          nonce: contextNonce,
          ciphertext: contextCiphertext,
          tag: contextTag,
        },
        this.#dataKey,
        row.bindingEpoch,
        row.taskId,
      ),
    }));
  }

  async claimOutbox(bindingEpoch: string, outboxId: string): Promise<boolean> {
    const result = await this.#db.exec(
      `UPDATE wechat_outbox
       SET status = 'sending', attempts = attempts + 1
       WHERE binding_epoch = ? AND id = ? AND status = 'pending'`,
      [bindingEpoch, outboxId],
    );
    return result.changes === 1;
  }

  markOutboxDelivered(
    bindingEpoch: string,
    outboxId: string,
    deliveredAt: number,
  ): Promise<WechatMarkOutboxDeliveredResult> {
    return this.#db.tx('wechatMarkOutboxDelivered', {
      bindingEpoch,
      outboxId,
      deliveredAt,
    });
  }

  recordOutboxFailure(args: {
    bindingEpoch: string;
    outboxId: string;
    nextRetryAt: number;
    terminal: boolean;
    errorCode: string;
  }): Promise<WechatRecordOutboxFailureResult> {
    return this.#db.tx('wechatRecordOutboxFailure', args);
  }

  stopAll(args: {
    bindingEpoch: string;
    now: number;
    errorCode: string;
  }): Promise<WechatStopAllResult> {
    return this.#db.tx('wechatStopAll', args);
  }

  closeBindingEpoch(bindingEpoch: string, now: number): Promise<{ closed: boolean }> {
    return this.#db.tx('wechatCloseBindingEpoch', { bindingEpoch, now });
  }

  unbindCleanup(bindingEpoch: string): Promise<WechatUnbindCleanupResult> {
    return this.#db.tx('wechatUnbindCleanup', { bindingEpoch });
  }
}
