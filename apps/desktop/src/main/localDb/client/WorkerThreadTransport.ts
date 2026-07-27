import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import type {
  DbTransport,
  DbTransportTerminationInfo,
  LogEvent,
  RpcRequest,
  VecStatusEvent,
  WorkerMessage,
} from './DbTransport.js';

const WORKER_CODE = `
// 旧版 inline worker fallback。默认运行时走 .vite/build/dbWorker.js；
// 这段只作为打包路径回滚口保留，后续验证 macOS / Windows packaged 后删除。
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

if (!parentPort) throw new Error('db worker must be spawned via worker_threads');

// betterSqliteModulePath：主进程 resolveBetterSqliteModuleEntry() 算好的
// better-sqlite3 入口 JS 绝对路径。inline 回滚口也复用真实 file worker 的解析策略，
// 避免 packaged 下裸 require('better-sqlite3') 猜错 node_modules 位置。
let Database = require((workerData && workerData.betterSqliteModulePath) || 'better-sqlite3');
let db = null;
let initError = null;

function postEvent(event, payload) {
  parentPort.postMessage({ event, payload });
}

function postLog(level, scope, payload) {
  postEvent('log', { level, scope, payload });
}

function normalizeParams(params) {
  return Array.isArray(params) ? params : [];
}

function rpcError(err) {
  return {
    code: err && typeof err === 'object' && typeof err.code === 'string'
      ? err.code
      : 'WORKER_RPC_ERROR',
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  };
}

function applyPragmas(nextDb) {
  nextDb.pragma('journal_mode = WAL');
  nextDb.pragma('foreign_keys = ON');
  nextDb.pragma('synchronous = NORMAL');
  nextDb.pragma('temp_store = MEMORY');
  nextDb.pragma('mmap_size = 268435456');
  nextDb.pragma('cache_size = -65536');
  nextDb.pragma('busy_timeout = 5000');
}

function hashMigrationFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const normalized = raw.replace(/\\r\\n/g, '\\n');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function readSchemaVersion(nextDb) {
  try {
    const row = nextDb
      .prepare("SELECT value FROM migration_meta WHERE key='schema_version'")
      .get();
    return row ? parseInt(row.value, 10) : -1;
  } catch (_) {
    return -1;
  }
}

function listPendingMigrations(drizzleDir, currentVersion) {
  const scriptDir = path.join(drizzleDir, 'scripts');
  return fs
    .readdirSync(drizzleDir)
    .filter((fileName) => /^\\d{4}_.+\\.sql$/.test(fileName))
    .map((fileName) => {
      const seq = Number(fileName.slice(0, 4));
      const baseName = fileName.slice(0, -'.sql'.length);
      const tsScriptPath = path.join(scriptDir, baseName + '.ts');
      return {
        seq,
        fileName,
        sqlPath: path.join(drizzleDir, fileName),
        tsScriptPath: fs.existsSync(tsScriptPath) ? tsScriptPath : undefined,
      };
    })
    .filter((migration) => migration.seq > currentVersion)
    .sort((a, b) => a.seq - b.seq);
}

function assertNoPendingMigrations(nextDb, dbPath, drizzleDir) {
  if (!drizzleDir || !fs.existsSync(drizzleDir)) {
    throw Object.assign(new Error('drizzle dir not found for db worker: ' + drizzleDir), {
      code: 'MIGRATION_DIR_MISSING',
    });
  }
  const currentVersion = readSchemaVersion(nextDb);
  const pending = listPendingMigrations(drizzleDir, currentVersion);
  postLog('info', 'db-worker', {
    event: 'dbWorker.migrate.scan',
    dbPath,
    drizzleDir,
    currentVersion,
    pendingCount: pending.length,
  });
  if (pending.length === 0) return;
  throw Object.assign(
    new Error(
      'db worker found ' + pending.length + ' pending migration(s); call localDb.ensureReady before createDbClient',
    ),
    {
      code: 'MIGRATION_REQUIRED',
      pending: pending.map((migration) => ({
        seq: migration.seq,
        fileName: migration.fileName,
      })),
    },
  );
}

function tableExists(nextDb, name) {
  return !!nextDb
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

function detectSchemaDrift(nextDb, drizzleDir) {
  if (!drizzleDir || !fs.existsSync(drizzleDir) || !tableExists(nextDb, 'migration_history')) {
    return { status: 'unknown', entries: [] };
  }
  let rows;
  try {
    rows = nextDb
      .prepare('SELECT seq, file_name, content_hash FROM migration_history')
      .all();
  } catch (err) {
    postLog('warn', 'db-worker', {
      event: 'dbWorker.schemaDrift.queryFailed',
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: 'unknown', entries: [] };
  }
  const entries = [];
  let incomplete = false;
  for (const row of rows) {
    const filePath = path.join(drizzleDir, row.file_name);
    if (!fs.existsSync(filePath)) {
      entries.push({ seq: row.seq, fileName: row.file_name, kind: 'missing' });
      continue;
    }
    try {
      const currentHash = hashMigrationFile(filePath);
      if (currentHash !== row.content_hash) {
        entries.push({ seq: row.seq, fileName: row.file_name, kind: 'drifted' });
      }
    } catch (err) {
      incomplete = true;
      postLog('warn', 'db-worker', {
        event: 'dbWorker.schemaDrift.hashFailed',
        fileName: row.file_name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { status: entries.length > 0 ? 'drifted' : incomplete ? 'unknown' : 'clean', entries };
}

function loadSqliteVec(nextDb, sqliteVecExtPath) {
  if (!sqliteVecExtPath) return { loaded: false, error: 'sqlite-vec path not provided' };
  if (!fs.existsSync(sqliteVecExtPath)) {
    return {
      loaded: false,
      error: 'sqlite-vec binary not found at expected path',
      expectedPath: sqliteVecExtPath,
    };
  }
  try {
    nextDb.loadExtension(sqliteVecExtPath);
    const row = nextDb.prepare('SELECT vec_version() as v').get();
    return { loaded: true, version: row && row.v ? row.v : 'unknown' };
  } catch (err) {
    return {
      loaded: false,
      error: err instanceof Error ? err.message : String(err),
      expectedPath: sqliteVecExtPath,
    };
  }
}

function createDatabase(opts) {
  const dbPath = opts && typeof opts.dbPath === 'string' && opts.dbPath
    ? opts.dbPath
    : ':memory:';
  const dbOpts = opts && opts.nativeBinding ? { nativeBinding: opts.nativeBinding } : {};
  const nextDb = new Database(dbPath, dbOpts);
  try {
    applyPragmas(nextDb);
    if (dbPath !== ':memory:') {
      const vec = loadSqliteVec(nextDb, opts.sqliteVecExtPath);
      postLog(vec.loaded ? 'info' : 'warn', 'db-worker', {
        event: 'dbWorker.sqliteVec',
        dbPath,
        ...vec,
      });
      parentPort.postMessage({ event: 'vec-status', payload: vec });
      assertNoPendingMigrations(nextDb, dbPath, opts.drizzleDir);
      const drift = detectSchemaDrift(nextDb, opts.drizzleDir);
      postLog(drift.status === 'clean' ? 'info' : 'warn', 'db-worker', {
        event: 'dbWorker.schemaDrift',
        dbPath,
        status: drift.status,
        entryCount: drift.entries.length,
      });
    }
  } catch (err) {
    try {
      nextDb.close();
    } catch (_) {}
    throw err;
  }
  postLog('info', 'db-worker', {
    event: 'dbWorker.init.ok',
    runtimeMode: 'inline',
    userId: opts && opts.userId,
    dbPath,
  });
  return nextDb;
}

function setDatabase(opts) {
  try {
    db = createDatabase(opts || {});
    initError = null;
  } catch (err) {
    initError = rpcError(err);
    db = null;
    postLog('error', 'db-worker', {
      event: 'dbWorker.init.failed',
      userId: opts && opts.userId,
      dbPath: opts && opts.dbPath,
      error: initError.message,
      code: initError.code,
    });
  }
}

function requireReadyDb() {
  if (db) return db;
  const err = new Error(initError ? initError.message : 'db worker is not initialized');
  err.code = initError ? initError.code : 'INIT_FAILED';
  throw err;
}

const LOCAL_DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = [1000, 5000, 30000, 5 * 60000, 30 * 60000];

function dispatchTx(readyDb, payload) {
  const request = asRecord(payload, 'tx args');
  const name = expectString(request.name, 'name');
  switch (name) {
    case 'codex.importMessages':
      return codexImportMessages(readyDb, request.args);
    case 'claude.importMessages':
      return claudeImportMessages(readyDb, request.args);
    case 'rewind.commit':
      return rewindCommit(readyDb, request.args);
    case 'fork.session':
      return forkSession(readyDb, request.args);
    case 'embedding.markDone':
      return embeddingMarkDone(readyDb, request.args);
    case 'embedding.commit':
      return embeddingCommit(readyDb, request.args);
    case 'embedding.recordFailures':
      return embeddingRecordFailures(readyDb, request.args);
    case 'embedding.enqueue':
      return embeddingEnqueue(readyDb, request.args);
    case 'orca.reserveWorkerCreation':
      return orcaReserveWorkerCreation(readyDb, request.args);
    case 'orca.renewWorkerCreationReservation':
      return orcaRenewWorkerCreationReservation(readyDb, request.args);
    case 'orca.releaseWorkerCreationReservation':
      return orcaReleaseWorkerCreationReservation(readyDb, request.args);
    case 'orca.upsertWorker':
      return orcaUpsertWorker(readyDb, request.args);
    case 'orca.setWorkerFocus':
      return orcaSetWorkerFocus(readyDb, request.args);
    case 'orca.removeWorker':
      return orcaRemoveWorker(readyDb, request.args);
    case 'orca.cancelStaleTeams':
      return orcaCancelStaleTeams(readyDb, request.args);
    case 'sessions.renameTitles':
      return sessionsRenameTitles(readyDb, request.args);
    case 'sessions.setStatus':
      return sessionsSetStatus(readyDb, request.args);
    case 'session.agentSwitchFallback':
      return sessionAgentSwitchFallback(readyDb, request.args);
    case 'message.delete':
      return messageDelete(readyDb, request.args);
    case 'im.deleteBindings':
      return imDeleteBindings(readyDb, request.args);
    case 'im.replaceBinding':
      return imReplaceBinding(readyDb, request.args);
    case 'session.importShare':
      return sessionImportShare(readyDb, request.args);
    default:
      throw Object.assign(new Error('unknown tx: ' + name), { code: 'UNKNOWN_TX' });
  }
}

// ⚠️ 与 worker/opHandlers/tx.ts 的 imDeleteBindings 保持一致。
function imDeleteBindings(readyDb, args) {
  const payload = asRecord(args, 'im.deleteBindings args');
  const identities = expectArray(payload.identities, 'identities').map((raw, index) => {
    const identity = asRecord(raw, 'identities.' + index);
    return {
      channel: expectString(identity.channel, 'identities.' + index + '.channel'),
      botContextId: expectString(identity.botContextId, 'identities.' + index + '.botContextId'),
      userId: expectString(identity.userId, 'identities.' + index + '.userId'),
      scopeKey: expectString(identity.scopeKey, 'identities.' + index + '.scopeKey'),
    };
  });
  const deleteBinding = readyDb.prepare(
    'DELETE FROM im_bindings WHERE channel = ? AND bot_context_id = ? AND user_id = ? AND scope_key = ?',
  );
  return readyDb.transaction(() => {
    for (const identity of identities) {
      deleteBinding.run(
        identity.channel,
        identity.botContextId,
        identity.userId,
        identity.scopeKey,
      );
    }
  })();
}

// ⚠️ 与 worker/opHandlers/tx.ts 的 imReplaceBinding 保持一致。
function imReplaceBinding(readyDb, args) {
  const payload = asRecord(args, 'im.replaceBinding args');
  const channel = expectString(payload.channel, 'channel');
  const botContextId = expectString(payload.botContextId, 'botContextId');
  const userId = expectString(payload.userId, 'userId');
  const scopeKey = expectString(payload.scopeKey, 'scopeKey');
  const targetSessionId = expectString(payload.targetSessionId, 'targetSessionId');
  const attachedAt = expectNumber(payload.attachedAt, 'attachedAt');
  const attachedViaCardMessageId = nullableString(payload.attachedViaCardMessageId);
  return readyDb.transaction(() => {
    readyDb.prepare(
      'DELETE FROM im_bindings WHERE target_session_id = ? OR (channel = ? AND bot_context_id = ? AND user_id = ? AND scope_key = ?)',
    ).run(targetSessionId, channel, botContextId, userId, scopeKey);
    readyDb.prepare(
      'INSERT INTO im_bindings (channel, bot_context_id, user_id, scope_key, target_session_id, attached_at, attached_via_card_message_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      channel,
      botContextId,
      userId,
      scopeKey,
      targetSessionId,
      attachedAt,
      attachedViaCardMessageId,
    );
  })();
}

// ⚠️ 与 worker/opHandlers/tx.ts 的同名事务保持一致。
function sessionAgentSwitchFallback(readyDb, args) {
  const payload = asRecord(args, 'session.agentSwitchFallback args');
  const sessionId = expectString(payload.sessionId, 'sessionId');
  const boundaryClientId = expectString(payload.boundaryClientId, 'boundaryClientId');
  const boundaryContent = expectString(payload.boundaryContent, 'boundaryContent');
  const updatedAt = expectNumber(payload.updatedAt, 'updatedAt');
  return readyDb.transaction(() => {
    const sessionResult = readyDb.prepare(
      'UPDATE sessions SET sdk_session_id = NULL, updated_at = ? WHERE id = ?',
    ).run(updatedAt, sessionId);
    if (sessionResult.changes !== 1) {
      throw Object.assign(new Error('Session 不存在: ' + sessionId), { code: 'NOT_FOUND' });
    }
    const boundaryResult = readyDb.prepare(
      "UPDATE messages SET content = ? WHERE session_id = ? AND client_id = ? AND role = 'agent_switch' AND rewind_at IS NULL",
    ).run(boundaryContent, sessionId, boundaryClientId);
    if (boundaryResult.changes !== 1) {
      throw Object.assign(new Error('Agent switch boundary 不存在: ' + boundaryClientId), {
        code: 'NOT_FOUND',
      });
    }
  })();
}

// ⚠️ 与 worker/opHandlers/tx.ts 的同名事务保持一致。
function messageDelete(readyDb, args) {
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

  return readyDb.transaction(() => {
    const selectTarget = readyDb.prepare(
      "SELECT id, client_id AS clientId FROM messages WHERE session_id = ? AND client_id = ? AND role IN ('user', 'assistant', 'tool_use', 'tool_result', 'ask_user', 'plan_review', 'thinking', 'error') AND rewind_at IS NULL LIMIT 1",
    );
    const targets = clientIds.map((clientId) => {
      const target = selectTarget.get(sessionId, clientId);
      if (!target) {
        throw Object.assign(new Error('Message 不存在或不可删除: ' + clientId), {
          code: 'NOT_FOUND',
        });
      }
      return target;
    });

    for (const target of targets) {
      // 向量只保存语义而非原文，但也属于该消息的本地派生数据；先按 job 记录
      // 清各 vec 表，再删 job。缺失的旧 vec 表按已经清理处理，不能反向阻断正文删除。
      const jobs = readyDb.prepare(
        "SELECT rowid, vec_table AS vecTable FROM embedding_jobs WHERE source = 'chat' AND source_id = ?",
      ).all(target.id);
      const deleteVecByTable = new Map();
      for (const job of jobs) {
        assertIdentifier(job.vecTable);
        if (!readyDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(job.vecTable)) {
          continue;
        }
        let stmt = deleteVecByTable.get(job.vecTable);
        if (!stmt) {
          stmt = readyDb.prepare('DELETE FROM "' + job.vecTable + '" WHERE rowid = ?');
          deleteVecByTable.set(job.vecTable, stmt);
        }
        stmt.run(job.rowid);
      }
      readyDb.prepare("DELETE FROM embedding_jobs WHERE source = 'chat' AND source_id = ?").run(target.id);
    }

    readyDb.prepare("DELETE FROM messages WHERE role = 'context_rebuild' AND session_id = ?").run(sessionId);
    // 保留不含正文/元数据的最小 tombstone，阻止外部 Claude/Codex transcript
    // importer 下次 messages:list 时把同一 clientId 重新导入；本地有效记录中
    // 消息内容已物理清空，普通历史读取因 rewind_at 非空完全不可见。
    const scrubTarget = readyDb.prepare(
      "UPDATE messages SET role = 'message_tombstone', content = 'null', tool_use_id = NULL, agent_meta = NULL, agent_kind = NULL, rewind_at = ? WHERE id = ? AND session_id = ? AND client_id = ? AND role IN ('user', 'assistant', 'tool_use', 'tool_result', 'ask_user', 'plan_review', 'thinking', 'error') AND rewind_at IS NULL",
    );
    for (const target of targets) {
      const scrubbed = scrubTarget.run(updatedAt, target.id, sessionId, target.clientId);
      if (scrubbed.changes !== 1) {
        throw Object.assign(new Error('Message 删除竞态: ' + target.clientId), {
          code: 'PRECONDITION_FAILED',
        });
      }
    }
    const sessionResult = readyDb.prepare(
      'UPDATE sessions SET sdk_session_id = NULL, updated_at = ? WHERE id = ?',
    ).run(updatedAt, sessionId);
    if (sessionResult.changes !== 1) {
      throw Object.assign(new Error('Session 不存在: ' + sessionId), { code: 'NOT_FOUND' });
    }
    readyDb.prepare(
      "INSERT INTO messages (id, client_id, session_id, role, content, created_at, rewind_at) VALUES (?, ?, ?, 'context_rebuild', ?, ?, ?)",
    ).run(markerId, markerClientId, sessionId, markerContent, markerCreatedAt, markerCreatedAt);
    return {
      messages: targets.map((target) => ({
        messageId: target.id,
        clientId: target.clientId,
      })),
    };
  })();
}

function sessionsRenameTitles(readyDb, args) {
  const payload = asRecord(args, 'sessions.renameTitles args');
  const changes = expectArray(payload.changes, 'changes');
  const selectSession = readyDb.prepare(
    'SELECT id, title, working_dir AS workingDir, updated_at AS updatedAt FROM sessions WHERE id = ? LIMIT 1',
  );
  const updateSession = readyDb.prepare(
    'UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND (? IS NULL OR title = ?) AND (? IS NULL OR updated_at = ?) RETURNING id, title, working_dir AS workingDir, updated_at AS updatedAt',
  );
  return readyDb.transaction(() => {
    const applied = [];
    for (const rawChange of changes) {
      const change = asRecord(rawChange, 'rename title change');
      const sessionId = expectString(change.sessionId, 'change.sessionId');
      const title = expectString(change.title, 'change.title');
      const existing = selectSession.get(sessionId);
      if (!existing) throw Object.assign(new Error('Session 不存在: ' + sessionId), { code: 'NOT_FOUND' });
      const expectedCurrentTitle = typeof change.expectedCurrentTitle === 'string'
        ? change.expectedCurrentTitle
        : null;
      const expectedUpdatedAt = typeof change.expectedUpdatedAt === 'string'
        ? change.expectedUpdatedAt
        : null;
      const expectedUpdatedAtMs = expectedUpdatedAt === null ? null : Date.parse(expectedUpdatedAt);
      if (expectedUpdatedAt !== null && !Number.isFinite(expectedUpdatedAtMs)) {
        throw Object.assign(new Error('Session expected_updated_at 非法: ' + sessionId), {
          code: 'PRECONDITION_FAILED',
        });
      }
      const updated = updateSession.get(
        title,
        Date.now(),
        sessionId,
        expectedCurrentTitle,
        expectedCurrentTitle,
        expectedUpdatedAtMs,
        expectedUpdatedAtMs,
      );
      if (!updated) {
        throw Object.assign(new Error('Session 标题或 updatedAt 已变化: ' + sessionId), {
          code: 'PRECONDITION_FAILED',
        });
      }
      applied.push({
        sessionId: updated.id,
        currentTitle: existing.title,
        newTitle: updated.title || title,
        workingDir: updated.workingDir,
        updatedAt: new Date(updated.updatedAt).toISOString(),
      });
    }
    return applied;
  })();
}

// ⚠️ 与 worker/opHandlers/tx.ts 的 sessionsSetStatus 必须逐字保持一致。
function sessionsSetStatus(readyDb, args) {
  const payload = asRecord(args, 'sessions.setStatus args');
  const sessionIds = expectArray(payload.sessionIds, 'sessionIds').map((id) =>
    expectString(id, 'sessionId'),
  );
  const status = expectString(payload.status, 'status');
  if (status !== 'active' && status !== 'archived') {
    throw Object.assign(new Error('invalid status: ' + status), { code: 'INVALID_ARGS' });
  }
  const selectSession = readyDb.prepare(
    'SELECT id, title, working_dir AS workingDir, workspace_kind AS workspaceKind FROM sessions WHERE id = ? LIMIT 1',
  );
  const updateSession = readyDb.prepare(
    'UPDATE sessions SET status = ?, updated_at = ? WHERE id = ? RETURNING id, title, working_dir AS workingDir, workspace_kind AS workspaceKind',
  );
  return readyDb.transaction(() => {
    const applied = [];
    const now = Date.now();
    for (const sessionId of sessionIds) {
      const existing = selectSession.get(sessionId);
      if (!existing) throw Object.assign(new Error('Session 不存在: ' + sessionId), { code: 'NOT_FOUND' });
      const updated = updateSession.get(status, now, sessionId);
      if (!updated) throw Object.assign(new Error('Session 不存在: ' + sessionId), { code: 'NOT_FOUND' });
      applied.push({
        sessionId: updated.id,
        title: updated.title,
        workingDir: updated.workingDir,
        workspaceKind: updated.workspaceKind,
        status,
      });
    }
    return applied;
  })();
}

// 会话分享(.xdtshare)导入落库: 与 worker/opHandlers/tx.ts 的同名 handler 保持一致。
// 单事务插 session 行 + 全量 messages, 任一行非法整体回滚零写入;
// session 已存在按 ALREADY_EXISTS 抛(并发双导入兜底)。
function sessionImportShare(readyDb, args) {
  const payload = asRecord(args, 'session.importShare args');
  const session = asRecord(payload.session, 'session');
  const messages = expectArray(payload.messages, 'messages');
  const sessionId = expectString(session.id, 'session.id');
  const insertMessage = readyDb.prepare(
    'INSERT INTO messages (id, client_id, session_id, role, content, tool_use_id, agent_meta, agent_kind, created_at, rewind_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
  );
  const messageCount = readyDb.transaction(() => {
    const existing = readyDb.prepare('SELECT id FROM sessions WHERE id = ? LIMIT 1').get(sessionId);
    if (existing) {
      throw Object.assign(new Error('session already exists: ' + sessionId), { code: 'ALREADY_EXISTS' });
    }
    readyDb.prepare(
      'INSERT INTO sessions (id, title, working_dir, workspace_kind, worktree_path, model, effort, permission_mode, provider_id, status, sdk_session_id, total_token_usage, total_cost_usd, context_tokens, context_window, fast_mode, plan_mode_enabled, agent_kind, source, extra_dirs, codex_history_has_product_prompt, cleared_at, user_send_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
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
      session.codexHistoryHasProductPrompt == null ? null : (session.codexHistoryHasProductPrompt ? 1 : 0),
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
  })();
  return { messageCount };
}

// ⚠️ F-COLLAB orca 事务: 与 worker/opHandlers/tx.ts 的同名 handler 必须逐字保持一致。
// focused 列是 integer(0/1); better-sqlite3 不接受 boolean 绑定, 一律转 0/1。
// 可选字段 === undefined 表示 "保留 existing 当前值", 与原 drizzle 写法语义一致。
function orcaSetWorkerFocus(readyDb, args) {
  const payload = asRecord(args, 'orca.setWorkerFocus args');
  const teamId = expectString(payload.teamId, 'teamId');
  const workerId = expectString(payload.workerId, 'workerId');
  const now = expectNumber(payload.now, 'now');
  const clearOthers = readyDb.prepare('UPDATE orca_workers SET focused = 0, updated_at = ? WHERE team_id = ? AND focused = 1');
  const setOne = readyDb.prepare('UPDATE orca_workers SET focused = 1, updated_at = ? WHERE id = ?');
  readyDb.transaction(() => {
    clearOthers.run(now, teamId);
    setOne.run(now, workerId);
  })();
}

function orcaRemoveWorker(readyDb, args) {
  const payload = asRecord(args, 'orca.removeWorker args');
  const workerId = expectString(payload.workerId, 'workerId');
  const now = expectNumber(payload.now, 'now');
  const selectWorker = readyDb.prepare('SELECT session_id AS sessionId FROM orca_workers WHERE id = ? LIMIT 1');
  const deleteWorker = readyDb.prepare('DELETE FROM orca_workers WHERE id = ?');
  const archiveSession = readyDb.prepare("UPDATE sessions SET status = 'archived', orca_role = NULL, updated_at = ? WHERE id = ?");
  return readyDb.transaction(() => {
    const row = selectWorker.get(workerId);
    if (!row) return null;
    deleteWorker.run(workerId);
    archiveSession.run(now, row.sessionId);
    return row.sessionId;
  })();
}

function orcaCancelStaleTeams(readyDb, args) {
  const payload = asRecord(args, 'orca.cancelStaleTeams args');
  const leadSessionId = expectString(payload.leadSessionId, 'leadSessionId');
  const keepTeamId = expectString(payload.keepTeamId, 'keepTeamId');
  const now = expectNumber(payload.now, 'now');
  const cancel = readyDb.prepare("UPDATE orca_teams SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE lead_session_id = ? AND status = 'active' AND id != ?");
  readyDb.transaction(() => {
    cancel.run(now, now, leadSessionId, keepTeamId);
  })();
}

function orcaUpsertWorker(readyDb, args) {
  const payload = asRecord(args, 'orca.upsertWorker args');
  const id = expectString(payload.id, 'id');
  const teamId = expectString(payload.teamId, 'teamId');
  const sessionId = expectString(payload.sessionId, 'sessionId');
  const now = expectNumber(payload.now, 'now');
  readyDb.transaction(() => {
    if (payload.focused === true) {
      readyDb.prepare('UPDATE orca_workers SET focused = 0, updated_at = ? WHERE team_id = ? AND focused = 1').run(now, teamId);
    }
    const existing = readyDb.prepare('SELECT * FROM orca_workers WHERE id = ? LIMIT 1').get(id);
    if (existing) {
      readyDb.prepare('UPDATE orca_workers SET team_id = ?, session_id = ?, status = ?, label = ?, worktree_branch = ?, role = ?, focused = ?, idle_since = ?, updated_at = ? WHERE id = ?').run(
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
    const bySession = readyDb.prepare('SELECT * FROM orca_workers WHERE session_id = ? LIMIT 1').get(sessionId);
    if (bySession) {
      readyDb.prepare('UPDATE orca_workers SET team_id = ?, status = ?, label = ?, worktree_branch = ?, role = ?, focused = ?, idle_since = ?, updated_at = ? WHERE session_id = ?').run(
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
    readyDb.prepare('INSERT INTO orca_workers (id, team_id, session_id, status, label, worktree_branch, role, focused, idle_since, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
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

function orcaReserveWorkerCreation(readyDb, args) {
  const payload = asRecord(args, 'orca.reserveWorkerCreation args');
  const reservationId = expectString(payload.reservationId, 'reservationId');
  const teamId = expectString(payload.teamId, 'teamId');
  const label = expectString(payload.label, 'label').toLowerCase();
  const hardLimit = expectNumber(payload.hardLimit, 'hardLimit');
  const now = expectNumber(payload.now, 'now');
  const expiresAt = expectNumber(payload.expiresAt, 'expiresAt');
  return readyDb.transaction(() => {
    readyDb.prepare('DELETE FROM orca_worker_creation_reservations WHERE expires_at <= ?').run(now);
    const duplicateWorker = readyDb.prepare(
      'SELECT 1 FROM orca_workers WHERE team_id = ? AND label = ? COLLATE NOCASE LIMIT 1',
    ).get(teamId, label);
    const duplicateReservation = readyDb.prepare(
      'SELECT 1 FROM orca_worker_creation_reservations WHERE team_id = ? AND label = ? COLLATE NOCASE LIMIT 1',
    ).get(teamId, label);
    if (duplicateWorker) return { ok: false, errorCode: 'DUPLICATE_LABEL' };
    if (duplicateReservation) return { ok: false, errorCode: 'WORKER_CREATION_IN_PROGRESS' };
    // Worker 进入终态仍占槽，只有关联 session 归档后才释放。
    const occupiedWorkerCount = Number(readyDb.prepare(\`SELECT COUNT(*)
      FROM orca_workers w INNER JOIN sessions s ON s.id = w.session_id
      WHERE w.team_id = ? AND s.status = 'active'\`).pluck().get(teamId) || 0);
    const reservationCount = Number(readyDb.prepare(
      'SELECT COUNT(*) FROM orca_worker_creation_reservations WHERE team_id = ?',
    ).pluck().get(teamId) || 0);
    const occupiedSlotsBefore = occupiedWorkerCount + reservationCount;
    if (occupiedSlotsBefore >= hardLimit) return { ok: false, errorCode: 'WORKER_LIMIT_HARD_EXCEEDED' };
    readyDb.prepare(\`INSERT INTO orca_worker_creation_reservations
      (id, team_id, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?)\`)
      .run(reservationId, teamId, label, now, expiresAt);
    return { ok: true, occupiedSlotsBefore };
  })();
}

function orcaRenewWorkerCreationReservation(readyDb, args) {
  const payload = asRecord(args, 'orca.renewWorkerCreationReservation args');
  const result = readyDb.prepare(
    'UPDATE orca_worker_creation_reservations SET expires_at = ? WHERE id = ? AND expires_at > ?',
  ).run(
    expectNumber(payload.expiresAt, 'expiresAt'),
    expectString(payload.reservationId, 'reservationId'),
    expectNumber(payload.now, 'now'),
  );
  return result.changes === 1;
}

function orcaReleaseWorkerCreationReservation(readyDb, args) {
  const payload = asRecord(args, 'orca.releaseWorkerCreationReservation args');
  readyDb.prepare('DELETE FROM orca_worker_creation_reservations WHERE id = ?').run(
    expectString(payload.reservationId, 'reservationId'),
  );
}

function codexImportMessages(readyDb, args) {
  const payload = asRecord(args, 'codex.importMessages args');
  const sessionId = expectString(payload.sessionId, 'sessionId');
  const importClientIdPrefix = expectString(payload.importClientIdPrefix, 'importClientIdPrefix');
  const sdkSessionId = expectString(payload.sdkSessionId, 'sdkSessionId');
  const model = expectString(payload.model, 'model');
  const rows = expectArray(payload.rows, 'rows');
  const existing = readExistingMessageFingerprints(readyDb, sessionId, importClientIdPrefix);
  const existingImportedClientIds = readExistingImportedClientIds(readyDb, sessionId, importClientIdPrefix);
  const upsert = readyDb.prepare(\`
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
  \`);
  const changed = readyDb.transaction(() => {
    let count = 0;
    for (const rawRow of rows) {
      const row = asRecord(rawRow, 'codex row');
      const lineNo = expectNumber(row.lineNo, 'row.lineNo');
      const role = expectString(row.role, 'row.role');
      const text = expectString(row.text, 'row.text');
      const createdAt = expectNumber(row.createdAt, 'row.createdAt');
      const clientId = importClientIdPrefix + lineNo;
      if (!existingImportedClientIds.has(clientId) && isLikelyLocalDuplicate(existing, { role, text, createdAt })) continue;
      count += upsert.run({
        id: 'codex-import-' + sdkSessionId + '-' + lineNo,
        clientId,
        sessionId,
        role,
        content: stringifyContent(row.content),
        agentMeta: JSON.stringify({ sdkSessionId, model }),
        createdAt,
      }).changes;
    }
    return count;
  })();
  return { changed };
}

function claudeImportMessages(readyDb, args) {
  const payload = asRecord(args, 'claude.importMessages args');
  const sessionId = expectString(payload.sessionId, 'sessionId');
  const importClientIdPrefix = expectString(payload.importClientIdPrefix, 'importClientIdPrefix');
  const sdkSessionId = expectString(payload.sdkSessionId, 'sdkSessionId');
  const rows = expectArray(payload.rows, 'rows');
  const upsert = readyDb.prepare(\`
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
  \`);
  const changed = readyDb.transaction(() => {
    let count = 0;
    for (const rawRow of rows) {
      const row = asRecord(rawRow, 'claude row');
      const key = expectNumber(row.lineNo, 'row.lineNo') + '-' + expectNumber(row.partIndex, 'row.partIndex');
      count += upsert.run({
        id: 'claude-import-' + sdkSessionId + '-' + key,
        clientId: importClientIdPrefix + key,
        sessionId,
        role: expectString(row.role, 'row.role'),
        content: stringifyContent(row.content),
        toolUseId: nullableString(row.toolUseId),
        agentMeta: row.agentMeta ? stringifyContent(row.agentMeta) : null,
        createdAt: expectNumber(row.createdAt, 'row.createdAt'),
      }).changes;
    }
    return count;
  })();
  return { changed };
}

function rewindCommit(readyDb, args) {
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
  const rows = readyDb.prepare(
    'SELECT id, client_id, role, created_at, agent_meta FROM messages WHERE session_id = ? AND rewind_at IS NULL',
  ).all(sessionId);
  // edit-last-message 原子守卫(与 worker/opHandlers/tx.ts 镜像同步):软删同一
  // 临界区内断言 target 之后没有更新的可见 user 消息,命中 → 抛错,软删不发生。
  if (requireLatestUser) {
    for (const row of rows) {
      if (row.role !== 'user') continue;
      const rowCreatedAt = Number(row.created_at);
      const isNewer =
        rowCreatedAt > targetCreatedAt ||
        (rowCreatedAt === targetCreatedAt && targetMessageId !== null && row.id > targetMessageId);
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
  const updateMessage = readyDb.prepare('UPDATE messages SET rewind_at = ? WHERE id = ?');
  readyDb.transaction(() => {
    for (const id of idsToRewind) updateMessage.run(now, id);
    if (sdkSessionId) {
      readyDb.prepare('UPDATE sessions SET user_send_at = ?, updated_at = ?, context_tokens = 0, context_window = 0, sdk_session_id = ? WHERE id = ?').run(now, now, sdkSessionId, sessionId);
    } else {
      readyDb.prepare('UPDATE sessions SET user_send_at = ?, updated_at = ?, context_tokens = 0, context_window = 0 WHERE id = ?').run(now, now, sessionId);
    }
  })();
}

function selectRewindMessageIds(rows, opts) {
  // Keep this mirror in sync with worker/opHandlers/tx.ts.
  const targetCreatedAt = opts.targetCreatedAt;
  const targetMessageId = opts.targetMessageId;
  const targetClientId = opts.targetClientId;
  const targetMessageUuid = opts.targetMessageUuid;
  const preserveMessageUuid = opts.preserveMessageUuid;
  const hasTranscriptBranch = Boolean(targetMessageUuid);
  const branchUuids = new Set();
  if (targetMessageUuid) branchUuids.add(targetMessageUuid);
  const selected = new Set();

  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (selected.has(row.id)) continue;
      const meta = parseAgentMeta(row.agent_meta);
      if (preserveMessageUuid && meta.uuid === preserveMessageUuid) continue;
      const isTarget = (targetClientId && row.client_id === targetClientId) ||
        (targetMessageUuid && meta.uuid === targetMessageUuid);
      const isBranchDescendant = Boolean(meta.transcriptParentUuid && branchUuids.has(meta.transcriptParentUuid));
      const rowCreatedAt = Number(row.created_at);
      const isSameTimestampTail = rowCreatedAt === targetCreatedAt &&
        (targetMessageId === null || String(row.id) >= targetMessageId);
      const isLegacyTail = (rowCreatedAt > targetCreatedAt || isSameTimestampTail) &&
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

function parseAgentMeta(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
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

function forkSession(readyDb, args) {
  const payload = asRecord(args, 'fork.session args');
  const sourceSessionId = expectString(payload.sourceSessionId, 'sourceSessionId');
  const sourceClearedAt = nullableNumber(payload.sourceClearedAt);
  const targetCreatedAt = expectNumber(payload.targetCreatedAt, 'targetCreatedAt');
  const targetRowid = nullableNumber(payload.targetRowid);
  const newSession = asRecord(payload.newSession, 'newSession');
  const uuidMap = normalizeUuidMap(payload.uuidMap);
  const legacyTranscriptParentUuids = normalizeStringSet(payload.legacyTranscriptParentUuids, 'legacyTranscriptParentUuids');
  const toolParentUuids = normalizeStringSet(payload.toolParentUuids, 'toolParentUuids');
  const detachAgentSwitchSessions = payload.detachAgentSwitchSessions === true;
  const resetHandoffBoundaryClientId = nullableString(payload.resetHandoffBoundaryClientId);
  const newMessageIds = normalizeNewMessageIds(payload.newMessageIds);
  const sourceMessages = readyDb.prepare(
    'SELECT client_id, role, content, tool_use_id, agent_meta, agent_kind, created_at FROM messages WHERE session_id = ? AND (? IS NULL OR created_at > ?) AND (created_at < ? OR (? IS NOT NULL AND created_at = ? AND rowid < ?)) AND rewind_at IS NULL ORDER BY created_at ASC, rowid ASC',
  ).all(sourceSessionId, sourceClearedAt, sourceClearedAt, targetCreatedAt, targetRowid, targetCreatedAt, targetRowid);
  if (newMessageIds.length !== sourceMessages.length) {
    throw invalidArgs('newMessageIds length mismatch: expected ' + sourceMessages.length + ', got ' + newMessageIds.length);
  }
  const insertMessage = readyDb.prepare(
    'INSERT INTO messages (id, client_id, session_id, role, content, tool_use_id, agent_meta, agent_kind, created_at, rewind_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
  );
  readyDb.transaction(() => {
    readyDb.prepare(
      'INSERT INTO sessions (id, title, working_dir, model, provider_id, effort, permission_mode, status, sdk_session_id, total_token_usage, total_cost_usd, context_tokens, context_window, fast_mode, cleared_at, pinned_at, user_send_at, agent_kind, workspace_kind, codex_history_has_product_prompt, parent_session_id, forked_at_message_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      expectString(newSession.id, 'newSession.id'),
      expectString(newSession.title, 'newSession.title'),
      normalizeWorkingDirForStorage(newSession.workingDir),
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
      newSession.codexHistoryHasProductPrompt == null ? null : (newSession.codexHistoryHasProductPrompt ? 1 : 0),
      nullableString(newSession.parentSessionId),
      nullableString(newSession.forkedAtMessageId),
      expectNumber(newSession.createdAt, 'newSession.createdAt'),
      expectNumber(newSession.updatedAt, 'newSession.updatedAt'),
    );
    for (let i = 0; i < sourceMessages.length; i += 1) {
      const message = sourceMessages[i];
      const ids = newMessageIds[i];
      insertMessage.run(ids.id, ids.clientId, expectString(newSession.id, 'newSession.id'), message.role, sanitizeForkedMessageContent(message, { detachAgentSwitchSessions, resetHandoffBoundaryClientId }), message.tool_use_id, remapAgentMetaUuid(message.agent_meta, uuidMap, legacyTranscriptParentUuids, toolParentUuids), message.agent_kind, message.created_at);
    }
  })();
  return { messageCount: sourceMessages.length };
}

function sanitizeForkedMessageContent(message, opts) {
  const resetConsumed = message.client_id === opts.resetHandoffBoundaryClientId;
  if (message.role !== 'agent_switch' || (!opts.detachAgentSwitchSessions && !resetConsumed)) return message.content;
  try {
    const parsed = JSON.parse(message.content);
    if (!isRecord(parsed)) return message.content;
    return JSON.stringify({
      ...parsed,
      ...(opts.detachAgentSwitchSessions ? { fromSdkSessionId: null } : {}),
      ...(resetConsumed ? { consumed: false } : {}),
    });
  } catch (_) {
    return message.content;
  }
}

function embeddingMarkDone(readyDb, args) {
  const payload = asRecord(args, 'embedding.markDone args');
  const stmt = readyDb.prepare("UPDATE embedding_jobs SET status = 'done', last_error = NULL WHERE rowid = ?");
  readyDb.transaction(() => {
    for (const rowid of expectArray(payload.rowids, 'rowids')) stmt.run(expectNumber(rowid, 'rowid'));
  })();
}

function embeddingCommit(readyDb, args) {
  const payload = asRecord(args, 'embedding.commit args');
  // DELETE + plain INSERT — 详见 worker/opHandlers/tx.ts:embeddingCommit 同位置注释。
  // 历史 INSERT OR REPLACE 在 sqlite-vec vec0 虚表上不生效(虚表 xUpdate 不支持
  // OR REPLACE conflict resolution),改成同事务内 DELETE+INSERT。两份实现必须保持
  // inline 回滚口、file worker tx handler、inproc 回滚口三处都要保持同一语义。
  // typecheck 抓不到跨运行时 drift。
  const deleteCache = new Map();
  const insertCache = new Map();
  const getDeleteStmt = (vecTable) => {
    let stmt = deleteCache.get(vecTable);
    if (!stmt) {
      assertIdentifier(vecTable);
      stmt = readyDb.prepare('DELETE FROM "' + vecTable + '" WHERE rowid = ?');
      deleteCache.set(vecTable, stmt);
    }
    return stmt;
  };
  const getInsertStmt = (vecTable) => {
    let stmt = insertCache.get(vecTable);
    if (!stmt) {
      assertIdentifier(vecTable);
      stmt = readyDb.prepare('INSERT INTO "' + vecTable + '" (rowid, embedding) VALUES (?, ?)');
      insertCache.set(vecTable, stmt);
    }
    return stmt;
  };
  const updateStmt = readyDb.prepare("UPDATE embedding_jobs SET status = 'done', last_error = NULL WHERE rowid = ?");
  readyDb.transaction(() => {
    for (const rawItem of expectArray(payload.items, 'items')) {
      const item = asRecord(rawItem, 'embedding item');
      const rowid = expectNumber(item.rowid, 'item.rowid');
      if (!(item.embedding instanceof Float32Array)) throw invalidArgs('item.embedding must be Float32Array');
      const vecTable = expectString(item.vecTable, 'item.vecTable');
      const rowidBig = BigInt(rowid);
      // 与 file worker 同语义：job 可能被消息删除事务并发清掉；不存在时只清
      // 孤立 vec，不允许飞行中的 embedding 结果把已删除消息的派生数据写回来。
      const updated = updateStmt.run(rowid);
      getDeleteStmt(vecTable).run(rowidBig);
      if (updated.changes !== 1) continue;
      getInsertStmt(vecTable).run(rowidBig, item.embedding);
    }
  })();
}

function embeddingRecordFailures(readyDb, args) {
  const payload = asRecord(args, 'embedding.recordFailures args');
  const jobs = expectArray(payload.jobs, 'jobs');
  const errMsg = truncate(expectString(payload.errMsg, 'errMsg'), 2000);
  const now = expectNumber(payload.now, 'now');
  const updReschedule = readyDb.prepare('UPDATE embedding_jobs SET attempts = ?, last_error = ?, scheduled_at = ? WHERE rowid = ?');
  const updFail = readyDb.prepare("UPDATE embedding_jobs SET attempts = ?, last_error = ?, status = 'failed' WHERE rowid = ?");
  const failCount = readyDb.transaction(() => {
    let count = 0;
    for (const rawJob of jobs) {
      const job = asRecord(rawJob, 'failure job');
      const rowid = expectNumber(job.rowid, 'job.rowid');
      const nextAttempts = expectNumber(job.attempts, 'job.attempts') + 1;
      if (nextAttempts >= MAX_ATTEMPTS) {
        updFail.run(nextAttempts, errMsg, rowid);
        count++;
      } else {
        const backoff = RETRY_BACKOFF_MS[Math.min(nextAttempts - 1, RETRY_BACKOFF_MS.length - 1)];
        updReschedule.run(nextAttempts, errMsg, now + backoff, rowid);
      }
    }
    return count;
  })();
  return { failCount };
}

function embeddingEnqueue(readyDb, args) {
  const payload = asRecord(args, 'embedding.enqueue args');
  const source = expectString(payload.source, 'source');
  const now = expectNumber(payload.now, 'now');
  const items = expectArray(payload.items, 'items');
  const stmt = readyDb.prepare("INSERT OR IGNORE INTO embedding_jobs (source, source_id, chunk_index, model_id, vec_table, status, attempts, scheduled_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)");
  const inserted = readyDb.transaction(() => {
    let count = 0;
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
      if (result.changes > 0) count++;
    }
    return count;
  })();
  return { inserted, skipped: items.length - inserted };
}

function readExistingImportedClientIds(readyDb, sessionId, importClientIdPrefix) {
  const rows = readyDb.prepare('SELECT client_id AS clientId FROM messages WHERE session_id = ? AND client_id LIKE ?').all(sessionId, importClientIdPrefix + '%');
  return new Set(rows.map((row) => row.clientId));
}

function readExistingMessageFingerprints(readyDb, sessionId, importClientIdPrefix) {
  const rows = readyDb.prepare("SELECT role, content, created_at AS createdAt FROM messages WHERE session_id = ? AND role IN ('user', 'assistant') AND client_id NOT LIKE ?").all(sessionId, importClientIdPrefix + '%');
  const out = [];
  for (const row of rows) {
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    const text = normalizeStoredMessageText(row.content);
    if (text) out.push(messageFingerprint(row.role, text, row.createdAt));
  }
  return out;
}

function isLikelyLocalDuplicate(existing, row) {
  const next = messageFingerprint(row.role, row.text, row.createdAt);
  return existing.some((prev) => prev.role === next.role && prev.text === next.text && Math.abs(prev.createdAt - next.createdAt) <= LOCAL_DUPLICATE_WINDOW_MS);
}

function messageFingerprint(role, text, createdAt) {
  return { role, text: normalizeFingerprintText(text), createdAt };
}

function normalizeStoredMessageText(raw) {
  let value = raw;
  try { value = JSON.parse(raw); } catch (_) {}
  return extractContentText(value);
}

function normalizeFingerprintText(text) {
  return text.replace(/\\r\\n/g, '\\n').trim();
}

function extractContentText(content) {
  if (typeof content === 'string') return content;
  if (isRecord(content) && typeof content.text === 'string') return content.text;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = typeof block.type === 'string' ? block.type : '';
    if ((type === 'input_text' || type === 'output_text' || type === 'text') && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\\n\\n');
}

function remapAgentMetaUuid(raw, map, legacyTranscriptParentUuids = new Set(), toolParentUuids = new Set()) {
  if (!raw || raw === 'null') return raw;
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { return raw; }
  const next = { ...parsed };
  if (typeof next.uuid === 'string' && legacyTranscriptParentUuids.has(next.uuid) && typeof next.parentUuid === 'string' && !next.transcriptParentUuid) {
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

function normalizeStringSet(value, label) {
  if (value === undefined) return new Set();
  return new Set(expectArray(value, label).map((item, index) => expectString(item, label + '.' + index)));
}

function normalizeUuidMap(value) {
  if (Array.isArray(value)) {
    return new Map(value.map((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2) throw invalidArgs('uuidMap entries must be pairs');
      return [expectString(entry[0], 'uuidMap.key'), expectString(entry[1], 'uuidMap.value')];
    }));
  }
  const record = asRecord(value, 'uuidMap');
  return new Map(Object.entries(record).map(([key, mapped]) => [key, expectString(mapped, 'uuidMap.' + key)]));
}

function normalizeNewMessageIds(value) {
  return expectArray(value, 'newMessageIds').map((rawItem, index) => {
    const item = asRecord(rawItem, 'newMessageIds.' + index);
    return {
      id: expectString(item.id, 'newMessageIds.' + index + '.id'),
      clientId: expectString(item.clientId, 'newMessageIds.' + index + '.clientId'),
    };
  });
}

function assertIdentifier(value) {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw invalidArgs('invalid vec_table identifier: ' + value);
}

function truncate(value, max) {
  return value.length <= max ? value : value.slice(0, max) + '...';
}

function stringifyContent(value) {
  const json = JSON.stringify(value);
  return json === undefined ? 'null' : json;
}

function asRecord(value, label) {
  if (!isRecord(value)) throw invalidArgs(label + ' must be an object');
  return value;
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function expectString(value, label) {
  if (typeof value !== 'string') throw invalidArgs(label + ' must be a string');
  return value;
}

function nullableString(value) {
  if (value == null) return null;
  if (typeof value !== 'string') throw invalidArgs('value must be string or null');
  return value;
}

function normalizeWorkingDirForStorage(value) {
  const input = nullableString(value);
  if (input == null) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;

  const bs = String.fromCharCode(92);
  const longUncPrefix = bs + bs + '?' + bs + 'UNC' + bs;
  const longPathPrefix = bs + bs + '?' + bs;
  let out = trimmed;
  if (out.startsWith(longUncPrefix)) {
    out = bs + bs + out.slice(longUncPrefix.length);
  } else if (out.startsWith(longPathPrefix)) {
    out = out.slice(longPathPrefix.length);
  }

  if (isWindowsPathLike(trimmed, bs) || isWindowsPathLike(out, bs)) {
    out = out.split(bs).join('/');
  }
  while (out.length > 1 && out.endsWith('/')) {
    if (isWindowsDriveRoot(out)) break;
    out = out.slice(0, -1);
  }
  return out;
}

function isWindowsPathLike(value, bs) {
  return isWindowsDrivePath(value, bs) || value.startsWith(bs + bs) || value.startsWith('//');
}

function isWindowsDrivePath(value, bs) {
  if (value.length < 3) return false;
  const ch = value[0];
  return ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) &&
    value[1] === ':' &&
    (value[2] === bs || value[2] === '/');
}

function isWindowsDriveRoot(value) {
  if (value.length !== 3) return false;
  const ch = value[0];
  return ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) &&
    value[1] === ':' &&
    value[2] === '/';
}

function expectNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidArgs(label + ' must be a finite number');
  return value;
}

function nullableNumber(value) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidArgs('value must be finite number or null');
  return value;
}

function expectArray(value, label) {
  if (!Array.isArray(value)) throw invalidArgs(label + ' must be an array');
  return value;
}

function invalidArgs(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGS' });
}

async function dispatch(op, args) {
  const readyDb = requireReadyDb();
  switch (op) {
    case 'query': {
      const { sql, params } = args || {};
      return readyDb.prepare(sql).all(...normalizeParams(params));
    }
    case 'queryOne': {
      const { sql, params } = args || {};
      return readyDb.prepare(sql).get(...normalizeParams(params));
    }
    case 'exec':
    case 'run': {
      const { sql, params } = args || {};
      const info = readyDb.prepare(sql).run(...normalizeParams(params));
      return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
    }
    case 'rawAll': {
      const { sql, params } = args || {};
      return readyDb.prepare(sql).raw().all(...normalizeParams(params));
    }
    case 'rawGet': {
      const { sql, params } = args || {};
      return readyDb.prepare(sql).raw().get(...normalizeParams(params));
    }
    case 'tx':
      return dispatchTx(readyDb, args);
    case 'closeDb': {
      if (db) db.close();
      db = null;
      return undefined;
    }
    case 'echoTransfer': {
      const { buffer } = args || {};
      return { byteLength: buffer && typeof buffer.byteLength === 'number' ? buffer.byteLength : 0 };
    }
    case 'sleep': {
      const { ms } = args || {};
      await new Promise((resolve) => setTimeout(resolve, Number(ms) || 0));
      return { slept: Number(ms) || 0 };
    }
    default:
      throw Object.assign(new Error('unknown op: ' + op), { code: 'UNKNOWN_OP' });
  }
}

setDatabase(workerData || {});

parentPort.on('message', async (req) => {
  try {
    const result = await dispatch(req.op, req.args);
    parentPort.postMessage({ id: req.id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ id: req.id, ok: false, error: rpcError(err) });
  }
});
`;

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  /** 当前预算窗口的起点(挂钟)。跨睡眠重武装时会重置,见 evaluateRpcTimeout。 */
  sentAtMs: number;
}

