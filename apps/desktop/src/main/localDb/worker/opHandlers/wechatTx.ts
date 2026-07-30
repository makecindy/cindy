import type Database from 'better-sqlite3';

import type {
  WechatActivateBindingEpochResult,
  WechatCancelForCommandResult,
  WechatCommitPollBatchResult,
  WechatCommitTerminalResult,
  WechatInboxStatus,
  WechatLeasedTask,
  WechatMarkOutboxDeliveredResult,
  WechatOutboxChunkInput,
  WechatPromoteTaskAttachmentsResult,
  WechatRefreshOutboxContextsResult,
  WechatRecordOutboxFailureResult,
  WechatStopAllResult,
  WechatUnbindCleanupResult,
} from '../../client/tx/types.js';

const DEFAULT_MAX_QUEUED_TASKS = 20;
const MAX_POLL_MESSAGES = 100;
const MAX_MEDIA_ITEMS = 1_000;
const MAX_OUTBOX_CHUNKS = 100;
const ACTIVE_QUEUE_STATUSES = [
  'pending',
  'dispatching',
  'accepted_running',
  'waiting_desktop',
] as const;
const CONTROL_COMMANDS = new Set(['/stop', '/stop all']);
const RUNNING_STATUSES = [
  'dispatching',
  'accepted_running',
  'waiting_desktop',
  'delivery_pending',
] as const;

interface ActiveEpochRow {
  bindingEpoch: string;
  syncCursor: string;
}

interface InboxStatusRow {
  status: WechatInboxStatus;
}

interface OutboxTaskRow {
  taskId: string;
  status: string;
}

export function wechatActivateBindingEpoch(
  db: Database.Database,
  args: unknown,
): WechatActivateBindingEpochResult {
  const payload = asRecord(args, 'wechatActivateBindingEpoch args');
  const bindingEpoch = expectId(payload.bindingEpoch, 'bindingEpoch');
  const expectedActiveEpoch = nullableId(payload.expectedActiveEpoch, 'expectedActiveEpoch');
  const initialCursor = expectString(payload.initialCursor, 'initialCursor', 65_536);
  const now = expectTimestamp(payload.now, 'now');

  const transaction = db.transaction((): WechatActivateBindingEpochResult => {
    const active = readActiveEpoch(db);
    if ((active?.bindingEpoch ?? null) !== expectedActiveEpoch) {
      return {
        activated: false,
        previousActiveEpoch: active?.bindingEpoch ?? null,
        activeBindingEpoch: active?.bindingEpoch ?? null,
      };
    }

    db.prepare(
      'UPDATE wechat_sync_state SET is_active = 0, updated_at = ? WHERE is_active = 1',
    ).run(now);
    db.prepare(
      `INSERT INTO wechat_sync_state
        (binding_epoch, is_active, sync_cursor, last_poll_at, last_error_code, updated_at)
       VALUES (?, 1, ?, NULL, NULL, ?)
       ON CONFLICT(binding_epoch) DO UPDATE SET
         is_active = 1,
         last_error_code = NULL,
         updated_at = excluded.updated_at`,
    ).run(bindingEpoch, initialCursor, now);

    return {
      activated: true,
      previousActiveEpoch: active?.bindingEpoch ?? null,
      activeBindingEpoch: bindingEpoch,
    };
  });
  return transaction();
}

export function wechatCommitPollBatch(
  db: Database.Database,
  args: unknown,
): WechatCommitPollBatchResult {
  const payload = asRecord(args, 'wechatCommitPollBatch args');
  const bindingEpoch = expectId(payload.bindingEpoch, 'bindingEpoch');
  const expectedCursor = expectString(payload.expectedCursor, 'expectedCursor', 65_536);
  const nextCursor = expectString(payload.nextCursor, 'nextCursor', 65_536);
  const now = expectTimestamp(payload.now, 'now');
  const messages = expectArray(payload.messages, 'messages');
  const mediaBlobs = expectArray(payload.mediaBlobs, 'mediaBlobs');
  const mediaRefs = expectArray(payload.mediaRefs, 'mediaRefs');
  const fileAttachments = expectArray(payload.fileAttachments, 'fileAttachments');
  const maxQueuedTasks =
    payload.maxQueuedTasks === undefined
      ? DEFAULT_MAX_QUEUED_TASKS
      : expectInteger(payload.maxQueuedTasks, 'maxQueuedTasks', 1, 100);

  enforceArrayLimit(messages, 'messages', MAX_POLL_MESSAGES);
  enforceArrayLimit(mediaBlobs, 'mediaBlobs', MAX_MEDIA_ITEMS);
  enforceArrayLimit(mediaRefs, 'mediaRefs', MAX_MEDIA_ITEMS);
  enforceArrayLimit(fileAttachments, 'fileAttachments', MAX_MEDIA_ITEMS);

  const transaction = db.transaction((): WechatCommitPollBatchResult => {
    const active = readActiveEpoch(db);
    if (active?.bindingEpoch !== bindingEpoch) {
      return {
        committed: false,
        reason: 'stale-epoch',
        activeBindingEpoch: active?.bindingEpoch ?? null,
        currentCursor: active?.syncCursor ?? null,
      };
    }
    if (active.syncCursor !== expectedCursor) {
      return {
        committed: false,
        reason: 'stale-cursor',
        activeBindingEpoch: active.bindingEpoch,
        currentCursor: active.syncCursor,
      };
    }

    let queuedTasks = Number(
      db
        .prepare(
          `SELECT COUNT(*) FROM wechat_inbox
           WHERE binding_epoch = ? AND status IN (${sqlPlaceholders(ACTIVE_QUEUE_STATUSES.length)})`,
        )
        .pluck()
        .get(bindingEpoch, ...ACTIVE_QUEUE_STATUSES),
    );
    const insertedTaskIds: string[] = [];
    const duplicateTaskIds: string[] = [];
    const rejectedTaskIds: string[] = [];
    const acceptedTaskIds = new Set<string>();
    const insertInbox = db.prepare(
      `INSERT OR IGNORE INTO wechat_inbox (
        id, binding_epoch, platform_message_id, platform_seq, peer_id,
        received_at, platform_created_at, expires_at, status, lease_until,
        session_id, conversation_epoch, payload_json, context_nonce,
        context_ciphertext, context_tag, attempts, last_error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, NULL)`,
    );
    const findDuplicate = db.prepare(
      `SELECT id FROM wechat_inbox
       WHERE binding_epoch = ? AND platform_message_id = ?`,
    );
    const insertOutbox = prepareOutboxInsert(db);

    for (let index = 0; index < messages.length; index += 1) {
      const message = parsePollMessage(messages[index], index);
      const isControlCommand = isWechatControlCommand(message.payloadJson);
      const status: WechatInboxStatus =
        queuedTasks >= maxQueuedTasks && !isControlCommand ? 'rejected_overload' : 'pending';
      const result = insertInbox.run(
        message.id,
        bindingEpoch,
        message.platformMessageId,
        message.platformSeq,
        message.peerId,
        message.receivedAt,
        message.platformCreatedAt,
        message.expiresAt,
        status,
        message.sessionId,
        message.conversationEpoch,
        message.payloadJson,
        message.context.nonce,
        message.context.ciphertext,
        message.context.tag,
      );
      if (result.changes === 0) {
        const existing = findDuplicate.get(bindingEpoch, message.platformMessageId) as
          { id: string } | undefined;
        if (!existing) throw invariantViolation('inbox dedupe row disappeared');
        duplicateTaskIds.push(existing.id);
        continue;
      }

      insertedTaskIds.push(message.id);
      if (status === 'pending') {
        queuedTasks += 1;
        acceptedTaskIds.add(message.id);
        continue;
      }

      rejectedTaskIds.push(message.id);
      if (!message.overloadReply) {
        throw invalidArgs(`messages.${index}.overloadReply is required when queue is full`);
      }
      insertOutboxChunk(
        insertOutbox,
        bindingEpoch,
        message.id,
        {
          id: message.overloadReply.outboxId,
          clientId: message.overloadReply.clientId,
          kind: 'overload',
          chunkIndex: 0,
          text: message.overloadReply.text,
        },
        now,
      );
    }

    commitMediaBlobs(db, mediaBlobs, mediaRefs, acceptedTaskIds);
    commitMediaRefs(db, mediaRefs, acceptedTaskIds);
    commitFileAttachments(db, fileAttachments, acceptedTaskIds, bindingEpoch);

    const cursorResult = db
      .prepare(
        `UPDATE wechat_sync_state
         SET sync_cursor = ?, last_poll_at = ?, last_error_code = NULL, updated_at = ?
         WHERE binding_epoch = ? AND is_active = 1 AND sync_cursor = ?`,
      )
      .run(nextCursor, now, now, bindingEpoch, expectedCursor);
    if (cursorResult.changes !== 1) {
      throw invariantViolation('active WeChat cursor changed inside poll transaction');
    }

    return {
      committed: true,
      insertedTaskIds,
      duplicateTaskIds,
      rejectedTaskIds,
    };
  });
  return transaction();
}

