/**
 * 存量接入：旧版导入的任务（id 以 codex- / claude- 开头）自动接入新导入器，用户什么都不用做。
 *
 * 对每个旧任务做一次：
 *  - 补写来源记录（之后「是不是导入的、来自哪个工具」都查来源记录，不再看 id 前缀）；
 *  - Codex：把原生历史放进 Cindy 的 codex-home（解压 .zst、带上分页祖先），修复
 *    「导入后接不上」；Cindy 里已有自己的副本（之前续做过）时保留它，不用外部原文覆盖；
 *  - 还没在 Cindy 里续做过的：补齐之前没导入的内容（例如 Codex 的工具调用），沿用旧的行键，
 *    不产生重复；Claude Code 同时建立带新编号的 Cindy 副本，从此与原工具分开；
 *  - 已经在 Cindy 里续做过的 Claude Code 任务保持原样，不改动正在使用的原生会话。
 * 补齐只做这一次，之后同样按「只导入、不同步」处理。
 */

import { getCurrentDbClientUserId, getDbClient } from '../localDb/client/current.js';
import { createLogger } from '../logger.js';
import { resolveSourceSessions } from './scan.js';
import { adapterFor } from './sources/index.js';
import { createMessageSink, runImportTx } from './writer.js';

const log = createLogger('session-import-legacy');
const META_KEY = 'session_import_legacy_adopt_v1';

interface LegacyRow {
  id: string;
  agentKind: string;
  sdkSessionId: string;
}

const adoptedInProcess = new Set<string>();
let sweepUser: string | null = null;

export function isLegacyImportedSessionId(sessionId: string): boolean {
  return sessionId.startsWith('codex-') || sessionId.startsWith('claude-');
}

async function hasLocalMessages(sessionId: string, legacyPrefix: string): Promise<boolean> {
  const row = await getDbClient().queryOne<{ one: number }>(`
    SELECT 1 AS one FROM messages
    WHERE session_id = ?
      AND client_id NOT LIKE ?
      AND client_id NOT LIKE 'app-exit-interrupted-%'
      AND role NOT IN ('context_rebuild', 'agent_switch', 'message_tombstone')
    LIMIT 1
  `, [sessionId, `${legacyPrefix}%`]);
  return !!row;
}

async function adoptOne(row: LegacyRow): Promise<void> {
  const source = row.agentKind === 'codex' ? 'codex' : 'claude';
  const sourceSessionId = source === 'codex' ? row.sdkSessionId.toLowerCase() : row.sdkSessionId;
  const legacyPrefix = `${source}-import:${row.sdkSessionId}:`;
  const { adopted } = await runImportTx({ action: 'adopt', sessionId: row.id, source, sourceSessionId, now: Date.now() }) as { adopted: boolean };
  if (!adopted) return;
  const key = `${source}:${sourceSessionId}`;
  const sourceSession = (await resolveSourceSessions([key], { includeImported: true }).catch(() => new Map())).get(key);
  const adapter = adapterFor(source);
  if (!sourceSession || !adapter) {
    log.info('legacy import adopted without source history', { sessionId: row.id, source });
    return;
  }
  const continued = await hasLocalMessages(row.id, legacyPrefix);
  let nativeSessionId: string | undefined;
  if (adapter.materialize && (source === 'codex' || !continued)) {
    try {
      const m = await adapter.materialize(sourceSession, { cindySessionId: row.id, ownerId: getCurrentDbClientUserId() ?? undefined });
      const ok = adapter.verify ? (await adapter.verify(m, sourceSession)).ok : true;
      if (ok) nativeSessionId = m.sdkSessionId;
    } catch (err) {
      log.warn('legacy native copy failed', { sessionId: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (!continued) {
    const sink = createMessageSink({
      sessionId: row.id,
      agentKind: row.agentKind,
      clientIdPrefix: legacyPrefix,
      idPrefix: `${source}-import-${row.sdkSessionId}-`,
    });
    for await (const message of adapter.read(sourceSession, { cindySessionId: row.id, nativeSessionId })) {
      await sink.push(message);
    }
    await sink.flush();
  }
  if (source === 'claude' && nativeSessionId && !continued && nativeSessionId !== row.sdkSessionId) {
    await runImportTx({ action: 'commit', sessionId: row.id, now: Date.now(), status: 'ready', issue: null, unhide: false, sessionPatch: { sdkSessionId: nativeSessionId } });
  }
  log.info('legacy import adopted', { sessionId: row.id, source, continued, nativeCopy: !!nativeSessionId });
}

async function legacyRows(onlyId?: string): Promise<LegacyRow[]> {
  return getDbClient().query<LegacyRow>(`
    SELECT s.id, s.agent_kind AS agentKind, s.sdk_session_id AS sdkSessionId
    FROM sessions s
    WHERE s.status != 'deleted'
      AND s.sdk_session_id IS NOT NULL
      AND ((s.id LIKE 'codex-%' AND s.agent_kind = 'codex') OR (s.id LIKE 'claude-%' AND s.agent_kind = 'cc'))
      AND NOT EXISTS (SELECT 1 FROM session_imports i WHERE i.session_id = s.id)
      ${onlyId ? 'AND s.id = ?' : ''}
  `, onlyId ? [onlyId] : []);
}

/** 打开某个旧导入任务前先接入它（与旧版「打开时导入」同等的等待），其余旧任务在后台处理。 */
export async function adoptLegacySessionBeforeOpen(sessionId: string): Promise<void> {
  const user = getCurrentDbClientUserId();
  if (!user || !isLegacyImportedSessionId(sessionId)) return;
  const k = `${user}:${sessionId}`;
  if (!adoptedInProcess.has(k)) {
    adoptedInProcess.add(k);
    for (const row of await legacyRows(sessionId)) {
      await adoptOne(row).catch((err) => log.warn('legacy adopt failed', { sessionId, error: err instanceof Error ? err.message : String(err) }));
    }
  }
  void ensureLegacyImportsAdopted();
}

/** 一次性接入全部旧导入任务（按账号；完成后写标记，下次启动不再扫）。 */
export async function ensureLegacyImportsAdopted(): Promise<void> {
  const user = getCurrentDbClientUserId();
  if (!user || sweepUser === user) return;
  sweepUser = user;
  try {
    const db = getDbClient();
    const done = await db.queryOne<{ value: string }>('SELECT value FROM migration_meta WHERE key = ?', [META_KEY]);
    if (done) return;
    const rows = await legacyRows();
    for (const row of rows) {
      if (getCurrentDbClientUserId() !== user) return;
      await adoptOne(row).catch((err) => log.warn('legacy adopt failed', { sessionId: row.id, error: err instanceof Error ? err.message : String(err) }));
    }
    await db.exec('INSERT OR REPLACE INTO migration_meta (key, value) VALUES (?, ?)', [META_KEY, 'done']);
    log.info('legacy import adoption complete', { sessions: rows.length });
  } catch (err) {
    sweepUser = null;
    log.warn('legacy import adoption sweep failed', { error: err instanceof Error ? err.message : String(err) });
  }
}