interface QueuedRpc {
  req: RpcRequest;
  transferList: unknown[];
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  /** RPC 总预算从进入 transport 开始计,而不是等 dispatch 后才开始。 */
  budgetStartedAtMs: number;
  queueTimeout?: ReturnType<typeof setTimeout>;
}

/**
 * 睡眠判定余量:超时定时器实际触发时刻比预算晚出这么多,只可能是进程被整体
 * 挂起过(系统睡眠 / dark wake 间隙),不是事件循环正常的毫秒级调度延迟。
 */
const SLEEP_DETECTION_SLACK_MS = 5_000;

/** RPC 超时评估结果:reject = 真超时;rearm = 定时器横跨系统睡眠,应重置预算续等。 */
export type RpcTimeoutVerdict =
  | { kind: 'reject'; wallElapsedMs: number }
  | { kind: 'rearm'; wallElapsedMs: number };

/**
 * 判定一次 RPC 超时是真超时还是「跨睡眠假超时」。
 *
 * 背景(2026-07-15 实锤):睡前发出的 RPC,其 30s setTimeout 会在系统睡眠期间
 * 继续计时(Apple Silicon 连续时钟)或在 dark wake 时集中触发,唤醒瞬间成批
 * "超时"——但 worker 从头到尾没得到过 30s 清醒的处理机会。这批假超时曾把
 * LocalDbGate 打进 fatal 造成白屏。语义修正:预算指「30s 清醒时间」,
 * 挂钟耗时远超预算说明中途睡过,重置预算重等;只有真实清醒窗口耗满才拒绝。
 */
