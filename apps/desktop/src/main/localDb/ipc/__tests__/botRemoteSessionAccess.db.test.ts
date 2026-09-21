import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrizzleProxy } from '../../client/drizzleProxy';
import type { DbTransport } from '../../client/DbTransport';
import { currentDbRpcAdmissionClass, runAsBackgroundDbRpc } from '../../client/rpcAdmission';
import { projectRemoteSessionResult, setRemoteBotSessionLookup } from '../../../device-link/remoteBotSessionBoundary';

const state = vi.hoisted(() => ({ db: null as unknown, owner: 1 }));
vi.mock('../../client/current.js', () => ({ getDbClient: () => ({ drizzle: state.db }) }));
vi.mock('../../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => state.owner,
  isDataOwnerBroadcastScopeCurrent: (owner: number) => owner === state.owner,
}));
import { readRemoteBotSessionAccess, readRemoteBotSessionAccessBatch } from '../botRemoteSessionAccess';

let sqlite: Database.Database;
let calls: Array<{ params: unknown[]; admission: string }>;
let active: number;
let peak: number;
let beforeReply: (() => void) | undefined;

beforeEach(() => {
  state.owner = 1;
  active = peak = 0;
  calls = [];
  beforeReply = undefined;
  sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT);
    CREATE TABLE bot_profiles (id TEXT PRIMARY KEY, hidden_at INTEGER, status TEXT);
    CREATE TABLE bot_session_links (session_id TEXT UNIQUE, bot_id TEXT);
    INSERT INTO bot_profiles VALUES ('visible', NULL, 'active'), ('hidden', 1, 'active'), ('archived', NULL, 'archived');
    INSERT INTO sessions VALUES ('ordinary', 'desktop'), ('visible', 'bot'), ('hidden', 'bot'), ('archived', 'bot'), ('orphan', 'bot');
    INSERT INTO bot_session_links VALUES ('visible', 'visible'), ('hidden', 'hidden'), ('archived', 'archived');
  `);
  const transport: DbTransport = {
    async send<R>(_op: string, args: unknown): Promise<R> {
      const { sql, params } = args as { sql: string; params: unknown[] };
      calls.push({ params, admission: currentDbRpcAdmissionClass() });
      active++;
      peak = Math.max(peak, active);
      try {
        // Real SQL through the production async Drizzle proxy, with a delayed RPC reply.
        const rows = sqlite.prepare(sql).raw().all(...params);
        await new Promise<void>((resolve) => setImmediate(resolve));
        beforeReply?.();
        return rows as R;
      } finally { active--; }
    },
    on() {}, onTerminated() {}, async close() {},
  };
  state.db = createDrizzleProxy(transport);
  setRemoteBotSessionLookup(readRemoteBotSessionAccess, readRemoteBotSessionAccessBatch);
});
afterEach(() => { setRemoteBotSessionLookup(null); sqlite.close(); });

describe('remote visibility batch SQL', () => {
  it('preserves ordinary, visible, hidden, archived, orphan and missing access semantics', async () => {
    const ids = ['ordinary', 'visible', 'hidden', 'archived', 'orphan', 'missing'];
    expect(Object.fromEntries(await readRemoteBotSessionAccessBatch(ids))).toEqual({
      ordinary: 'ordinary', visible: 'visible', hidden: 'hidden', archived: 'hidden', orphan: 'hidden', missing: 'missing',
    });
    expect(Object.fromEntries(await readRemoteBotSessionAccessBatch(ids, 'bot'))).toEqual({
      ordinary: 'missing', visible: 'visible', hidden: 'hidden', archived: 'hidden', orphan: 'missing', missing: 'missing',
    });
    expect(await readRemoteBotSessionAccess('hidden')).toBe('hidden');
  });

  it('returns 1,000 authorized tasks in order without a per-row RPC burst or interactive admission', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `task-${i}` }));
    const insert = sqlite.prepare("INSERT INTO sessions VALUES (?, 'desktop')");
    sqlite.transaction(() => { for (const row of rows) insert.run(row.id); })();
    const input = [...rows, { id: 'hidden' }, rows[0]];
    expect(await runAsBackgroundDbRpc(() => projectRemoteSessionResult('local-db:sessions:list', input)))
      .toEqual([...rows, rows[0]]);
    expect(calls).toHaveLength(6);
    expect(peak).toBe(1);
    expect(calls.every((call) => call.params.length <= 200 && call.admission === 'background')).toBe(true);
  });

  it('discards already read chunks and stops issuing SQL if the data owner changes', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `task-${i}`);
    beforeReply = () => { if (calls.length === 2) state.owner++; };
    const result = await readRemoteBotSessionAccessBatch(ids);
    expect(result.size).toBe(450);
    expect([...result.values()].every((access) => access === 'hidden')).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('does not cache visibility across separate deliveries and propagates DB failures', async () => {
    expect(await projectRemoteSessionResult('local-db:bots:list', [{ id: 'visible' }])).toEqual([{ id: 'visible' }]);
    sqlite.exec("UPDATE bot_profiles SET hidden_at=10 WHERE id='visible'");
    expect(await projectRemoteSessionResult('local-db:bots:list', [{ id: 'visible' }])).toEqual([]);
    sqlite.exec('DROP TABLE sessions');
    await expect(projectRemoteSessionResult('local-db:sessions:list', [{ id: 'ordinary' }])).rejects.toThrow();
  });
});
