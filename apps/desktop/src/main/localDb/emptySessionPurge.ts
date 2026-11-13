import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { isDbEmptySessionPurge, type DbEmptySessionPurge } from '../../shared/localDbMaintenance';

/** Self-contained factory also serialized into the existing inline worker fallback. */
export function createEmptySessionPurgeScanner(
  hash: (text: string) => string,
  validate: (value: unknown) => boolean,
) {
  const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  /** The DB worker scans in a read transaction; startup maintenance revalidates its copy. */
  return function scanEmptySessionPurge(db: Database.Database, ids: string[]): DbEmptySessionPurge {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 10_000)
      throw Error('Invalid empty-session allowlist');
    const shape = { targets: ids.map((id) => ({ id, fingerprint: '0'.repeat(64) })) };
    if (!validate(shape)) throw Error('Invalid empty-session allowlist');
    const targets = ids.map((id) => {
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
        Record<string, unknown> | undefined;
      const links = db
        .prepare('SELECT * FROM bot_session_links WHERE session_id = ? ORDER BY id')
        .all(id) as Array<Record<string, unknown>>;
      if (
        !session ||
        session.status !== 'deleted' ||
        session.source !== 'bot' ||
        !links.length ||
        links.some((l) => l.role !== 'routine') ||
        [
          'summary',
          'list_preview',
          'sdk_session_id',
          'worktree_path',
          'parent_session_id',
          'codex_plan_json',
          'total_token_usage',
          'total_cost_usd',
          'total_cost_amount',
          'active_turn_started_at',
          'active_turn_pid',
        ].some((key) => !!session[key]) ||
        db.prepare('SELECT 1 FROM messages WHERE session_id = ? LIMIT 1').get(id)
      ) {
        throw Error('Empty-session evidence changed: ' + id);
      }
      return {
        id,
        fingerprint: hash(JSON.stringify({ session, links })),
      };
    });
    const wanted = new Set(ids);
    // Include non-FK and JSON references. Ignore only a record's own metadata and its routine link.
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND sql NOT LIKE 'CREATE VIRTUAL%' AND name NOT LIKE '%fts%' AND name NOT LIKE '%vec%'",
      )
      .all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const columns = (
        db.prepare('PRAGMA table_info(' + quote(name) + ')').all() as Array<{
          name: string;
          type: string;
        }>
      )
        .filter((c) => c.type.toLowerCase() === 'text')
        .map((c) => c.name);
      if (!columns.length) continue;
      for (const row of db
        .prepare('SELECT ' + columns.map(quote).join(',') + ' FROM ' + quote(name))
        .iterate() as Iterable<Record<string, unknown>>) {
        const own =
          name === 'sessions' ? row.id : name === 'bot_session_links' ? row.session_id : undefined;
        for (const col of columns) {
          const value = row[col];
          if (typeof value !== 'string') continue;
          for (const [id] of value.matchAll(uuid)) {
            if (wanted.has(id) && id !== own)
              throw Error('Referenced empty session: ' + id + ' in ' + name + '.' + col);
          }
        }
      }
    }
    return { targets };
  };
}
export const scanEmptySessionPurge = createEmptySessionPurgeScanner(
  (text) => createHash('sha256').update(text).digest('hex'),
  isDbEmptySessionPurge,
);

/** Only called inside the disposable-copy transaction, never against a live connection. */
export function purgeEmptySessions(db: Database.Database, approved: DbEmptySessionPurge): number {
  if (!isDbEmptySessionPurge(approved)) throw Error('Invalid approved empty-session plan');
  const current = scanEmptySessionPurge(
    db,
    approved.targets.map((t) => t.id),
  );
  if (JSON.stringify(current) !== JSON.stringify(approved))
    throw Error('Empty-session plan changed; scan again');
  const unlink = db.prepare('DELETE FROM bot_session_links WHERE session_id = ?');
  const remove = db.prepare('DELETE FROM sessions WHERE id = ?');
  for (const target of approved.targets) {
    unlink.run(target.id);
    if (remove.run(target.id).changes !== 1) throw Error('Empty-session deletion count mismatch');
  }
  if ((db.pragma('foreign_key_check') as unknown[]).length)
    throw Error('Empty-session foreign key check failed');
  return approved.targets.length;
}