export function wechatLeaseNextTask(db: Database.Database, args: unknown): WechatLeasedTask | null {
  const payload = asRecord(args, 'wechatLeaseNextTask args');
  const bindingEpoch = expectId(payload.bindingEpoch, 'bindingEpoch');
  const now = expectTimestamp(payload.now, 'now');
  const leaseUntil = expectTimestamp(payload.leaseUntil, 'leaseUntil');
  if (leaseUntil <= now) throw invalidArgs('leaseUntil must be later than now');

  return db.transaction(() => {
    if (readActiveEpoch(db)?.bindingEpoch !== bindingEpoch) return null;

    expirePendingTasks(db, bindingEpoch, now);
    db.prepare(
      `UPDATE wechat_inbox
       SET status = 'pending', lease_until = NULL
       WHERE binding_epoch = ? AND status = 'dispatching'
         AND lease_until IS NOT NULL AND lease_until <= ? AND expires_at > ?`,
    ).run(bindingEpoch, now, now);

    const row = db
      .prepare(
        `SELECT
           i.id,
           i.binding_epoch AS bindingEpoch,
           i.peer_id AS peerId,
           i.session_id AS sessionId,
           i.conversation_epoch AS conversationEpoch,
           i.payload_json AS payloadJson,
           i.context_nonce AS contextNonce,
           i.context_ciphertext AS contextCiphertext,
           i.context_tag AS contextTag,
           i.attempts,
           i.received_at AS receivedAt,
           i.expires_at AS expiresAt
         FROM wechat_inbox i
         WHERE i.binding_epoch = ? AND i.status = 'pending' AND i.expires_at > ?
           AND i.session_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM wechat_inbox running
             WHERE running.binding_epoch = i.binding_epoch
               AND running.session_id = i.session_id
               AND running.status IN (${sqlPlaceholders(RUNNING_STATUSES.length)})
           )
         ORDER BY
           CASE
             WHEN json_extract(i.payload_json, '$.text') IN ('/stop', '/stop all') THEN 0
             ELSE 1
           END,
           i.received_at ASC,
           i.id ASC
         LIMIT 1`,
      )
      .get(bindingEpoch, now, ...RUNNING_STATUSES) as
      | {
          id: string;
          bindingEpoch: string;
          peerId: string;
          sessionId: string;
          conversationEpoch: number;
          payloadJson: string;
          contextNonce: string;
          contextCiphertext: string;
          contextTag: string;
          attempts: number;
          receivedAt: number;
          expiresAt: number;
        }
      | undefined;
    if (!row) return null;

    const leased = db
      .prepare(
        `UPDATE wechat_inbox
         SET status = 'dispatching', lease_until = ?, attempts = attempts + 1
         WHERE id = ? AND binding_epoch = ? AND status = 'pending'`,
      )
      .run(leaseUntil, row.id, bindingEpoch);
    if (leased.changes !== 1) return null;

    return {
      id: row.id,
      bindingEpoch: row.bindingEpoch,
      peerId: row.peerId,
      sessionId: row.sessionId,
      conversationEpoch: row.conversationEpoch,
      payloadJson: row.payloadJson,
      context: {
        nonce: row.contextNonce,
        ciphertext: row.contextCiphertext,
        tag: row.contextTag,
      },
      attempts: row.attempts + 1,
      receivedAt: row.receivedAt,
      expiresAt: row.expiresAt,
    };
  })();
}

export function wechatMarkAccepted(db: Database.Database, args: unknown): boolean {
  const payload = asRecord(args, 'wechatMarkAccepted args');
  const bindingEpoch = expectId(payload.bindingEpoch, 'bindingEpoch');
  const taskId = expectId(payload.taskId, 'taskId');
  return db.transaction(() => {
    if (readActiveEpoch(db)?.bindingEpoch !== bindingEpoch) return false;
    const result = db
      .prepare(
        `UPDATE wechat_inbox
         SET status = 'accepted_running', lease_until = NULL
         WHERE id = ? AND binding_epoch = ? AND status = 'dispatching'`,
      )
      .run(taskId, bindingEpoch);
    return result.changes === 1;
  })();
}

