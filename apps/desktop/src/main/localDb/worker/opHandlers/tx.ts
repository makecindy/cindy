// inproc 回滚口：仅在 XDT_DB_INPROC=true 时使用。
// 默认热路径走 file worker（dbWorker.ts + dispatcher），这里要和同名 tx handler 保持一致。

import type Database from 'better-sqlite3';

import type { DbTxName } from '../../client/tx/types.js';
import { normalizeWorkingDirForStorage } from '../../../../shared/workingDir.js';
import {
  wechatActivateBindingEpoch,
  wechatCancelForCommand,
  wechatCloseBindingEpoch,
  wechatCommitInterrupted,
  wechatCommitPreDispatchFailure,
  wechatCommitPollBatch,
  wechatCommitTerminal,
  wechatLeaseNextTask,
  wechatMarkAccepted,
  wechatMarkOutboxDelivered,
  wechatPromoteTaskAttachments,
  wechatRefreshOutboxContexts,
  wechatRecordOutboxFailure,
  wechatReleaseDispatch,
  wechatSetWaitingDesktop,
  wechatStopAll,
  wechatUnbindCleanup,
} from './wechatTx.js';

const LOCAL_DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = [1_000, 5_000, 30_000, 5 * 60_000, 30 * 60_000];

export function tx(db: Database.Database, args: unknown): unknown {
  const payload = asRecord(args, 'tx args');
  const name = expectString(payload.name, 'name') as DbTxName;
  const txArgs = payload.args;

  switch (name) {
    case 'codex.importMessages':
      return codexImportMessages(db, txArgs);
    case 'claude.importMessages':
      return claudeImportMessages(db, txArgs);
    case 'rewind.commit':
      return rewindCommit(db, txArgs);
    case 'session.treeRehydrate':
      return sessionTreeRehydrate(db, txArgs);
    case 'fork.session':
      return forkSession(db, txArgs);
    case 'embedding.markDone':
      return embeddingMarkDone(db, txArgs);
    case 'embedding.commit':
      return embeddingCommit(db, txArgs);
    case 'embedding.recordFailures':
      return embeddingRecordFailures(db, txArgs);
    case 'embedding.enqueue':
      return embeddingEnqueue(db, txArgs);
    case 'orca.reserveWorkerCreation':
      return orcaReserveWorkerCreation(db, txArgs);
    case 'orca.renewWorkerCreationReservation':
      return orcaRenewWorkerCreationReservation(db, txArgs);
    case 'orca.releaseWorkerCreationReservation':
      return orcaReleaseWorkerCreationReservation(db, txArgs);
    case 'orca.upsertWorker':
      return orcaUpsertWorker(db, txArgs);
    case 'orca.setWorkerFocus':
      return orcaSetWorkerFocus(db, txArgs);
    case 'orca.removeWorker':
      return orcaRemoveWorker(db, txArgs);
    case 'orca.cancelStaleTeams':
      return orcaCancelStaleTeams(db, txArgs);
    case 'sessions.renameTitles':
      return sessionsRenameTitles(db, txArgs);
    case 'sessions.setStatus':
      return sessionsSetStatus(db, txArgs);
    case 'session.agentSwitchFallback':
      return sessionAgentSwitchFallback(db, txArgs);
    case 'message.delete':
      return messageDelete(db, txArgs);
    case 'im.deleteBindings':
      return imDeleteBindings(db, txArgs);
    case 'im.replaceBinding':
      return imReplaceBinding(db, txArgs);
    case 'wechatActivateBindingEpoch':
      return wechatActivateBindingEpoch(db, txArgs);
    case 'wechatCommitPollBatch':
      return wechatCommitPollBatch(db, txArgs);
    case 'wechatLeaseNextTask':
      return wechatLeaseNextTask(db, txArgs);
    case 'wechatReleaseDispatch':
      return wechatReleaseDispatch(db, txArgs);
    case 'wechatMarkAccepted':
      return wechatMarkAccepted(db, txArgs);
    case 'wechatSetWaitingDesktop':
      return wechatSetWaitingDesktop(db, txArgs);
    case 'wechatCommitPreDispatchFailure':
      return wechatCommitPreDispatchFailure(db, txArgs);
    case 'wechatCancelForCommand':
      return wechatCancelForCommand(db, txArgs);
    case 'wechatCommitInterrupted':
      return wechatCommitInterrupted(db, txArgs);
    case 'wechatCommitTerminal':
      return wechatCommitTerminal(db, txArgs);
    case 'wechatMarkOutboxDelivered':
      return wechatMarkOutboxDelivered(db, txArgs);
    case 'wechatRecordOutboxFailure':
      return wechatRecordOutboxFailure(db, txArgs);
    case 'wechatStopAll':
      return wechatStopAll(db, txArgs);
    case 'wechatCloseBindingEpoch':
      return wechatCloseBindingEpoch(db, txArgs);
    case 'wechatPromoteTaskAttachments':
      return wechatPromoteTaskAttachments(db, txArgs);
    case 'wechatRefreshOutboxContexts':
      return wechatRefreshOutboxContexts(db, txArgs);
    case 'wechatUnbindCleanup':
      return wechatUnbindCleanup(db, txArgs);
    case 'session.importShare':
      return sessionImportShare(db, txArgs);
    default:
      throw Object.assign(new Error(`unknown tx: ${name}`), { code: 'UNKNOWN_TX' });
  }
}

/** Remove every stale startup binding as one all-or-nothing repair. */
function imDeleteBindings(db: Database.Database, args: unknown): void {
  const payload = asRecord(args, 'im.deleteBindings args');
  const identities = expectArray(payload.identities, 'identities').map((raw, index) => {
    const identity = asRecord(raw, `identities.${index}`);
    return {
      channel: expectString(identity.channel, `identities.${index}.channel`),
      botContextId: expectString(identity.botContextId, `identities.${index}.botContextId`),
      userId: expectString(identity.userId, `identities.${index}.userId`),
      scopeKey: expectString(identity.scopeKey, `identities.${index}.scopeKey`),
    };
  });
  const deleteBinding = db.prepare(
    `DELETE FROM im_bindings
     WHERE channel = ? AND bot_context_id = ? AND user_id = ? AND scope_key = ?`,
  );
  const transaction = db.transaction(() => {
    for (const identity of identities) {
      deleteBinding.run(
        identity.channel,
        identity.botContextId,
        identity.userId,
        identity.scopeKey,
      );
    }
  });
  transaction();
}

/**
 * IM takeover replacement must not expose the delete-before-insert gap: if
 * the insert fails, SQLite restores both the previous target owner and this
 * identity's previous target.
 */
