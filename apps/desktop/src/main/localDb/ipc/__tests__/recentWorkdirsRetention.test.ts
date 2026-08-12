/**
 * recentWorkdirsRetention.test.ts — 持久项目目录写入契约。
 *
 * 项目目录与会话生命周期解耦：upsert 只新增或刷新时间，任何自动容量淘汰都会让
 * 已清空会话的项目再次从侧栏消失。条目只由显式 remove IPC 删除。
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DbTransport } from '../../client/DbTransport.js';

const h = vi.hoisted(() => ({
  sqlite: null as InstanceType<typeof import('better-sqlite3')> | null,
  client: null as {
    drizzle: unknown;
    tx: (name: string, args: unknown) => Promise<unknown>;
  } | null,
  warns: [] as unknown[],
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => h.warns.push(args),
    error: vi.fn(),
  }),
}));
vi.mock('../../client/current', () => ({
  getDbClient: () => h.client,
}));

import { createDrizzleProxy } from '../../client/drizzleProxy';
import { upsertRecentWorkdir } from '../recentWorkdirs';

function createTransport(): DbTransport {
  return {
    send: async (op: string, args?: unknown) => {
      const { sql: text, params = [] } = (args ?? {}) as { sql: string; params?: unknown[] };
      const stmt = h.sqlite!.prepare(text);
      if (op === 'query') return stmt.all(...(params as never[]));
      if (op === 'queryOne') return stmt.get(...(params as never[]));
      if (op === 'rawAll') return stmt.raw().all(...(params as never[]));
      if (op === 'rawGet') return stmt.raw().get(...(params as never[]));
      if (op === 'run' || op === 'exec') return stmt.run(...(params as never[]));
      throw new Error(`unexpected op: ${op}`);
    },
    on: () => {},
    onTerminated: () => {},
    close: async () => {},
  } as unknown as DbTransport;
}

function rows(): Array<{ path: string; last_used_at: number }> {
  return h
    .sqlite!.prepare('SELECT path, last_used_at FROM recent_workdirs ORDER BY last_used_at DESC')
    .all() as Array<{ path: string; last_used_at: number }>;
}

beforeEach(() => {
  h.sqlite?.close();
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE recent_workdirs (
      path TEXT PRIMARY KEY NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE INDEX idx_recent_workdirs_last_used_at ON recent_workdirs(last_used_at);
  `);
  h.sqlite = sqlite;
  h.warns = [];
  h.client = {
    drizzle: createDrizzleProxy(() => createTransport()),
    tx: async (name: string, args: unknown) => {
      if (name !== 'recentWorkdirs.mergeWindowsIdentity') throw new Error(`unexpected tx: ${name}`);
      const input = args as { path: string; lastUsedAt: number };
      return h.sqlite!.transaction(() => {
        h.sqlite!.prepare(
          `INSERT INTO recent_workdirs (path, last_used_at)
             SELECT COALESCE(
                      (SELECT path FROM recent_workdirs
                       WHERE LOWER(path) = LOWER(?)
                       ORDER BY last_used_at DESC, rowid ASC LIMIT 1),
                      ?
                    ),
                    MAX(?, COALESCE(MAX(last_used_at), 0))
             FROM recent_workdirs
             WHERE LOWER(path) = LOWER(?)
             ON CONFLICT(path) DO UPDATE SET
               last_used_at = MAX(recent_workdirs.last_used_at, excluded.last_used_at)`,
        ).run(input.path, input.path, input.lastUsedAt, input.path);
        h.sqlite!
          .prepare(
            `DELETE FROM recent_workdirs
             WHERE LOWER(path) = LOWER(?)
               AND path != (
                 SELECT path FROM recent_workdirs
                 WHERE LOWER(path) = LOWER(?)
                 ORDER BY last_used_at DESC, rowid ASC LIMIT 1
               )`,
          )
          .run(input.path, input.path);
      })();
    },
  };
});

describe('upsertRecentWorkdir retention', () => {
  it('retains every explicitly added project even after the list grows beyond ten', async () => {
    const total = 14;
    for (let i = 0; i < total; i += 1) {
      await upsertRecentWorkdir(`/Users/dash/Code/project-${i}`, 1_700_000_000_000 + i * 1_000);
    }

    expect(rows()).toHaveLength(total);
    expect(rows().map((row) => row.path)).toEqual(
      Array.from({ length: total }, (_, index) => `/Users/dash/Code/project-${total - 1 - index}`),
    );
    expect(h.warns).toEqual([]);
  });

  it('refreshes an existing project without inserting a duplicate or regressing activity time', async () => {
    await upsertRecentWorkdir('/Users/dash/Code/project-a', 1_700_000_000_000);
    await upsertRecentWorkdir('/Users/dash/Code/project-a', 1_700_000_009_000);
    await upsertRecentWorkdir('/Users/dash/Code/project-a', 1_700_000_001_000);

    expect(rows()).toEqual([
      { path: '/Users/dash/Code/project-a', last_used_at: 1_700_000_009_000 },
    ]);
    expect(h.warns).toEqual([]);
  });

  it('deduplicates Windows drive and UNC casing while preserving the stable display path', async () => {
    await upsertRecentWorkdir('D:\\Work\\Project-A', 3_000, 'win32');
    await upsertRecentWorkdir('d:/work/project-a/', 2_000, 'win32');
    await upsertRecentWorkdir('\\\\Server\\Share\\Project-B', 4_000, 'win32');
    await upsertRecentWorkdir('//server/share/project-b/', 5_000, 'win32');

    expect(rows()).toEqual([
      { path: '//Server/Share/Project-B', last_used_at: 5_000 },
      { path: 'D:/Work/Project-A', last_used_at: 3_000 },
    ]);
  });

  it('keeps POSIX path casing distinct', async () => {
    await upsertRecentWorkdir('/Workspace/Project-A', 1_000, 'linux');
    await upsertRecentWorkdir('/workspace/project-a', 2_000, 'linux');

    expect(rows()).toHaveLength(2);
  });
});