export function wechatReleaseDispatch(db: Database.Database, args: unknown): boolean {
  const payload = asRecord(args, 'wechatReleaseDispatch args');
  const bindingEpoch = expectId(payload.bindingEpoch, 'bindingEpoch');
  const taskId = expectId(payload.taskId, 'taskId');
  return db.transaction(() => {
    if (readActiveEpoch(db)?.bindingEpoch !== bindingEpoch) return false;
    const result = db
      .prepare(
        `UPDATE wechat_inbox
         SET status = 'pending', lease_until = NULL
         WHERE id = ? AND binding_epoch = ? AND status = 'dispatching'`,
      )
      .run(taskId, bindingEpoch);
    return result.changes === 1;
  })();
}

export function wechatSetWaitingDesktop(db: Database.Database, args: unknown): boolean {
  const payload = asRecord(args, 'wechatSetWaitingDesktop args');
  const bindingEpoch = expectId(payload.bindingEpoch, 'bindingEpoch');
  const taskId = expectId(payload.taskId, 'taskId');
  const waiting = expectBoolean(payload.waiting, 'waiting');
  const from = waiting ? 'accepted_running' : 'waiting_desktop';
  const to = waiting ? 'waiting_desktop' : 'accepted_running';
  return db.transaction(() => {
    if (readActiveEpoch(db)?.bindingEpoch !== bindingEpoch) return false;
    const result = db
      .prepare(
        `UPDATE wechat_inbox
         SET status = ?
         WHERE id = ? AND binding_epoch = ? AND status = ?`,
      )
      .run(to, taskId, bindingEpoch, from);
    return result.changes === 1;
  })();
}

export function wechatCommitInterrupted(db: Database.Database, args: unknown): boolean {
  const payload = asRecord(args, 'wechatCommitInterrupted args');
  const bindingEpoch = expectId(payload.bindingEpoch, 'bindingEpoch');
  const taskId = expectId(payload.taskId, 'taskId');
  const now = expectTimestamp(payload.now, 'now');
  const errorCode = expectMachineCode(payload.errorCode, 'errorCode');
  const outbox = payload.outbox === undefined ? [] : parseOutbox(payload.outbox, 'outbox');
  const context =
    payload.context === undefined ? null : parseEncryptedContext(payload.context, 'context');

  return db.transaction(() => {
    if (readActiveEpoch(db)?.bindingEpoch !== bindingEpoch) return false;
    const row = db
      .prepare('SELECT status FROM wechat_inbox WHERE id = ? AND binding_epoch = ?')
      .get(taskId, bindingEpoch) as InboxStatusRow | undefined;
    const canInterrupt = row && ['accepted_running', 'waiting_desktop'].includes(row.status);
    const canAttachRecoveredNotice = row?.status === 'interrupted' && outbox.length > 0;
    if (!canInterrupt && !canAttachRecoveredNotice) return false;
    if (canAttachRecoveredNotice && !context) {
      throw invalidArgs('context is required for a recovered interruption notice');
    }

    if (outbox.length > 0) {
      const insertOutbox = prepareOutboxInsert(db);
      for (const chunk of outbox) {
        insertOutboxChunk(insertOutbox, bindingEpoch, taskId, chunk, now);
      }
      db.prepare(
        `UPDATE wechat_inbox
         SET status = 'delivery_pending', lease_until = NULL, last_error_code = ?,
             context_nonce = COALESCE(?, context_nonce),
             context_ciphertext = COALESCE(?, context_ciphertext),
             context_tag = COALESCE(?, context_tag)
         WHERE id = ? AND binding_epoch = ?`,
      ).run(
        errorCode,
        context?.nonce ?? null,
        context?.ciphertext ?? null,
        context?.tag ?? null,
        taskId,
        bindingEpoch,
      );
    } else {
      db.prepare(
        `UPDATE wechat_inbox
         SET status = 'interrupted', lease_until = NULL, last_error_code = ?
         WHERE id = ? AND binding_epoch = ?`,
      ).run(errorCode, taskId, bindingEpoch);
      releaseTaskMediaRefs(db, taskId);
    }
    return true;
  })();
}

export function wechatCommitPreDispatchFailure(db: Database.Database, args: unknown): boolean {
  const payload = asRecord(args, 'wechatCommitPreDispatchFailure args');
  const bindingEpoch = expectId(payload.bindingEpoch, 'bindingEpoch');
  const taskId = expectId(payload.taskId, 'taskId');
  const now = expectTimestamp(payload.now, 'now');
  const errorCode = expectMachineCode(payload.errorCode, 'errorCode');
  const outbox = parseOutbox(payload.outbox, 'outbox');
  if (outbox.length === 0) throw invalidArgs('outbox must contain at least one chunk');

  return db.transaction(() => {
    if (readActiveEpoch(db)?.bindingEpoch !== bindingEpoch) return false;
    const row = db
      .prepare('SELECT status FROM wechat_inbox WHERE id = ? AND binding_epoch = ?')
      .get(taskId, bindingEpoch) as InboxStatusRow | undefined;
    if (row?.status !== 'dispatching') return false;
    const insertOutbox = prepareOutboxInsert(db);
    for (const chunk of outbox) {
      insertOutboxChunk(insertOutbox, bindingEpoch, taskId, chunk, now);
    }
    const updated = db
      .prepare(
        `UPDATE wechat_inbox
         SET status = 'delivery_pending', lease_until = NULL, last_error_code = ?
         WHERE id = ? AND binding_epoch = ? AND status = 'dispatching'`,
      )
      .run(errorCode, taskId, bindingEpoch);
    if (updated.changes !== 1) {
      throw invariantViolation('pre-dispatch outbox was inserted without task transition');
    }
    return true;
  })();
}

