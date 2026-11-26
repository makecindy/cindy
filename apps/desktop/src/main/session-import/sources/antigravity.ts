/**
 * Antigravity App / CLI history (handoff). Google documents the transcript path
 * at https://antigravity.google/docs/hooks. The optional SQLite index supplies
 * project and parent metadata; the JSONL remains the source for messages.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBetterSqliteDatabase } from '../../localDb/betterSqliteFactory.js';
import { parseJsonLine, readLines, type LineReadOptions } from '../lineReader.js';
import type { NormalizedMessage, ReadContext, ScanContext, SourceAdapter, SourceListResult, SourceSession } from '../types.js';
import { isRecord, makeTitle, num, parseMaybeJson, snapshotSqlite, str, toMs } from './common.js';

const ROOTS = ['antigravity', 'antigravity-cli'] as const;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const SCAN_BYTES = 256 * 1024;

interface Summary {
  title: string;
  cwd: string | null;
  updatedAt: number;
  internal: boolean;
}

type IndexLoadResult =
  | { ok: true; map: Map<string, Summary> | null }
  | { ok: false; error: Error };

function workingDir(workspaces: unknown): string | null {
  const uris = parseMaybeJson(workspaces);
  if (!Array.isArray(uris) || uris.length !== 1 || typeof uris[0] !== 'string') return null;
  try {
    const url = new URL(uris[0]);
    return url.protocol === 'file:' && !url.hostname ? fileURLToPath(url) : null;
  } catch {
    return null;
  }
}

/** Only read real files at the expected locations, including on a resumed import. */
async function safeStat(file: string) {
  const real = await fs.realpath(file).catch(() => null);
  if (real !== file) return null;
  const stat = await fs.lstat(file).catch(() => null);
  return stat?.isFile() ? stat : null;
}

async function summaries(root: string): Promise<Map<string, Summary> | null> {
  const result = new Map<string, Summary>();
  const file = path.join(root, 'conversation_summaries.db');
  const dbStat = await fs.lstat(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (!dbStat) return null;
  if (!dbStat.isFile() || await fs.realpath(file).catch(() => null) !== file) {
    throw new Error('Antigravity summary index is unreadable');
  }
  for (const suffix of ['-wal', '-shm']) {
    const stat = await fs.lstat(file + suffix).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
      return null;
    });
    if (stat && !stat.isFile()) throw new Error('Antigravity summary index sidecar is unreadable');
  }
  const snapshot = await snapshotSqlite(file);
  if (!snapshot) throw new Error('Antigravity summary index snapshot failed');
  try {
    const db = createBetterSqliteDatabase(snapshot.file, { readonly: true, fileMustExist: true });
    try {
      const cols = new Set(
        (db.prepare('PRAGMA table_info(conversation_summaries)').all() as Array<{ name: string }>).map((c) => c.name),
      );
      if (!cols.has('conversation_id')) {
        throw new Error('Antigravity summary index table is missing');
      }
      const pick = (col: string, fallback = 'NULL') => (cols.has(col) ? col : fallback);
      const rows = db.prepare(`SELECT conversation_id,
        ${pick('title')} AS title,
        ${pick('workspace_uris')} AS workspace_uris,
        ${pick('last_modified_time')} AS last_modified_time,
        ${pick('parent_conversation_id')} AS parent_conversation_id,
        ${pick('nesting_depth', '0')} AS nesting_depth
        FROM conversation_summaries`).iterate() as Iterable<Record<string, unknown>>;
      for (const row of rows) {
        const id = str(row.conversation_id);
        if (!UUID.test(id)) continue;
        result.set(id.toLowerCase(), {
          title: str(row.title),
          cwd: workingDir(row.workspace_uris),
          updatedAt: toMs(row.last_modified_time),
          internal: !!str(row.parent_conversation_id) || num(row.nesting_depth) > 0,
        });
      }
    } finally {
      db.close();
    }
  } finally {
    await snapshot.dispose();
  }
  return result;
}

function parseLine(line: string, strict: boolean): Record<string, unknown> | null {
  if (!line.trim()) return null;
  if (!strict) return parseJsonLine(line);
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error('Antigravity transcript is truncated or malformed');
  }
  if (!isRecord(parsed)) throw new Error('Antigravity transcript line is invalid');
  return parsed;
}

function readMessage(line: string, lineNo: number, strict: boolean): NormalizedMessage | null {
  const row = parseLine(line, strict);
  if (!row) return null;
  const role = row.type === 'USER_INPUT' ? 'user' : row.type === 'PLANNER_RESPONSE' ? 'assistant' : null;
  const content = str(row.content);
  if (!role || !content.trim()) return null;
  // Real transcripts can reuse a step_index for different user inputs. Preserve
  // both lines and their physical order instead of treating the index as an ID.
  return { key: String(lineNo), role, content, createdAt: toMs(row.created_at) };
}

async function* messages(
  file: string,
  options: LineReadOptions,
  strict = false,
): AsyncIterable<NormalizedMessage> {
  let lineNo = 0;
  for await (const line of readLines(file, options)) {
    const message = readMessage(line, ++lineNo, strict);
    if (message) yield message;
  }
}

