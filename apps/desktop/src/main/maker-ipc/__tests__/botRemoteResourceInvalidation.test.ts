import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { SQL } from 'drizzle-orm';
import { botSessionLinks } from '../../localDb/schema.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  boundaryPending: false,
  limit: vi.fn(),
  condition: undefined as SQL | undefined,
  ownerScope: 'owner-a',
  tap: vi.fn(),
  realDb: false,
  records: {} as Record<string, Record<string, unknown>>,
}));

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  getSafeDataOwnerPushStamp: () => ({ dataOwnerId: h.ownerScope, epoch: 1 }),
  tapWindowBroadcast: h.tap,
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.ownerScope,
  isAppSessionBoundaryPending: () => h.boundaryPending,
  ownerScopedUserDataPath: () => '/owner-a',
}));
vi.mock('../botTaskResponsibility.js', () => ({
  readTaskResponsibilities: async (_root: string, botId: string) => {
    if (botId === 'bot-damaged') throw new Error('Invalid task responsibility store');
    return h.records[botId] ?? {};
  },
}));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => (h.realDb ? { drizzle: db } : {
    drizzle: {
      select: () => ({
        from: () => ({
          where: (condition: SQL) => { h.condition = condition; return { limit: h.limit }; },
        }),
      }),
    },
  }),
}));

import {
  scheduleBotRemoteResourceChangedForFollowedSession,
  scheduleBotRemoteResourceChangedForSession,
} from '../botRemoteResourceInvalidation.js';

const sqlite = new Database(':memory:');
sqlite.exec("CREATE TABLE bot_session_links (id TEXT PRIMARY KEY, bot_id TEXT, session_id TEXT, role TEXT, archived_at INTEGER); INSERT INTO bot_session_links VALUES ('c', 'bot-1', 'session-1', 'canonical', NULL), ('d', 'bot-1', 'delegated', 'delegation', NULL), ('a', 'bot-1', 'archived', 'delegation', 1), ('h', 'bot-1', 'history', 'history', NULL)");
sqlite.exec("ALTER TABLE bot_session_links ADD COLUMN route_key TEXT; INSERT INTO bot_session_links VALUES ('g', 'bot-1', 'group-lane', 'group', NULL, 'group:group-1')");
sqlite.exec("CREATE TABLE bot_profiles (id TEXT PRIMARY KEY, status TEXT); INSERT INTO bot_profiles VALUES ('bot-starter', 'active'), ('bot-taker', 'active'), ('bot-other', 'active'), ('bot-damaged', 'active'), ('bot-paused', 'paused')");
sqlite.exec("CREATE TABLE bot_delegations (id TEXT PRIMARY KEY, requesting_bot_id TEXT, child_session_id TEXT); INSERT INTO bot_delegations VALUES ('d1', 'bot-starter', 'task-1')");
const db = drizzle(sqlite);
afterAll(() => sqlite.close());

describe('Bot remote resource message invalidation', () => {
  beforeEach(() => {
    h.boundaryPending = false;
    h.ownerScope = 'owner-a';
    h.limit.mockReset();
    h.limit.mockImplementation(async (limit: number) => db.select({ botId: botSessionLinks.botId, role: botSessionLinks.role, routeKey: botSessionLinks.routeKey }).from(botSessionLinks).where(h.condition).limit(limit).all());
    h.tap.mockReset();
  });

  it('coalesces canonical Session message writes into a generic collection invalidation', async () => {
    scheduleBotRemoteResourceChangedForSession('session-1');
    scheduleBotRemoteResourceChangedForSession('session-1');

    await vi.waitFor(() => expect(h.tap).toHaveBeenCalledOnce());
    expect(h.limit).toHaveBeenCalledWith(1);
    expect(h.tap).toHaveBeenCalledWith(
      'maker:remote-resources:changed',
      expect.objectContaining({ collectionId: 'teammates' }),
      expect.objectContaining({ dataOwnerId: 'owner-a' }),
    );
  });

  it('refreshes a group when its lane activity changes without a new message', async () => {
    scheduleBotRemoteResourceChangedForSession('group-lane');
    await vi.waitFor(() => expect(h.tap).toHaveBeenCalledOnce());
    expect(h.tap.mock.calls[0][1]).toMatchObject({
      collectionId: 'bot-groups', resourceRefs: [{ id: 'group-1' }],
    });
  });

  it('drops the deferred lookup across an account boundary', async () => {
    scheduleBotRemoteResourceChangedForSession('session-2');
    h.ownerScope = 'owner-b';

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.tap).not.toHaveBeenCalled();
  });

  it('invalidates delegation activity but excludes archival and history links', async () => {
    h.tap.mockClear();
    scheduleBotRemoteResourceChangedForSession('delegated');
    await vi.waitFor(() => expect(h.tap).toHaveBeenCalledOnce());
    expect(h.tap.mock.calls[0][1].resourceRefs[0].id).toBe('bot-1');
    h.tap.mockClear();
    scheduleBotRemoteResourceChangedForSession('archived');
    scheduleBotRemoteResourceChangedForSession('history');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.tap).not.toHaveBeenCalled();
  });

  // Roster rows link only open tasks: restoring one must refresh its followers' rows (#7066 review).
  it('refreshes the teammates that started or took over a task whose archive state changed', async () => {
    h.realDb = true;
    h.records = { 'bot-taker': { 'task-1': { responsible: true, updatedAt: '2026-10-24T00:00:00Z' } },
      'bot-paused': { 'task-1': { responsible: true, updatedAt: '2026-10-24T00:00:00Z' } } };
    try {
      scheduleBotRemoteResourceChangedForFollowedSession('task-1');
      await vi.waitFor(() => expect(h.tap).toHaveBeenCalledTimes(2));
      expect(h.tap.mock.calls.map((call) => call[1].resourceRefs[0].id).sort()).toEqual(['bot-starter', 'bot-taker']);
    } finally {
      h.realDb = false;
      h.records = {};
    }
  });
});
