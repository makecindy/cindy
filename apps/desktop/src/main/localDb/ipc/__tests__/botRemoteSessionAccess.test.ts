import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ db: null as ReturnType<typeof drizzle> | null, current: true }));
vi.mock('../../client/current.js', () => ({ getDbClient: () => ({ drizzle: h.db }) }));
vi.mock('../../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => 'owner',
  isDataOwnerBroadcastScopeCurrent: () => h.current,
}));
import {
  readRemoteBotSessionAccessBatch,
  readRemoteBotSessionAccess,
} from '../botRemoteSessionAccess';
import {
  projectRemoteSessionResult,
  setRemoteBotSessionLookup,
} from '../../../device-link/remoteBotSessionBoundary';
let db: Database.Database;
beforeEach(() => {
  h.current = true;
  db = new Database(':memory:');
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT);
    CREATE TABLE bot_session_links(session_id TEXT PRIMARY KEY, bot_id TEXT);
    CREATE TABLE bot_profiles(id TEXT PRIMARY KEY, hidden_at INTEGER, status TEXT);
    INSERT INTO sessions VALUES ('ordinary','desktop'),('visible','bot'),('hidden','bot'),('archived','bot'),('orphan','bot');
    INSERT INTO bot_profiles VALUES ('v',NULL,'active'),('h',1,'active'),('a',NULL,'archived');
    INSERT INTO bot_session_links VALUES ('visible','v'),('hidden','h'),('archived','a');`);
  h.db = drizzle(db);
});
afterEach(() => {
  setRemoteBotSessionLookup(null);
  db.close();
});
describe('batch DB visibility', () => {
  it('matches single-read visibility and includes explicit missing verdicts', async () => {
    const select = vi.spyOn(h.db!, 'select');
    const ids = ['ordinary', 'visible', 'hidden', 'archived', 'orphan', 'missing', 'visible'];
    const result = await readRemoteBotSessionAccessBatch(ids, 'session');
    expect(Object.fromEntries(result)).toEqual({
      ordinary: 'ordinary',
      visible: 'visible',
      hidden: 'hidden',
      archived: 'hidden',
      orphan: 'hidden',
      missing: 'missing',
    });
    expect(select).toHaveBeenCalledTimes(1);
    for (const id of ids) expect(await readRemoteBotSessionAccess(id)).toBe(result.get(id));
    expect(
      Object.fromEntries(await readRemoteBotSessionAccessBatch(['v', 'h', 'a', 'no'], 'bot')),
    ).toEqual({ v: 'visible', h: 'hidden', a: 'hidden', no: 'missing' });
  });
  it('bounds queries and denies the entire result when ownership changes', async () => {
    const select = vi.spyOn(h.db!, 'select');
    const ids = Array.from({ length: 600 }, (_, i) => `missing${i}`);
    expect((await readRemoteBotSessionAccessBatch(ids, 'session')).size).toBe(600);
    expect(select).toHaveBeenCalledTimes(3);
    select.mockClear();
    h.current = false;
    const result = await readRemoteBotSessionAccessBatch(['ordinary', ...ids], 'session');
    expect([...result.values()].every((value) => value === 'hidden')).toBe(true);
    expect(select).toHaveBeenCalledTimes(1);
  });
});

it.each([774, 1000])(
  'projects %i tasks with four SQL reads and rechecks hidden bots on replay',
  async (count) => {
    const rows = Array.from({ length: count }, (_, i) => ({ id: `s${i}` }));
    const insert = db.prepare('INSERT INTO sessions VALUES (?, ?)');
    db.transaction(() => {
      for (const row of rows) insert.run(row.id, 'desktop');
    })();
    const select = vi.spyOn(h.db!, 'select');
    setRemoteBotSessionLookup(readRemoteBotSessionAccess, readRemoteBotSessionAccessBatch);
    expect(await projectRemoteSessionResult('local-db:sessions:list', rows)).toEqual(rows);
    expect(select).toHaveBeenCalledTimes(4);
    db.prepare("UPDATE sessions SET source = 'bot' WHERE id = ?").run(rows[0].id);
    db.prepare('INSERT INTO bot_session_links VALUES (?, ?)').run(rows[0].id, 'h');
    expect(await projectRemoteSessionResult('local-db:sessions:list', rows)).toEqual(rows.slice(1));
    expect(select).toHaveBeenCalledTimes(8);
  },
);

it('discards earlier batches if the owner changes during a later query', async () => {
  let queries = 0;
  h.db = drizzle(db, {
    logger: {
      logQuery() {
        if (++queries === 2) h.current = false;
      },
    },
  });
  const ids = ['ordinary', ...Array.from({ length: 773 }, (_, i) => `s${i}`)];
  const result = await readRemoteBotSessionAccessBatch(ids, 'session');
  expect(queries).toBe(2);
  expect(result.size).toBe(774);
  expect([...result.values()].every((value) => value === 'hidden')).toBe(true);
});

it('does not query for an empty batch', async () => {
  const select = vi.spyOn(h.db!, 'select');
  expect((await readRemoteBotSessionAccessBatch([], 'session')).size).toBe(0);
  expect(select).not.toHaveBeenCalled();
});
