/**
 * #8486: production writeCard + message writer/mapper + PR store in memory SQLite.
 * Existing ipc.test.ts mocks message persistence; store tests bypass writeCard.
 * Minimal failure: a pending card completes with one public PR after backfill.
 * Observe persisted associations, public broadcasts and rejected stale writes.
 * Standard tier: no account, filesystem, network or Electron process is used.
 * A separate file is needed because ipc.test.ts replaces the DB and message writer.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { tmpdir } from 'node:os';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpAppsHostDeps } from '../host.js';
import type { McpAppRecord } from '../../../shared/mcpApps.js';
import type { DbClient } from '../../localDb/client/DbClient.js';

const h = vi.hoisted(() => ({
  deps: undefined as McpAppsHostDeps | undefined,
  broadcast: vi.fn(),
  changed: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../host.js', () => ({
  appServerRevision: vi.fn(),
  McpAppsHost: class {
    constructor(deps: McpAppsHostDeps) { h.deps = deps; }
  },
}));
vi.mock('../runtime.js', () => ({ setMcpAppsHost: vi.fn(), readAppServer: vi.fn() }));
vi.mock('../../secrets/providerSecretStore.js', () => ({ getMcpAppRevisionKey: vi.fn() }));
vi.mock('../sandboxProtocol.js', () => ({
  supplyMcpAppDocument: vi.fn(), removeMcpAppDocument: vi.fn(),
  assertMcpAppDocumentCaller: vi.fn(), setMcpAppCallerCleanup: vi.fn(),
  setMcpAppFileReader: vi.fn(),
}));
vi.mock('../../device-link/index.js', () => ({ remoteInvoke: vi.fn(), getRemoteLinkCloseEpoch: () => 0 }));
vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseDeviceLink: true }) }));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: vi.fn() }));
vi.mock('../../device-link/invoke-context', () => ({
  getDeviceLinkInvokeContext: () => undefined, isDeviceLinkInvoke: () => false,
}));
vi.mock('../../device-link/broadcast-tap', () => ({
  captureDataOwnerBroadcastScope: () => null,
  getSafeDataOwnerPushStamp: () => undefined,
  tapWindowBroadcast: h.broadcast,
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() }),
}));
vi.mock('../../session-import/legacy', () => ({ adoptLegacySessionBeforeOpen: vi.fn() }));
vi.mock('../../embedders/chat-history-embedder', () => ({ onMessageCreated: async () => {} }));
vi.mock('../../cindy-media/chatAttachments', () => ({
  collectCindyMediaHashes: () => [], commitMessageMediaRefs: async () => {},
}));
vi.mock('../../cindy-media/taskImageDelivery', () => ({
  restoreTaskImageRows: async (_client: unknown, rows: unknown[]) => rows,
}));
vi.mock('../../cindy-media/generatedImageRecovery', () => ({ recoverGeneratedImagesForHistory: vi.fn() }));
vi.mock('../../maker-ipc/botRemoteResourceInvalidation', () => ({
  scheduleBotRemoteResourceChangedForSession: vi.fn(),
}));

import * as schema from '../../localDb/schema.js';
import { messages, migrationMeta, sessionPrRefs, sessions } from '../../localDb/schema.js';
import { setCurrentDbClient, clearCurrentDbClient } from '../../localDb/client/current.js';
import { tx } from '../../localDb/worker/opHandlers/tx.js';
import { createMessage } from '../../localDb/ipc/messages.js';
import {
  ensurePrRefsBackfill, listPrRefs, managePrRefs, setPrRefsChangedListener,
} from '../../git-context/prRefsStore.js';
import { registerMcpAppsIpc } from '../ipc.js';

const sqlite = new Database(':memory:');
const db = drizzle(sqlite, { schema });
for (const table of [sessions, messages, sessionPrRefs, migrationMeta] as SQLiteTable[]) {
  const config = getTableConfig(table);
  sqlite.exec(`CREATE TABLE "${config.name}" (${config.columns.map(c =>
    `"${c.name}" ${c.getSQLType()}${c.primary ? ' PRIMARY KEY' : ''}`).join(', ')})`);
}
sqlite.exec('CREATE UNIQUE INDEX pr_identity ON session_pr_refs(session_id,provider,host,owner,repo,pr_number)');
sqlite.exec('CREATE UNIQUE INDEX message_identity ON messages(session_id,client_id)');
let client: DbClient;
const url = (number: number) => `https://github.com/example/repo/pull/${number}`;
const pending: McpAppRecord = {
  version: 1, serverId: 'example', serverRevision: 'revision', resourceUri: 'ui://example/app',
  tool: { name: 'form', inputSchema: { type: 'object' } },
  arguments: { privateUrl: url(91) },
};
const completed = (text: string): McpAppRecord => ({
  ...pending,
  result: {
    content: [{ type: 'text', text, _meta: { privateUrl: url(92) } }],
    structuredContent: { privateUrl: url(93) }, _meta: { privateUrl: url(94) },
  },
});
const write = (record: McpAppRecord) => h.deps!.writeCard('task', 'card', record);
const refs = async () => (await listPrRefs('task')).map(ref => ref.prNumber).sort((a, b) => a - b);

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  sqlite.exec('DELETE FROM sessions; DELETE FROM messages; DELETE FROM session_pr_refs; DELETE FROM migration_meta;');
  client = {
    drizzle: db,
    query: async <T>(sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(...params) as T[],
    queryOne: async <T>(sql: string, params: unknown[] = []) => sqlite.prepare(sql).get(...params) as T | undefined,
    exec: async (sql, params = []) => sqlite.prepare(sql).run(...params),
    tx: async (name: string, args: unknown) => tx(sqlite, { name, args }) as never,
    vecAvailable: false, dispose: async () => {},
  };
  setCurrentDbClient(client, 'test');
  db.insert(sessions).values({ id: 'task', title: 'fixture', workingDir: tmpdir(),
    source: 'desktop', status: 'active', createdAt: 1, updatedAt: 1 }).run();
  setPrRefsChangedListener(h.changed);
  // Complete the current production backfill before any App result exists.
  await ensurePrRefsBackfill();
  registerMcpAppsIpc(async () => {}, async () => ({ kind: 'permission', behavior: 'allow' }));
});
afterAll(() => { clearCurrentDbClient(client); sqlite.close(); });

describe('MCP App result PR associations after backfill', () => {
  it('associates public completion, replaces A with B and removes links without another backfill', async () => {
    await write(pending);
    expect(await refs()).toEqual([]);
    await write(completed(url(1)));
    expect(await refs()).toEqual([1]);
    expect(h.changed).toHaveBeenLastCalledWith('task');
    expect(h.broadcast).toHaveBeenCalledWith('local-db:messages:created',
      expect.objectContaining({ message: expect.objectContaining({
        content: { mcpAppHistory: { version: 1, title: 'form', text: url(1) } },
      }) }));
    await write(completed(url(2)));
    expect(await refs()).toEqual([2]);
    await write(completed('Saved'));
    expect(await refs()).toEqual([]);
    expect(h.warn).not.toHaveBeenCalled();
    const row = db.select().from(messages).where(eq(messages.clientId, 'card')).get()!;
    expect(JSON.parse(row.content)).toEqual({ mcpApp: completed('Saved') });
  });

  it('keeps other visible mentions, manual associations and removal tombstones during replacement', async () => {
    await write(pending);
    await write(completed(url(1)));
    const verify = async () => {};
    await managePrRefs('task', { action: 'add', url: url(2) }, verify);
    const added = await managePrRefs('task', { action: 'add', url: url(3) }, verify);
    await managePrRefs('task', { action: 'remove', id: added.find(ref => ref.prNumber === 3)!.id }, verify);
    await createMessage('task', { clientId: 'other', role: 'user', content: url(1) });
    await write(completed(`${url(3)} ${url(4)}`));
    expect(await refs()).toEqual([1, 2, 4]);
    const tombstone = db.select().from(sessionPrRefs).where(eq(sessionPrRefs.prNumber, 3)).get()!;
    expect(tombstone.removedAt).not.toBeNull();
    db.delete(messages).where(eq(messages.clientId, 'other')).run();
    await write(completed('Saved'));
    expect(await refs()).toEqual([2]);
    expect(db.select().from(sessionPrRefs).where(eq(sessionPrRefs.prNumber, 3)).get()).toEqual(tombstone);
    expect(h.warn).not.toHaveBeenCalled();
  });

  it.each(['clear', 'rewind', 'delete', 'revision', 'archive'] as const)(
    'rejects a late completion after %s without publishing an association', async invalidation => {
      await write(pending);
      if (invalidation === 'clear') db.update(sessions).set({ clearedAt: Date.now() + 1 }).run();
      if (invalidation === 'rewind') db.update(messages).set({ rewindAt: Date.now() }).run();
      if (invalidation === 'delete') db.delete(messages).run();
      if (invalidation === 'revision') db.update(messages).set({
        content: JSON.stringify({ mcpApp: { ...pending, serverRevision: 'new' } }),
      }).run();
      if (invalidation === 'archive') db.update(sessions).set({ status: 'archived' }).run();
      h.changed.mockClear();
      h.broadcast.mockClear();
      await expect(write(completed(url(5)))).rejects.toThrow(/MCP_APP_(?:CARD|SESSION)_UNAVAILABLE/);
      expect(await refs()).toEqual([]);
      expect(h.changed).not.toHaveBeenCalled();
      expect(h.broadcast).not.toHaveBeenCalled();
    },
  );

  it('does not publish associations when ownership changes after the message broadcast', async () => {
    await write(pending);
    h.changed.mockClear();
    h.broadcast.mockImplementationOnce(() => setCurrentDbClient(client, 'test'));
    await write(completed(url(6)));
    expect(await refs()).toEqual([]);
    expect(h.changed).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
  });
});