function imReplaceBinding(db: Database.Database, args: unknown): void {
  const payload = asRecord(args, 'im.replaceBinding args');
  const channel = expectString(payload.channel, 'channel');
  const botContextId = expectString(payload.botContextId, 'botContextId');
  const userId = expectString(payload.userId, 'userId');
  const scopeKey = expectString(payload.scopeKey, 'scopeKey');
  const targetSessionId = expectString(payload.targetSessionId, 'targetSessionId');
  const attachedAt = expectNumber(payload.attachedAt, 'attachedAt');
  const attachedViaCardMessageId = nullableString(payload.attachedViaCardMessageId);
  const transaction = db.transaction(() => {
    db.prepare(
      `DELETE FROM im_bindings
       WHERE target_session_id = ?
          OR (channel = ? AND bot_context_id = ? AND user_id = ? AND scope_key = ?)`,
    ).run(targetSessionId, channel, botContextId, userId, scopeKey);
    db.prepare(
      `INSERT INTO im_bindings (
        channel, bot_context_id, user_id, scope_key, target_session_id,
        attached_at, attached_via_card_message_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      channel,
      botContextId,
      userId,
      scopeKey,
      targetSessionId,
      attachedAt,
      attachedViaCardMessageId,
    );
  });
  transaction();
}

/** 清失效停泊 id 与改写交接边界必须同成同败,防止重启后重建出错误 pending。 */
function sessionAgentSwitchFallback(db: Database.Database, args: unknown): void {
  const payload = asRecord(args, 'session.agentSwitchFallback args');
  const sessionId = expectString(payload.sessionId, 'sessionId');
  const boundaryClientId = expectString(payload.boundaryClientId, 'boundaryClientId');
  const boundaryContent = expectString(payload.boundaryContent, 'boundaryContent');
  const updatedAt = expectNumber(payload.updatedAt, 'updatedAt');
  const transaction = db.transaction(() => {
    const sessionResult = db.prepare(
      'UPDATE sessions SET sdk_session_id = NULL, updated_at = ? WHERE id = ?',
    ).run(updatedAt, sessionId);
    if (sessionResult.changes !== 1) {
      throw Object.assign(new Error(`Session 不存在: ${sessionId}`), { code: 'NOT_FOUND' });
    }
    const boundaryResult = db.prepare(
      "UPDATE messages SET content = ? WHERE session_id = ? AND client_id = ? AND role = 'agent_switch' AND rewind_at IS NULL",
    ).run(boundaryContent, sessionId, boundaryClientId);
    if (boundaryResult.changes !== 1) {
      throw Object.assign(new Error(`Agent switch boundary 不存在: ${boundaryClientId}`), {
        code: 'NOT_FOUND',
      });
    }
  });
  transaction();
}

/** 一轮消息内容清除 + 原生上下文失效 + 隐藏重建标记，三者同成同败。 */
function messageDelete(
  db: Database.Database,
  args: unknown,
): { messages: Array<{ messageId: string; clientId: string }> } {
  const payload = asRecord(args, 'message.delete args');
  const sessionId = expectString(payload.sessionId, 'sessionId');
  const clientIds = [...new Set(
    expectArray(payload.clientIds, 'clientIds').map((value) =>
      expectString(value, 'clientId'),
    ),
  )];
  if (clientIds.length === 0) {
    throw Object.assign(new Error('message.delete requires at least one clientId'), {
      code: 'INVALID_ARGS',
    });
  }
  const marker = asRecord(payload.contextMarker, 'contextMarker');
  const markerId = expectString(marker.id, 'contextMarker.id');
  const markerClientId = expectString(marker.clientId, 'contextMarker.clientId');
  const markerContent = expectString(marker.content, 'contextMarker.content');
  const markerCreatedAt = expectNumber(marker.createdAt, 'contextMarker.createdAt');
  const updatedAt = expectNumber(payload.updatedAt, 'updatedAt');

  const transaction = db.transaction(() => {
    const selectTarget = db.prepare(
      "SELECT id, client_id AS clientId FROM messages WHERE session_id = ? AND client_id = ? AND role IN ('user', 'assistant', 'tool_use', 'tool_result', 'ask_user', 'plan_review', 'thinking', 'error') AND rewind_at IS NULL LIMIT 1",
    );
    const targets = clientIds.map((clientId) => {
      const target = selectTarget.get(sessionId, clientId) as
        | { id: string; clientId: string }
        | undefined;
      if (!target) {
        throw Object.assign(new Error(`Message 不存在或不可删除: ${clientId}`), {
          code: 'NOT_FOUND',
        });
      }
      return target;
    });

    for (const target of targets) {
      const jobs = db.prepare(
        "SELECT rowid, vec_table AS vecTable FROM embedding_jobs WHERE source = 'chat' AND source_id = ?",
      ).all(target.id) as Array<{ rowid: number; vecTable: string }>;
      const deleteVecByTable = new Map<string, Database.Statement>();
      for (const job of jobs) {
        assertIdentifier(job.vecTable);
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(job.vecTable)) {
          continue;
        }
        let stmt = deleteVecByTable.get(job.vecTable);
        if (!stmt) {
          stmt = db.prepare(`DELETE FROM "${job.vecTable}" WHERE rowid = ?`);
          deleteVecByTable.set(job.vecTable, stmt);
        }
        stmt.run(job.rowid);
      }
      db.prepare("DELETE FROM embedding_jobs WHERE source = 'chat' AND source_id = ?").run(target.id);
    }

    // 旧重建标记的 handoff 可能包含本次目标消息；先删旧标记，只保留基于
    // 当前有效历史重新生成的最新版本，避免隐藏派生记录把内容留在本地。
    db.prepare("DELETE FROM messages WHERE role = 'context_rebuild' AND session_id = ?").run(sessionId);
    const scrubTarget = db.prepare(
      "UPDATE messages SET role = 'message_tombstone', content = 'null', tool_use_id = NULL, agent_meta = NULL, agent_kind = NULL, rewind_at = ? WHERE id = ? AND session_id = ? AND client_id = ? AND role IN ('user', 'assistant', 'tool_use', 'tool_result', 'ask_user', 'plan_review', 'thinking', 'error') AND rewind_at IS NULL",
    );
    for (const target of targets) {
      const scrubbed = scrubTarget.run(updatedAt, target.id, sessionId, target.clientId);
      if (scrubbed.changes !== 1) {
        throw Object.assign(new Error(`Message 删除竞态: ${target.clientId}`), {
          code: 'PRECONDITION_FAILED',
        });
      }
    }
    const sessionResult = db.prepare(
      'UPDATE sessions SET sdk_session_id = NULL, updated_at = ? WHERE id = ?',
    ).run(updatedAt, sessionId);
    if (sessionResult.changes !== 1) {
      throw Object.assign(new Error(`Session 不存在: ${sessionId}`), { code: 'NOT_FOUND' });
    }
    db.prepare(
      "INSERT INTO messages (id, client_id, session_id, role, content, created_at, rewind_at) VALUES (?, ?, ?, 'context_rebuild', ?, ?, ?)",
    ).run(markerId, markerClientId, sessionId, markerContent, markerCreatedAt, markerCreatedAt);
    return {
      messages: targets.map((target) => ({
        messageId: target.id,
        clientId: target.clientId,
      })),
    };
  });
  return transaction();
}

function sessionsRenameTitles(db: Database.Database, args: unknown): Array<{
  sessionId: string;
  currentTitle: string | null;
  newTitle: string;
  workingDir: string | null;
  updatedAt: string;
}> {
  const payload = asRecord(args, 'sessions.renameTitles args');
  const changes = expectArray(payload.changes, 'changes');
  const selectSession = db.prepare(
    'SELECT id, title, working_dir AS workingDir, updated_at AS updatedAt FROM sessions WHERE id = ? LIMIT 1',
  );
  const updateSession = db.prepare(
    'UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND (? IS NULL OR title = ?) AND (? IS NULL OR updated_at = ?) RETURNING id, title, working_dir AS workingDir, updated_at AS updatedAt',
  );
  const transaction = db.transaction(() => {
    const applied: Array<{
      sessionId: string;
      currentTitle: string | null;
      newTitle: string;
      workingDir: string | null;
      updatedAt: string;
    }> = [];
    for (const rawChange of changes) {
      const change = asRecord(rawChange, 'rename title change');
      const sessionId = expectString(change.sessionId, 'change.sessionId');
      const title = expectString(change.title, 'change.title');
      const existing = selectSession.get(sessionId) as
        | { id: string; title: string | null; workingDir: string | null; updatedAt: number }
        | undefined;
      if (!existing) throw Object.assign(new Error(`Session 不存在: ${sessionId}`), { code: 'NOT_FOUND' });

      const expectedCurrentTitle = typeof change.expectedCurrentTitle === 'string'
        ? change.expectedCurrentTitle
        : null;
      const expectedUpdatedAt = typeof change.expectedUpdatedAt === 'string'
        ? change.expectedUpdatedAt
        : null;
      const expectedUpdatedAtMs = expectedUpdatedAt === null ? null : Date.parse(expectedUpdatedAt);
      if (expectedUpdatedAt !== null && !Number.isFinite(expectedUpdatedAtMs)) {
        throw Object.assign(new Error(`Session expected_updated_at 非法: ${sessionId}`), {
          code: 'PRECONDITION_FAILED',
        });
      }

      const now = Date.now();
      const updated = updateSession.get(
        title,
        now,
        sessionId,
        expectedCurrentTitle,
        expectedCurrentTitle,
        expectedUpdatedAtMs,
        expectedUpdatedAtMs,
      ) as { id: string; title: string | null; workingDir: string | null; updatedAt: number } | undefined;
      if (!updated) {
        throw Object.assign(new Error(`Session 标题或 updatedAt 已变化: ${sessionId}`), {
          code: 'PRECONDITION_FAILED',
        });
      }

      applied.push({
        sessionId: updated.id,
        currentTitle: existing.title,
        newTitle: updated.title ?? title,
        workingDir: updated.workingDir,
        updatedAt: new Date(updated.updatedAt).toISOString(),
      });
    }
    return applied;
  });
  return transaction() as Array<{
    sessionId: string;
    currentTitle: string | null;
    newTitle: string;
    workingDir: string | null;
    updatedAt: string;
  }>;
}

// 批量归档 / 取消归档:存在性预检 + 状态更新放进同一事务,任一 id 缺失整批回滚(全有才写)。
// 本文件是 inproc 回滚口;默认热路径走 file worker 的同名 handler(client/WorkerThreadTransport.ts)。
// 两份实现必须同步,typecheck 抓不到 drift。
function sessionsSetStatus(db: Database.Database, args: unknown): Array<{
  sessionId: string;
  title: string | null;
  workingDir: string | null;
  workspaceKind: string | null;
  status: 'active' | 'archived';
}> {
  const payload = asRecord(args, 'sessions.setStatus args');
  const sessionIds = expectArray(payload.sessionIds, 'sessionIds').map((id) =>
    expectString(id, 'sessionId'),
  );
  const status = expectString(payload.status, 'status');
  if (status !== 'active' && status !== 'archived') {
    throw invalidArgs(`invalid status: ${status}`);
  }
  const selectSession = db.prepare(
    'SELECT id, title, working_dir AS workingDir, workspace_kind AS workspaceKind FROM sessions WHERE id = ? LIMIT 1',
  );
  const updateSession = db.prepare(
    'UPDATE sessions SET status = ?, updated_at = ? WHERE id = ? RETURNING id, title, working_dir AS workingDir, workspace_kind AS workspaceKind',
  );
  const transaction = db.transaction(() => {
    const applied: Array<{
      sessionId: string;
      title: string | null;
      workingDir: string | null;
      workspaceKind: string | null;
      status: 'active' | 'archived';
    }> = [];
    const now = Date.now();
    for (const sessionId of sessionIds) {
      const existing = selectSession.get(sessionId);
      if (!existing) {
        throw Object.assign(new Error(`Session 不存在: ${sessionId}`), { code: 'NOT_FOUND' });
      }
      const updated = updateSession.get(status, now, sessionId) as
        | { id: string; title: string | null; workingDir: string | null; workspaceKind: string | null }
        | undefined;
      if (!updated) {
        throw Object.assign(new Error(`Session 不存在: ${sessionId}`), { code: 'NOT_FOUND' });
      }
      applied.push({
        sessionId: updated.id,
        title: updated.title,
        workingDir: updated.workingDir,
        workspaceKind: updated.workspaceKind,
        status,
      });
    }
    return applied;
  });
  return transaction() as Array<{
    sessionId: string;
    title: string | null;
    workingDir: string | null;
    workspaceKind: string | null;
    status: 'active' | 'archived';
  }>;
}

function codexImportMessages(db: Database.Database, args: unknown): { changed: number } {
  const payload = asRecord(args, 'codex.importMessages args');
  const sessionId = expectString(payload.sessionId, 'sessionId');
  const importClientIdPrefix = expectString(payload.importClientIdPrefix, 'importClientIdPrefix');
  const sdkSessionId = expectString(payload.sdkSessionId, 'sdkSessionId');
  const model = expectString(payload.model, 'model');
  const rows = expectArray(payload.rows, 'rows');
  const existing = readExistingMessageFingerprints(db, sessionId, importClientIdPrefix);
  const existingImportedClientIds = readExistingImportedClientIds(db, sessionId, importClientIdPrefix);
  const upsert = db.prepare(`
    INSERT INTO messages
      (id, client_id, session_id, role, content, tool_use_id, agent_meta, created_at, rewind_at)
    VALUES
      (@id, @clientId, @sessionId, @role, @content, NULL, @agentMeta, @createdAt, NULL)
    ON CONFLICT(session_id, client_id) DO UPDATE SET
      role = excluded.role,
      content = excluded.content,
      agent_meta = excluded.agent_meta,
      created_at = excluded.created_at
    WHERE
      messages.role != 'message_tombstone' AND
      messages.rewind_at IS NULL AND
      (
        messages.role IS NOT excluded.role OR
        messages.content IS NOT excluded.content OR
        messages.agent_meta IS NOT excluded.agent_meta OR
        messages.created_at IS NOT excluded.created_at
      )
  `);
  const transaction = db.transaction(() => {
    let changed = 0;
    for (const rawRow of rows) {
      const row = asRecord(rawRow, 'codex row');
      const lineNo = expectNumber(row.lineNo, 'row.lineNo');
      const role = expectString(row.role, 'row.role') as 'user' | 'assistant';
      const text = expectString(row.text, 'row.text');
      const createdAt = expectNumber(row.createdAt, 'row.createdAt');
      const clientId = `${importClientIdPrefix}${lineNo}`;
      if (
        !existingImportedClientIds.has(clientId) &&
        isLikelyLocalDuplicate(existing, { role, text, createdAt })
      ) {
        continue;
      }
      changed += upsert.run({
        id: `codex-import-${sdkSessionId}-${lineNo}`,
        clientId,
        sessionId,
        role,
        content: stringifyContent(row.content),
        agentMeta: JSON.stringify({ sdkSessionId, model }),
        createdAt,
      }).changes;
    }
    return changed;
  });
  return { changed: transaction() as number };
}

function claudeImportMessages(db: Database.Database, args: unknown): { changed: number } {
  const payload = asRecord(args, 'claude.importMessages args');
  const sessionId = expectString(payload.sessionId, 'sessionId');
  const importClientIdPrefix = expectString(payload.importClientIdPrefix, 'importClientIdPrefix');
  const sdkSessionId = expectString(payload.sdkSessionId, 'sdkSessionId');
  const rows = expectArray(payload.rows, 'rows');
  const upsert = db.prepare(`
    INSERT INTO messages
      (id, client_id, session_id, role, content, tool_use_id, agent_meta, created_at, rewind_at)
    VALUES
      (@id, @clientId, @sessionId, @role, @content, @toolUseId, @agentMeta, @createdAt, NULL)
    ON CONFLICT(session_id, client_id) DO UPDATE SET
      role = excluded.role,
      content = excluded.content,
      tool_use_id = excluded.tool_use_id,
      agent_meta = excluded.agent_meta,
      created_at = excluded.created_at
    WHERE
      messages.role != 'message_tombstone' AND
      messages.rewind_at IS NULL AND
      (
        messages.role IS NOT excluded.role OR
        messages.content IS NOT excluded.content OR
        messages.tool_use_id IS NOT excluded.tool_use_id OR
        messages.agent_meta IS NOT excluded.agent_meta OR
        messages.created_at IS NOT excluded.created_at
      )
  `);
  const transaction = db.transaction(() => {
    let changed = 0;
    for (const rawRow of rows) {
      const row = asRecord(rawRow, 'claude row');
      const key = `${expectNumber(row.lineNo, 'row.lineNo')}-${expectNumber(row.partIndex, 'row.partIndex')}`;
      changed += upsert.run({
        id: `claude-import-${sdkSessionId}-${key}`,
        clientId: `${importClientIdPrefix}${key}`,
        sessionId,
        role: expectString(row.role, 'row.role'),
        content: stringifyContent(row.content),
        toolUseId: nullableString(row.toolUseId),
        agentMeta: row.agentMeta ? stringifyContent(row.agentMeta) : null,
        createdAt: expectNumber(row.createdAt, 'row.createdAt'),
      }).changes;
    }
    return changed;
  });
  return { changed: transaction() as number };
}

function rewindCommit(db: Database.Database, args: unknown): void {
  const payload = asRecord(args, 'rewind.commit args');
  const sessionId = expectString(payload.sessionId, 'sessionId');
  const targetCreatedAt = expectNumber(payload.targetCreatedAt, 'targetCreatedAt');
  const targetMessageId = typeof payload.targetMessageId === 'string' ? payload.targetMessageId : null;
  const targetClientId = typeof payload.targetClientId === 'string' ? payload.targetClientId : null;
  const targetMessageUuid = typeof payload.targetMessageUuid === 'string' ? payload.targetMessageUuid : null;
  const preserveMessageUuid = typeof payload.preserveMessageUuid === 'string' ? payload.preserveMessageUuid : null;
  const sdkSessionId = typeof payload.sdkSessionId === 'string' && payload.sdkSessionId ? payload.sdkSessionId : null;
  const requireLatestUser = payload.requireLatestUser === true;
  const now = expectNumber(payload.now, 'now');
  const rows = db.prepare(
    `SELECT id, client_id, role, created_at, agent_meta
       FROM messages
      WHERE session_id = ?
        AND rewind_at IS NULL`,
  ).all(sessionId) as RewindMessageRow[];
  // edit-last-message 原子守卫(requireLatestUser):与软删同一同步临界区内
  // 断言 target 之后没有更新的可见 user 消息(worker 单线程 + better-sqlite3
  // 同步执行,本函数内不可能被其它写操作打断)。命中 → 抛错,软删不发生,
  // 并发落库的新轮次被保住;错误前缀被 main 侧识别为 REWIND_TARGET_NOT_LATEST。
  if (requireLatestUser) {
    for (const row of rows) {
      if (row.role !== 'user') continue;
      const isNewer =
        row.created_at > targetCreatedAt ||
        (row.created_at === targetCreatedAt && targetMessageId !== null && row.id > targetMessageId);
      if (isNewer) {
        throw new Error('REWIND_TARGET_NOT_LATEST: newer visible user message exists');
      }
    }
  }
  const idsToRewind = selectRewindMessageIds(rows, {
    targetCreatedAt,
    targetMessageId,
    targetClientId,
    targetMessageUuid,
    preserveMessageUuid,
  });
  const updateMessage = db.prepare('UPDATE messages SET rewind_at = ? WHERE id = ?');
  const transaction = db.transaction(() => {
    for (const id of idsToRewind) updateMessage.run(now, id);
    if (sdkSessionId) {
      db.prepare(
        `UPDATE sessions
           SET user_send_at = ?, updated_at = ?, context_tokens = 0, context_window = 0,
               sdk_session_id = ?
         WHERE id = ?`,
      ).run(now, now, sdkSessionId, sessionId);
    } else {
      db.prepare(
        `UPDATE sessions
           SET user_send_at = ?, updated_at = ?, context_tokens = 0, context_window = 0
         WHERE id = ?`,
      ).run(now, now, sessionId);
    }
  });
  transaction();
}

interface TreeAttachmentSourceRow {
  client_id: string;
  content: string;
  agent_meta: string | null;
  created_at: number;
  rewind_at: number | null;
}

function parsedObjectJson(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function treeEntryUuid(agentMeta: string | null): string | null {
  const uuid = parsedObjectJson(agentMeta)?.uuid;
  return typeof uuid === 'string' && uuid.length > 0 ? uuid : null;
}

function linkedPiEntryId(agentMeta: string | null): string | null {
  const piEntryId = parsedObjectJson(agentMeta)?.piEntryId;
  return typeof piEntryId === 'string' && piEntryId.length > 0 ? piEntryId : null;
}

function normalizedTreeUserText(content: string): string | null {
  const parsed = parsedObjectJson(content);
  if (!parsed || typeof parsed.text !== 'string') return null;
  // Pi 树会把原图 block 投影成 [image]；该占位不是 Cindy 文本的一部分。
  return parsed.text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '[image]')
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function mergeTreeUserAttachments(content: string, source: TreeAttachmentSourceRow | null): string {
  if (!source) return content;
  const next = parsedObjectJson(content);
  const previous = parsedObjectJson(source.content);
  if (!next || !previous) return content;
  const merged: Record<string, unknown> = { ...next };
  // 只恢复 Cindy 自己持久化的托管引用；不从 Pi base64 猜路径，也不复制其它
  // 分支的任意 content 字段。传入消息若将来原生带附件，则以它自己的值为准。
  if (!Object.hasOwn(next, 'images') && Array.isArray(previous.images)) {
    merged.images = previous.images;
  }
  if (!Object.hasOwn(next, 'files') && Array.isArray(previous.files)) {
    merged.files = previous.files;
  }
  return JSON.stringify(merged);
}

const TREE_HOST_AGENT_META_KEYS = ['origin', 'autoResume', 'autoResumeInfo'] as const;

function mergeTreeUserAgentMeta(
  agentMeta: string | null,
  source: TreeAttachmentSourceRow | null,
): string | null {
  if (!source) return agentMeta;
  const previous = parsedObjectJson(source.agent_meta);
  if (!previous) return agentMeta;
  const projected = parsedObjectJson(agentMeta) ?? {};
  const merged: Record<string, unknown> = { ...projected };
  let changed = false;
  // Pi owns the projected entry uuid; Cindy remains authoritative for delivery metadata that
  // controls scheduler/auto-resume rendering and must survive A→B→A branch reprojection.
  for (const key of TREE_HOST_AGENT_META_KEYS) {
    if (!Object.hasOwn(previous, key)) continue;
    merged[key] = previous[key];
    changed = true;
  }
  return changed ? JSON.stringify(merged) : agentMeta;
}

/** Pi 原生分支切换后，把当前活动路径原子投影成 Cindy 可见消息时间线。 */
function sessionTreeRehydrate(
  db: Database.Database,
  args: unknown,
): { messageCount: number; hiddenClientIds: string[] } {
  const payload = asRecord(args, 'session.treeRehydrate args');
  const sessionId = expectString(payload.sessionId, 'sessionId');
  const now = expectNumber(payload.now, 'now');
  const contextTokens = expectNumber(payload.contextTokens, 'contextTokens');
  if (contextTokens < 0) throw new TypeError('contextTokens must be non-negative');
  const contextWindow = expectNumber(payload.contextWindow, 'contextWindow');
  if (contextWindow < 0) throw new TypeError('contextWindow must be non-negative');
  const rows = expectArray(payload.messages, 'messages').map((raw, index) => {
    const row = asRecord(raw, `messages.${index}`);
    return {
      id: expectString(row.id, `messages.${index}.id`),
      clientId: expectString(row.clientId, `messages.${index}.clientId`),
      role: expectString(row.role, `messages.${index}.role`),
      content: expectString(row.content, `messages.${index}.content`),
      toolUseId: nullableString(row.toolUseId),
      agentMeta: nullableString(row.agentMeta),
      agentKind: expectString(row.agentKind, `messages.${index}.agentKind`),
      createdAt: expectNumber(row.createdAt, `messages.${index}.createdAt`),
    };
  });
  const selectVisibleClientIds = db.prepare(
    'SELECT client_id FROM messages WHERE session_id = ? AND rewind_at IS NULL',
  );
  const selectUserAttachmentSources = db.prepare(
    `SELECT client_id, content, agent_meta, created_at, rewind_at
       FROM messages
      WHERE session_id = ? AND role = 'user'
      ORDER BY created_at ASC, id ASC`,
  );
  const hideVisible = db.prepare(
    'UPDATE messages SET rewind_at = ? WHERE session_id = ? AND rewind_at IS NULL',
  );
  const upsert = db.prepare(
    `INSERT INTO messages
      (id, client_id, session_id, role, content, tool_use_id, agent_meta, agent_kind, created_at, rewind_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(session_id, client_id) DO UPDATE SET
       role = excluded.role,
       content = excluded.content,
       tool_use_id = excluded.tool_use_id,
       agent_meta = excluded.agent_meta,
       agent_kind = excluded.agent_kind,
       created_at = excluded.created_at,
       rewind_at = NULL`,
  );
  const transaction = db.transaction((): string[] => {
    const session = db.prepare('SELECT id FROM sessions WHERE id = ? LIMIT 1').get(sessionId);
    if (!session) throw Object.assign(new Error(`Session 不存在: ${sessionId}`), { code: 'NOT_FOUND' });
    // 在隐藏前冻结附件来源。历史投影行(含已 rewind 的其它分支)按稳定 clientId / Pi
    // entry uuid 精确复用；首次导航按发送时持久化的 piEntryId 关联。旧 live 行没有关联时，
    // 只允许“可见公共前缀中
    // 文本和原始时间戳都一致”的保守回退，避免相同文字的另一分支附件串线。
    const attachmentSources = selectUserAttachmentSources.all(sessionId) as TreeAttachmentSourceRow[];
    const byClientId = new Map(attachmentSources.map((row) => [row.client_id, row]));
    const byUuid = new Map<string, TreeAttachmentSourceRow>();
    const byLinkedPiEntryId = new Map<string, TreeAttachmentSourceRow>();
    for (const source of attachmentSources) {
      const uuid = treeEntryUuid(source.agent_meta);
      if (uuid) byUuid.set(uuid, source);
      const piEntryId = linkedPiEntryId(source.agent_meta);
      if (piEntryId) byLinkedPiEntryId.set(piEntryId, source);
    }
    const visibleUserSources = attachmentSources.filter((row) => row.rewind_at === null);
    let visiblePrefixIndex = 0;
    let visiblePrefixIntact = true;

    // 原子快照当前可见集,再隐藏:导航期间(带摘要可等数分钟)并发落库的消息也在其中,
    // 交给调用方作删除广播的权威集 —— 避免用导航前的陈旧快照漏掉这条(codex review)。
    const hiddenClientIds = (selectVisibleClientIds.all(sessionId) as { client_id: string }[])
      .map((row) => row.client_id);
    hideVisible.run(now, sessionId);
    for (const row of rows) {
      let content = row.content;
      let agentMeta = row.agentMeta;
      if (row.role === 'user') {
        const uuid = treeEntryUuid(row.agentMeta);
        let source = byClientId.get(row.clientId)
          ?? (uuid ? byUuid.get(uuid) : undefined)
          ?? (uuid ? byLinkedPiEntryId.get(uuid) : undefined)
          ?? null;
        const candidate = visibleUserSources[visiblePrefixIndex] ?? null;
        if (source && visiblePrefixIntact && source !== candidate) {
          // 已经精确命中另一个历史分支，说明公共可见前缀在这里结束；后续消息不能
          // 再退回按文本/时间猜附件，否则会把旧活动分支的附件串到新分支。
          visiblePrefixIntact = false;
        } else if (!source && visiblePrefixIntact) {
          const samePrefix = !!candidate
            && candidate.created_at === row.createdAt
            && normalizedTreeUserText(candidate.content) === normalizedTreeUserText(row.content);
          if (samePrefix) source = candidate;
          else visiblePrefixIntact = false;
        }
        visiblePrefixIndex += 1;
        content = mergeTreeUserAttachments(row.content, source);
        agentMeta = mergeTreeUserAgentMeta(row.agentMeta, source);
      }
      upsert.run(
        row.id,
        row.clientId,
        sessionId,
        row.role,
        content,
        row.toolUseId,
        agentMeta,
        row.agentKind,
        row.createdAt,
      );
    }
    db.prepare(
      `UPDATE sessions
          SET cleared_at = NULL, context_tokens = ?, context_window = ?, updated_at = ?
        WHERE id = ?`,
    ).run(contextTokens, contextWindow, now, sessionId);
    return hiddenClientIds;
  });
  const hiddenClientIds = transaction();
  return { messageCount: rows.length, hiddenClientIds };
}

interface RewindMessageRow {
  id: string;
  client_id: string;
  role: string;
  created_at: number;
  agent_meta: string | null;
}

interface RewindSelectOpts {
  targetCreatedAt: number;
  targetMessageId: string | null;
  targetClientId: string | null;
  targetMessageUuid: string | null;
  preserveMessageUuid: string | null;
}

function selectRewindMessageIds(rows: RewindMessageRow[], opts: RewindSelectOpts): string[] {
  // Keep this mirror in sync with localDb/client/WorkerThreadTransport.ts.
  const hasTranscriptBranch = Boolean(opts.targetMessageUuid);
  const branchUuids = new Set<string>();
  if (opts.targetMessageUuid) branchUuids.add(opts.targetMessageUuid);
  const selected = new Set<string>();

  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (selected.has(row.id)) continue;
      const meta = parseRewindAgentMeta(row.agent_meta);
      if (opts.preserveMessageUuid && meta.uuid === opts.preserveMessageUuid) continue;
      const isTarget = (opts.targetClientId !== null && row.client_id === opts.targetClientId) ||
        (opts.targetMessageUuid !== null && meta.uuid === opts.targetMessageUuid);
      const isBranchDescendant = Boolean(meta.transcriptParentUuid && branchUuids.has(meta.transcriptParentUuid));
      const isSameTimestampTail = row.created_at === opts.targetCreatedAt &&
        (opts.targetMessageId === null || row.id >= opts.targetMessageId);
      const isLegacyTail = (row.created_at > opts.targetCreatedAt || isSameTimestampTail) &&
        (!hasTranscriptBranch || !meta.transcriptParentUuid);
      if (!isTarget && !isBranchDescendant && !isLegacyTail) continue;
      selected.add(row.id);
      if (meta.uuid && !branchUuids.has(meta.uuid)) {
        branchUuids.add(meta.uuid);
        changed = true;
      }
    }
  }

  return [...selected];
}

function parseRewindAgentMeta(raw: string | null): { uuid?: string; transcriptParentUuid?: string } {
  if (!raw || raw === 'null') return {};
  try {
    const parsed = JSON.parse(raw) as { uuid?: unknown; transcriptParentUuid?: unknown };
    const uuid = typeof parsed.uuid === 'string' && parsed.uuid ? parsed.uuid : undefined;
    const transcriptParentUuid =
      typeof parsed.transcriptParentUuid === 'string' && parsed.transcriptParentUuid
        ? parsed.transcriptParentUuid
        : undefined;
    return { uuid, transcriptParentUuid };
  } catch {
    return {};
  }
}

function forkSession(db: Database.Database, args: unknown): { messageCount: number } {
  const payload = asRecord(args, 'fork.session args');
  const sourceSessionId = expectString(payload.sourceSessionId, 'sourceSessionId');
  const sourceClearedAt = nullableNumber(payload.sourceClearedAt);
  const targetCreatedAt = expectNumber(payload.targetCreatedAt, 'targetCreatedAt');
  const targetRowid = nullableNumber(payload.targetRowid);
  const newSession = asRecord(payload.newSession, 'newSession');
  const uuidMap = normalizeUuidMap(payload.uuidMap);
  const legacyTranscriptParentUuids = normalizeStringSet(
    payload.legacyTranscriptParentUuids,
    'legacyTranscriptParentUuids',
  );
  const toolParentUuids = normalizeStringSet(payload.toolParentUuids, 'toolParentUuids');
  const detachAgentSwitchSessions = payload.detachAgentSwitchSessions === true;
  const resetHandoffBoundaryClientId = nullableString(payload.resetHandoffBoundaryClientId);
  const newMessageIds = normalizeNewMessageIds(payload.newMessageIds);
  const sourceMessages = db.prepare(
    `SELECT client_id, role, content, tool_use_id, agent_meta, agent_kind, created_at
       FROM messages
      WHERE session_id = ?
        AND (? IS NULL OR created_at > ?)
        AND (
          created_at < ?
          OR (? IS NOT NULL AND created_at = ? AND rowid < ?)
        )
        AND rewind_at IS NULL
      ORDER BY created_at ASC, rowid ASC`,
  ).all(
    sourceSessionId,
    sourceClearedAt,
    sourceClearedAt,
    targetCreatedAt,
    targetRowid,
    targetCreatedAt,
    targetRowid,
  ) as Array<{
    client_id: string;
    role: string;
    content: string;
    tool_use_id: string | null;
    agent_meta: string | null;
    agent_kind: string | null;
    created_at: number;
  }>;
  if (newMessageIds.length !== sourceMessages.length) {
    throw invalidArgs(
      `newMessageIds length mismatch: expected ${sourceMessages.length}, got ${newMessageIds.length}`,
    );
  }
  const insertMessage = db.prepare(
    `INSERT INTO messages
      (id, client_id, session_id, role, content, tool_use_id, agent_meta, agent_kind, created_at, rewind_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  const transaction = db.transaction(() => {
    db.prepare(
      `INSERT INTO sessions (
        id, title, working_dir, model, provider_id, effort, permission_mode, status,
        sdk_session_id, total_token_usage, total_cost_usd, context_tokens,
        context_window, fast_mode, cleared_at, pinned_at, user_send_at,
        agent_kind, workspace_kind, codex_history_has_product_prompt,
        parent_session_id, forked_at_message_id,
        created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      expectString(newSession.id, 'newSession.id'),
      expectString(newSession.title, 'newSession.title'),
      normalizeWorkingDirForStorage(nullableString(newSession.workingDir)),
      expectString(newSession.model, 'newSession.model'),
      nullableString(newSession.providerId),
      expectString(newSession.effort, 'newSession.effort'),
      expectString(newSession.permissionMode, 'newSession.permissionMode'),
      expectString(newSession.status, 'newSession.status'),
      nullableString(newSession.sdkSessionId),
      expectNumber(newSession.totalTokenUsage, 'newSession.totalTokenUsage'),
      expectNumber(newSession.totalCostUsd, 'newSession.totalCostUsd'),
      expectNumber(newSession.contextTokens, 'newSession.contextTokens'),
      expectNumber(newSession.contextWindow, 'newSession.contextWindow'),
      newSession.fastMode ? 1 : 0,
      nullableNumber(newSession.clearedAt),
      nullableNumber(newSession.pinnedAt),
      nullableNumber(newSession.userSendAt),
      expectString(newSession.agentKind, 'newSession.agentKind'),
      expectString(newSession.workspaceKind, 'newSession.workspaceKind'),
      newSession.codexHistoryHasProductPrompt == null
        ? null
        : newSession.codexHistoryHasProductPrompt
          ? 1
          : 0,
      nullableString(newSession.parentSessionId),
      nullableString(newSession.forkedAtMessageId),
      expectNumber(newSession.createdAt, 'newSession.createdAt'),
      expectNumber(newSession.updatedAt, 'newSession.updatedAt'),
    );
    for (let i = 0; i < sourceMessages.length; i += 1) {
      const message = sourceMessages[i];
      const ids = newMessageIds[i];
      insertMessage.run(
        ids.id,
        ids.clientId,
        expectString(newSession.id, 'newSession.id'),
        message.role,
        sanitizeForkedMessageContent(message, {
          detachAgentSwitchSessions,
          resetHandoffBoundaryClientId,
        }),
        message.tool_use_id,
        remapAgentMetaUuid(message.agent_meta, uuidMap, legacyTranscriptParentUuids, toolParentUuids),
        message.agent_kind,
        message.created_at,
      );
    }
  });
  transaction();
  return { messageCount: sourceMessages.length };
}

/** 复制边界只保留可见语义；vendor session 绑定必须属于父分支。 */
function sanitizeForkedMessageContent(
  message: { client_id: string; role: string; content: string },
  opts: { detachAgentSwitchSessions: boolean; resetHandoffBoundaryClientId: string | null },
): string {
  const resetConsumed = message.client_id === opts.resetHandoffBoundaryClientId;
  if (message.role !== 'agent_switch' || (!opts.detachAgentSwitchSessions && !resetConsumed)) {
    return message.content;
  }
  try {
    const parsed = JSON.parse(message.content);
    if (!isRecord(parsed)) return message.content;
    return JSON.stringify({
      ...parsed,
      ...(opts.detachAgentSwitchSessions ? { fromSdkSessionId: null } : {}),
      ...(resetConsumed ? { consumed: false } : {}),
    });
  } catch {
    return message.content;
  }
}

// 会话分享(.xdtshare)导入落库:单事务插 session 行 + 全量 messages(含 rewind 链)。
// 行级校验放在事务体内,任一行非法 → 整体回滚零写入(导入编排的"DB 是最后一步"
// 依赖这个原子性做免回滚)。session 已存在按 ALREADY_EXISTS 抛,编排层在
// 冲突预检后理论上不会命中,这里是并发双导入的兜底。
// 本文件是 inproc 回滚口;默认热路径走 file worker 的同名 handler
// (client/WorkerThreadTransport.ts)。两份实现必须同步,typecheck 抓不到 drift。
function sessionImportShare(db: Database.Database, args: unknown): { messageCount: number } {
  const payload = asRecord(args, 'session.importShare args');
  const session = asRecord(payload.session, 'session');
  const messages = expectArray(payload.messages, 'messages');
  const sessionId = expectString(session.id, 'session.id');
  const insertMessage = db.prepare(
    `INSERT INTO messages
      (id, client_id, session_id, role, content, tool_use_id, agent_meta, agent_kind, created_at, rewind_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const transaction = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM sessions WHERE id = ? LIMIT 1').get(sessionId);
    if (existing) {
      throw Object.assign(new Error(`session already exists: ${sessionId}`), {
        code: 'ALREADY_EXISTS',
      });
    }
    db.prepare(
      `INSERT INTO sessions (
        id, title, working_dir, workspace_kind, worktree_path, model, effort, permission_mode, provider_id, status,
        sdk_session_id, total_token_usage, total_cost_usd, context_tokens, context_window,
        fast_mode, plan_mode_enabled, agent_kind, source, extra_dirs,
        codex_history_has_product_prompt, cleared_at, user_send_at, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      sessionId,
      expectString(session.title, 'session.title'),
      nullableString(session.workingDir),
      expectString(session.workspaceKind, 'session.workspaceKind'),
      nullableString(session.worktreePath),
      expectString(session.model, 'session.model'),
      expectString(session.effort, 'session.effort'),
      expectString(session.permissionMode, 'session.permissionMode'),
      nullableString(session.providerId),
      expectString(session.status, 'session.status'),
      nullableString(session.sdkSessionId),
      expectNumber(session.totalTokenUsage, 'session.totalTokenUsage'),
      expectNumber(session.totalCostUsd, 'session.totalCostUsd'),
      expectNumber(session.contextTokens, 'session.contextTokens'),
      expectNumber(session.contextWindow, 'session.contextWindow'),
      session.fastMode ? 1 : 0,
      session.planModeEnabled ? 1 : 0,
      expectString(session.agentKind, 'session.agentKind'),
      expectString(session.source, 'session.source'),
      expectString(session.extraDirs, 'session.extraDirs'),
      session.codexHistoryHasProductPrompt == null
        ? null
        : session.codexHistoryHasProductPrompt
          ? 1
          : 0,
      nullableNumber(session.clearedAt),
      nullableNumber(session.userSendAt),
      expectNumber(session.createdAt, 'session.createdAt'),
      expectNumber(session.updatedAt, 'session.updatedAt'),
    );
    for (const rawMessage of messages) {
      const m = asRecord(rawMessage, 'message');
      insertMessage.run(
        expectString(m.id, 'message.id'),
        expectString(m.clientId, 'message.clientId'),
        sessionId,
        expectString(m.role, 'message.role'),
        expectString(m.content, 'message.content'),
        nullableString(m.toolUseId),
        nullableString(m.agentMeta),
        nullableString(m.agentKind),
        expectNumber(m.createdAt, 'message.createdAt'),
        nullableNumber(m.rewindAt),
      );
    }
    return messages.length;
  });
  return { messageCount: transaction() as number };
}

function embeddingMarkDone(db: Database.Database, args: unknown): void {
  const payload = asRecord(args, 'embedding.markDone args');
  const rowids = expectArray(payload.rowids, 'rowids');
  const stmt = db.prepare(`UPDATE embedding_jobs SET status = 'done', last_error = NULL WHERE rowid = ?`);
  const transaction = db.transaction(() => {
    for (const rowid of rowids) stmt.run(expectNumber(rowid, 'rowid'));
  });
  transaction();
}

function embeddingCommit(db: Database.Database, args: unknown): void {
  const payload = asRecord(args, 'embedding.commit args');
  const items = expectArray(payload.items, 'items');
  // 写入侧需要 idempotent 重试:同一 embedding_jobs.rowid 可能因 worker 重启 / 上一轮
  // tx 部分提交而残留 vec 行,retry 时再 INSERT 撞 UNIQUE。
  // 历史 fix(0b10635c)用 INSERT OR REPLACE 想实现幂等,但 sqlite-vec vec0 虚表的
  // xUpdate 不支持 SQLite 的 OR REPLACE conflict resolution(虚表不会把 REPLACE 翻成
  // 先 DELETE 再 INSERT),仍按主键冲突抛错 → fix 形同虚设,日志里 UNIQUE 仍在出。
  // 改为显式 DELETE + plain INSERT:sqlite-vec 支持 DELETE,同一事务内做完 → 等价于
  // upsert,且事务原子性保留(回滚时两条都退)。
  // 本文件是 inproc 回滚口；默认热路径走 file worker 的同名 tx handler。
  // 两份实现必须同步，typecheck 抓不到 drift。
  const deleteCache = new Map<string, Database.Statement>();
  const insertCache = new Map<string, Database.Statement>();
  const getDeleteStmt = (vecTable: string): Database.Statement => {
    let stmt = deleteCache.get(vecTable);
    if (!stmt) {
      assertIdentifier(vecTable);
      stmt = db.prepare(`DELETE FROM "${vecTable}" WHERE rowid = ?`);
      deleteCache.set(vecTable, stmt);
    }
    return stmt;
  };
  const getInsertStmt = (vecTable: string): Database.Statement => {
    let stmt = insertCache.get(vecTable);
    if (!stmt) {
      assertIdentifier(vecTable);
      stmt = db.prepare(`INSERT INTO "${vecTable}" (rowid, embedding) VALUES (?, ?)`);
      insertCache.set(vecTable, stmt);
    }
    return stmt;
  };
  const updateStmt = db.prepare(
    `UPDATE embedding_jobs SET status = 'done', last_error = NULL WHERE rowid = ?`,
  );
  const transaction = db.transaction(() => {
    for (const rawItem of items) {
      const item = asRecord(rawItem, 'embedding item');
      const rowid = expectNumber(item.rowid, 'item.rowid');
      const embedding = item.embedding;
      if (!(embedding instanceof Float32Array)) {
        throw invalidArgs('item.embedding must be Float32Array');
      }
      const vecTable = expectString(item.vecTable, 'item.vecTable');
      const rowidBig = BigInt(rowid);
      // 消息删除可能在 embedding API 请求飞行期间删掉 job 与旧 vec。提交时
      // 先确认 job 仍存在；不存在就只清理可能的孤立 vec，绝不能把已删除消息
      // 的派生向量重新写回本地。
      const updated = updateStmt.run(rowid);
      getDeleteStmt(vecTable).run(rowidBig);
      if (updated.changes !== 1) continue;
      getInsertStmt(vecTable).run(rowidBig, embedding);
    }
  });
  transaction();
}

function embeddingRecordFailures(db: Database.Database, args: unknown): { failCount: number } {
  const payload = asRecord(args, 'embedding.recordFailures args');
  const jobs = expectArray(payload.jobs, 'jobs');
  const errMsg = truncate(expectString(payload.errMsg, 'errMsg'), 2000);
  const now = expectNumber(payload.now, 'now');
  const updReschedule = db.prepare(
    `UPDATE embedding_jobs
        SET attempts = ?, last_error = ?, scheduled_at = ?
      WHERE rowid = ?`,
  );
  const updFail = db.prepare(
    `UPDATE embedding_jobs
        SET attempts = ?, last_error = ?, status = 'failed'
      WHERE rowid = ?`,
  );
  const transaction = db.transaction(() => {
    let failCount = 0;
    for (const rawJob of jobs) {
      const job = asRecord(rawJob, 'failure job');
      const rowid = expectNumber(job.rowid, 'job.rowid');
      const nextAttempts = expectNumber(job.attempts, 'job.attempts') + 1;
      if (nextAttempts >= MAX_ATTEMPTS) {
        updFail.run(nextAttempts, errMsg, rowid);
        failCount++;
      } else {
        const backoff = RETRY_BACKOFF_MS[Math.min(nextAttempts - 1, RETRY_BACKOFF_MS.length - 1)];
        updReschedule.run(nextAttempts, errMsg, now + backoff, rowid);
      }
    }
    return failCount;
  });
  return { failCount: transaction() as number };
}

function embeddingEnqueue(db: Database.Database, args: unknown): { inserted: number; skipped: number } {
  const payload = asRecord(args, 'embedding.enqueue args');
  const source = expectString(payload.source, 'source');
  const now = expectNumber(payload.now, 'now');
  const items = expectArray(payload.items, 'items');
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO embedding_jobs
       (source, source_id, chunk_index, model_id, vec_table, status, attempts, scheduled_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`,
  );
  const transaction = db.transaction(() => {
    let inserted = 0;
    for (const rawItem of items) {
      const item = asRecord(rawItem, 'enqueue item');
      const result = stmt.run(
        source,
        expectString(item.sourceId, 'item.sourceId'),
        typeof item.chunkIndex === 'number' ? item.chunkIndex : 0,
        expectString(item.modelId, 'item.modelId'),
        expectString(item.vecTable, 'item.vecTable'),
        now,
      );
      if (result.changes > 0) inserted++;
    }
    return inserted;
  });
  const inserted = transaction() as number;
  return { inserted, skipped: items.length - inserted };
}

// F-COLLAB orca 事务：与 file worker tx handler 的同名逻辑保持一致。
// focused 列是 integer(0/1); better-sqlite3 不接受 boolean 绑定, 一律转 0/1。
// 可选字段 === undefined 表示 "保留 existing 当前值", 与原 drizzle 写法语义一致。
function orcaSetWorkerFocus(db: Database.Database, args: unknown): void {
  const payload = asRecord(args, 'orca.setWorkerFocus args');
  const teamId = expectString(payload.teamId, 'teamId');
  const workerId = expectString(payload.workerId, 'workerId');
  const now = expectNumber(payload.now, 'now');
  const clearOthers = db.prepare('UPDATE orca_workers SET focused = 0, updated_at = ? WHERE team_id = ? AND focused = 1');
  const setOne = db.prepare('UPDATE orca_workers SET focused = 1, updated_at = ? WHERE id = ?');
  db.transaction(() => {
    clearOthers.run(now, teamId);
    setOne.run(now, workerId);
  })();
}

function orcaRemoveWorker(db: Database.Database, args: unknown): string | null {
  const payload = asRecord(args, 'orca.removeWorker args');
  const workerId = expectString(payload.workerId, 'workerId');
  const now = expectNumber(payload.now, 'now');
  const selectWorker = db.prepare('SELECT session_id AS sessionId FROM orca_workers WHERE id = ? LIMIT 1');
  const deleteWorker = db.prepare('DELETE FROM orca_workers WHERE id = ?');
  const archiveSession = db.prepare("UPDATE sessions SET status = 'archived', orca_role = NULL, updated_at = ? WHERE id = ?");
  const transaction = db.transaction(() => {
    const row = selectWorker.get(workerId) as { sessionId: string } | undefined;
    if (!row) return null;
    deleteWorker.run(workerId);
    archiveSession.run(now, row.sessionId);
    return row.sessionId;
  });
  return transaction() as string | null;
}

function orcaCancelStaleTeams(db: Database.Database, args: unknown): void {
  const payload = asRecord(args, 'orca.cancelStaleTeams args');
  const leadSessionId = expectString(payload.leadSessionId, 'leadSessionId');
  const keepTeamId = expectString(payload.keepTeamId, 'keepTeamId');
  const now = expectNumber(payload.now, 'now');
  const cancel = db.prepare("UPDATE orca_teams SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE lead_session_id = ? AND status = 'active' AND id != ?");
  db.transaction(() => {
    cancel.run(now, now, leadSessionId, keepTeamId);
  })();
}

function orcaUpsertWorker(db: Database.Database, args: unknown): void {
  const payload = asRecord(args, 'orca.upsertWorker args');
  const id = expectString(payload.id, 'id');
  const teamId = expectString(payload.teamId, 'teamId');
  const sessionId = expectString(payload.sessionId, 'sessionId');
  const now = expectNumber(payload.now, 'now');
  db.transaction(() => {
    if (payload.focused === true) {
      db.prepare('UPDATE orca_workers SET focused = 0, updated_at = ? WHERE team_id = ? AND focused = 1').run(now, teamId);
    }
    const existing = db.prepare('SELECT * FROM orca_workers WHERE id = ? LIMIT 1').get(id) as Record<string, unknown> | undefined;
    if (existing) {
      db.prepare('UPDATE orca_workers SET team_id = ?, session_id = ?, status = ?, label = ?, worktree_branch = ?, role = ?, focused = ?, idle_since = ?, updated_at = ? WHERE id = ?').run(
        teamId,
        sessionId,
        payload.status != null ? payload.status : existing.status,
        payload.label === undefined ? existing.label : nullableString(payload.label),
        payload.worktreeBranch === undefined ? existing.worktree_branch : nullableString(payload.worktreeBranch),
        payload.role === undefined ? existing.role : expectString(payload.role, 'role'),
        payload.focused === undefined ? existing.focused : (payload.focused ? 1 : 0),
        payload.idleSince === undefined ? existing.idle_since : (payload.idleSince == null ? null : expectNumber(payload.idleSince, 'idleSince')),
        now,
        id,
      );
      return;
    }
    const bySession = db.prepare('SELECT * FROM orca_workers WHERE session_id = ? LIMIT 1').get(sessionId) as Record<string, unknown> | undefined;
    if (bySession) {
      db.prepare('UPDATE orca_workers SET team_id = ?, status = ?, label = ?, worktree_branch = ?, role = ?, focused = ?, idle_since = ?, updated_at = ? WHERE session_id = ?').run(
        teamId,
        payload.status != null ? payload.status : bySession.status,
        payload.label === undefined ? bySession.label : nullableString(payload.label),
        payload.worktreeBranch === undefined ? bySession.worktree_branch : nullableString(payload.worktreeBranch),
        payload.role === undefined ? bySession.role : expectString(payload.role, 'role'),
        payload.focused === undefined ? bySession.focused : (payload.focused ? 1 : 0),
        payload.idleSince === undefined ? bySession.idle_since : (payload.idleSince == null ? null : expectNumber(payload.idleSince, 'idleSince')),
        now,
        sessionId,
      );
      return;
    }
    db.prepare('INSERT INTO orca_workers (id, team_id, session_id, status, label, worktree_branch, role, focused, idle_since, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      id,
      teamId,
      sessionId,
      payload.status != null ? payload.status : 'idle',
      payload.label == null ? null : nullableString(payload.label),
      payload.worktreeBranch == null ? null : nullableString(payload.worktreeBranch),
      payload.role != null ? expectString(payload.role, 'role') : 'developer',
      payload.focused ? 1 : 0,
      payload.idleSince == null ? null : expectNumber(payload.idleSince, 'idleSince'),
      now,
      now,
    );
  })();
}

function orcaReserveWorkerCreation(db: Database.Database, args: unknown): unknown {
  const payload = asRecord(args, 'orca.reserveWorkerCreation args');
  const reservationId = expectString(payload.reservationId, 'reservationId');
  const teamId = expectString(payload.teamId, 'teamId');
  const label = expectString(payload.label, 'label').toLowerCase();
  const hardLimit = expectNumber(payload.hardLimit, 'hardLimit');
  const now = expectNumber(payload.now, 'now');
  const expiresAt = expectNumber(payload.expiresAt, 'expiresAt');
  return db.transaction(() => {
    // DELETE 即使没有命中也会先取得 writer lock，后续检查与 INSERT 因而跨连接串行。
    db.prepare('DELETE FROM orca_worker_creation_reservations WHERE expires_at <= ?').run(now);
    const duplicateWorker = db.prepare(
      'SELECT 1 FROM orca_workers WHERE team_id = ? AND label = ? COLLATE NOCASE LIMIT 1',
    ).get(teamId, label);
    const duplicateReservation = db.prepare(
      'SELECT 1 FROM orca_worker_creation_reservations WHERE team_id = ? AND label = ? COLLATE NOCASE LIMIT 1',
    ).get(teamId, label);
    if (duplicateWorker) return { ok: false, errorCode: 'DUPLICATE_LABEL' };
    if (duplicateReservation) return { ok: false, errorCode: 'WORKER_CREATION_IN_PROGRESS' };
    // Worker 进入终态仍占槽，只有关联 session 归档后才释放。
    const occupiedWorkerCount = Number(db.prepare(`SELECT COUNT(*)
      FROM orca_workers w INNER JOIN sessions s ON s.id = w.session_id
      WHERE w.team_id = ? AND s.status = 'active'`).pluck().get(teamId) || 0);
    const reservationCount = Number(db.prepare(
      'SELECT COUNT(*) FROM orca_worker_creation_reservations WHERE team_id = ?',
    ).pluck().get(teamId) || 0);
    const occupiedSlotsBefore = occupiedWorkerCount + reservationCount;
    if (occupiedSlotsBefore >= hardLimit) {
      return { ok: false, errorCode: 'WORKER_LIMIT_HARD_EXCEEDED' };
    }
    db.prepare(`INSERT INTO orca_worker_creation_reservations
      (id, team_id, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
      .run(reservationId, teamId, label, now, expiresAt);
    return { ok: true, occupiedSlotsBefore };
  })();
}

function orcaRenewWorkerCreationReservation(db: Database.Database, args: unknown): boolean {
  const payload = asRecord(args, 'orca.renewWorkerCreationReservation args');
  const result = db.prepare(
    'UPDATE orca_worker_creation_reservations SET expires_at = ? WHERE id = ? AND expires_at > ?',
  ).run(
    expectNumber(payload.expiresAt, 'expiresAt'),
    expectString(payload.reservationId, 'reservationId'),
    expectNumber(payload.now, 'now'),
  );
  return result.changes === 1;
}

function orcaReleaseWorkerCreationReservation(db: Database.Database, args: unknown): void {
  const payload = asRecord(args, 'orca.releaseWorkerCreationReservation args');
  db.prepare('DELETE FROM orca_worker_creation_reservations WHERE id = ?').run(
    expectString(payload.reservationId, 'reservationId'),
  );
}

function readExistingImportedClientIds(
  db: Database.Database,
  sessionId: string,
  importClientIdPrefix: string,
): Set<string> {
  const rows = db.prepare(`
    SELECT client_id AS clientId
    FROM messages
    WHERE session_id = ? AND client_id LIKE ?
  `).all(sessionId, `${importClientIdPrefix}%`) as Array<{ clientId: string }>;
  return new Set(rows.map((row) => row.clientId));
}

interface MessageFingerprint {
  role: 'user' | 'assistant';
  /** 原文指纹(仅换行归一 + trim),普通消息只用它精确比较。 */
  plain: string;
  /**
   * citation 规范形指纹(有损:标记→路径、去反引号、折叠空白)。只在 canon 比较
   * 门放行时参与(见 isLikelyLocalDuplicate),避免「仅 Markdown 格式不同」的两条
   * 正常回复被误判成重复(review 反馈)。
   */
  canonical?: string;
  /** 原文是否含原始标记字面量——canon 比较的门:至少一侧为真才启用有损比较。 */
  hasMarker: boolean;
  createdAt: number;
}

function readExistingMessageFingerprints(
  db: Database.Database,
  sessionId: string,
  importClientIdPrefix: string,
): MessageFingerprint[] {
  const rows = db.prepare(`
    SELECT role, content, created_at AS createdAt
    FROM messages
    WHERE session_id = ?
      AND role IN ('user', 'assistant')
      AND client_id NOT LIKE ?
  `).all(sessionId, `${importClientIdPrefix}%`) as Array<{
    role: string;
    content: string;
    createdAt: number;
  }>;
  const out: MessageFingerprint[] = [];
  for (const row of rows) {
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    const text = normalizeStoredMessageText(row.content);
    if (!text) continue;
    out.push(messageFingerprint(row.role, text, row.createdAt));
  }
  return out;
}

function isLikelyLocalDuplicate(
  existing: MessageFingerprint[],
  row: { role: 'user' | 'assistant'; text: string; createdAt: number },
): boolean {
  const next = messageFingerprint(row.role, row.text, row.createdAt);
  return existing.some(
    (prev) =>
      prev.role === next.role &&
      Math.abs(prev.createdAt - next.createdAt) <= LOCAL_DUPLICATE_WINDOW_MS &&
      // 普通消息:原文精确比较。canon 有损比较只在「至少一侧含原始标记字面量」时
      // 启用——即升级前的旧标记行 vs 已归一化的导入行;两条都不含标记的正常回复
      // (如 `Use \`foo\`` vs `Use foo`)绝不走有损比较(review 反馈)。
      (prev.plain === next.plain ||
        (prev.canonical !== undefined &&
          next.canonical !== undefined &&
          (prev.hasMarker || next.hasMarker) &&
          prev.canonical === next.canonical)),
  );
}

function messageFingerprint(
  role: 'user' | 'assistant',
  text: string,
  createdAt: number,
): MessageFingerprint {
  // 升级前落库的旧行仍带原始 `:codex-file-citation{...}` 标记,导入侧新文本已
  // 归一化(标记换成 code span,截断残尾则被整段剥掉——此时是**不含任何标记/
  // 反引号的纯文本**)。因此 assistant 一律算出规范形候选指纹,是否参与比较由
  // isLikelyLocalDuplicate 的标记门决定(review 反馈:残尾行的规范形是纯文本,
  // 导入侧若不给纯文本算规范形就永远配不上)。只影响比较,不改落库内容。
  const plain = normalizeFingerprintText(text);
  const hasMarker = role === 'assistant' && text.includes(CODEX_CITATION_OPEN);
  const canonical =
    role === 'assistant' ? normalizeFingerprintText(canonicalizeCodexCitations(text)) : undefined;
  return { role, plain, ...(canonical !== undefined ? { canonical } : {}), hasMarker, createdAt };
}

// 指纹专用规范形——与展示形(maker-core finalizeCodexCitationText)**刻意不同**:
// 标记替换为解码路径本体(无 code span 围栏/空格垫),循环到不动点,再去掉全部
// 反引号并折叠空白。这样「升级前的原始标记行」与「已归一化的展示形文本」两侧
// 都收敛到同一规范形——路径本身解码出完整标记字面量的极端文件名也一致(review
// 反馈:展示形二次处理不幂等,不能拿来当指纹)。只用于去重比较,不落库。
// eval-fallback worker(WorkerThreadTransport WORKER_CODE)无法 import,两份 worker
// 各内联一份,口径变更需同步(tx.test 用真实标记 fixture 钉行为)。
const CODEX_CITATION_RE = /:codex-file-citation\{((?:[^"{}]|"(?:[^"\\]|\\.)*")*)\}/g;
const CODEX_CITATION_OPEN = ':codex-file-citation{';

function codexCitationClose(text: string, attrsStart: number): number {
  let inQuote = false;
  for (let i = attrsStart; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuote && ch === '\\') i += 1;
    else if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch === '}') return i;
    else if (!inQuote && ch === '{') return -2; // 裸 { = 畸形标记,原样透出
  }
  return -1; // 扫描到末尾未闭合 = 截断残尾
}

// path 属性解码(与 translator extractCitationPath 同口径:完整属性名边界、
// \"/\\ 转义、开头恰好两个反斜杠 = 原生 UNC 整体保留)。
function decodeCitationPathForFingerprint(attrs: string): string {
  const raw = /(?:^|\s)path="((?:[^"\\]|\\.)*)"/.exec(attrs)?.[1];
  if (raw === undefined) return '';
  const nativeUnc = raw.startsWith('\\\\') && raw[2] !== '\\';
  const head = nativeUnc ? '\\\\' : '';
  return head + (nativeUnc ? raw.slice(2) : raw).replace(/\\([\\"])/g, '$1');
}

function canonicalizeCodexCitations(text: string): string {
  // 无早退:纯文本也要走末尾的空白折叠,否则「残尾行规范形(折叠过)」与「导入侧
  // 纯文本规范形(未折叠)」会因内部空白差异配不上。
  // 截断残尾剥除(与展示口径一致:只剥「扫描到文本末尾仍未闭合」的标记)。
  let out = text;
  let from = 0;
  for (;;) {
    const open = out.indexOf(CODEX_CITATION_OPEN, from);
    if (open === -1) break;
    const close = codexCitationClose(out, open + CODEX_CITATION_OPEN.length);
    if (close === -1) {
      out = out.slice(0, open);
      break;
    }
    from = close === -2 ? open + CODEX_CITATION_OPEN.length : close + 1;
  }
  // 标记 → 解码路径,循环到不动点(路径解码可能暴露新的完整标记字面量;有界防御)。
  for (let i = 0; i < 5; i += 1) {
    const next = out.replace(CODEX_CITATION_RE, (_all, attrs: string) =>
      decodeCitationPathForFingerprint(attrs),
    );
    if (next === out) break;
    out = next;
  }
  // 展示形的围栏/空格垫与换行渲染差异不参与指纹比较。
  return out.replace(/`+/g, '').replace(/\s+/g, ' ');
}

function normalizeStoredMessageText(raw: string): string {
  let value: unknown = raw;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    value = raw;
  }
  return extractContentText(value);
}

function normalizeFingerprintText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (isRecord(content) && typeof content.text === 'string') return content.text;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = typeof block.type === 'string' ? block.type : '';
    if ((type === 'input_text' || type === 'output_text' || type === 'text') && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n\n');
}

function remapAgentMetaUuid(
  raw: string | null,
  map: Map<string, string>,
  legacyTranscriptParentUuids: Set<string> = new Set(),
  toolParentUuids: Set<string> = new Set(),
): string | null {
  if (!raw || raw === 'null') return raw;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return raw;
  }
  const next = { ...parsed };
  if (
    typeof next.uuid === 'string' &&
    legacyTranscriptParentUuids.has(next.uuid) &&
    typeof next.parentUuid === 'string' &&
    !next.transcriptParentUuid
  ) {
    next.transcriptParentUuid = next.parentUuid;
    delete next.parentUuid;
  }
  if (typeof next.uuid === 'string') {
    const mapped = map.get(next.uuid);
    if (mapped) next.uuid = mapped;
    else delete next.uuid;
  }
  if (typeof next.parentUuid === 'string') {
    const mapped = map.get(next.parentUuid);
    if (mapped) next.parentUuid = mapped;
    else if (!toolParentUuids.has(next.parentUuid)) delete next.parentUuid;
  }
  if (typeof next.transcriptParentUuid === 'string') {
    const mapped = map.get(next.transcriptParentUuid);
    if (mapped) next.transcriptParentUuid = mapped;
    else delete next.transcriptParentUuid;
  }
  return JSON.stringify(next);
}

function normalizeStringSet(value: unknown, label: string): Set<string> {
  if (value === undefined) return new Set();
  return new Set(expectArray(value, label).map((item, index) => expectString(item, `${label}.${index}`)));
}

function normalizeUuidMap(value: unknown): Map<string, string> {
  if (Array.isArray(value)) {
    return new Map(
      value.map((entry) => {
        if (!Array.isArray(entry) || entry.length !== 2) throw invalidArgs('uuidMap entries must be pairs');
        return [expectString(entry[0], 'uuidMap.key'), expectString(entry[1], 'uuidMap.value')];
      }),
    );
  }
  const record = asRecord(value, 'uuidMap');
  return new Map(
    Object.entries(record).map(([key, mapped]) => [key, expectString(mapped, `uuidMap.${key}`)]),
  );
}

function normalizeNewMessageIds(value: unknown): Array<{ id: string; clientId: string }> {
  return expectArray(value, 'newMessageIds').map((raw, index) => {
    const item = asRecord(raw, `newMessageIds.${index}`);
    return {
      id: expectString(item.id, `newMessageIds.${index}.id`),
      clientId: expectString(item.clientId, `newMessageIds.${index}.clientId`),
    };
  });
}

function assertIdentifier(value: string): void {
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw Object.assign(new Error(`invalid vec_table identifier: ${value}`), { code: 'INVALID_ARGS' });
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function stringifyContent(value: unknown): string {
  const json = JSON.stringify(value);
  return json === undefined ? 'null' : json;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalidArgs(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw invalidArgs(`${label} must be a string`);
  return value;
}

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw invalidArgs('value must be string or null');
  return value;
}

function expectNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidArgs(`${label} must be a finite number`);
  }
  return value;
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidArgs('value must be finite number or null');
  }
  return value;
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw invalidArgs(`${label} must be an array`);
  return value;
}

function invalidArgs(message: string): Error {
  return Object.assign(new Error(message), { code: 'INVALID_ARGS' });
}