export function wechatCancelForCommand(
  db: Database.Database,
  args: unknown,
): WechatCancelForCommandResult {
  const payload = asRecord(args, 'wechatCancelForCommand args');
  const bindingEpoch = expectId(payload.bindingEpoch, 'bindingEpoch');
  const commandTaskId = expectId(payload.commandTaskId, 'commandTaskId');
  const peerId = payload.peerId === undefined ? null : expectString(payload.peerId, 'peerId', 512);
  const now = expectTimestamp(payload.now, 'now');

  return db.transaction(() => {
    if (readActiveEpoch(db)?.bindingEpoch !== bindingEpoch) {
      return { cancelled: 0, interrupted: 0 };
    }
    const command = db
      .prepare(
        `SELECT peer_id AS peerId, status
         FROM wechat_inbox
         WHERE binding_epoch = ? AND id = ?`,
      )
      .get(bindingEpoch, commandTaskId) as
      { peerId: string; status: WechatInboxStatus } | undefined;
    if (!command || command.status !== 'pending') {
      return { cancelled: 0, interrupted: 0 };
    }
    if (peerId !== null && command.peerId !== peerId) {
      throw invalidArgs('command task peer does not match peerId');
    }

    const peerClause = peerId === null ? '' : ' AND peer_id = ?';
    const peerParams = peerId === null ? [] : [peerId];
    const cancellable = db
      .prepare(
        `SELECT id FROM wechat_inbox
         WHERE binding_epoch = ? AND id != ?
           AND status IN ('pending', 'dispatching')${peerClause}`,
      )
      .all(bindingEpoch, commandTaskId, ...peerParams) as Array<{ id: string }>;
    const cancelled = db
      .prepare(
        `UPDATE wechat_inbox
         SET status = 'cancelled', lease_until = NULL, last_error_code = 'STOPPED_BY_USER'
         WHERE binding_epoch = ? AND id != ?
           AND status IN ('pending', 'dispatching')${peerClause}`,
      )
      .run(bindingEpoch, commandTaskId, ...peerParams).changes;
    for (const row of cancellable) releaseTaskMediaRefs(db, row.id);

    const interrupted = db
      .prepare(
        `UPDATE wechat_inbox
         SET status = 'interrupted', lease_until = NULL, last_error_code = 'STOPPED_BY_USER'
         WHERE binding_epoch = ? AND id != ?
           AND status IN ('accepted_running', 'waiting_desktop')${peerClause}`,
      )
      .run(bindingEpoch, commandTaskId, ...peerParams).changes;

    db.prepare(
      `UPDATE wechat_sync_state
       SET updated_at = ?
       WHERE binding_epoch = ? AND is_active = 1`,
    ).run(now, bindingEpoch);
    return { cancelled, interrupted };
  })();
}

export function wechatCommitTerminal(
  db: Database.Database,
  args: unknown,
): WechatCommitTerminalResult {
  const payload = asRecord(args, 'wechatCommitTerminal args');
  const bindingEpoch = expectId(payload.bindingEpoch, 'bindingEpoch');
  const taskId = expectId(payload.taskId, 'taskId');
  const now = expectTimestamp(payload.now, 'now');
  const outbox = parseOutbox(payload.outbox, 'outbox');
  if (outbox.length === 0) throw invalidArgs('outbox must contain at least one chunk');

  return db.transaction(() => {
    if (readActiveEpoch(db)?.bindingEpoch !== bindingEpoch) {
      return { committed: false, alreadyCommitted: false };
    }
    const row = db
      .prepare('SELECT status FROM wechat_inbox WHERE id = ? AND binding_epoch = ?')
      .get(taskId, bindingEpoch) as InboxStatusRow | undefined;
    if (!row) return { committed: false, alreadyCommitted: false };
    if (row.status === 'delivery_pending' || row.status === 'completed') {
      const count = Number(
        db
          .prepare('SELECT COUNT(*) FROM wechat_outbox WHERE binding_epoch = ? AND task_id = ?')
          .pluck()
          .get(bindingEpoch, taskId),
      );
      return { committed: count > 0, alreadyCommitted: count > 0 };
    }
    if (!['accepted_running', 'waiting_desktop'].includes(row.status)) {
      return { committed: false, alreadyCommitted: false };
    }

    const insertOutbox = prepareOutboxInsert(db);
    for (const chunk of outbox) {
      insertOutboxChunk(insertOutbox, bindingEpoch, taskId, chunk, now);
    }
    const updated = db
      .prepare(
        `UPDATE wechat_inbox
         SET status = 'delivery_pending', lease_until = NULL, last_error_code = NULL
         WHERE id = ? AND binding_epoch = ?
           AND status IN ('accepted_running', 'waiting_desktop')`,
      )
      .run(taskId, bindingEpoch);
    if (updated.changes !== 1) {
      throw invariantViolation('terminal outbox was inserted without task transition');
    }
    return { committed: true, alreadyCommitted: false };
  })();
}

export function wechatMarkOutboxDelivered(
  db: Database.Database,
  args: unknown,
): WechatMarkOutboxDeliveredResult {
  const payload = asRecord(args, 'wechatMarkOutboxDelivered args');
  const bindingEpoch = expectId(payload.bindingEpoch, 'bindingEpoch');
  const outboxId = expectId(payload.outboxId, 'outboxId');
  const deliveredAt = expectTimestamp(payload.deliveredAt, 'deliveredAt');

  return db.transaction(() => {
    const row = db
      .prepare(
        'SELECT task_id AS taskId, status FROM wechat_outbox WHERE id = ? AND binding_epoch = ?',
      )
      .get(outboxId, bindingEpoch) as OutboxTaskRow | undefined;
    if (!row) return { changed: false, taskId: null, taskCompleted: false };
    const changed =
      db
        .prepare(
          `UPDATE wechat_outbox
         SET status = 'delivered', delivered_at = ?
         WHERE id = ? AND binding_epoch = ? AND status IN ('pending', 'sending')`,
        )
        .run(deliveredAt, outboxId, bindingEpoch).changes === 1;
    const remaining = Number(
      db
        .prepare(
          `SELECT COUNT(*) FROM wechat_outbox
           WHERE binding_epoch = ? AND task_id = ? AND status != 'delivered'`,
        )
        .pluck()
        .get(bindingEpoch, row.taskId),
    );
    let taskCompleted = false;
    if (remaining === 0) {
      taskCompleted =
        db
          .prepare(
            `UPDATE wechat_inbox
             SET status = 'completed', lease_until = NULL
             WHERE id = ? AND binding_epoch = ? AND status = 'delivery_pending'`,
          )
          .run(row.taskId, bindingEpoch).changes === 1;
      if (taskCompleted) releaseTaskMediaRefs(db, row.taskId);
    }
    return { changed, taskId: row.taskId, taskCompleted };
  })();
}

export function wechatRecordOutboxFailure(
  db: Database.Database,
  args: unknown,
): WechatRecordOutboxFailureResult {
  const payload = asRecord(args, 'wechatRecordOutboxFailure args');
  const bindingEpoch = expectId(payload.bindingEpoch, 'bindingEpoch');
  const outboxId = expectId(payload.outboxId, 'outboxId');
  const nextRetryAt = expectTimestamp(payload.nextRetryAt, 'nextRetryAt');
  const terminal = expectBoolean(payload.terminal, 'terminal');
  const errorCode = expectMachineCode(payload.errorCode, 'errorCode');

  return db.transaction(() => {
    const row = db
      .prepare(
        'SELECT task_id AS taskId, status FROM wechat_outbox WHERE id = ? AND binding_epoch = ?',
      )
      .get(outboxId, bindingEpoch) as OutboxTaskRow | undefined;
    if (!row) return { changed: false, taskId: null, taskFailed: false };
    const changed =
      db
        .prepare(
          `UPDATE wechat_outbox
           SET status = ?, next_retry_at = ?
           WHERE id = ? AND binding_epoch = ? AND status = 'sending'`,
        )
        .run(terminal ? 'failed_terminal' : 'pending', nextRetryAt, outboxId, bindingEpoch)
        .changes === 1;
    if (!changed) return { changed: false, taskId: row.taskId, taskFailed: false };

    if (!terminal) {
      db.prepare(
        `UPDATE wechat_inbox SET last_error_code = ?
         WHERE id = ? AND binding_epoch = ? AND status = 'delivery_pending'`,
      ).run(errorCode, row.taskId, bindingEpoch);
      return { changed: true, taskId: row.taskId, taskFailed: false };
    }

    db.prepare(
      `UPDATE wechat_outbox
       SET status = 'failed_terminal'
       WHERE task_id = ? AND binding_epoch = ? AND status != 'delivered'`,
    ).run(row.taskId, bindingEpoch);
    const taskFailed =
      db
        .prepare(
          `UPDATE wechat_inbox
           SET status = 'failed_terminal', lease_until = NULL, last_error_code = ?
           WHERE id = ? AND binding_epoch = ? AND status = 'delivery_pending'`,
        )
        .run(errorCode, row.taskId, bindingEpoch).changes === 1;
    if (taskFailed) releaseTaskMediaRefs(db, row.taskId);
    return { changed: true, taskId: row.taskId, taskFailed };
  })();
}

