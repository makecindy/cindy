/**
 * sessionSpendBroadcaster tests for session-level context snapshot persistence.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createDrizzleProxy } from '../localDb/client/drizzleProxy';
import type { DbTransport } from '../localDb/client/DbTransport';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const runMock = vi.fn();
const getMock = vi.fn();
const setMock = vi.fn();
let snapshotDb: ReturnType<typeof createDrizzleProxy> | undefined;

vi.mock('../localDb/client/current', () => ({
  getDbClient: () => ({
    drizzle: snapshotDb ?? {
      update: vi.fn(() => ({
        set: setMock,
      })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            get: getMock,
          })),
        })),
      })),
    },
  }),
}));

import { recordSessionContextSnapshot } from '../sessionSpendBroadcaster.js';

beforeEach(() => {
  vi.clearAllMocks();
  runMock.mockResolvedValue(undefined);
  getMock.mockResolvedValue({ contextTokens: 0, contextWindow: 200000 });
  setMock.mockReturnValue({
    where: vi.fn(() => ({
      run: runMock,
    })),
  });
});

describe('recordSessionContextSnapshot', () => {
  // #10198: previous coverage checked only .set arguments, not the persisted
  // snapshot a reopened task reads (standard tier, SQLite, no file/network IO).
  it('reads the lower compaction watermark from a reopened database', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, context_tokens INTEGER,
      context_window INTEGER, context_window_runtime INTEGER);
      INSERT INTO sessions VALUES ('compacting', 579216, 272000, 272000);`);
    const transport: DbTransport = {
      async send<R>(op: string, args: unknown): Promise<R> {
        const { sql, params } = args as { sql: string; params: unknown[] };
        const statement = sqlite.prepare(sql);
        return (op === 'run' ? statement.run(...params)
          : op === 'rawGet' ? statement.raw().get(...params)
          : statement.raw().all(...params)) as R;
      },
      on() {}, onTerminated() {}, async close() {},
    };
    snapshotDb = createDrizzleProxy(transport);
    try {
      await recordSessionContextSnapshot('compacting', 46703, 272000);
      const reopened = new Database(sqlite.serialize());
      try {
        expect(reopened.prepare('SELECT context_tokens, context_window, context_window_runtime FROM sessions').get()).toEqual({
          context_tokens: 46703, context_window: 272000, context_window_runtime: 272000,
        });
      } finally { reopened.close(); }
    } finally {
      snapshotDb = undefined;
      sqlite.close();
    }
  });

  it('does not certify an old catalog window when a status only supplies tokens', async () => {
    await recordSessionContextSnapshot('s1', 42, 0);
    expect(setMock).toHaveBeenCalledWith({ contextTokens: 42 });
  });

  it('skips 0/0 placeholder snapshots from interrupted compact turns', async () => {
    await recordSessionContextSnapshot('s1', 0, 0);

    expect(setMock).not.toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('persists zero context tokens when the context window is authoritative', async () => {
    await recordSessionContextSnapshot('s1', 0, 200000);

    expect(setMock).toHaveBeenCalledWith({ contextTokens: 0, contextWindow: 200000, contextWindowRuntime: 200000 });
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledTimes(1);
  });
});