export function evaluateRpcTimeout(
  sentAtMs: number,
  nowMs: number,
  budgetMs: number,
): RpcTimeoutVerdict {
  const wallElapsedMs = nowMs - sentAtMs;
  if (wallElapsedMs > budgetMs + SLEEP_DETECTION_SLACK_MS) {
    return { kind: 'rearm', wallElapsedMs };
  }
  return { kind: 'reject', wallElapsedMs };
}

type EventName = 'log' | 'vec-status';

export interface WorkerThreadTransportOptions {
  userId?: string;
  dbPath?: string;
  drizzleDir?: string;
  sqliteVecExtPath?: string;
  nativeBinding?: string;
  /** better-sqlite3 入口 JS 绝对路径，供 worker 在 packaged 下绕开 bare require 解析差异。 */
  betterSqliteModulePath?: string;
  /** 测试或回滚时可显式指定 worker 文件路径。生产默认解析 .vite/build/dbWorker.js。 */
  workerScriptPath?: string;
  /** 临时回滚口：跳过真实 worker 文件，走旧 inline worker。 */
  useInlineWorker?: boolean;
  /** DB worker 同时在途 RPC 上限。默认值覆盖正常 burst，测试可缩小。 */
  maxInFlightRpcs?: number;
  /** 背压等待队列上限；超出后快速拒绝，避免异常生产者耗尽主进程内存。 */
  maxQueuedRpcs?: number;
  /** 单个 RPC 从入队到完成的总预算；生产默认 30s，测试可缩短。 */
  rpcTimeoutMs?: number;
}