export function wechatStopAll(db: Database.Database, args: unknown): WechatStopAllResult {
  const payload = asRecord(args, 'wechatStopAll args');
  const bindingEpoch = expectId(payload.bindingEpoch, 'bindingEpoch');
  const now = expectTimestamp(payload.now, 'now');
  const errorCode = expectMachineCode(payload.errorCode, 'errorCode');

  return db.transaction(() => {
    db.prepare(
      `UPDATE wechat_outbox
       SET status = 'pending', next_retry_at = ?
       WHERE binding_epoch = ? AND status = 'sending'`,
    ).run(now, bindingEpoch);
    repairAcceptedTaskAttachments(db, bindingEpoch, now);
    const expired = expirePendingTasks(db, bindingEpoch, now);
    const requeued = db
      .prepare(
        `UPDATE wechat_inbox
         SET status = 'pending', lease_until = NULL, last_error_code = ?
         WHERE binding_epoch = ? AND status = 'dispatching' AND expires_at > ?`,
      )
      .run(errorCode, bindingEpoch, now).changes;
    const interrupted = db
      .prepare(
        `UPDATE wechat_inbox
         SET status = 'interrupted', lease_until = NULL, last_error_code = ?
         WHERE binding_epoch = ? AND status IN ('accepted_running', 'waiting_desktop')`,
      )
      .run(errorCode, bindingEpoch).changes;
    const repaired = db
      .prepare(
        `UPDATE wechat_inbox
         SET status = 'interrupted', lease_until = NULL,
             last_error_code = 'OUTBOX_INVARIANT_VIOLATION'
         WHERE binding_epoch = ? AND status = 'delivery_pending'
           AND NOT EXISTS (
             SELECT 1 FROM wechat_outbox o
             WHERE o.binding_epoch = wechat_inbox.binding_epoch
               AND o.task_id = wechat_inbox.id
           )`,
      )
      .run(bindingEpoch).changes;
    releaseTerminalMediaRefs(db, bindingEpoch);
    return { requeued, interrupted, expired, repaired };
  })();
}

export function wechatCloseBindingEpoch(db: Database.Database, args: unknown): { closed: boolean } {
  const payload = asRecord(args, 'wechatCloseBindingEpoch args');
  const bindingEpoch = expectId(payload.bindingEpoch, 'bindingEpoch');
  const now = expectTimestamp(payload.now, 'now');

  return db.transaction(() => {
    const exists =
      db.prepare('SELECT 1 FROM wechat_sync_state WHERE binding_epoch = ?').get(bindingEpoch) !==
      undefined;
    if (!exists) return { closed: false };
    repairAcceptedTaskAttachments(db, bindingEpoch, now);
    db.prepare(
      `UPDATE wechat_sync_state
       SET is_active = 0, updated_at = ?
       WHERE binding_epoch = ?`,
    ).run(now, bindingEpoch);
    db.prepare(
      `UPDATE wechat_inbox
       SET status = 'cancelled', lease_until = NULL, last_error_code = 'BINDING_CLOSED'
       WHERE binding_epoch = ? AND status IN ('pending', 'dispatching')`,
    ).run(bindingEpoch);
    db.prepare(
      `UPDATE wechat_inbox
       SET status = 'interrupted', lease_until = NULL, last_error_code = 'BINDING_CLOSED'
       WHERE binding_epoch = ? AND status IN ('accepted_running', 'waiting_desktop')`,
    ).run(bindingEpoch);
    releaseTerminalMediaRefs(db, bindingEpoch);
    return { closed: true };
  })();
}

export function wechatPromoteTaskAttachments(
  db: Database.Database,
  args: unknown,
): WechatPromoteTaskAttachmentsResult {
  const payload = asRecord(args, 'wechatPromoteTaskAttachments args');
  const bindingEpoch = expectId(payload.bindingEpoch, 'bindingEpoch');
  const taskId = expectId(payload.taskId, 'taskId');
  const sessionId = expectId(payload.sessionId, 'sessionId');
  const now = expectTimestamp(payload.now, 'now');

  return db.transaction(() => {
    const task = db
      .prepare(
        `SELECT session_id AS sessionId, status
         FROM wechat_inbox
         WHERE binding_epoch = ? AND id = ?`,
      )
      .get(bindingEpoch, taskId) as { sessionId: string; status: string } | undefined;
    if (
      !task ||
      task.sessionId !== sessionId ||
      !['accepted_running', 'waiting_desktop', 'delivery_pending', 'completed'].includes(
        task.status,
      )
    ) {
      return { eligible: false, promotedMediaRefs: 0, promotedFiles: 0 };
    }

    const promotedMediaRefs = db
      .prepare(
        `INSERT OR IGNORE INTO media_refs
          (id, hash, ref_kind, ref_id, origin_session_id, origin_kind, origin_id, label, created_at)
         SELECT
           lower(hex(randomblob(16))),
           hash,
           'session-attachment',
           ?,
           ?,
           'integration',
           'wechat',
           label,
           ?
         FROM media_refs
         WHERE ref_kind IN ('im-inbox', 'wechat-inbox') AND ref_id = ?`,
      )
      .run(sessionId, sessionId, now, taskId).changes;
    db.prepare(
      `DELETE FROM media_refs
       WHERE ref_kind IN ('im-inbox', 'wechat-inbox') AND ref_id = ?`,
    ).run(taskId);
    const promotedFiles = db
      .prepare(
        `UPDATE wechat_file_attachments
         SET status = 'promoted', promoted_at = ?
         WHERE binding_epoch = ? AND task_id = ? AND session_id = ? AND status = 'staged'`,
      )
      .run(now, bindingEpoch, taskId, sessionId).changes;
    return { eligible: true, promotedMediaRefs, promotedFiles };
  })();
}

