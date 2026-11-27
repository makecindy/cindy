import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../shared/ghost.js';
import { createGhostPageBridge } from '../../../shared/ghostPageBridge.js';
import * as schema from '../../localDb/schema.js';
import { tx } from '../../localDb/worker/opHandlers/tx.js';
import { GhostSessionStateSlot, readGhostSessionStateRows } from '../sessionStateSlot.js';
import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';

const loadPipe = createGhostProductionCallbacks<{
  send(event: { sender: { id: number; isDestroyed(): boolean } }, payload: unknown): Promise<unknown>;
}>({ variables: ['executionPipe', 'sessionStateSlot'], callbacks: { send: ['ipcMain.handle', 'ghost-pipe:send'] } });

function subscriber(): InstalledGhost {
  return {
    enabled: true,
    approval: { state: 'approved', revision: 'revision' },
    manifest: { subscribe: { topics: ['session'] } },
  } as InstalledGhost;
}

describe('session state queries', () => {
  let sqlite: Database.Database;
  let ghost: InstalledGhost | null;
  let dbOwner: string | null;
  let senderAlive: boolean;
  let isStable: boolean;

  beforeEach(() => {
    ghost = subscriber();
    dbOwner = 'owner';
    senderAlive = true;
    isStable = true;
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, status TEXT, source TEXT, orca_role TEXT, remote_host_id TEXT,
        agent_device_id TEXT,
        title TEXT, working_dir TEXT, workspace_kind TEXT, side_chat_close_pending INTEGER,
        snoozed_until INTEGER, snoozed_at INTEGER, updated_at INTEGER
      );
      INSERT INTO sessions (id, status, source, title, working_dir)
        VALUES ('local', 'active', 'desktop', 'Private title', '/private/workdir'),
               ('automation', 'archived', 'scheduler', 'Hidden title', '/private/hidden');
      INSERT INTO sessions (id, status, source, orca_role)
        VALUES ('worker', 'active', 'desktop', 'worker'), ('lead', 'active', 'desktop', 'lead');
      INSERT INTO sessions (id, status, source, remote_host_id)
        VALUES ('ssh-session', 'deleted', 'desktop', 'ssh-alias');
      INSERT INTO sessions (id, status, source, agent_device_id)
        VALUES ('remote-agent', 'archived', 'desktop', 'another-computer');
    `);
  });

  afterEach(() => { sqlite.close(); });

  function fixture() {
    const getDbClient = vi.fn(() => ({ drizzle: drizzle(sqlite, { schema }) }));
    const query = loadPipe({
      GhostSessionStateSlot, readGhostSessionStateRows, getDbClient,
      findGhostForInstanceId: () => ghost,
      ghostOwnerScope: { capture: () => 'owner-generation', isCurrent: () => true, isStable: () => isStable },
      getActiveAppSession: () => ({ dataOwnerId: 'owner' }),
      getCurrentDbClientUserId: () => dbOwner,
      ghostIdForLogicWebContents: () => 'plugin',
      requireGhostAvailableForActiveSession: () => undefined,
    });
    const bridge = createGhostPageBridge({
      ping: async () => ({ ok: true, id: 'plugin' }),
      send: payload => query.send({ sender: { id: 7, isDestroyed: () => !senderAlive } }, payload),
    }).api;
    return { bridge, getDbClient, query: (sessionIds: string[]) => bridge.sessionStates({ sessionIds }) };
  }

  it('reads only id and state after durable archive and restore, without a delivered event', async () => {
    const { query } = fixture();
    const expected = (status: string) => ({ ok: true, sessions: [{ sessionId: 'local', status }] });
    expect(await query(['local'])).toStrictEqual(expected('active'));
    tx(sqlite, { name: 'sessions.setStatus', args: { sessionIds: ['local'], status: 'archived' } });
    expect(await query(['local'])).toStrictEqual(expected('archived'));
    tx(sqlite, { name: 'sessions.setStatus', args: { sessionIds: ['local'], status: 'active' } });
    expect(await query(['local'])).toStrictEqual(expected('active'));
    sqlite.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('local');
    expect(await query(['local'])).toStrictEqual(expected('deleted'));
  });

  it.each(['uninstalled', 'disabled', 'invalid approval', 'no session topic'])(
    'does not read or return session data for an %s installation', async reason => {
      const { query, getDbClient } = fixture();
      if (reason === 'uninstalled') ghost = null;
      if (reason === 'disabled') ghost!.enabled = false;
      if (reason === 'invalid approval') ghost!.approval = { state: 'invalid' };
      if (reason === 'no session topic') ghost!.manifest.subscribe = { topics: ['turn'] };
      expect(await query(['local'])).toStrictEqual({
        ok: false, errorCode: 'PERMISSION_DENIED', message: expect.any(String),
      });
      expect(getDbClient).not.toHaveBeenCalled();
    },
  );

  it('returns identical receipts for ineligible local rows and the same ids missing from this device', async () => {
    const { query, getDbClient } = fixture();
    const ids = ['worker', 'lead', 'automation', 'missing', 'worker'];
    const receipt = await query(ids);
    expect(receipt).toStrictEqual({
      ok: true, sessions: ids.map(sessionId => ({ sessionId, status: 'out_of_scope' })),
    });
    expect(getDbClient).toHaveBeenCalledTimes(1);
    sqlite.prepare("DELETE FROM sessions WHERE id IN ('worker', 'lead', 'automation')").run();
    expect(JSON.stringify(await query(ids))).toBe(JSON.stringify(receipt));
  });

  it.each([
    ['ssh-session', 'deleted'],
    ['remote-agent', 'archived'],
  ])('returns the durable local state for %s regardless of execution location', async (sessionId, status) => {
    const { query } = fixture();
    expect(await query([sessionId])).toStrictEqual({
      ok: true, sessions: [{ sessionId, status }],
    });
  });

  it.each([
    { name: 'empty', ids: [] },
    { name: 'invalid id', ids: ['local', 'bad/id'] },
    { name: 'trailing newline', ids: ['local\n'] },
    { name: 'sparse array', ids: new Array<string>(1) },
    { name: 'over limit', ids: Array<string>(101).fill('local') },
  ])('rejects the entire invalid batch without reading the database: $name', async ({ ids }) => {
      const { query, getDbClient } = fixture();
      expect(await query(ids)).toStrictEqual({
        ok: false, errorCode: 'INVALID_REQUEST', message: expect.any(String),
      });
      expect(getDbClient).not.toHaveBeenCalled();
  });

  it('returns a structured read error without exposing database details', async () => {
    const { query } = fixture();
    sqlite.exec('DROP TABLE sessions');
    expect(await query(['local'])).toStrictEqual({
      ok: false, errorCode: 'INTERNAL', message: '无法读取会话状态',
    });
  });

  it.each([
    ['reapproval', 'PERMISSION_DENIED'],
    ['disable', 'PERMISSION_DENIED'],
    ['owner switch', 'HOST_NOT_READY'],
    ['sender destroyed', 'HOST_NOT_READY'],
  ])('discards an in-flight result on %s', async (change, errorCode) => {
    const { query } = fixture();
    const pending = query(['local']);
    if (change === 'reapproval') ghost!.approval = { state: 'approved', revision: 'new' };
    if (change === 'disable') ghost!.enabled = false;
    if (change === 'owner switch') isStable = false;
    if (change === 'sender destroyed') senderAlive = false;
    expect(await pending).toStrictEqual({ ok: false, errorCode, message: expect.any(String) });
  });

  it('does not read a database belonging to a different owner', async () => {
    const { query, getDbClient } = fixture();
    dbOwner = 'previous-owner';
    expect(await query(['local'])).toStrictEqual({
      ok: false, errorCode: 'HOST_NOT_READY', message: expect.any(String),
    });
    expect(getDbClient).not.toHaveBeenCalled();
  });

  it('uses the documented feature check to distinguish old Desktop from a failed query', async () => {
    const { bridge } = fixture();
    const docs = readFileSync(new URL('../../../../resources/system-skills/cindy-plugin-creator/references/plugin-event-subscriptions.md', import.meta.url), 'utf8');
    const example = docs.match(/\x60\x60\x60js\n(async function reconcileSessionStates[\s\S]*?)\n\x60\x60\x60/)?.[1];
    expect(example).toBeDefined();
    const reconcile = (cindy: Partial<typeof bridge>) =>
      runInNewContext(`${example}\nreconcileSessionStates`, { cindy });
    expect(await reconcile({ send: bridge.send })(['local'])).toEqual({ outcome: 'unsupported' });
    expect(await reconcile(bridge)(['local'])).toEqual({
      outcome: 'ok', sessions: [{ sessionId: 'local', status: 'active' }],
    });
    ghost!.enabled = false;
    expect(await reconcile(bridge)(['local'])).toEqual({
      outcome: 'failed', errorCode: 'PERMISSION_DENIED',
    });
  });
});