export class WorkerThreadTransport implements DbTransport {
  private static readonly RPC_TIMEOUT_MS = 30_000;
  private static readonly DEFAULT_MAX_IN_FLIGHT_RPCS = 128;
  private static readonly DEFAULT_MAX_QUEUED_RPCS = 512;

  private worker: Worker;
  private nextId = 1;
  private closed = false;
  private closing = false;
  private vecLoaded = false;
  private readonly pending = new Map<number, PendingRpc>();
  private readonly queued: QueuedRpc[] = [];
  private readonly eventListeners = new Map<EventName, Set<(payload: unknown) => void>>();
  private readonly terminatedListeners = new Set<(info: DbTransportTerminationInfo) => void>();
  private readonly opts: WorkerThreadTransportOptions;

  constructor(opts: WorkerThreadTransportOptions = {}) {
    this.opts = opts;
    this.worker = this.spawnWorker();
  }

  send<R = unknown>(op: string, args?: unknown, transferList?: unknown[]): Promise<R> {
    if (this.closed || this.closing) {
      return Promise.reject(new Error('db worker transport is closed'));
    }
    const id = this.nextId++;
    const req: RpcRequest = { id, op, args };
    return new Promise<R>((resolve, reject) => {
      const queued: QueuedRpc = {
        req,
        transferList: transferList ?? [],
        resolve: resolve as (value: unknown) => void,
        reject,
        budgetStartedAtMs: Date.now(),
      };
      if (this.pending.size < this.maxInFlightRpcs) {
        this.dispatch(queued);
        return;
      }
      if (this.queued.length >= this.maxQueuedRpcs) {
        reject(
          new Error(
            `db worker RPC queue overloaded: op="${op}" inFlight=${this.pending.size}` +
              ` queued=${this.queued.length}`,
          ),
        );
        return;
      }
      this.queued.push(queued);
      this.armQueuedTimeout(queued);
    });
  }

