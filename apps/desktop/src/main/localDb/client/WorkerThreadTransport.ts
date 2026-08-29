import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import {
  createDbTransportError,
  DB_TRANSPORT_NOT_SENT,
  DB_TRANSPORT_OUTCOME_UNKNOWN,
  type DbTransport,
  type DbTransportTerminationInfo,
  type LogEvent,
  type RpcRequest,
  type VecStatusEvent,
  type WorkerMessage,
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
    case 'session.treeRehydrate':
      return sessionTreeRehydrate(readyDb, request.args);
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
    case 'orca.archiveWorkersByTeam':
      return orcaArchiveWorkersByTeam(readyDb, request.args);
    case 'orca.reconcileInactiveTeamWorkersForLead':
      return orcaReconcileInactiveTeamWorkersForLead(readyDb, request.args);
    case 'sessions.renameTitles':
      return sessionsRenameTitles(readyDb, request.args);
    case 'sessions.setStatus':
      return sessionsSetStatus(readyDb, request.args);
    case 'toolResults.compactSession':
      return compactSessionToolResults(readyDb, request.args);
    case 'session.agentSwitchFallback':
      return sessionAgentSwitchFallback(readyDb, request.args);
    case 'context.rebuild':
      return contextRebuild(readyDb, request.args);
    case 'message.insert':
      return messageInsert(readyDb, request.args);
    case 'message.updateContent':
      return messageUpdateContent(readyDb, request.args);
    case 'message.leaseMutate':
      return messageLeaseMutate(readyDb, request.args);
    case 'message.rewindUserAfterClear':
      return messageRewindUserAfterClear(readyDb, request.args);
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
function contextRebuild(readyDb, args) {
  const payload = asRecord(args, 'context.rebuild args');
  const sessionId = expectString(payload.sessionId, 'sessionId');
  const markerId = expectString(payload.markerId, 'markerId');
  const markerClientId = expectString(payload.markerClientId, 'markerClientId');
  const markerContent = expectString(payload.markerContent, 'markerContent');
  const markerCreatedAt = expectNumber(payload.markerCreatedAt, 'markerCreatedAt');
  const updatedAt = expectNumber(payload.updatedAt, 'updatedAt');
  const expectedClearedAt =
    payload.expectedClearedAt === undefined || payload.expectedClearedAt === null
      ? null
      : expectNumber(payload.expectedClearedAt, 'expectedClearedAt');
  return readyDb.transaction(() => {
    const sessionResult = readyDb.prepare(
      'UPDATE sessions SET sdk_session_id = NULL, updated_at = ?, list_message_count = NULL WHERE id = ? AND ifnull(cleared_at, -1) = ifnull(?, -1)',
    ).run(updatedAt, sessionId, expectedClearedAt);
    if (sessionResult.changes !== 1) {
      throw Object.assign(new Error('Session missing or clear-boundary changed: ' + sessionId), {
        code: 'PRECONDITION_FAILED',
      });
    }
    // 只追加新边界。删掉更早的 context_rebuild 会让 fork 丢掉中间失效点。
    readyDb.prepare(
      "INSERT INTO messages (id, client_id, session_id, role, content, created_at, rewind_at) VALUES (?, ?, ?, 'context_rebuild', ?, ?, ?)",
    ).run(markerId, markerClientId, sessionId, markerContent, markerCreatedAt, markerCreatedAt);
  })();
}

// ⚠️ 与 worker/opHandlers/tx.ts 的同名事务保持一致。
function messageInsert(readyDb, args) {
  const payload = asRecord(args, 'message.insert args');
  const sessionId = expectString(payload.sessionId, 'sessionId');
  const id = expectString(payload.id, 'id');
  const clientId = expectString(payload.clientId, 'clientId');
  const role = expectString(payload.role, 'role');
  const content = expectString(payload.content, 'content');
  const toolUseId = nullableString(payload.toolUseId);
  const agentMeta = nullableString(payload.agentMeta);
  const agentKind = nullableString(payload.agentKind);
  const createdAt = expectNumber(payload.createdAt, 'createdAt');
  const guarded = payload.guarded === true;
  const expected =
    payload.expectedClearBoundaryMs === undefined || payload.expectedClearBoundaryMs === null
      ? null
      : expectNumber(payload.expectedClearBoundaryMs, 'expectedClearBoundaryMs');
  return readyDb.transaction(() => {
    let changes = 0;
    if (guarded) {
      changes = readyDb.prepare(
        'INSERT INTO messages (id, client_id, session_id, role, content, tool_use_id, agent_meta, agent_kind, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? FROM sessions AS s WHERE s.id = ? AND COALESCE(s.cleared_at, -1) = COALESCE(?, -1) ON CONFLICT(session_id, client_id) DO NOTHING',
      ).run(id, clientId, sessionId, role, content, toolUseId, agentMeta, agentKind, createdAt, sessionId, expected).changes;
    } else {
      changes = readyDb.prepare(
        'INSERT INTO messages (id, client_id, session_id, role, content, tool_use_id, agent_meta, agent_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, clientId, sessionId, role, content, toolUseId, agentMeta, agentKind, createdAt).changes;
    }
    if (changes > 0) {
      if (role === 'user' || role === 'assistant') {
        readyDb.prepare(
          'UPDATE sessions SET list_preview = NULL, list_preview_role = NULL, list_message_count = NULL WHERE id = ?',
        ).run(sessionId);
      } else {
        readyDb.prepare('UPDATE sessions SET list_message_count = NULL WHERE id = ?').run(sessionId);
      }
    }
    return { changes };
  })();
}

function messageUpdateContent(readyDb, args) {
  const payload = asRecord(args, 'message.updateContent args');
  const sessionId = expectString(payload.sessionId, 'sessionId');
  const clientId = expectString(payload.clientId, 'clientId');
  const content = expectString(payload.content, 'content');
  return readyDb.transaction(() => {
    const changes = readyDb.prepare(
      'UPDATE messages SET content = ? WHERE session_id = ? AND client_id = ?',
    ).run(content, sessionId, clientId).changes;
    if (changes > 0) {
      const row = readyDb.prepare(
        'SELECT role, rewind_at FROM messages WHERE session_id = ? AND client_id = ? LIMIT 1',
      ).get(sessionId, clientId);
      if (row && row.rewind_at == null && (row.role === 'user' || row.role === 'assistant')) {
        readyDb.prepare(
          'UPDATE sessions SET list_preview = NULL, list_preview_role = NULL WHERE id = ?',
        ).run(sessionId);
      }
    }
    return { changes };
  })();
}

function messageLeaseMutate(readyDb, args) {
  const payload = asRecord(args, 'message.leaseMutate args');
  const op = expectString(payload.op, 'op');
  const sessionId = expectString(payload.sessionId, 'sessionId');
  const clientId = expectString(payload.clientId, 'clientId');
  return readyDb.transaction(() => {
    let changes = 0;
    if (op === 'insert') {
      const createdAt = expectNumber(payload.createdAt, 'createdAt');
      changes = readyDb.prepare(
        "INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, created_at, rewind_at) VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?) ON CONFLICT(session_id, client_id) DO NOTHING",
      ).run(
        expectString(payload.id, 'id'),
        clientId,
        sessionId,
        expectString(payload.content, 'content'),
        nullableString(payload.agentMeta),
        createdAt,
        createdAt,
      ).changes;
    } else if (op === 'deleteByContent') {
      changes = readyDb.prepare(
        'DELETE FROM messages WHERE session_id = ? AND client_id = ? AND content = ?',
      ).run(sessionId, clientId, expectString(payload.content, 'content')).changes;
    } else if (op === 'deleteById') {
      changes = readyDb.prepare(
        'DELETE FROM messages WHERE id = ? AND session_id = ? AND client_id = ?',
      ).run(expectString(payload.id, 'id'), sessionId, clientId).changes;
    } else {
      throw Object.assign(new Error('unknown message.leaseMutate op: ' + op), { code: 'INVALID_ARGS' });
    }
    if (changes > 0) {
      readyDb.prepare('UPDATE sessions SET list_message_count = NULL WHERE id = ?').run(sessionId);
    }
    return { changes };
  })();
}

function messageRewindUserAfterClear(readyDb, args) {
  const payload = asRecord(args, 'message.rewindUserAfterClear args');
  const sessionId = expectString(payload.sessionId, 'sessionId');
  const clientId = expectString(payload.clientId, 'clientId');
  const rewoundAt = expectNumber(payload.rewoundAt, 'rewoundAt');
  return readyDb.transaction(() => {
    const changes = readyDb.prepare(
      "UPDATE messages SET rewind_at = ? WHERE session_id = ? AND client_id = ? AND role = 'user' AND rewind_at IS NULL",
    ).run(rewoundAt, sessionId, clientId).changes;
    if (changes > 0) {
      readyDb.prepare(
        'UPDATE sessions SET list_preview = NULL, list_preview_role = NULL WHERE id = ?',
      ).run(sessionId);
    }
    return { changes };
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
  const rawSubagentTurnWindow = payload.subagentTurnWindow;
  const subagentTurnWindow = rawSubagentTurnWindow === undefined
    ? null
    : (() => {
        const window = asRecord(rawSubagentTurnWindow, 'subagentTurnWindow');
        const startedAtInclusive = expectNumber(window.startedAtInclusive, 'subagentTurnWindow.startedAtInclusive');
        const startedAtExclusive = window.startedAtExclusive === undefined
          ? undefined
          : expectNumber(window.startedAtExclusive, 'subagentTurnWindow.startedAtExclusive');
        if (
          !Number.isSafeInteger(startedAtInclusive)
          || startedAtInclusive < 0
          || (startedAtExclusive !== undefined
            && (!Number.isSafeInteger(startedAtExclusive) || startedAtExclusive < 0))
        ) {
          throw invalidArgs('subagentTurnWindow must contain non-negative integer timestamps');
        }
        return { startedAtInclusive, startedAtExclusive };
      })();

  return readyDb.transaction(() => {
    const selectTarget = readyDb.prepare(
      "SELECT id, client_id AS clientId, tool_use_id AS toolUseId FROM messages WHERE session_id = ? AND client_id = ? AND role IN ('user', 'assistant', 'tool_use', 'tool_result', 'ask_user', 'plan_review', 'thinking', 'error') AND rewind_at IS NULL LIMIT 1",
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

    const subagentRunIds = new Set();
    const hasSubagentRuns = Boolean(
      readyDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'subagent_runs'").get(),
    );
    if (hasSubagentRuns) {
      const selectLinkedSubagents = readyDb.prepare(
        'SELECT id FROM subagent_runs WHERE session_id = ? AND parent_tool_use_id = ? AND rewind_at IS NULL AND deleted_at IS NULL',
      );
      const parentToolUseIds = new Set(
        targets.flatMap((target) => target.toolUseId ? [target.toolUseId] : []),
      );
      for (const toolUseId of parentToolUseIds) {
        const linkedRows = selectLinkedSubagents.all(sessionId, toolUseId);
        for (const row of linkedRows) subagentRunIds.add(row.id);
      }
      if (subagentTurnWindow) {
        const parentlessRows = subagentTurnWindow.startedAtExclusive === undefined
          ? readyDb.prepare(
              'SELECT id FROM subagent_runs WHERE session_id = ? AND parent_tool_use_id IS NULL AND rewind_at IS NULL AND deleted_at IS NULL AND started_at >= ?',
            ).all(sessionId, subagentTurnWindow.startedAtInclusive)
          : readyDb.prepare(
              'SELECT id FROM subagent_runs WHERE session_id = ? AND parent_tool_use_id IS NULL AND rewind_at IS NULL AND deleted_at IS NULL AND started_at >= ? AND started_at < ?',
            ).all(sessionId, subagentTurnWindow.startedAtInclusive, subagentTurnWindow.startedAtExclusive);
        for (const row of parentlessRows) subagentRunIds.add(row.id);
      }
      const scrubSubagent = readyDb.prepare(
        "UPDATE subagent_runs SET title = NULL, description = NULL, summary = NULL, activity = '[]', updated_at = MAX(updated_at, ?), deleted_at = ? WHERE id = ? AND session_id = ? AND rewind_at IS NULL AND deleted_at IS NULL",
      );
      for (const runId of subagentRunIds) {
        const scrubbed = scrubSubagent.run(updatedAt, updatedAt, runId, sessionId);
        if (scrubbed.changes !== 1) {
          throw Object.assign(new Error('Subagent 删除竞态: ' + runId), {
            code: 'PRECONDITION_FAILED',
          });
        }
      }
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
      'UPDATE sessions SET sdk_session_id = NULL, updated_at = ?, list_preview = NULL, list_preview_role = NULL, list_message_count = NULL WHERE id = ?',
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
      subagentRunIds: [...subagentRunIds].sort(),
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
    'SELECT id, title, working_dir AS workingDir, workspace_kind AS workspaceKind, status FROM sessions WHERE id = ? LIMIT 1',
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
      if (existing.status === 'deleted') {
        throw Object.assign(new Error('已删除的任务不能恢复或归档: ' + sessionId), {
          code: 'PRECONDITION_FAILED',
        });
      }
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

function compactSessionToolResults(readyDb, args) {
  const payload = asRecord(args, 'toolResults.compactSession args');
  const sessionId = expectString(payload.sessionId, 'sessionId');
  const now = expectNumber(payload.now, 'now');

  const selectSession = readyDb.prepare(
    "SELECT id FROM sessions WHERE id = ? AND status IN ('archived', 'deleted') LIMIT 1",
  );
  // Keep this aggregate + bulk update path in sync with worker/opHandlers/tx.ts.
  // Only prefix-shaped rows pay for JSON validation.
  const uncompactedContentPredicate = [
    'CASE',
    "WHEN content NOT GLOB '{\\\"type\\\":\\\"tool_result_compacted\\\",\\\"version\\\":1,*' THEN 1",
    'WHEN json_valid(content) = 0 THEN 1',
    "WHEN json_type(content) = 'object'",
    "AND json_extract(content, '$.type') = 'tool_result_compacted'",
    "AND json_extract(content, '$.version') = 1",
    "AND json_type(content, '$.originalBytes') IN ('integer', 'real')",
    "AND json_extract(content, '$.originalBytes') >= 0",
    "AND json_type(content, '$.compactedAt') IN ('integer', 'real')",
    "AND json_extract(content, '$.compactedAt') >= 0 THEN 0",
    'ELSE 1 END',
  ].join(' ');
  const summarizeCandidates = readyDb.prepare(
    "SELECT COALESCE(SUM(octet_length(content)), 0) AS originalBytes FROM messages WHERE session_id = ? AND role = 'tool_result' AND (" + uncompactedContentPredicate + ') = 1',
  );
  const compactMessages = readyDb.prepare(
    "UPDATE messages SET content = json_object('type', 'tool_result_compacted', 'version', 1, 'originalBytes', octet_length(content), 'compactedAt', ?) WHERE session_id = ? AND role = 'tool_result' AND (" + uncompactedContentPredicate + ') = 1',
  );

  return readyDb.transaction(() => {
    const session = selectSession.get(sessionId);
    if (!session) {
      return { compactedRows: 0, originalBytes: 0 };
    }
    const summary = summarizeCandidates.get(session.id);
    const compactedRows = compactMessages.run(now, session.id).changes;
    return {
      compactedRows,
      originalBytes: compactedRows > 0 ? summary.originalBytes : 0,
    };
  })();
}

// 单事务插 session 行 + 全量 messages, 任一行非法整体回滚零写入;
// session 已存在按 ALREADY_EXISTS 抛(并发双导入兜底)。
// 协同包经可选 orca 段在同一事务追加 Worker 会话 + orca_teams/orca_workers 关系图。
// 会话分享(.xdtshare)导入落库: 与 worker/opHandlers/tx.ts 的同名 handler 保持一致。
function sessionImportShare(readyDb, args) {
  const payload = asRecord(args, 'session.importShare args');
  const session = asRecord(payload.session, 'session');
  const messages = expectArray(payload.messages, 'messages');
  const replaceSessions = payload.replaceSessions == null
    ? []
    : expectArray(payload.replaceSessions, 'replaceSessions').map((raw, i) => {
        const replacement = asRecord(raw, 'replaceSessions[' + i + ']');
        const status = expectString(replacement.status, 'replaceSessions[' + i + '].status');
        if (status !== 'active' && status !== 'archived') {
          throw new Error('replaceSessions[' + i + '].status must be active or archived');
        }
        return {
          id: expectString(replacement.id, 'replaceSessions[' + i + '].id'),
          status,
        };
      });
  const orca = payload.orca == null ? null : asRecord(payload.orca, 'orca');
  const insertSession = readyDb.prepare(
    'INSERT INTO sessions (id, title, working_dir, workspace_kind, worktree_path, model, effort, permission_mode, provider_id, status, sdk_session_id, total_token_usage, total_cost_usd, context_tokens, context_window, fast_mode, plan_mode_enabled, agent_kind, orca_role, source, extra_dirs, codex_history_has_product_prompt, cleared_at, user_send_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  const insertMessage = readyDb.prepare(
    'INSERT INTO messages (id, client_id, session_id, role, content, tool_use_id, agent_meta, agent_kind, created_at, rewind_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
  );
  const insertSessionWithMessages = (rawSession, rawMessages) => {
    const sessionId = expectString(rawSession.id, 'session.id');
    const existing = readyDb.prepare('SELECT id FROM sessions WHERE id = ? LIMIT 1').get(sessionId);
    if (existing) {
      throw Object.assign(new Error('session already exists: ' + sessionId), { code: 'ALREADY_EXISTS' });
    }
    insertSession.run(
      sessionId,
      expectString(rawSession.title, 'session.title'),
      nullableString(rawSession.workingDir),
      expectString(rawSession.workspaceKind, 'session.workspaceKind'),
      nullableString(rawSession.worktreePath),
      expectString(rawSession.model, 'session.model'),
      expectString(rawSession.effort, 'session.effort'),
      expectString(rawSession.permissionMode, 'session.permissionMode'),
      nullableString(rawSession.providerId),
      expectString(rawSession.status, 'session.status'),
      nullableString(rawSession.sdkSessionId),
      expectNumber(rawSession.totalTokenUsage, 'session.totalTokenUsage'),
      expectNumber(rawSession.totalCostUsd, 'session.totalCostUsd'),
      expectNumber(rawSession.contextTokens, 'session.contextTokens'),
      expectNumber(rawSession.contextWindow, 'session.contextWindow'),
      rawSession.fastMode ? 1 : 0,
      rawSession.planModeEnabled ? 1 : 0,
      expectString(rawSession.agentKind, 'session.agentKind'),
      nullableString(rawSession.orcaRole),
      expectString(rawSession.source, 'session.source'),
      expectString(rawSession.extraDirs, 'session.extraDirs'),
      rawSession.codexHistoryHasProductPrompt == null ? null : (rawSession.codexHistoryHasProductPrompt ? 1 : 0),
      nullableNumber(rawSession.clearedAt),
      nullableNumber(rawSession.userSendAt),
      expectNumber(rawSession.createdAt, 'session.createdAt'),
      expectNumber(rawSession.updatedAt, 'session.updatedAt'),
    );
    for (const rawMessage of rawMessages) {
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
    return rawMessages.length;
  };
  const messageCount = readyDb.transaction(() => {
    // 覆盖导入的替换必须与新图落库同事务:失败时旧 session 状态原子回滚。
    // 不能走带异步资源清理副作用的 patchSessionMetaInDb。
    const deleteReplacedSession = readyDb.prepare(
      "UPDATE sessions SET status = 'deleted', updated_at = ? WHERE id = ? AND status != 'deleted'",
    );
    const replacementUpdatedAt = expectNumber(session.updatedAt, 'session.updatedAt');
    for (const replacedSession of replaceSessions) {
      deleteReplacedSession.run(replacementUpdatedAt, replacedSession.id);
    }
    let count = insertSessionWithMessages(session, messages);
    if (orca) {
      const team = asRecord(orca.team, 'orca.team');
      readyDb.prepare(
        'INSERT INTO orca_teams (id, lead_session_id, status, completed_at, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      ).run(
        expectString(team.id, 'orca.team.id'),
        expectString(team.leadSessionId, 'orca.team.leadSessionId'),
        expectString(team.status, 'orca.team.status'),
        nullableNumber(team.completedAt),
        expectNumber(team.createdAt, 'orca.team.createdAt'),
        expectNumber(team.updatedAt, 'orca.team.updatedAt'),
      );
      const insertWorker = readyDb.prepare(
        'INSERT INTO orca_workers (id, team_id, session_id, status, label, worktree_branch, role, focused, idle_since, created_at, updated_at) VALUES (?,?,?,?,?,NULL,?,?,NULL,?,?)',
      );
      for (const rawWorker of expectArray(orca.workers, 'orca.workers')) {
        const worker = asRecord(rawWorker, 'orca.workers[]');
        const record = asRecord(worker.record, 'orca.workers[].record');
        count += insertSessionWithMessages(
          asRecord(worker.session, 'orca.workers[].session'),
          expectArray(worker.messages, 'orca.workers[].messages'),
        );
        insertWorker.run(
          expectString(record.id, 'orca.workers[].record.id'),
          expectString(record.teamId, 'orca.workers[].record.teamId'),
          expectString(record.sessionId, 'orca.workers[].record.sessionId'),
          expectString(record.status, 'orca.workers[].record.status'),
          nullableString(record.label),
          expectString(record.role, 'orca.workers[].record.role'),
          record.focused ? 1 : 0,
          expectNumber(record.createdAt, 'orca.workers[].record.createdAt'),
          expectNumber(record.updatedAt, 'orca.workers[].record.updatedAt'),
        );
      }
    }
    return count;
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
  const archiveSession = readyDb.prepare("UPDATE sessions SET status = 'archived', orca_role = NULL, updated_at = ? WHERE id = ? AND status != 'deleted'");
  return readyDb.transaction(() => {
    const row = selectWorker.get(workerId);
    if (!row) return null;
    deleteWorker.run(workerId);
    const archived = archiveSession.run(now, row.sessionId);
    return archived.changes > 0 ? row.sessionId : null;
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

function orcaArchiveWorkersByTeam(readyDb, args) {
  const payload = asRecord(args, 'orca.archiveWorkersByTeam args');
  const teamId = expectString(payload.teamId, 'teamId');
  const sessionIds = expectArray(payload.sessionIds, 'sessionIds').map((value, index) =>
    expectString(value, 'sessionIds[' + index + ']'),
  );
  const now = expectNumber(payload.now, 'now');
  const archiveSession = readyDb.prepare(
    "UPDATE sessions SET status = 'archived', updated_at = ? WHERE id = ? AND status = 'active' AND EXISTS (SELECT 1 FROM orca_workers WHERE orca_workers.session_id = sessions.id AND orca_workers.team_id = ?)",
  );
  return readyDb.transaction(() => {
    const updatedIds = [];
    for (const id of sessionIds) {
      if (archiveSession.run(now, id, teamId).changes > 0) updatedIds.push(id);
    }
    return updatedIds;
  })();
}

function orcaReconcileInactiveTeamWorkersForLead(readyDb, args) {
  const payload = asRecord(args, 'orca.reconcileInactiveTeamWorkersForLead args');
  const leadSessionId = expectString(payload.leadSessionId, 'leadSessionId');
  const sessionIds = expectArray(payload.sessionIds, 'sessionIds').map((value, index) =>
    expectString(value, 'sessionIds[' + index + ']'),
  );
  const now = expectNumber(payload.now, 'now');
  const finishWorkers = readyDb.prepare(
    "UPDATE orca_workers SET status = 'done', updated_at = ? WHERE team_id IN (SELECT id FROM orca_teams WHERE lead_session_id = ? AND status != 'active')",
  );
  const archiveSession = readyDb.prepare(
    "UPDATE sessions SET status = 'archived', updated_at = ? WHERE id = ? AND status = 'active' AND EXISTS (SELECT 1 FROM orca_workers INNER JOIN orca_teams ON orca_workers.team_id = orca_teams.id WHERE orca_workers.session_id = sessions.id AND orca_teams.lead_session_id = ? AND orca_teams.status != 'active')",
  );
  return readyDb.transaction(() => {
    finishWorkers.run(now, leadSessionId);
    const updatedIds = [];
    for (const id of sessionIds) {
      if (archiveSession.run(now, id, leadSessionId).changes > 0) updatedIds.push(id);
    }
    return updatedIds;
  })();
}

function orcaUpsertWorker(readyDb, args) {
  const payload = asRecord(args, 'orca.upsertWorker args');
  const id = expectString(payload.id, 'id');
  const teamId = expectString(payload.teamId, 'teamId');
  const sessionId = expectString(payload.sessionId, 'sessionId');
  const now = expectNumber(payload.now, 'now');
  readyDb.transaction(() => {
    const activeTeam = readyDb.prepare(
      "SELECT 1 FROM orca_teams WHERE id = ? AND status = 'active' LIMIT 1",
    ).get(teamId);
    if (!activeTeam) {
      throw new Error('Orca team ' + teamId + ' is no longer active');
    }
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

function invalidateSessionListProjection(readyDb, sessionId) {
  readyDb.prepare(
    'UPDATE sessions SET list_preview = NULL, list_preview_role = NULL, list_message_count = NULL WHERE id = ?',
  ).run(sessionId);
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
        content: stringifyImportedContent(role, row.content),
        agentMeta: JSON.stringify({ sdkSessionId, model }),
        createdAt,
      }).changes;
    }
    if (count > 0) invalidateSessionListProjection(readyDb, sessionId);
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
        messages.role != 'tool_result' OR
        CASE
          WHEN messages.content NOT GLOB '{"type":"tool_result_compacted","version":1,*' THEN 1
          WHEN json_valid(messages.content) = 0 THEN 1
          WHEN json_type(messages.content) = 'object'
           AND json_extract(messages.content, '$.type') = 'tool_result_compacted'
           AND json_extract(messages.content, '$.version') = 1
           AND json_type(messages.content, '$.originalBytes') IN ('integer', 'real')
           AND json_extract(messages.content, '$.originalBytes') >= 0
           AND json_type(messages.content, '$.compactedAt') IN ('integer', 'real')
           AND json_extract(messages.content, '$.compactedAt') >= 0 THEN 0
          ELSE 1
        END = 1
      ) AND
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
      const role = expectString(row.role, 'row.role');
      count += upsert.run({
        id: 'claude-import-' + sdkSessionId + '-' + key,
        clientId: importClientIdPrefix + key,
        sessionId,
        role,
        content: stringifyImportedContent(role, row.content),
        toolUseId: nullableString(row.toolUseId),
        agentMeta: row.agentMeta ? stringifyContent(row.agentMeta) : null,
        createdAt: expectNumber(row.createdAt, 'row.createdAt'),
      }).changes;
    }
    if (count > 0) invalidateSessionListProjection(readyDb, sessionId);
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
    'SELECT id, client_id, role, created_at, agent_meta, tool_use_id FROM messages WHERE session_id = ? AND rewind_at IS NULL',
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
  const hasSubagentRuns = Boolean(
    readyDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'subagent_runs'").get(),
  );
  const rewindSubagentByParent = hasSubagentRuns
    ? readyDb.prepare('UPDATE subagent_runs SET rewind_at = ? WHERE session_id = ? AND rewind_at IS NULL AND parent_tool_use_id = ?')
    : null;
  const rewindParentlessSubagentTail = hasSubagentRuns
    ? readyDb.prepare('UPDATE subagent_runs SET rewind_at = ? WHERE session_id = ? AND rewind_at IS NULL AND parent_tool_use_id IS NULL AND started_at >= ?')
    : null;
  readyDb.transaction(() => {
    for (const id of idsToRewind) updateMessage.run(now, id);
    if (rewindSubagentByParent && rewindParentlessSubagentTail) {
      const rewoundIds = new Set(idsToRewind);
      const parentToolUseIds = new Set(
        rows.flatMap((row) => rewoundIds.has(row.id) && row.tool_use_id ? [row.tool_use_id] : []),
      );
      for (const toolUseId of parentToolUseIds) {
        rewindSubagentByParent.run(now, sessionId, toolUseId);
      }
      // Mirror worker/opHandlers/tx.ts: parentless same-ms rows are ambiguous,
      // so fail closed rather than expose work from a withdrawn branch.
      rewindParentlessSubagentTail.run(now, sessionId, targetCreatedAt);
    }
    if (sdkSessionId) {
      readyDb.prepare('UPDATE sessions SET user_send_at = ?, updated_at = ?, context_tokens = 0, context_window = 0, codex_plan_json = NULL, sdk_session_id = ?, list_preview = NULL, list_preview_role = NULL WHERE id = ?').run(now, now, sdkSessionId, sessionId);
    } else {
      readyDb.prepare('UPDATE sessions SET user_send_at = ?, updated_at = ?, context_tokens = 0, context_window = 0, codex_plan_json = NULL, list_preview = NULL, list_preview_role = NULL WHERE id = ?').run(now, now, sessionId);
    }
  })();
}

function parsedTreeObjectJson(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function treeEntryUuid(agentMeta) {
  const parsed = parsedTreeObjectJson(agentMeta);
  return parsed && typeof parsed.uuid === 'string' && parsed.uuid ? parsed.uuid : null;
}

function linkedPiEntryId(agentMeta) {
  const parsed = parsedTreeObjectJson(agentMeta);
  return parsed && typeof parsed.piEntryId === 'string' && parsed.piEntryId ? parsed.piEntryId : null;
}

function normalizedTreeUserText(content) {
  const parsed = parsedTreeObjectJson(content);
  if (!parsed || typeof parsed.text !== 'string') return null;
  return parsed.text
    .split(/\\r?\\n/)
    .filter((line) => line.trim() !== '[image]')
    .join('\\n')
    .replace(/\\s+/g, ' ')
    .trim();
}

function mergeTreeUserAttachments(content, source) {
  if (!source) return content;
  const next = parsedTreeObjectJson(content);
  const previous = parsedTreeObjectJson(source.content);
  if (!next || !previous) return content;
  const merged = { ...next };
  if (!Object.hasOwn(next, 'images') && Array.isArray(previous.images)) merged.images = previous.images;
  if (!Object.hasOwn(next, 'files') && Array.isArray(previous.files)) merged.files = previous.files;
  return JSON.stringify(merged);
}

const TREE_HOST_AGENT_META_KEYS = ['origin', 'autoResume', 'autoResumeInfo'];

function mergeTreeUserAgentMeta(agentMeta, source) {
  if (!source) return agentMeta;
  const previous = parsedTreeObjectJson(source.agent_meta);
  if (!previous) return agentMeta;
  const projected = parsedTreeObjectJson(agentMeta) || {};
  const merged = { ...projected };
  let changed = false;
  for (const key of TREE_HOST_AGENT_META_KEYS) {
    if (!Object.hasOwn(previous, key)) continue;
    merged[key] = previous[key];
    changed = true;
  }
  return changed ? JSON.stringify(merged) : agentMeta;
}

function sessionTreeRehydrate(readyDb, args) {
  const payload = asRecord(args, 'session.treeRehydrate args');
  const sessionId = expectString(payload.sessionId, 'sessionId');
  const now = expectNumber(payload.now, 'now');
  const contextTokens = expectNumber(payload.contextTokens, 'contextTokens');
  if (contextTokens < 0) throw new TypeError('contextTokens must be non-negative');
  const contextWindow = expectNumber(payload.contextWindow, 'contextWindow');
  if (contextWindow < 0) throw new TypeError('contextWindow must be non-negative');
  const rows = expectArray(payload.messages, 'messages').map((raw, index) => {
    const row = asRecord(raw, 'messages.' + index);
    return {
      id: expectString(row.id, 'messages.' + index + '.id'),
      clientId: expectString(row.clientId, 'messages.' + index + '.clientId'),
      role: expectString(row.role, 'messages.' + index + '.role'),
      content: expectString(row.content, 'messages.' + index + '.content'),
      toolUseId: nullableString(row.toolUseId),
      agentMeta: nullableString(row.agentMeta),
      agentKind: expectString(row.agentKind, 'messages.' + index + '.agentKind'),
      createdAt: expectNumber(row.createdAt, 'messages.' + index + '.createdAt'),
    };
  });
  const selectVisibleClientIds = readyDb.prepare(
    'SELECT client_id FROM messages WHERE session_id = ? AND rewind_at IS NULL',
  );
  const selectUserAttachmentSources = readyDb.prepare(
    "SELECT client_id, content, agent_meta, created_at, rewind_at FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at ASC, id ASC",
  );
  const hideVisible = readyDb.prepare(
    'UPDATE messages SET rewind_at = ? WHERE session_id = ? AND rewind_at IS NULL',
  );
  const upsert = readyDb.prepare(
    'INSERT INTO messages (id, client_id, session_id, role, content, tool_use_id, agent_meta, agent_kind, created_at, rewind_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(session_id, client_id) DO UPDATE SET role = excluded.role, content = excluded.content, tool_use_id = excluded.tool_use_id, agent_meta = excluded.agent_meta, agent_kind = excluded.agent_kind, created_at = excluded.created_at, rewind_at = NULL',
  );
  const hiddenClientIds = readyDb.transaction(() => {
    const session = readyDb.prepare('SELECT id FROM sessions WHERE id = ? LIMIT 1').get(sessionId);
    if (!session) throw Object.assign(new Error('Session 不存在: ' + sessionId), { code: 'NOT_FOUND' });
    // Keep this fallback mirror in sync with worker/opHandlers/tx.ts: preserve only
    // Cindy-managed attachments matched by stable id/uuid/piEntryId or a verified visible prefix.
    const attachmentSources = selectUserAttachmentSources.all(sessionId);
    const byClientId = new Map(attachmentSources.map((row) => [row.client_id, row]));
    const byUuid = new Map();
    const byLinkedPiEntryId = new Map();
    for (const source of attachmentSources) {
      const uuid = treeEntryUuid(source.agent_meta);
      if (uuid) byUuid.set(uuid, source);
      const piEntryId = linkedPiEntryId(source.agent_meta);
      if (piEntryId) byLinkedPiEntryId.set(piEntryId, source);
    }
    const visibleUserSources = attachmentSources.filter((row) => row.rewind_at === null);
    let visiblePrefixIndex = 0;
    let visiblePrefixIntact = true;
    // 与 worker/opHandlers/tx.ts 保持同步:原子快照可见集再隐藏,导航期间并发落库的消息也纳入。
    const captured = selectVisibleClientIds.all(sessionId).map((row) => row.client_id);
    hideVisible.run(now, sessionId);
    for (const row of rows) {
      let content = row.content;
      let agentMeta = row.agentMeta;
      if (row.role === 'user') {
        const uuid = treeEntryUuid(row.agentMeta);
        let source = byClientId.get(row.clientId)
          || (uuid ? byUuid.get(uuid) : null)
          || (uuid ? byLinkedPiEntryId.get(uuid) : null)
          || null;
        const candidate = visibleUserSources[visiblePrefixIndex] || null;
        if (source && visiblePrefixIntact && source !== candidate) {
          visiblePrefixIntact = false;
        } else if (!source && visiblePrefixIntact) {
          const samePrefix = candidate &&
            candidate.created_at === row.createdAt &&
            normalizedTreeUserText(candidate.content) === normalizedTreeUserText(row.content);
          if (samePrefix) source = candidate;
          else visiblePrefixIntact = false;
        }
        visiblePrefixIndex += 1;
        content = mergeTreeUserAttachments(row.content, source);
        agentMeta = mergeTreeUserAgentMeta(row.agentMeta, source);
      }
      upsert.run(row.id, row.clientId, sessionId, row.role, content, row.toolUseId, agentMeta, row.agentKind, row.createdAt);
    }
    readyDb.prepare('UPDATE sessions SET cleared_at = NULL, context_tokens = ?, context_window = ?, updated_at = ?, list_preview = NULL, list_preview_role = NULL, list_message_count = NULL WHERE id = ?').run(contextTokens, contextWindow, now, sessionId);
    return captured;
  })();
  return { messageCount: rows.length, hiddenClientIds };
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
  // 普通消息原文精确比较;canon 有损比较只在「至少一侧含原始标记字面量」时启用
  // (升级前旧标记行 vs 已归一化导入行),避免仅 Markdown 格式不同的正常回复被
  // 误判成重复。口径同 opHandlers/tx.ts。
  return existing.some((prev) => prev.role === next.role
    && Math.abs(prev.createdAt - next.createdAt) <= LOCAL_DUPLICATE_WINDOW_MS
    && (prev.plain === next.plain
      || (prev.canonical !== undefined && next.canonical !== undefined
        && (prev.hasMarker || next.hasMarker)
        && prev.canonical === next.canonical)));
}

function messageFingerprint(role, text, createdAt) {
  const plain = normalizeFingerprintText(text);
  const hasMarker = role === 'assistant' && text.includes(CODEX_CITATION_OPEN);
  const canonical = role === 'assistant'
    ? normalizeFingerprintText(canonicalizeCodexCitations(text))
    : undefined;
  const out = { role, plain, hasMarker, createdAt };
  if (canonical !== undefined) out.canonical = canonical;
  return out;
}

// 与 opHandlers/tx.ts 的指纹规范形同构;SSoT 注释见该文件,口径变更需同步。
const CODEX_CITATION_RE = /:codex-file-citation\\{((?:[^"{}]|"(?:[^"\\\\]|\\\\.)*")*)\\}/g;
const CODEX_CITATION_OPEN = ':codex-file-citation{';

function codexCitationClose(text, attrsStart) {
  let inQuote = false;
  for (let i = attrsStart; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuote && ch === '\\\\') i += 1;
    else if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch === '}') return i;
    else if (!inQuote && ch === '{') return -2;
  }
  return -1;
}

function decodeCitationPathForFingerprint(attrs) {
  const m = /(?:^|\\s)path="((?:[^"\\\\]|\\\\.)*)"/.exec(attrs);
  if (!m) return '';
  const raw = m[1];
  const nativeUnc = raw.startsWith('\\\\\\\\') && raw[2] !== '\\\\';
  const head = nativeUnc ? '\\\\\\\\' : '';
  return head + (nativeUnc ? raw.slice(2) : raw).replace(/\\\\([\\\\"])/g, '$1');
}

function canonicalizeCodexCitations(text) {
  let out = text;
  let from = 0;
  for (;;) {
    const open = out.indexOf(CODEX_CITATION_OPEN, from);
    if (open === -1) break;
    const close = codexCitationClose(out, open + CODEX_CITATION_OPEN.length);
    if (close === -1) { out = out.slice(0, open); break; }
    from = close === -2 ? open + CODEX_CITATION_OPEN.length : close + 1;
  }
  for (let i = 0; i < 5; i += 1) {
    const next = out.replace(CODEX_CITATION_RE, (_all, attrs) => decodeCitationPathForFingerprint(attrs));
    if (next === out) break;
    out = next;
  }
  return out.replace(/\`+/g, '').replace(/\\s+/g, ' ');
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

function capToolResultTextForPersist(text) {
  var limit = 8 * 1024;
  var suffix = '\\n\\n[tool result truncated: stored first 8KB]';
  if (text.length <= limit) return text;
  var cut = Math.max(0, limit - suffix.length);
  var lastKept = text.charCodeAt(cut - 1);
  if (cut > 0 && lastKept >= 0xd800 && lastKept <= 0xdbff) cut -= 1;
  return text.slice(0, cut) + suffix;
}

function stringifyImportedContent(role, content) {
  if (role === 'tool_result' && typeof content === 'string') {
    return stringifyContent(capToolResultTextForPersist(content));
  }
  return stringifyContent(content);
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
      return Promise.reject(
        createDbTransportError(
          DB_TRANSPORT_NOT_SENT,
          'db worker transport is closed',
        ),
      );
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
          createDbTransportError(
            DB_TRANSPORT_NOT_SENT,
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
      this.rejectAllPending(
        createDbTransportError(
          DB_TRANSPORT_OUTCOME_UNKNOWN,
          'db worker transport closed',
        ),
        createDbTransportError(DB_TRANSPORT_NOT_SENT, 'db worker transport closed'),
      );
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
        createDbTransportError(
          DB_TRANSPORT_NOT_SENT,
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
        createDbTransportError(
          DB_TRANSPORT_OUTCOME_UNKNOWN,
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
      item.reject(
        createDbTransportError(
          DB_TRANSPORT_NOT_SENT,
          toError(err).message,
          err,
        ),
      );
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
      this.rejectAllPending(
        createDbTransportError(DB_TRANSPORT_OUTCOME_UNKNOWN, error.message, error),
        createDbTransportError(DB_TRANSPORT_NOT_SENT, error.message, error),
      );
      this.emitTerminated({ code: null, signal: null, error });
    });
    worker.on('exit', (code) => {
      if (workerTerminated) return;
      workerTerminated = true;
      const err = new Error(`db worker exited with code ${code}`);
      this.rejectAllPending(
        createDbTransportError(DB_TRANSPORT_OUTCOME_UNKNOWN, err.message, err),
        createDbTransportError(DB_TRANSPORT_NOT_SENT, err.message, err),
      );
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

  private rejectAllPending(pendingError: Error, queuedError: Error = pendingError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(pendingError);
    }
    this.pending.clear();
    for (const queued of this.queued.splice(0)) {
      if (queued.queueTimeout) clearTimeout(queued.queueTimeout);
      queued.reject(queuedError);
    }
  }

  private emitTerminated(info: DbTransportTerminationInfo): void {
    for (const cb of this.terminatedListeners) cb(info);
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
