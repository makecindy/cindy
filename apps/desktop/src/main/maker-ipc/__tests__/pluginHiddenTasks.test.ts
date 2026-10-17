/**
 * 插件详情页「后台任务」IPC 业务体:只列本插件经有效创建回执拥有、仍在后台且未删除的任务;
 * 显示到任务列表复用宿主写入口并复核归属。
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../../localDb/client/DbClient.js';
import {
  createPluginBackgroundTaskHandlers,
  revealAllPluginHiddenTasks,
  selectPluginHiddenTaskRows,
} from '../pluginHiddenTasks.js';

let sqlite: Database.Database;
let db: DbClient;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, status TEXT, source TEXT, hidden_at INTEGER, updated_at INTEGER);
    CREATE TABLE plugin_task_requests (id TEXT PRIMARY KEY, plugin_id TEXT, operation TEXT, target_id TEXT,
      request_key TEXT, fingerprint TEXT, payload TEXT, revision INTEGER, created_at INTEGER);
    INSERT INTO sessions VALUES
      ('bg-new', 'New', 'active', 'plugin', 5, 30),
      ('bg-old', 'Old', 'archived', 'plugin', 5, 10),
      ('shown', 'Shown', 'active', 'plugin', NULL, 40),
      ('deleted', 'Deleted', 'deleted', 'plugin', 5, 50),
      ('revoked', 'Revoked', 'active', 'plugin', 5, 60),
      ('other', 'Other plugin', 'active', 'plugin', 5, 70);
    INSERT INTO plugin_task_requests VALUES
      ('bg-new', 'demo', 'create', '', 'k1', 'f', '{"route":{}}', 0, 1),
      ('bg-old', 'demo', 'create', '', 'k2', 'f', '{"route":{}}', 0, 1),
      ('shown', 'demo', 'create', '', 'k3', 'f', '{}', 0, 1),
      ('deleted', 'demo', 'create', '', 'k4', 'f', '{}', 0, 1),
      ('revoked', 'demo', 'create', '', 'k5', 'f', '{"ownershipRevoked":true}', 0, 1),
      ('other', 'elsewhere', 'create', '', 'k6', 'f', '{}', 0, 1),
      ('send-1', 'demo', 'send', 'bg-new', 'k7', 'f', '{}', 0, 1);
  `);
  db = { drizzle: drizzle(sqlite) } as unknown as DbClient;
});

describe('plugin background task rows', () => {
  it('lists only owned, hidden, undeleted tasks of this plugin, newest first', async () => {
    expect((await selectPluginHiddenTaskRows(db, 'demo')).map((row) => row.taskId)).toEqual(['bg-new', 'bg-old']);
    expect((await selectPluginHiddenTaskRows(db, 'demo', { taskId: 'other' }))).toEqual([]);
    expect((await selectPluginHiddenTaskRows(db, 'elsewhere')).map((row) => row.taskId)).toEqual(['other']);
  });
});

describe('revealing every plugin background task', () => {
  const addHiddenTasks = (count: number) => {
    for (let i = 0; i < count; i += 1) {
      sqlite.prepare("INSERT INTO sessions VALUES (?, 'Bulk', 'active', 'plugin', 5, ?)").run(`bulk-${i}`, 100 + i);
      sqlite.prepare("INSERT INTO plugin_task_requests VALUES (?, 'bulk', 'create', '', ?, 'f', '{}', 0, 1)")
        .run(`bulk-${i}`, `kb-${i}`);
    }
  };

  it('reveals beyond one batch until nothing of this plugin stays hidden', async () => {
    addHiddenTasks(5);
    const reveal = vi.fn(async (taskId: string) => {
      sqlite.prepare('UPDATE sessions SET hidden_at = NULL WHERE id = ?').run(taskId);
    });
    await revealAllPluginHiddenTasks(db, 'bulk', reveal, { batchSize: 2 });
    expect(reveal).toHaveBeenCalledTimes(5);
    expect(new Set(reveal.mock.calls.map(([id]) => id)).size).toBe(5);
    expect(await selectPluginHiddenTaskRows(db, 'bulk')).toEqual([]);
    // 其它插件的后台任务不受影响。
    expect((await selectPluginHiddenTaskRows(db, 'demo')).map((row) => row.taskId)).toEqual(['bg-new', 'bg-old']);
  });

  it('throws instead of looping when a reveal does not take effect', async () => {
    addHiddenTasks(5);
    const reveal = vi.fn(async () => undefined);
    await expect(revealAllPluginHiddenTasks(db, 'bulk', reveal, { batchSize: 2 })).rejects.toThrow('still hidden');
    expect(reveal).toHaveBeenCalledTimes(2);
  });

  it('stops at maxBatches', async () => {
    addHiddenTasks(5);
    const reveal = vi.fn(async (taskId: string) => {
      sqlite.prepare('UPDATE sessions SET hidden_at = NULL WHERE id = ?').run(taskId);
    });
    await expect(revealAllPluginHiddenTasks(db, 'bulk', reveal, { batchSize: 2, maxBatches: 2 }))
      .rejects.toThrow('after 2 batches');
    expect(reveal).toHaveBeenCalledTimes(4);
  });
});

describe('plugin background task IPC handlers', () => {
  const setup = (overrides: Partial<Parameters<typeof createPluginBackgroundTaskHandlers>[0]> = {}) => {
    const setHidden = vi.fn(async (input: { sessionId: string; hidden: boolean; assertCurrent: () => void }) => {
      input.assertCurrent();
      sqlite.prepare('UPDATE sessions SET hidden_at = NULL WHERE id = ?').run(input.sessionId);
      return true;
    });
    const handlers = createPluginBackgroundTaskHandlers({
      currentDb: () => db,
      isInstalled: (id) => id === 'demo',
      isRunning: (id) => id === 'bg-new',
      setHidden,
      ...overrides,
    });
    return { handlers, setHidden };
  };

  it('projects status, last activity and running state', async () => {
    const { handlers } = setup();
    expect(await handlers.list('demo')).toEqual({ items: [
      { taskId: 'bg-new', title: 'New', status: 'active', updatedAt: 30, running: true },
      { taskId: 'bg-old', title: 'Old', status: 'archived', updatedAt: 10, running: false },
    ] });
  });

  it('reveals only a hidden task owned by the plugin and treats already visible tasks as done', async () => {
    const { handlers, setHidden } = setup();
    await expect(handlers.reveal('demo', 'bg-old')).resolves.toEqual({ ok: true });
    expect(setHidden).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'bg-old', hidden: false, db }));
    expect((await handlers.list('demo')).items.map((item) => item.taskId)).toEqual(['bg-new']);
    await expect(handlers.reveal('demo', 'other')).resolves.toEqual({ ok: true });
    await expect(handlers.reveal('demo', 'shown')).resolves.toEqual({ ok: true });
    expect(setHidden).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT hidden_at FROM sessions WHERE id = 'other'").get()).toEqual({ hidden_at: 5 });
  });

  it('rejects malformed input, uninstalled plugins and a missing account database', async () => {
    const { handlers } = setup();
    await expect(handlers.list('')).rejects.toThrow('INVALID_PARAMS');
    await expect(handlers.reveal('demo', 42)).rejects.toThrow('INVALID_PARAMS');
    await expect(handlers.list('elsewhere')).rejects.toThrow('NOT_FOUND');
    const offline = setup({ currentDb: () => null }).handlers;
    await expect(offline.list('demo')).rejects.toThrow('PRECONDITION_FAILED');
  });

  it('refuses to write when the account changes before the reveal', async () => {
    let current: DbClient | null = db;
    const { handlers, setHidden } = setup({ currentDb: () => current });
    setHidden.mockImplementationOnce(async (input) => { current = null; input.assertCurrent(); return true; });
    await expect(handlers.reveal('demo', 'bg-new')).rejects.toThrow('Account changed');
  });
});