  on(event: 'log', cb: (payload: LogEvent) => void): void;
  on(event: 'vec-status', cb: (payload: VecStatusEvent) => void): void;
  on(
    event: EventName,
    cb:
      | ((payload: LogEvent) => void)
      | ((payload: VecStatusEvent) => void),
  ): void {
    const listeners = this.eventListeners.get(event) ?? new Set<(payload: unknown) => void>();
    listeners.add(cb as (payload: unknown) => void);
    this.eventListeners.set(event, listeners);
  }

  onTerminated(cb: (info: DbTransportTerminationInfo) => void): void {
    this.terminatedListeners.add(cb);
  }

  async close(): Promise<void> {
    if (this.closed || this.closing) return;
    const canCloseGracefully = this.pending.size === 0 && this.queued.length === 0;
    const gracefulClose = canCloseGracefully ? this.send('closeDb') : null;
    // closeDb 仅在 transport 空闲时直发。已有 backlog 时不再把关闭请求排到队尾,
    // 直接拒绝遗留工作并 terminate,避免登出 / 退出被慢 RPC 拖住。
    this.closing = true;
    try {
      await gracefulClose;
    } catch {
      // Worker may already be down; terminate below still releases resources.
    } finally {
      this.closed = true;
      this.rejectAllPending(new Error('db worker transport closed'));
      await this.worker.terminate();
    }
  }