export function wechatRefreshOutboxContexts(
  db: Database.Database,
  args: unknown,
): WechatRefreshOutboxContextsResult {
  const payload = asRecord(args, 'wechatRefreshOutboxContexts args');
  const bindingEpoch = expectId(payload.bindingEpoch, 'bindingEpoch');
  const peerId = expectString(payload.peerId, 'peerId', 512);
  const now = expectTimestamp(payload.now, 'now');
  const contexts = expectArray(payload.contexts, 'contexts');
  enforceArrayLimit(contexts, 'contexts', 100);

  return db.transaction(() => {
    const updateContext = db.prepare(
      `UPDATE wechat_inbox
       SET context_nonce = ?, context_ciphertext = ?, context_tag = ?
       WHERE binding_epoch = ? AND id = ? AND peer_id = ? AND status = 'delivery_pending'
         AND EXISTS (
           SELECT 1 FROM wechat_outbox
           WHERE binding_epoch = ? AND task_id = ? AND status = 'pending'
         )`,
    );
    let refreshedTasks = 0;
    const refreshedIds: string[] = [];
    for (let index = 0; index < contexts.length; index += 1) {
      const item = asRecord(contexts[index], `contexts.${index}`);
      const taskId = expectId(item.taskId, `contexts.${index}.taskId`);
      const context = parseEncryptedContext(item.context, `contexts.${index}.context`);
      const changed = updateContext.run(
        context.nonce,
        context.ciphertext,
        context.tag,
        bindingEpoch,
        taskId,
        peerId,
        bindingEpoch,
        taskId,
      ).changes;
      if (changed > 0) {
        refreshedTasks += changed;
        refreshedIds.push(taskId);
      }
    }
    if (refreshedIds.length === 0) return { refreshedTasks: 0, outboxWoken: 0 };
    const outboxWoken = db
      .prepare(
        `UPDATE wechat_outbox
         SET next_retry_at = ?
         WHERE binding_epoch = ? AND status = 'pending'
           AND task_id IN (${sqlPlaceholders(refreshedIds.length)})`,
      )
      .run(now, bindingEpoch, ...refreshedIds).changes;
    return { refreshedTasks, outboxWoken };
  })();
}

export function wechatUnbindCleanup(
  db: Database.Database,
  args: unknown,
): WechatUnbindCleanupResult {
  const payload = asRecord(args, 'wechatUnbindCleanup args');
  const bindingEpoch = expectId(payload.bindingEpoch, 'bindingEpoch');

  return db.transaction(() => {
    const active = db
      .prepare('SELECT is_active AS isActive FROM wechat_sync_state WHERE binding_epoch = ?')
      .get(bindingEpoch) as { isActive: number } | undefined;
    if (active?.isActive === 1) throw invalidArgs('active binding epoch must be closed first');
    const deletedTasks = Number(
      db
        .prepare('SELECT COUNT(*) FROM wechat_inbox WHERE binding_epoch = ?')
        .pluck()
        .get(bindingEpoch),
    );
    const filePaths = (
      db
        .prepare(
          `SELECT abs_path AS absPath
           FROM wechat_file_attachments
           WHERE binding_epoch = ? AND status != 'promoted'`,
        )
        .all(bindingEpoch) as Array<{ absPath: string }>
    ).map(({ absPath }) => absPath);
    const deletedMediaRefs = db
      .prepare(
        `DELETE FROM media_refs
         WHERE ref_kind IN ('im-inbox', 'wechat-inbox')
           AND ref_id IN (SELECT id FROM wechat_inbox WHERE binding_epoch = ?)`,
      )
      .run(bindingEpoch).changes;
    db.prepare('DELETE FROM wechat_sync_state WHERE binding_epoch = ?').run(bindingEpoch);
    return { deletedTasks, deletedMediaRefs, filePaths };
  })();
}

function readActiveEpoch(db: Database.Database): ActiveEpochRow | undefined {
  return db
    .prepare(
      `SELECT binding_epoch AS bindingEpoch, sync_cursor AS syncCursor
       FROM wechat_sync_state WHERE is_active = 1 LIMIT 1`,
    )
    .get() as ActiveEpochRow | undefined;
}

function parsePollMessage(value: unknown, index: number) {
  const label = `messages.${index}`;
  const item = asRecord(value, label);
  const context = parseEncryptedContext(item.context, `${label}.context`);
  const overloadRaw =
    item.overloadReply === undefined
      ? undefined
      : asRecord(item.overloadReply, `${label}.overloadReply`);
  const receivedAt = expectTimestamp(item.receivedAt, `${label}.receivedAt`);
  const expiresAt = expectTimestamp(item.expiresAt, `${label}.expiresAt`);
  if (expiresAt < receivedAt) {
    throw invalidArgs(`${label}.expiresAt must not be earlier than receivedAt`);
  }
  return {
    id: expectId(item.id, `${label}.id`),
    platformMessageId: expectString(item.platformMessageId, `${label}.platformMessageId`, 512),
    platformSeq: expectInteger(item.platformSeq, `${label}.platformSeq`, 0),
    peerId: expectString(item.peerId, `${label}.peerId`, 512),
    receivedAt,
    platformCreatedAt: expectTimestamp(item.platformCreatedAt, `${label}.platformCreatedAt`),
    expiresAt,
    sessionId: expectId(item.sessionId, `${label}.sessionId`),
    conversationEpoch: expectInteger(item.conversationEpoch, `${label}.conversationEpoch`, 0),
    payloadJson: expectString(item.payloadJson, `${label}.payloadJson`, 4 * 1024 * 1024),
    context,
    overloadReply: overloadRaw
      ? {
          outboxId: expectId(overloadRaw.outboxId, `${label}.overloadReply.outboxId`),
          clientId: expectId(overloadRaw.clientId, `${label}.overloadReply.clientId`),
          text: expectString(overloadRaw.text, `${label}.overloadReply.text`, 16_384),
        }
      : undefined,
  };
}

function isWechatControlCommand(payloadJson: string): boolean {
  try {
    const payload: unknown = JSON.parse(payloadJson);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const text = (payload as { text?: unknown }).text;
    return typeof text === 'string' && CONTROL_COMMANDS.has(text.trim());
  } catch {
    return false;
  }
}

function parseEncryptedContext(value: unknown, label: string) {
  const context = asRecord(value, label);
  return {
    nonce: expectBase64(context.nonce, `${label}.nonce`, 64),
    ciphertext: expectBase64(context.ciphertext, `${label}.ciphertext`, 64 * 1024),
    tag: expectBase64(context.tag, `${label}.tag`, 64),
  };
}

