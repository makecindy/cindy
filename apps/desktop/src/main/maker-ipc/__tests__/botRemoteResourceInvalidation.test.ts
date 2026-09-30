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
}));

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  getSafeDataOwnerPushStamp: () => ({ dataOwnerId: h.ownerScope, epoch: 1 }),
  tapWindowBroadcast: h.tap,
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.ownerScope,
  isAppSessionBoundaryPending: () => h.boundaryPending,
}));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
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
  scheduleBotRemoteResourceChangedForSession,
} from '../botRemoteResourceInvalidation.js';

const sqlite = new Database(':memory:');
sqlite.exec("CREATE TABLE bot_session_links (id TEXT PRIMARY KEY, bot_id TEXT, session_id TEXT, role TEXT, archived_at INTEGER); INSERT INTO bot_session_links VALUES ('c', 'bot-1', 'session-1', 'canonical', NULL), ('d', 'bot-1', 'delegated', 'delegation', NULL), ('a', 'bot-1', 'archived', 'delegation', 1), ('h', 'bot-1', 'history', 'history', NULL)");
const db = drizzle(sqlite);
afterAll(() => sqlite.close());

describe('Bot remote resource message invalidation', () => {
  beforeEach(() => {
    h.boundaryPending = false;
    h.ownerScope = 'owner-a';
    h.limit.mockReset();
    h.limit.mockImplementation(async (limit: number) => db.select({ botId: botSessionLinks.botId }).from(botSessionLinks).where(h.condition).limit(limit).all());
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
});