  terminateForTest(): Promise<number> {
    return this.worker.terminate();
  }

  get isVecAvailable(): boolean {
    return this.vecLoaded;
  }

  private get maxInFlightRpcs(): number {
    return this.opts.maxInFlightRpcs ?? WorkerThreadTransport.DEFAULT_MAX_IN_FLIGHT_RPCS;
  }

  private get maxQueuedRpcs(): number {
    return this.opts.maxQueuedRpcs ?? WorkerThreadTransport.DEFAULT_MAX_QUEUED_RPCS;
  }

  private get rpcTimeoutMs(): number {
    return this.opts.rpcTimeoutMs ?? WorkerThreadTransport.RPC_TIMEOUT_MS;
  }

  private armQueuedTimeout(item: QueuedRpc): void {
    const onTimeout = (): void => {
      const index = this.queued.indexOf(item);
      if (index < 0) return;
      const verdict = evaluateRpcTimeout(
        item.budgetStartedAtMs,
        Date.now(),
        this.rpcTimeoutMs,
      );
      if (verdict.kind === 'rearm') {
        item.budgetStartedAtMs = Date.now();
        item.queueTimeout = setTimeout(onTimeout, this.rpcTimeoutMs);
        return;
      }
      this.queued.splice(index, 1);
      item.reject(
        new Error(
          `db worker RPC queue timeout: op="${item.req.op}" id=${item.req.id}` +
            ` exceeded ${this.rpcTimeoutMs / 1000}s total budget`,
        ),
      );
    };
    item.queueTimeout = setTimeout(onTimeout, this.rpcTimeoutMs);
  }

