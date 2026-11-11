/**
 * OpenCode 来源适配器（换引擎续做）。
 *
 * - 数据目录：`$XDG_DATA_HOME/opencode`，缺省 `~/.local/share/opencode`；
 * - 新版存 SQLite：`$OPENCODE_DB`，否则目录里的 `opencode*.db`（按发布渠道分库）。表：
 *   session / message / part（v1），session_v2 / session_message / session_part（v2）；
 * - 旧版存 JSON：`storage/session/<项目>/<会话>.json`、`storage/message/<会话>/*.json`、
 *   `storage/part/<消息>/*.json`；同一会话两边都有时以数据库为准；
 * - 子任务会话（parent_id 有值）只计数；`session.revert` 之后的内容视为已撤回。
 * - 数据库先拷快照再读（snapshotSqlite），不和正在运行的 OpenCode 抢锁。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';

import { createBetterSqliteDatabase } from '../../localDb/betterSqliteFactory.js';
import type { NormalizedImage, NormalizedMessage, ReadContext, ScanContext, SourceAdapter, SourceListResult, SourceSession } from '../types.js';
import {
  envDir,
  firstNonEmpty,
  isRecord,
  makeTitle,
  num,
  parseDataUrl,
  snapshotSqlite,
  str,
  stringifyOutput,
  toMs,
  walkFiles,
} from './common.js';

type OpenCodeLocator =
  | { kind: 'db'; db: string; id: string; table: 'v1' | 'v2' }
  | { kind: 'json'; storage: string; id: string };

interface OcMessage { id: string; role: string; createdAt: number; parts: Array<Record<string, unknown>>; data: Record<string, unknown> }

function dataDir(homeDir: string): string {
  const xdg = envDir('XDG_DATA_HOME', homeDir) ?? path.join(homeDir, '.local', 'share');
  return path.join(xdg, 'opencode');
}

async function databases(homeDir: string): Promise<string[]> {
  const dir = dataDir(homeDir);
  const explicit = process.env.OPENCODE_DB?.trim();
  if (explicit && explicit !== ':memory:') return [path.isAbsolute(explicit) ? explicit : path.join(dir, explicit)];
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  return names.filter((n) => /^opencode(-[\w.-]+)?\.db$/.test(n)).map((n) => path.join(dir, n));
}

function parseJson(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw !== 'string') return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return isRecord(v) ? v : {};
  } catch {
    return {};
  }
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function columns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
}

interface SharedSnapshot {
  stamp: string;
  file: string;
  dispose: () => Promise<void>;
  users: number;
  timer: NodeJS.Timeout | null;
}

/** 同一个库在一次扫描、多条导入之间共用一份快照；库有变化或闲置两分钟后丢弃。 */
const snapshots = new Map<string, SharedSnapshot>();
const SNAPSHOT_IDLE_MS = 2 * 60_000;

async function stampOf(dbPath: string): Promise<string | null> {
  const main = await fsp.stat(dbPath).catch(() => null);
  if (!main) return null;
  const wal = await fsp.stat(`${dbPath}-wal`).catch(() => null);
  return `${main.mtimeMs}:${main.size}:${wal?.mtimeMs ?? 0}:${wal?.size ?? 0}`;
}

function release(dbPath: string, snap: SharedSnapshot): void {
  snap.users -= 1;
  if (snap.users > 0) return;
  const stale = snapshots.get(dbPath) !== snap;
  if (stale) {
    void snap.dispose();
    return;
  }
  snap.timer = setTimeout(() => {
    if (snapshots.get(dbPath) === snap && snap.users === 0) {
      snapshots.delete(dbPath);
      void snap.dispose();
    }
  }, SNAPSHOT_IDLE_MS);
  snap.timer.unref?.();
}

async function acquire(dbPath: string): Promise<SharedSnapshot | null> {
  const stamp = await stampOf(dbPath);
  if (!stamp) return null;
  const cached = snapshots.get(dbPath);
  if (cached && cached.stamp === stamp) {
    if (cached.timer) clearTimeout(cached.timer);
    cached.timer = null;
    cached.users += 1;
    return cached;
  }
  const snap = await snapshotSqlite(dbPath);
  if (!snap) return null;
  // 把快照里的 WAL 合进主文件并改成普通日志模式，之后可以只读打开、多处同时读。
  const db = createBetterSqliteDatabase(snap.file);
  try {
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
  }
  const shared: SharedSnapshot = { stamp, file: snap.file, dispose: snap.dispose, users: 1, timer: null };
  if (cached) {
    snapshots.delete(dbPath);
    if (cached.users === 0) {
      if (cached.timer) clearTimeout(cached.timer);
      void cached.dispose();
    }
  }
  snapshots.set(dbPath, shared);
  return shared;
}