function commitMediaBlobs(
  db: Database.Database,
  mediaBlobs: unknown[],
  mediaRefs: unknown[],
  acceptedTaskIds: ReadonlySet<string>,
): void {
  const referencedHashes = new Set<string>();
  for (let index = 0; index < mediaRefs.length; index += 1) {
    const item = asRecord(mediaRefs[index], `mediaRefs.${index}`);
    const taskId = expectId(item.taskId, `mediaRefs.${index}.taskId`);
    if (acceptedTaskIds.has(taskId)) {
      referencedHashes.add(expectHash(item.hash, `mediaRefs.${index}.hash`));
    }
  }
  const suppliedHashes = new Set<string>();
  const findBlob = db.prepare(
    'SELECT ext, mime_type AS mimeType, bytes FROM media_blobs WHERE hash = ?',
  );
  const upsertBlob = db.prepare(
    `INSERT INTO media_blobs
      (hash, ext, mime_type, bytes, is_cache, created_at, last_access_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(hash) DO UPDATE SET
       is_cache = CASE
         WHEN media_blobs.is_cache = 0 OR excluded.is_cache = 0 THEN 0
         ELSE 1
       END,
       last_access_at = MAX(media_blobs.last_access_at, excluded.last_access_at)`,
  );
  for (let index = 0; index < mediaBlobs.length; index += 1) {
    const item = asRecord(mediaBlobs[index], `mediaBlobs.${index}`);
    const hash = expectHash(item.hash, `mediaBlobs.${index}.hash`);
    if (!referencedHashes.has(hash)) continue;
    const ext = expectExtension(item.ext, `mediaBlobs.${index}.ext`);
    const mimeType = expectString(item.mimeType, `mediaBlobs.${index}.mimeType`, 255);
    const bytes = expectInteger(item.bytes, `mediaBlobs.${index}.bytes`, 0);
    const isCache = expectBoolean(item.isCache, `mediaBlobs.${index}.isCache`);
    const createdAt = expectTimestamp(item.createdAt, `mediaBlobs.${index}.createdAt`);
    const lastAccessAt = expectTimestamp(item.lastAccessAt, `mediaBlobs.${index}.lastAccessAt`);
    const existing = findBlob.get(hash) as
      { ext: string; mimeType: string; bytes: number } | undefined;
    if (
      existing &&
      (existing.ext !== ext || existing.mimeType !== mimeType || existing.bytes !== bytes)
    ) {
      throw invariantViolation(`media metadata mismatch for hash ${hash}`);
    }
    upsertBlob.run(hash, ext, mimeType, bytes, isCache ? 1 : 0, createdAt, lastAccessAt);
    suppliedHashes.add(hash);
  }
  for (const hash of referencedHashes) {
    if (!suppliedHashes.has(hash) && !findBlob.get(hash)) {
      throw invalidArgs(`mediaRefs references unknown hash ${hash}`);
    }
  }
}

function commitMediaRefs(
  db: Database.Database,
  mediaRefs: unknown[],
  acceptedTaskIds: ReadonlySet<string>,
): void {
  const insertRef = db.prepare(
    `INSERT OR IGNORE INTO media_refs
      (id, hash, ref_kind, ref_id, origin_session_id, origin_kind, origin_id, label, created_at)
     VALUES (?, ?, 'im-inbox', ?, NULL, 'integration', 'wechat', ?, ?)`,
  );
  for (let index = 0; index < mediaRefs.length; index += 1) {
    const item = asRecord(mediaRefs[index], `mediaRefs.${index}`);
    const taskId = expectId(item.taskId, `mediaRefs.${index}.taskId`);
    if (!acceptedTaskIds.has(taskId)) continue;
    insertRef.run(
      expectId(item.id, `mediaRefs.${index}.id`),
      expectHash(item.hash, `mediaRefs.${index}.hash`),
      taskId,
      nullableString(item.label, `mediaRefs.${index}.label`, 1_024),
      expectTimestamp(item.createdAt, `mediaRefs.${index}.createdAt`),
    );
  }
}

function commitFileAttachments(
  db: Database.Database,
  fileAttachments: unknown[],
  acceptedTaskIds: ReadonlySet<string>,
  bindingEpoch: string,
): void {
  const insertFile = db.prepare(
    `INSERT INTO wechat_file_attachments
      (id, binding_epoch, task_id, session_id, abs_path, original_name,
       mime_type, bytes, status, promoted_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staged', NULL, ?)`,
  );
  for (let index = 0; index < fileAttachments.length; index += 1) {
    const item = asRecord(fileAttachments[index], `fileAttachments.${index}`);
    const taskId = expectId(item.taskId, `fileAttachments.${index}.taskId`);
    if (!acceptedTaskIds.has(taskId)) continue;
    insertFile.run(
      expectId(item.id, `fileAttachments.${index}.id`),
      bindingEpoch,
      taskId,
      expectId(item.sessionId, `fileAttachments.${index}.sessionId`),
      expectString(item.absPath, `fileAttachments.${index}.absPath`, 32_768),
      expectString(item.originalName, `fileAttachments.${index}.originalName`, 1_024),
      expectString(item.mimeType, `fileAttachments.${index}.mimeType`, 255),
      expectInteger(item.bytes, `fileAttachments.${index}.bytes`, 0),
      expectTimestamp(item.createdAt, `fileAttachments.${index}.createdAt`),
    );
  }
}

function prepareOutboxInsert(db: Database.Database): Database.Statement {
  return db.prepare(
    `INSERT INTO wechat_outbox
      (id, binding_epoch, task_id, client_id, kind, chunk_index, text,
       media_json, status, attempts, next_retry_at, created_at, delivered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, NULL)`,
  );
}

function insertOutboxChunk(
  statement: Database.Statement,
  bindingEpoch: string,
  taskId: string,
  chunk: WechatOutboxChunkInput,
  now: number,
): void {
  statement.run(
    chunk.id,
    bindingEpoch,
    taskId,
    chunk.clientId,
    chunk.kind,
    chunk.chunkIndex,
    chunk.text,
    chunk.mediaJson ?? '[]',
    now,
    now,
  );
}

function parseOutbox(value: unknown, label: string): WechatOutboxChunkInput[] {
  const rows = expectArray(value, label);
  enforceArrayLimit(rows, label, MAX_OUTBOX_CHUNKS);
  const seenChunks = new Set<number>();
  return rows.map((raw, index) => {
    const itemLabel = `${label}.${index}`;
    const item = asRecord(raw, itemLabel);
    const chunkIndex = expectInteger(item.chunkIndex, `${itemLabel}.chunkIndex`, 0);
    if (seenChunks.has(chunkIndex)) throw invalidArgs(`${label} contains duplicate chunkIndex`);
    seenChunks.add(chunkIndex);
    const kind = expectEnum(item.kind, `${itemLabel}.kind`, [
      'final',
      'error',
      'interrupted',
      'overload',
    ] as const);
    const mediaJson =
      item.mediaJson === undefined
        ? undefined
        : expectString(item.mediaJson, `${itemLabel}.mediaJson`, 256 * 1024);
    return {
      id: expectId(item.id, `${itemLabel}.id`),
      clientId: expectId(item.clientId, `${itemLabel}.clientId`),
      kind,
      chunkIndex,
      text: expectString(item.text, `${itemLabel}.text`, 16_384),
      mediaJson,
    };
  });
}

