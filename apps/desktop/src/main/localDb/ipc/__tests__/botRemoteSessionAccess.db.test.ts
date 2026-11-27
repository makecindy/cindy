import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrizzleProxy } from '../../client/drizzleProxy';
import type { DbTransport } from '../../client/DbTransport';
import { currentDbRpcAdmissionClass, runAsBackgroundDbRpc } from '../../client/rpcAdmission';
import { DL_HISTORY_QUERY_CHANNEL } from '@cindy/device-link';
import {
  projectRemoteBotPush,
  projectRemoteSessionResult,
  setRemoteBotSessionLookup,
} from '../../../device-link/remoteBotSessionBoundary';

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
    CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, hidden_at INTEGER);
    CREATE TABLE bot_profiles (id TEXT PRIMARY KEY, hidden_at INTEGER, status TEXT);
    CREATE TABLE bot_session_links (session_id TEXT UNIQUE, bot_id TEXT);
    INSERT INTO bot_profiles VALUES ('visible', NULL, 'active'), ('hidden', 1, 'active'), ('archived', NULL, 'archived');
    INSERT INTO sessions (id, source) VALUES ('ordinary', 'desktop'), ('visible', 'bot'), ('hidden', 'bot'), ('archived', 'bot'), ('orphan', 'bot');
    INSERT INTO sessions (id, source, hidden_at) VALUES ('background', 'plugin', 5);
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
      ordinary: 'ordinary', visible: 'visible', hidden: 'background', archived: 'background', orphan: 'background', missing: 'missing',
    });
    expect(Object.fromEntries(await readRemoteBotSessionAccessBatch(ids, 'bot'))).toEqual({
      ordinary: 'missing', visible: 'visible', hidden: 'hidden', archived: 'hidden', orphan: 'missing', missing: 'missing',
    });
    expect(await readRemoteBotSessionAccess('hidden')).toBe('background');
  });

  it('returns 1,000 authorized tasks in order without a per-row RPC burst or interactive admission', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `task-${i}` }));
    const insert = sqlite.prepare("INSERT INTO sessions (id, source) VALUES (?, 'desktop')");
    sqlite.transaction(() => { for (const row of rows) insert.run(row.id); })();
    const input = [...rows, { id: 'hidden' }, rows[0]];
    expect(await runAsBackgroundDbRpc(() => projectRemoteSessionResult('local-db:sessions:list', input)))
      .toEqual([...rows, rows[0]]);
    expect(calls).toHaveLength(6);
    expect(peak).toBe(1);
    expect(calls.every((call) => call.params.length <= 200 && call.admission === 'background')).toBe(true);
  });

  it('omits plugin background tasks from list channels while single reads still resolve them', async () => {
    const rows = [{ id: 'ordinary' }, { id: 'background' }];
    expect(await projectRemoteSessionResult('local-db:sessions:list', rows)).toEqual([{ id: 'ordinary' }]);
    expect(await projectRemoteSessionResult('maker:list-active', [{ sessionId: 'ordinary' }, { sessionId: 'background' }]))
      .toEqual([{ sessionId: 'ordinary' }]);
    expect(await projectRemoteSessionResult('maker:list-active', { format: 'active-sessions-v2', sessions: [{ sessionId: 'background' }] }))
      .toEqual({ format: 'active-sessions-v2', sessions: [] });
    expect(await projectRemoteSessionResult('local-db:sessions:get', { id: 'background' })).toEqual({ id: 'background' });
    expect(await projectRemoteSessionResult('local-db:sessions:get-many', rows)).toEqual(rows);
  });

  it('discards already read chunks and stops issuing SQL if the data owner changes', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `task-${i}`);
    beforeReply = () => { if (calls.length === 2) state.owner++; };
    const result = await readRemoteBotSessionAccessBatch(ids);
    expect(result.size).toBe(450);
    expect([...result.values()].every((access) => access === 'hidden')).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('omits hidden/archived/background createdBySession on list and push channels while preserving exact-ID reads and history', async () => {
    sqlite.exec("INSERT INTO sessions (id, source) VALUES ('from-hidden-bot', 'desktop'), ('from-archived-bot', 'desktop'), ('from-plugin-bg', 'desktop'), ('from-deleted-hidden-bot', 'desktop'), ('from-visible-bot', 'desktop'), ('from-ordinary', 'desktop'), ('from-remote', 'desktop')");
    const fromHiddenBot = { id: 'from-hidden-bot', createdBySession: { kind: 'session', sessionId: 'hidden', title: 'Hidden bot task', botId: 'hidden', botName: 'Secret' } };
    const fromArchivedBot = { id: 'from-archived-bot', createdBySession: { kind: 'session', sessionId: 'archived', title: 'Archived bot task', botId: 'archived', botName: 'Old' } };
    const fromPluginBg = { id: 'from-plugin-bg', createdBySession: { kind: 'session', sessionId: 'background', title: 'Plugin background' } };
    const fromDeletedHiddenBot = { id: 'from-deleted-hidden-bot', createdBySession: { kind: 'session', sessionId: 'deleted-session', title: 'Deleted hidden bot', botId: 'hidden', botName: 'Secret' } };
    const fromVisibleBot = { id: 'from-visible-bot', createdBySession: { kind: 'session', sessionId: 'visible', title: 'Visible bot task', botId: 'visible', botName: 'Alex' } };
    const fromOrdinary = { id: 'from-ordinary', createdBySession: { kind: 'session', sessionId: 'ordinary', title: 'Ordinary task' } };
    const fromRemote = { id: 'from-remote', createdBySession: { kind: 'session', sessionId: 'other-device::hidden', title: 'Remote task', deviceId: 'other-device' } };

    // Real readRemoteBotSessionAccessBatch returns 'background' for hidden/archived companions and plugin background tasks:
    // list channels must omit createdBySession so hidden companion metadata never leaks into remote sidebars.
    expect(await projectRemoteSessionResult('local-db:sessions:list', [
      fromHiddenBot,
      fromArchivedBot,
      fromPluginBg,
      fromDeletedHiddenBot,
      fromVisibleBot,
      fromOrdinary,
      fromRemote,
    ])).toEqual([
      { id: 'from-hidden-bot' },
      { id: 'from-archived-bot' },
      { id: 'from-plugin-bg' },
      { id: 'from-deleted-hidden-bot' },
      fromVisibleBot,
      fromOrdinary,
      fromRemote,
    ]);

    expect(await projectRemoteSessionResult('maker:list-active', [
      { sessionId: 'from-hidden-bot', createdBySession: fromHiddenBot.createdBySession },
      { sessionId: 'from-visible-bot', createdBySession: fromVisibleBot.createdBySession },
    ])).toEqual([
      { sessionId: 'from-hidden-bot' },
      { sessionId: 'from-visible-bot', createdBySession: fromVisibleBot.createdBySession },
    ]);

    // Live pushes for newly created/patched ordinary tasks must also strip hidden/background origins without dropping the visible task.
    expect(await projectRemoteBotPush({ session: fromHiddenBot }, 'local-db:sessions:created')).toEqual({
      session: { id: 'from-hidden-bot' },
    });
    expect(await projectRemoteBotPush({ sessionId: 'from-archived-bot', patch: { title: 'Updated', createdBySession: fromArchivedBot.createdBySession } }, 'local-db:sessions:patched')).toEqual({
      sessionId: 'from-archived-bot',
      patch: { title: 'Updated' },
    });
    expect(await projectRemoteBotPush({ session: fromVisibleBot }, 'local-db:sessions:created')).toEqual({
      session: fromVisibleBot,
    });

    // Exact-ID reads and history queries keep 'background' companion lineage readable by ID.
    expect(await projectRemoteSessionResult('local-db:sessions:get', fromHiddenBot)).toEqual(fromHiddenBot);
    expect(await projectRemoteSessionResult('local-db:sessions:get-many', [fromHiddenBot, fromVisibleBot])).toEqual([
      fromHiddenBot,
      fromVisibleBot,
    ]);
    expect(await projectRemoteSessionResult(DL_HISTORY_QUERY_CHANNEL, {
      ok: true,
      sessions: [fromHiddenBot, fromVisibleBot],
      nextCursor: null,
      hasMore: false,
    })).toEqual({
      ok: true,
      sessions: [fromHiddenBot, fromVisibleBot],
      nextCursor: null,
      hasMore: false,
    });
  });

  it('does not cache visibility across separate deliveries and propagates DB failures', async () => {
    expect(await projectRemoteSessionResult('local-db:bots:list', [{ id: 'visible' }])).toEqual([{ id: 'visible' }]);
    sqlite.exec("UPDATE bot_profiles SET hidden_at=10 WHERE id='visible'");
    expect(await projectRemoteSessionResult('local-db:bots:list', [{ id: 'visible' }])).toEqual([]);
    sqlite.exec('DROP TABLE sessions');
    await expect(projectRemoteSessionResult('local-db:sessions:list', [{ id: 'ordinary' }])).rejects.toThrow();
  });
});