  private dispatch(item: QueuedRpc): void {
    const { id, op } = item.req;
    if (item.queueTimeout) clearTimeout(item.queueTimeout);
    const onTimeout = (): void => {
      const pending = this.pending.get(id);
      if (!pending) return;
      const verdict = evaluateRpcTimeout(
        pending.sentAtMs,
        Date.now(),
        this.rpcTimeoutMs,
      );
      if (verdict.kind === 'rearm') {
        // 跨睡眠假超时:重置预算续等,请求在唤醒后照常完成或在真超时时拒绝。
        this.emitClientLog('warn', {
          event: 'rpc.timeout.rearmedAfterSleep',
          op,
          id,
          wallElapsedMs: verdict.wallElapsedMs,
        });
        pending.sentAtMs = Date.now();
        pending.timeout = setTimeout(onTimeout, this.rpcTimeoutMs);
        return;
      }
      this.pending.delete(id);
      pending.reject(
        new Error(
          `db worker RPC timeout: op="${op}" id=${id} exceeded ${this.rpcTimeoutMs / 1000}s` +
            ` wallElapsedMs=${verdict.wallElapsedMs}`,
        ),
      );
      this.drainQueue();
    };
    const budgetElapsedMs = Date.now() - item.budgetStartedAtMs;
    const remainingBudgetMs = Math.max(
      1,
      this.rpcTimeoutMs - budgetElapsedMs,
    );
    const timeout = setTimeout(onTimeout, remainingBudgetMs);
    this.pending.set(id, {
      resolve: item.resolve,
      reject: item.reject,
      timeout,
      sentAtMs: item.budgetStartedAtMs,
    });
    try {
      this.worker.postMessage(item.req, item.transferList as never);
    } catch (err) {
      clearTimeout(timeout);
      this.pending.delete(id);
      item.reject(toError(err));
      this.drainQueue();
    }
  }