function expirePendingTasks(db: Database.Database, bindingEpoch: string, now: number): number {
  const changed = db
    .prepare(
      `UPDATE wechat_inbox
       SET status = 'expired', lease_until = NULL, last_error_code = 'TASK_EXPIRED'
       WHERE binding_epoch = ? AND status IN ('pending', 'dispatching') AND expires_at <= ?`,
    )
    .run(bindingEpoch, now).changes;
  if (changed > 0) releaseTerminalMediaRefs(db, bindingEpoch);
  return changed;
}

function releaseTaskMediaRefs(db: Database.Database, taskId: string): void {
  db.prepare(
    "DELETE FROM media_refs WHERE ref_kind IN ('im-inbox', 'wechat-inbox') AND ref_id = ?",
  ).run(taskId);
  db.prepare(
    `UPDATE wechat_file_attachments
     SET status = 'released'
     WHERE task_id = ? AND status = 'staged'`,
  ).run(taskId);
}

function repairAcceptedTaskAttachments(
  db: Database.Database,
  bindingEpoch: string,
  now: number,
): void {
  const acceptedStatuses = [
    'accepted_running',
    'waiting_desktop',
    'delivery_pending',
    'completed',
  ] as const;
  const placeholders = sqlPlaceholders(acceptedStatuses.length);
  db.prepare(
    `INSERT OR IGNORE INTO media_refs
      (id, hash, ref_kind, ref_id, origin_session_id, origin_kind, origin_id, label, created_at)
     SELECT
       lower(hex(randomblob(16))),
       r.hash,
       'session-attachment',
       i.session_id,
       i.session_id,
       'integration',
       'wechat',
       r.label,
       ?
     FROM media_refs r
     INNER JOIN wechat_inbox i ON i.id = r.ref_id
     WHERE i.binding_epoch = ?
       AND i.status IN (${placeholders})
       AND r.ref_kind IN ('im-inbox', 'wechat-inbox')`,
  ).run(now, bindingEpoch, ...acceptedStatuses);
  db.prepare(
    `DELETE FROM media_refs
     WHERE ref_kind IN ('im-inbox', 'wechat-inbox')
       AND ref_id IN (
         SELECT id FROM wechat_inbox
         WHERE binding_epoch = ? AND status IN (${placeholders})
       )`,
  ).run(bindingEpoch, ...acceptedStatuses);
  db.prepare(
    `UPDATE wechat_file_attachments
     SET status = 'promoted', promoted_at = COALESCE(promoted_at, ?)
     WHERE binding_epoch = ? AND status = 'staged'
       AND task_id IN (
         SELECT id FROM wechat_inbox
         WHERE binding_epoch = ? AND status IN (${placeholders})
       )`,
  ).run(now, bindingEpoch, bindingEpoch, ...acceptedStatuses);
}

function releaseTerminalMediaRefs(db: Database.Database, bindingEpoch: string): void {
  db.prepare(
    `DELETE FROM media_refs
     WHERE ref_kind IN ('im-inbox', 'wechat-inbox')
       AND ref_id IN (
         SELECT id FROM wechat_inbox
         WHERE binding_epoch = ?
           AND status IN ('completed', 'interrupted', 'cancelled', 'expired', 'failed_terminal')
       )`,
  ).run(bindingEpoch);
  db.prepare(
    `UPDATE wechat_file_attachments
     SET status = 'released'
     WHERE binding_epoch = ? AND status = 'staged'
       AND task_id IN (
         SELECT id FROM wechat_inbox
         WHERE binding_epoch = ?
           AND status IN ('completed', 'interrupted', 'cancelled', 'expired', 'failed_terminal')
       )`,
  ).run(bindingEpoch, bindingEpoch);
}

function sqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function enforceArrayLimit(value: unknown[], label: string, max: number): void {
  if (value.length > max) throw invalidArgs(`${label} exceeds ${max} items`);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidArgs(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw invalidArgs(`${label} must be an array`);
  return value;
}

function expectString(value: unknown, label: string, max = 4_096): string {
  if (typeof value !== 'string') throw invalidArgs(`${label} must be a string`);
  if (value.length > max) throw invalidArgs(`${label} exceeds ${max} characters`);
  return value;
}

function expectId(value: unknown, label: string): string {
  const id = expectString(value, label, 512);
  if (id.length === 0) throw invalidArgs(`${label} must not be empty`);
  return id;
}

function nullableId(value: unknown, label: string): string | null {
  if (value === null) return null;
  return expectId(value, label);
}

function nullableString(value: unknown, label: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  return expectString(value, label, max);
}

function expectInteger(
  value: unknown,
  label: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw invalidArgs(`${label} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function expectTimestamp(value: unknown, label: string): number {
  return expectInteger(value, label, 0);
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidArgs(`${label} must be a boolean`);
  return value;
}

function expectMachineCode(value: unknown, label: string): string {
  const code = expectString(value, label, 128);
  if (!/^[A-Z][A-Z0-9_]*$/.test(code)) {
    throw invalidArgs(`${label} must be an uppercase machine code`);
  }
  return code;
}

function expectHash(value: unknown, label: string): string {
  const hash = expectString(value, label, 64);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw invalidArgs(`${label} must be a SHA-256 hex hash`);
  return hash;
}

function expectExtension(value: unknown, label: string): string {
  const ext = expectString(value, label, 16);
  if (!/^\.[a-z0-9]{1,15}$/.test(ext)) throw invalidArgs(`${label} is invalid`);
  return ext;
}

function expectBase64(value: unknown, label: string, max: number): string {
  const encoded = expectString(value, label, max);
  if (encoded.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw invalidArgs(`${label} must be base64`);
  }
  return encoded;
}

function expectEnum<const T extends readonly string[]>(
  value: unknown,
  label: string,
  values: T,
): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw invalidArgs(`${label} is invalid`);
  }
  return value as T[number];
}

function invalidArgs(message: string): Error {
  return Object.assign(new Error(message), { code: 'INVALID_ARGS' });
}

function invariantViolation(message: string): Error {
  return Object.assign(new Error(message), { code: 'DB_INVARIANT_VIOLATION' });
}
