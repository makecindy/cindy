/**
 * rightSidebarTabs IPC handler unit tests —— 验证 list / ensure-singleton / upsert / close /
 * setActive / reorder 的正路径 + 关键错误码(RIGHT_SIDEBAR_TOO_MANY_TABS /
 * RIGHT_SIDEBAR_STATE_TOO_LARGE / NOT_FOUND / INVALID_PARAMS)。规则 14:main 业务必带测。
 *
 * 用 in-memory better-sqlite3 + drizzle 驱动真 SQL,避免 mock 整套 drizzle 链路。
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { rightSidebarTabs, sessions } from '../../schema.js';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));
vi.mock('../../client/current.js', () => ({
  getDbClient: () => ({ drizzle: h.db }),
}));

import { registerRightSidebarTabsIpc } from '../rightSidebarTabs.js';
import { assertTrustedAppRendererEvent } from '../../../security/trustedAppRenderer.js';

function createDb(): Database.Database {
  const sqlite = new Database(':memory:');
  // 与 schema.ts 对齐(测试只需 sessions PK + right_sidebar_tabs 全列)
  sqlite.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE right_sidebar_tabs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      position INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX right_sidebar_tabs_session_idx ON right_sidebar_tabs (session_id, position);
    CREATE UNIQUE INDEX right_sidebar_tabs_subagents_singleton_idx
      ON right_sidebar_tabs (session_id) WHERE kind = 'subagents';
  `);
  sqlite.prepare(`INSERT INTO sessions (id) VALUES (?)`).run('s1');
  sqlite.prepare(`INSERT INTO sessions (id) VALUES (?)`).run('s2');
  h.db = drizzle(sqlite, { schema: { rightSidebarTabs, sessions } });
  return sqlite;
}

interface ListResp {
  tabs: Array<{
    id: string;
    sessionId: string;
    kind: string;
    position: number;
    state: unknown;
    isActive: boolean;
  }>;
  activeTabId: string | null;
  persistable?: boolean;
}

async function invoke<T>(channel: string, payload: unknown): Promise<T> {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`handler not registered: ${channel}`);
  return (await handler({}, payload)) as T;
}

describe('rightSidebarTabs IPC', () => {
  beforeEach(() => {
    vi.mocked(assertTrustedAppRendererEvent).mockReset();
    h.handlers.clear();
    createDb();
    registerRightSidebarTabsIpc();
  });

  it('rejects every read and write handler before parsing untrusted payloads', async () => {
    vi.mocked(assertTrustedAppRendererEvent).mockImplementation(() => {
      throw new Error('UNTRUSTED_RENDERER');
    });
    const channels = [
      'local-db:right-sidebar-tabs:list',
      'local-db:right-sidebar-tabs:ensure-singleton',
      'local-db:right-sidebar-tabs:upsert',
      'local-db:right-sidebar-tabs:close',
      'local-db:right-sidebar-tabs:setActive',
      'local-db:right-sidebar-tabs:reorder',
    ];

    for (const channel of channels) {
      await expect(invoke(channel, undefined)).rejects.toThrow('UNTRUSTED_RENDERER');
    }
    expect(assertTrustedAppRendererEvent).toHaveBeenCalledTimes(channels.length);
  });

  describe(':list', () => {
    it('empty session returns empty tabs + null activeTabId', async () => {
      const result = await invoke<ListResp>('local-db:right-sidebar-tabs:list', {
        sessionId: 's1',
      });
      expect(result.tabs).toEqual([]);
      expect(result.activeTabId).toBeNull();
      expect(result.persistable).toBe(true);
    });

    it('unknown session returns a non-persistable empty bucket for remote sessions', async () => {
      const result = await invoke<ListResp>('local-db:right-sidebar-tabs:list', {
        sessionId: 'remote-s1',
      });
      expect(result.tabs).toEqual([]);
      expect(result.activeTabId).toBeNull();
      expect(result.persistable).toBe(false);
    });

    it('returns tabs ordered by position with parsed JSON state', async () => {
      await invoke('local-db:right-sidebar-tabs:upsert', {
        id: 't2',
        sessionId: 's1',
        kind: 'web-browser',
        position: 1,
        state: { url: 'https://example.com' },
      });
      await invoke('local-db:right-sidebar-tabs:upsert', {
        id: 't1',
        sessionId: 's1',
        kind: 'file-browser',
        position: 0,
        state: { selectedFilePath: 'a.ts' },
      });
      const result = await invoke<ListResp>('local-db:right-sidebar-tabs:list', {
        sessionId: 's1',
      });
      expect(result.tabs.map((t) => t.id)).toEqual(['t1', 't2']);
      expect(result.tabs[0].state).toEqual({ selectedFilePath: 'a.ts' });
      expect(result.tabs[1].state).toEqual({ url: 'https://example.com' });
    });

    it('different sessions do not cross-leak', async () => {
      await invoke('local-db:right-sidebar-tabs:upsert', {
        id: 't1',
        sessionId: 's1',
        kind: 'file-browser',
        position: 0,
      });
      await invoke('local-db:right-sidebar-tabs:upsert', {
        id: 't2',
        sessionId: 's2',
        kind: 'web-browser',
        position: 0,
      });
      const r1 = await invoke<ListResp>('local-db:right-sidebar-tabs:list', { sessionId: 's1' });
      const r2 = await invoke<ListResp>('local-db:right-sidebar-tabs:list', { sessionId: 's2' });
      expect(r1.tabs).toHaveLength(1);
      expect(r1.tabs[0].id).toBe('t1');
      expect(r2.tabs).toHaveLength(1);
      expect(r2.tabs[0].id).toBe('t2');
    });
  });

  describe(':upsert', () => {
    it('inserts new tab', async () => {
      await invoke('local-db:right-sidebar-tabs:upsert', {
        id: 't1',
        sessionId: 's1',
        kind: 'file-browser',
        position: 0,
        state: { foo: 'bar' },
      });
      const result = await invoke<ListResp>('local-db:right-sidebar-tabs:list', {
        sessionId: 's1',
      });
      expect(result.tabs).toHaveLength(1);
      expect(result.tabs[0].state).toEqual({ foo: 'bar' });
    });

    it('updates existing tab on conflict', async () => {
      await invoke('local-db:right-sidebar-tabs:upsert', {
        id: 't1',
        sessionId: 's1',
        kind: 'file-browser',
        position: 0,
        state: { v: 1 },
      });
      await invoke('local-db:right-sidebar-tabs:upsert', {
        id: 't1',
        sessionId: 's1',
        kind: 'file-browser',
        position: 5,
        state: { v: 2 },
      });
      const result = await invoke<ListResp>('local-db:right-sidebar-tabs:list', {
        sessionId: 's1',
      });
      expect(result.tabs).toHaveLength(1);
      expect(result.tabs[0].position).toBe(5);
      expect(result.tabs[0].state).toEqual({ v: 2 });
    });

    it('rejects 21st tab with RIGHT_SIDEBAR_TOO_MANY_TABS', async () => {
      for (let i = 0; i < 20; i++) {
        await invoke('local-db:right-sidebar-tabs:upsert', {
          id: `t${i}`,
          sessionId: 's1',
          kind: 'file-browser',
          position: i,
        });
      }
      await expect(
        invoke('local-db:right-sidebar-tabs:upsert', {
          id: 't20',
          sessionId: 's1',
          kind: 'file-browser',
          position: 20,
        }),
      ).rejects.toThrow(/RIGHT_SIDEBAR_TOO_MANY_TABS/);
    });

    it('rejects state JSON > 16KB with RIGHT_SIDEBAR_STATE_TOO_LARGE', async () => {
      const big = 'x'.repeat(20 * 1024);
      await expect(
        invoke('local-db:right-sidebar-tabs:upsert', {
          id: 't1',
          sessionId: 's1',
          kind: 'web-browser',
          position: 0,
          state: { huge: big },
        }),
      ).rejects.toThrow(/RIGHT_SIDEBAR_STATE_TOO_LARGE/);
    });

    it.each([
      ['cyclic state', () => {
        const state: Record<string, unknown> = {};
        state.self = state;
        return state;
      }],
      ['BigInt state', () => ({ value: BigInt(1) })],
      ['top-level function state', () => () => undefined],
    ])('rejects non-JSON-serializable %s with INVALID_PARAMS', async (_name, makeState) => {
      await expect(
        invoke('local-db:right-sidebar-tabs:upsert', {
          id: 't1',
          sessionId: 's1',
          kind: 'web-browser',
          position: 0,
          state: makeState(),
        }),
      ).rejects.toThrow(/\[INVALID_PARAMS\] tab state must be JSON-serializable/);
    });

    it('rejects invalid params (missing sessionId)', async () => {
      await expect(
        invoke('local-db:right-sidebar-tabs:upsert', {
          id: 't1',
          kind: 'file-browser',
          position: 0,
        }),
      ).rejects.toThrow(/INVALID_PARAMS/);
    });
  });

  describe(':ensure-singleton', () => {
    it('rejects an untrusted renderer before accepting persistent state', async () => {
      vi.mocked(assertTrustedAppRendererEvent).mockImplementationOnce(() => {
        throw new Error('UNTRUSTED_RENDERER');
      });

      await expect(
        invoke('local-db:right-sidebar-tabs:ensure-singleton', {
          sessionId: 's1',
          kind: 'subagents',
          state: { selectedRunId: 'must-not-persist' },
        }),
      ).rejects.toThrow('UNTRUSTED_RENDERER');
      const listed = await invoke<ListResp>('local-db:right-sidebar-tabs:list', {
        sessionId: 's1',
      });
      expect(listed.tabs).toEqual([]);
    });

    it('returns one canonical Subagents tab across concurrent callers without activating it', async () => {
      const [first, second] = await Promise.all([
        invoke<{ tab: ListResp['tabs'][number]; created: boolean }>(
          'local-db:right-sidebar-tabs:ensure-singleton',
          { sessionId: 's1', kind: 'subagents', state: { selectedRunId: null } },
        ),
        invoke<{ tab: ListResp['tabs'][number]; created: boolean }>(
          'local-db:right-sidebar-tabs:ensure-singleton',
          { sessionId: 's1', kind: 'subagents', state: { selectedRunId: 'ignored-race' } },
        ),
      ]);

      expect(first.tab.id).toBe(second.tab.id);
      expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
      const listed = await invoke<ListResp>('local-db:right-sidebar-tabs:list', {
        sessionId: 's1',
      });
      expect(listed.tabs).toHaveLength(1);
      expect(listed.tabs[0]).toMatchObject({ kind: 'subagents', isActive: false });
      expect(listed.activeTabId).toBeNull();
    });

    it('fails closed for unknown sessions and non-singleton kinds', async () => {
      await expect(
        invoke('local-db:right-sidebar-tabs:ensure-singleton', {
          sessionId: 'remote-s1',
          kind: 'subagents',
        }),
      ).resolves.toMatchObject({ tab: null, persistable: false });
      await expect(
        invoke('local-db:right-sidebar-tabs:ensure-singleton', {
          sessionId: 's1',
          kind: 'web-browser',
        }),
      ).rejects.toThrow(/INVALID_PARAMS/);
    });
  });

  describe(':close', () => {
    it('deletes tab', async () => {
      await invoke('local-db:right-sidebar-tabs:upsert', {
        id: 't1',
        sessionId: 's1',
        kind: 'file-browser',
        position: 0,
      });
      await invoke('local-db:right-sidebar-tabs:close', { id: 't1' });
      const result = await invoke<ListResp>('local-db:right-sidebar-tabs:list', {
        sessionId: 's1',
      });
      expect(result.tabs).toHaveLength(0);
    });

    it('throws NOT_FOUND when id missing', async () => {
      await expect(
        invoke('local-db:right-sidebar-tabs:close', { id: 'nonexistent' }),
      ).rejects.toThrow(/NOT_FOUND/);
    });
  });

  describe(':setActive', () => {
    beforeEach(async () => {
      await invoke('local-db:right-sidebar-tabs:upsert', {
        id: 't1',
        sessionId: 's1',
        kind: 'file-browser',
        position: 0,
      });
      await invoke('local-db:right-sidebar-tabs:upsert', {
        id: 't2',
        sessionId: 's1',
        kind: 'web-browser',
        position: 1,
      });
    });

    it('sets active and clears previous', async () => {
      await invoke('local-db:right-sidebar-tabs:setActive', { sessionId: 's1', id: 't1' });
      const r1 = await invoke<ListResp>('local-db:right-sidebar-tabs:list', { sessionId: 's1' });
      expect(r1.activeTabId).toBe('t1');
      await invoke('local-db:right-sidebar-tabs:setActive', { sessionId: 's1', id: 't2' });
      const r2 = await invoke<ListResp>('local-db:right-sidebar-tabs:list', { sessionId: 's1' });
      expect(r2.activeTabId).toBe('t2');
      // 同 session 最多 1 行 is_active=true
      expect(r2.tabs.filter((t) => t.isActive)).toHaveLength(1);
    });

    it('id=null clears active', async () => {
      await invoke('local-db:right-sidebar-tabs:setActive', { sessionId: 's1', id: 't1' });
      await invoke('local-db:right-sidebar-tabs:setActive', { sessionId: 's1', id: null });
      const result = await invoke<ListResp>('local-db:right-sidebar-tabs:list', {
        sessionId: 's1',
      });
      expect(result.activeTabId).toBeNull();
      expect(result.tabs.filter((t) => t.isActive)).toHaveLength(0);
    });

    it('throws NOT_FOUND for tab not in session', async () => {
      await expect(
        invoke('local-db:right-sidebar-tabs:setActive', { sessionId: 's2', id: 't1' }),
      ).rejects.toThrow(/NOT_FOUND/);
    });
  });

  describe(':reorder', () => {
    it('rewrites positions per orderedIds', async () => {
      await invoke('local-db:right-sidebar-tabs:upsert', {
        id: 'a',
        sessionId: 's1',
        kind: 'file-browser',
        position: 0,
      });
      await invoke('local-db:right-sidebar-tabs:upsert', {
        id: 'b',
        sessionId: 's1',
        kind: 'file-browser',
        position: 1,
      });
      await invoke('local-db:right-sidebar-tabs:upsert', {
        id: 'c',
        sessionId: 's1',
        kind: 'file-browser',
        position: 2,
      });
      await invoke('local-db:right-sidebar-tabs:reorder', {
        sessionId: 's1',
        orderedIds: ['c', 'a', 'b'],
      });
      const result = await invoke<ListResp>('local-db:right-sidebar-tabs:list', {
        sessionId: 's1',
      });
      expect(result.tabs.map((t) => t.id)).toEqual(['c', 'a', 'b']);
      expect(result.tabs.map((t) => t.position)).toEqual([0, 1, 2]);
    });

    it('rejects non-string id in orderedIds', async () => {
      await expect(
        invoke('local-db:right-sidebar-tabs:reorder', {
          sessionId: 's1',
          orderedIds: ['a', 42, 'b'],
        }),
      ).rejects.toThrow(/INVALID_PARAMS/);
    });
  });

  describe('cross-session isolation', () => {
    it('reorder one session does not affect another', async () => {
      await invoke('local-db:right-sidebar-tabs:upsert', {
        id: 's1-a',
        sessionId: 's1',
        kind: 'file-browser',
        position: 0,
      });
      await invoke('local-db:right-sidebar-tabs:upsert', {
        id: 's1-b',
        sessionId: 's1',
        kind: 'file-browser',
        position: 1,
      });
      await invoke('local-db:right-sidebar-tabs:upsert', {
        id: 's2-a',
        sessionId: 's2',
        kind: 'web-browser',
        position: 0,
      });
      await invoke('local-db:right-sidebar-tabs:reorder', {
        sessionId: 's1',
        orderedIds: ['s1-b', 's1-a'],
      });
      const r2 = await invoke<ListResp>('local-db:right-sidebar-tabs:list', { sessionId: 's2' });
      expect(r2.tabs).toHaveLength(1);
      expect(r2.tabs[0].id).toBe('s2-a');
      expect(r2.tabs[0].position).toBe(0);
    });
  });
});