  private drainQueue(): void {
    while (!this.closed && this.pending.size < this.maxInFlightRpcs) {
      const next = this.queued.shift();
      if (!next) return;
      this.dispatch(next);
    }
  }

  private spawnWorker(): Worker {
    const worker = this.createWorker();
    let workerTerminated = false;
    worker.on('message', (msg: WorkerMessage) => this.handleMessage(msg));
    worker.on('error', (err) => {
      if (workerTerminated) return;
      workerTerminated = true;
      const error = toError(err);
      this.rejectAllPending(error);
      this.emitTerminated({ code: null, signal: null, error });
    });
    worker.on('exit', (code) => {
      if (workerTerminated) return;
      workerTerminated = true;
      const err = new Error(`db worker exited with code ${code}`);
      this.rejectAllPending(err);
      this.emitTerminated({ code, signal: null });
    });
    return worker;
  }

  private createWorker(): Worker {
    // 显式 workerScriptPath 用于真实文件 worker 校验，不能被临时 inline fallback 覆盖。
    if (this.opts.workerScriptPath) {
      return new Worker(this.resolveWorkerScriptPath(), { workerData: this.opts });
    }
    if (this.shouldUseInlineWorker()) {
      return new Worker(WORKER_CODE, { eval: true, workerData: this.opts });
    }
    return new Worker(this.resolveWorkerScriptPath(), { workerData: this.opts });
  }

  private shouldUseInlineWorker(): boolean {
    return this.opts.useInlineWorker === true || process.env.XDT_DB_WORKER_INLINE === 'true';
  }

  private resolveWorkerScriptPath(): string {
    if (this.opts.workerScriptPath) {
      if (fs.existsSync(this.opts.workerScriptPath)) return this.opts.workerScriptPath;
      throw new Error(`db worker script not found: ${this.opts.workerScriptPath}`);
    }
    const candidate = path.join(__dirname, 'dbWorker.js');
    if (fs.existsSync(candidate)) return candidate;
    throw new Error(
      `db worker script not found: ${candidate}; set XDT_DB_WORKER_INLINE=true only for temporary fallback`,
    );
  }

  private handleMessage(msg: WorkerMessage): void {
    if ('id' in msg) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timeout);
      if (msg.ok) {
        pending.resolve(msg.result);
      } else {
        const err = Object.assign(new Error(msg.error.message), {
          code: msg.error.code,
          stack: msg.error.stack,
        });
        pending.reject(err);
      }
      this.drainQueue();
      return;
    }

    const listeners = this.eventListeners.get(msg.event);
    if (msg.event === 'vec-status') this.vecLoaded = msg.payload.loaded;
    if (!listeners) return;
    for (const cb of listeners) cb(msg.payload);
  }

  /**
   * 客户端侧(非 worker)产生的日志走同一条 'log' 事件通道,由 DbClient 汇入
   * 统一 logger —— transport 自身不 import logger,保持零 Electron 依赖可测。
   */
  private emitClientLog(level: LogEvent['level'], payload: unknown): void {
    const listeners = this.eventListeners.get('log');
    if (!listeners) return;
    const event: LogEvent = { level, scope: 'db-rpc', payload };
    for (const cb of listeners) cb(event);
  }

  private rejectAllPending(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this.pending.clear();
    for (const queued of this.queued.splice(0)) {
      if (queued.queueTimeout) clearTimeout(queued.queueTimeout);
      queued.reject(err);
    }
  }

  private emitTerminated(info: DbTransportTerminationInfo): void {
    for (const cb of this.terminatedListeners) cb(info);
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