async function withDb<T>(dbPath: string, fn: (db: Database.Database) => T): Promise<T | null> {
  const snap = await acquire(dbPath);
  if (!snap) return null;
  let db: Database.Database | null = null;
  try {
    db = createBetterSqliteDatabase(snap.file, { readonly: true, fileMustExist: true });
    return fn(db);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
    release(dbPath, snap);
  }
}

interface ListedRow { id: string; title: string; directory: string; parent: string; created: number; updated: number; archived: boolean; size: number }

function listDb(db: Database.Database): { rows: ListedRow[]; table: 'v1' | 'v2' }[] {
  const out: { rows: ListedRow[]; table: 'v1' | 'v2' }[] = [];
  for (const [table, sessionTable, partTable] of [['v1', 'session', 'part'], ['v2', 'session_v2', 'session_message']] as const) {
    if (!tableExists(db, sessionTable)) continue;
    const cols = columns(db, sessionTable);
    const pick = (c: string, fallback = 'NULL') => (cols.has(c) ? c : fallback);
    const sizes = new Map<string, number>();
    if (tableExists(db, partTable) && columns(db, partTable).has('session_id')) {
      for (const r of db.prepare(`SELECT session_id AS id, SUM(LENGTH(data)) AS size FROM ${partTable} GROUP BY session_id`).all() as Array<{ id: string; size: number }>) {
        sizes.set(r.id, num(r.size));
      }
    }
    const rows = db.prepare(`SELECT id, ${pick('title')} AS title, ${pick('directory')} AS directory, ${pick('parent_id')} AS parent,
      ${pick('time_created', '0')} AS created, ${pick('time_updated', '0')} AS updated, ${pick('time_archived')} AS archived FROM ${sessionTable}`).all() as Array<Record<string, unknown>>;
    out.push({
      table,
      rows: rows.map((r) => ({
        id: str(r.id),
        title: str(r.title),
        directory: str(r.directory),
        parent: str(r.parent),
        created: toMs(r.created),
        updated: toMs(r.updated),
        archived: !!r.archived,
        size: sizes.get(str(r.id)) ?? 0,
      })),
    });
  }
  return out;
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    return parseJson(await fsp.readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

async function list(ctx: ScanContext): Promise<SourceListResult> {
  const sessions: SourceSession[] = [];
  const seen = new Set<string>();
  let internalCount = 0;
  let unreadableCount = 0;
  const push = (row: ListedRow, locator: OpenCodeLocator) => {
    if (!row.id || seen.has(row.id)) return;
    seen.add(row.id);
    if (row.parent) {
      internalCount += 1;
      return;
    }
    sessions.push({
      source: 'opencode',
      sourceSessionId: row.id,
      title: makeTitle(row.title, 'OpenCode'),
      cwd: row.directory || null,
      createdAt: row.created || row.updated,
      updatedAt: row.updated || row.created,
      archived: row.archived,
      sizeBytes: row.size,
      locator: JSON.stringify(locator),
    });
  };
  for (const dbPath of await databases(ctx.homeDir)) {
    try {
      const listed = await withDb(dbPath, listDb);
      for (const { rows, table } of listed ?? []) for (const row of rows) push(row, { kind: 'db', db: dbPath, id: row.id, table });
    } catch {
      unreadableCount += 1;
    }
  }
  const storage = path.join(dataDir(ctx.homeDir), 'storage');
  const files = await walkFiles(path.join(storage, 'session'), (name) => name.endsWith('.json'), { maxDepth: 2 });
  for (const f of files) {
    const info = await readJson(f.file);
    const id = str(info.id) || path.basename(f.file, '.json');
    const time = isRecord(info.time) ? info.time : {};
    const messages = await walkFiles(path.join(storage, 'message', id), (n) => n.endsWith('.json'), { maxDepth: 0 });
    if (messages.length === 0) continue;
    push({
      id,
      title: str(info.title),
      directory: str(info.directory),
      parent: str(info.parentID),
      created: toMs(time.created),
      updated: toMs(time.updated) || Math.floor(f.mtimeMs),
      archived: !!time.archived,
      size: messages.reduce((acc, m) => acc + m.size, 0),
    }, { kind: 'json', storage, id });
  }
  return { sessions, internalCount, unreadableCount };
}

function loadDbMessages(db: Database.Database, id: string, table: 'v1' | 'v2'): { messages: OcMessage[]; revert: Record<string, unknown> } {
  if (table === 'v1') {
    const session = db.prepare('SELECT * FROM session WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    const msgs = db.prepare('SELECT id, time_created AS created, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(id) as Array<Record<string, unknown>>;
    // v1.19 起新会话可能只写 session_message：老表里没有这条会话的消息时改读新表。
    if (msgs.length === 0 && tableExists(db, 'session_message')) return { ...loadDbMessages(db, id, 'v2'), revert: parseJson(session?.revert) };
    const parts = db.prepare('SELECT id, message_id AS mid, data FROM part WHERE session_id = ? ORDER BY id').all(id) as Array<Record<string, unknown>>;
    const byMessage = new Map<string, Array<Record<string, unknown>>>();
    for (const p of parts) {
      const list = byMessage.get(str(p.mid)) ?? [];
      list.push({ id: str(p.id), ...parseJson(p.data) });
      byMessage.set(str(p.mid), list);
    }
    return {
      revert: parseJson(session?.revert),
      messages: msgs.map((m) => {
        const data = parseJson(m.data);
        return { id: str(m.id), role: str(data.role), createdAt: toMs(m.created) || toMs(isRecord(data.time) ? data.time.created : 0), parts: byMessage.get(str(m.id)) ?? [], data };
      }),
    };
  }
  const session = tableExists(db, 'session_v2')
    ? db.prepare('SELECT * FROM session_v2 WHERE id = ?').get(id) as Record<string, unknown> | undefined
    : undefined;
  const msgCols = columns(db, 'session_message');
  const msgs = db.prepare(`SELECT id, type, data${msgCols.has('seq') ? ', seq' : ''} FROM session_message WHERE session_id = ? ORDER BY ${msgCols.has('seq') ? 'seq' : 'id'}`).all(id) as Array<Record<string, unknown>>;
  const partsByMessage = new Map<string, Array<Record<string, unknown>>>();
  if (tableExists(db, 'session_part')) {
    const ids = msgs.map((m) => str(m.id));
    const stmt = db.prepare('SELECT type, data FROM session_part WHERE message_id = ? ORDER BY ordinal');
    for (const mid of ids) {
      const rows = stmt.all(mid) as Array<Record<string, unknown>>;
      if (rows.length) partsByMessage.set(mid, rows.map((r) => ({ type: str(r.type), ...parseJson(r.data) })));
    }
  }
  return {
    revert: parseJson(session?.revert),
    messages: msgs.map((m) => {
      const data = parseJson(m.data);
      const type = str(m.type);
      const inline = Array.isArray(data.content) ? data.content.filter(isRecord) : [];
      const parts = partsByMessage.get(str(m.id)) ?? inline;
      const role = type === 'user' ? 'user' : type === 'assistant' ? 'assistant' : type === 'shell' ? 'shell' : '';
      const createdAt = toMs(isRecord(data.time) ? data.time.created ?? data.time.start : 0);
      return { id: str(m.id), role, createdAt, parts: role === 'user' && typeof data.text === 'string' ? [{ type: 'text', text: data.text }, ...(Array.isArray(data.files) ? data.files.filter(isRecord).map((f) => ({ type: 'file', ...f })) : [])] : parts, data };
    }),
  };
}

async function loadJsonMessages(storage: string, id: string): Promise<{ messages: OcMessage[]; revert: Record<string, unknown> }> {
  const files = await walkFiles(path.join(storage, 'message', id), (n) => n.endsWith('.json'), { maxDepth: 0 });
  const messages: OcMessage[] = [];
  for (const f of files.sort((a, b) => a.file.localeCompare(b.file))) {
    const data = await readJson(f.file);
    const mid = str(data.id) || path.basename(f.file, '.json');
    const partFiles = await walkFiles(path.join(storage, 'part', mid), (n) => n.endsWith('.json'), { maxDepth: 0 });
    const parts: Array<Record<string, unknown>> = [];
    for (const pf of partFiles.sort((a, b) => a.file.localeCompare(b.file))) parts.push(await readJson(pf.file));
    messages.push({ id: mid, role: str(data.role), createdAt: toMs(isRecord(data.time) ? data.time.created : 0), parts, data });
  }
  messages.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  let revert: Record<string, unknown> = {};
  const sessionFiles = await walkFiles(path.join(storage, 'session'), (n) => n === `${id}.json`, { maxDepth: 2 });
  if (sessionFiles[0]) revert = parseJson((await readJson(sessionFiles[0].file)).revert);
  return { messages, revert };
}

function fileImage(part: Record<string, unknown>): NormalizedImage | null {
  const mime = firstNonEmpty(part.mime, part.mimeType);
  const url = str(part.url);
  if (!mime.startsWith('image/') || !url) return null;
  const parsed = parseDataUrl(url);
  if (parsed) return parsed;
  if (url.startsWith('file://')) return { mimeType: mime, filePath: decodeURIComponent(url.slice('file://'.length)) };
  return null;
}

/** 一条 OpenCode 消息（含 parts）→ 统一消息。 */
export function parseOpenCodeMessage(m: OcMessage): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  const createdAt = m.createdAt;
  let i = 0;
  if (m.role === 'user') {
    const texts: string[] = [];
    const images: NormalizedImage[] = [];
    for (const p of m.parts) {
      const type = str(p.type);
      if (type === 'text' && p.synthetic !== true && p.ignored !== true && typeof p.text === 'string') texts.push(p.text);
      else if (type === 'file') {
        const image = fileImage(p);
        if (image) images.push(image);
      }
    }
    const text = texts.join('\n\n').trim();
    if (text || images.length) out.push({ key: `${m.id}-0`, role: 'user', content: text, ...(images.length ? { images } : {}), createdAt });
    return out;
  }
  if (m.role === 'shell') {
    const command = str(m.data.command);
    if (!command) return out;
    out.push({ key: `${m.id}-0`, role: 'tool_use', content: { toolUseId: `${m.id}-shell`, toolName: 'bash', input: { command } }, toolUseId: `${m.id}-shell`, createdAt });
    out.push({ key: `${m.id}-1`, role: 'tool_result', content: stringifyOutput(m.data.output), toolUseId: `${m.id}-shell`, createdAt });
    return out;
  }
  if (m.role !== 'assistant') return out;
  for (const p of m.parts) {
    const type = str(p.type);
    const key = `${m.id}-${i++}`;
    if (type === 'text' && typeof p.text === 'string' && p.text.trim() && p.synthetic !== true) {
      out.push({ key, role: 'assistant', content: p.text, createdAt });
    } else if (type === 'reasoning' && typeof p.text === 'string' && p.text.trim()) {
      out.push({ key, role: 'thinking', content: { text: p.text, durationMs: 0, isRedacted: false }, createdAt });
    } else if (type === 'tool') {
      const state = isRecord(p.state) ? p.state : {};
      const toolUseId = firstNonEmpty(p.callID, p.id) || key;
      const at = toMs(isRecord(state.time) ? state.time.start : 0) || createdAt;
      out.push({ key, role: 'tool_use', content: { toolUseId, toolName: firstNonEmpty(p.tool, p.name) || 'tool', input: state.input ?? null }, toolUseId, createdAt: at });
      const status = str(state.status);
      if (status === 'completed' || status === 'error' || 'output' in state || 'content' in state) {
        const text = status === 'error' ? stringifyOutput(state.error) : stringifyOutput(state.output ?? state.content);
        out.push({ key: `${key}r`, role: 'tool_result', content: text, toolUseId, createdAt: toMs(isRecord(state.time) ? state.time.end : 0) || at });
      }
    }
  }
  return out;
}

/** session.revert 指向的消息（及其后的一切）已撤回。 */
function applyRevert(messages: OcMessage[], revert: Record<string, unknown>): OcMessage[] {
  const at = str(revert.messageID);
  if (!at) return messages;
  const idx = messages.findIndex((m) => m.id === at);
  if (idx < 0) return messages;
  const partID = str(revert.partID);
  if (!partID) return messages.slice(0, idx);
  const head = messages[idx]!;
  const cut = head.parts.findIndex((p) => str(p.id) === partID);
  return [...messages.slice(0, idx), ...(cut > 0 ? [{ ...head, parts: head.parts.slice(0, cut) }] : [])];
}

async function* read(session: SourceSession, ctx: ReadContext): AsyncIterable<NormalizedMessage> {
  const locator = JSON.parse(session.locator) as OpenCodeLocator;
  const loaded = locator.kind === 'db'
    ? await withDb(locator.db, (db) => loadDbMessages(db, locator.id, locator.table))
    : await loadJsonMessages(locator.storage, locator.id);
  if (!loaded) throw new Error('OpenCode history not found');
  ctx.onBytes?.(session.sizeBytes);
  for (const m of applyRevert(loaded.messages, loaded.revert)) {
    if (ctx.signal?.aborted) return;
    yield* parseOpenCodeMessage(m);
  }
}

export const opencodeAdapter: SourceAdapter = { id: 'opencode', label: 'OpenCode', list, read };