async function scanHead(
  file: string,
  size: number,
  indexedTitle: string,
  signal?: AbortSignal,
): Promise<{ first: NormalizedMessage | undefined; userText: string }> {
  const run = async (maxBytes?: number) => {
    let first: NormalizedMessage | undefined;
    let userText = '';
    for await (const message of messages(file, { ...(maxBytes !== undefined ? { maxBytes } : {}), signal })) {
      first ??= message;
      if (message.role === 'user') userText = str(message.content);
      if (userText || (indexedTitle && first)) break;
    }
    return { first, userText };
  };
  const head = await run(SCAN_BYTES);
  if (head.first && (indexedTitle || head.userText)) return head;
  // A large leading SYSTEM_MESSAGE or pasted USER_INPUT can exceed SCAN_BYTES;
  // fall back to streaming past the prefix rather than dropping the session.
  if (size <= SCAN_BYTES || signal?.aborted) return head;
  return run();
}

async function list(ctx: ScanContext): Promise<SourceListResult> {
  const sessions = new Map<string, { session: SourceSession; mtime: number }>();
  const internal = new Set<string>();
  const rootErrors: Error[] = [];
  let unreadableCount = 0;
  const home = await fs.realpath(ctx.homeDir).catch(() => ctx.homeDir);
  const roots = ROOTS.map((name) => path.join(home, '.gemini', name));
  const indexes: IndexLoadResult[] = await Promise.all(roots.map(async (root) => {
    try {
      return { ok: true as const, map: await summaries(root) };
    } catch (err) {
      unreadableCount += 1;
      const error = err instanceof Error ? err : new Error(String(err));
      rootErrors.push(error);
      return { ok: false as const, error };
    }
  }));

  for (const [index, root] of roots.entries()) {
    if (ctx.signal?.aborted) break;
    const hereIndex = indexes[index]!;
    const otherIndex = indexes[1 - index]!;
    // A client without its own index can rely on the other client's metadata.
    // If that index failed to load, the logs cannot distinguish its subagents.
    if (!hereIndex.ok || (!hereIndex.map && !otherIndex.ok)) continue;
    const brain = path.join(root, 'brain');
    const brainStat = await fs.lstat(brain).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      unreadableCount += 1;
      rootErrors.push(err);
      return null;
    });
    if (!brainStat) continue;
    if (!brainStat.isDirectory() || await fs.realpath(brain).catch(() => null) !== brain) {
      unreadableCount += 1;
      rootErrors.push(new Error(`Antigravity brain directory is unreadable: ${path.basename(root)}`));
      continue;
    }
    let dirs;
    try {
      dirs = await fs.readdir(brain, { withFileTypes: true });
    } catch (err) {
      unreadableCount += 1;
      rootErrors.push(err instanceof Error ? err : new Error(String(err)));
      continue;
    }
    for (const dir of dirs) {
      if (ctx.signal?.aborted) break;
      if (!dir.isDirectory() || !UUID.test(dir.name)) continue;
      const id = dir.name.toLowerCase();
      const here = hereIndex.map?.get(id);
      const other = otherIndex.ok ? otherIndex.map?.get(id) : undefined;
      if (here?.internal || other?.internal) {
        internal.add(id);
        continue;
      }
      const file = path.join(brain, dir.name, '.system_generated', 'logs', 'transcript.jsonl');
      const stat = await safeStat(file);
      if (!stat?.size) continue;
      const [fresh, fallback] = (here?.updatedAt ?? 0) >= (other?.updatedAt ?? 0)
        ? [here, other]
        : [other, here];
      const indexedTitle = fresh?.title || fallback?.title || '';
      try {
        const { first, userText } = await scanHead(file, stat.size, indexedTitle, ctx.signal);
        const title = makeTitle(indexedTitle || userText, '');
        if (!first || !title) continue;
        const cwd = fresh?.cwd ?? fallback?.cwd ?? null;
        const updatedAt = Math.max(here?.updatedAt ?? 0, other?.updatedAt ?? 0, Math.floor(stat.mtimeMs));
        const candidate: SourceSession = {
          source: 'antigravity', sourceSessionId: id, title, cwd, dialogue: !cwd,
          createdAt: first.createdAt || updatedAt, updatedAt, archived: false,
          sizeBytes: stat.size, locator: file,
        };
        const previous = sessions.get(id);
        // Both clients can hold a copy. Prefer the newer transcript (breaking
        // equal-mtime ties by size) while metadata comes from the fresher index.
        if (
          !previous
          || stat.mtimeMs > previous.mtime
          || (stat.mtimeMs === previous.mtime && stat.size > previous.session.sizeBytes)
        ) {
          sessions.set(id, { session: candidate, mtime: stat.mtimeMs });
        }
      } catch {
        unreadableCount += 1;
      }
    }
  }
  if (sessions.size === 0 && internal.size === 0 && rootErrors.length > 0) {
    throw rootErrors[0]!;
  }
  return { sessions: [...sessions.values()].map(({ session }) => session), internalCount: internal.size, unreadableCount };
}

async function* read(session: SourceSession, ctx: ReadContext): AsyncIterable<NormalizedMessage> {
  const before = await safeStat(session.locator);
  if (!before) throw new Error('Antigravity transcript is unavailable');
  let createdAt = 0;
  for await (const message of messages(session.locator, { signal: ctx.signal, onBytes: ctx.onBytes }, true)) {
    // A missing or out-of-order timestamp must not reorder the transcript in Cindy.
    createdAt = Math.max(createdAt, message.createdAt || createdAt || session.createdAt);
    yield { ...message, createdAt };
  }
  if (ctx.signal?.aborted) return;
  const after = await safeStat(session.locator);
  if (!after || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error('Antigravity transcript changed while reading');
  }
}

export const antigravityAdapter: SourceAdapter = { id: 'antigravity', label: 'Antigravity', list, read };
