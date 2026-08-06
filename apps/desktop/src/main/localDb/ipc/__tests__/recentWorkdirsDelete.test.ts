/**
 * recentWorkdirsDelete.test.ts — 最近工作目录 list(exists 探测)/ delete IPC 回归。
 *
 * 覆盖:
 *  - delete 按归一化主键删行(反斜杠 / 尾斜杠形态都能命中同一条)
 *  - delete 幂等:不存在的 path 返回 deleted:false,不抛错
 *  - delete 入参非法(非字符串 / 空白)→ INVALID_PARAMS / no-op
 *  - list 返回 exists 字段:磁盘上真实存在的目录 true,已迁移的死路径 false
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  sqlite: null as InstanceType<typeof import('better-sqlite3')> | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  webContentsSend: null as ReturnType<typeof vi.fn> | null,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: h.webContentsSend } },
    ],
  },
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../client/current', () => ({
  getDbClient: () => ({ drizzle: h.db }),
}));

import { registerRecentWorkdirsIpc } from '../recentWorkdirs';
import { IPC_CHANNELS } from '@cindy/cindy-ipc';

function createDb(): void {
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
  h.db = drizzle(sqlite);
}

function seed(path: string, lastUsedAt: number): void {
  h.sqlite!
    .prepare('INSERT INTO recent_workdirs (path, last_used_at) VALUES (?, ?)')
    .run(path, lastUsedAt);
}

function rows(): Array<{ path: string }> {
  return h.sqlite!.prepare('SELECT path FROM recent_workdirs ORDER BY path').all() as Array<{
    path: string;
  }>;
}

async function invoke(channel: string, input?: unknown): Promise<unknown> {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`handler not registered: ${channel}`);
  return handler({}, input);
}

// 存在性探测用的真实临时目录(fs.access 是真探测,不 mock)。
const existingDir = mkdtempSync(join(tmpdir(), 'recent-workdirs-test-'));

afterAll(() => {
  rmSync(existingDir, { recursive: true, force: true });
  h.sqlite?.close();
});

describe(IPC_CHANNELS.LOCAL_DB.RECENT_WORKDIRS_REMOVE, () => {
  beforeEach(() => {
    h.handlers.clear();
    h.webContentsSend = vi.fn();
    createDb();
    registerRecentWorkdirsIpc();
  });

  it('deletes the row by exact normalized path and broadcasts to windows', async () => {
    seed('/repo/project-a', 1000);
    seed('/repo/project-b', 2000);

    const res = (await invoke(IPC_CHANNELS.LOCAL_DB.RECENT_WORKDIRS_REMOVE, {
      path: '/repo/project-a',
    })) as { deleted: boolean };

    expect(res.deleted).toBe(true);
    expect(rows()).toEqual([{ path: '/repo/project-b' }]);
    // 其它窗口靠这条广播刷新各自的模块级缓存,漏发 = 别的窗口残留可选的已删项目。
    expect(h.webContentsSend).toHaveBeenCalledWith(IPC_CHANNELS.LOCAL_DB.RECENT_WORKDIRS_CHANGED, {
      path: '/repo/project-a',
    });
  });

  it('normalizes separators and trailing slashes before deleting', async () => {
    // 写入侧主键是 posix 归一形态;删除侧必须走同一归一,否则 Windows 路径删不掉。
    seed('E:/foo/bar', 1000);

    const res = (await invoke(IPC_CHANNELS.LOCAL_DB.RECENT_WORKDIRS_REMOVE, {
      path: 'E:\\foo\\bar\\',
    })) as { deleted: boolean };

    expect(res.deleted).toBe(true);
    expect(rows()).toEqual([]);
  });

  it('is idempotent: missing path resolves deleted:false without broadcasting', async () => {
    const res = (await invoke(IPC_CHANNELS.LOCAL_DB.RECENT_WORKDIRS_REMOVE, {
      path: '/not/in/table',
    })) as { deleted: boolean };
    expect(res.deleted).toBe(false);
    expect(h.webContentsSend).not.toHaveBeenCalled();
  });

  it('rejects non-string / blank path with INVALID_PARAMS', async () => {
    await expect(invoke(IPC_CHANNELS.LOCAL_DB.RECENT_WORKDIRS_REMOVE, { path: 42 })).rejects.toThrow(
      /INVALID_PARAMS/,
    );
    await expect(invoke(IPC_CHANNELS.LOCAL_DB.RECENT_WORKDIRS_REMOVE, undefined)).rejects.toThrow(
      /INVALID_PARAMS/,
    );
    await expect(invoke(IPC_CHANNELS.LOCAL_DB.RECENT_WORKDIRS_REMOVE, { path: '   ' })).rejects.toThrow(
      /INVALID_PARAMS/,
    );
  });

  it('treats managed-worktree path as no-op (normalize returns null)', async () => {
    // 这类路径本来进不了表(upsert 同样拒绝),删除侧对齐:归一失败即幂等 no-op。
    seed('/repo/project-a', 1000);
    const res = (await invoke(IPC_CHANNELS.LOCAL_DB.RECENT_WORKDIRS_REMOVE, {
      path: '/repo/.cindy-worktrees/task-x',
    })) as { deleted: boolean };
    expect(res.deleted).toBe(false);
    expect(rows()).toEqual([{ path: '/repo/project-a' }]);
  });
});

describe('local-db:recent-workdirs:list exists probe', () => {
  beforeEach(() => {
    h.handlers.clear();
    createDb();
    registerRecentWorkdirsIpc();
  });

  it('marks live dirs exists:true; vanished paths and plain files exists:false', async () => {
    // 路径被普通文件顶替时必须判不存在 —— access 探测会误报 true(review 已踩)。
    const filePath = join(existingDir, 'not-a-dir.txt');
    writeFileSync(filePath, 'x');
    seed(existingDir.replace(/\\/g, '/'), 3000);
    seed(filePath.replace(/\\/g, '/'), 2000);
    seed('/definitely/not/a/real/dir/xyz', 1000);

    const list = (await invoke(IPC_CHANNELS.LOCAL_DB.RECENT_WORKDIRS_LIST)) as Array<{
      path: string;
      lastUsedAt: string;
      exists: boolean;
    }>;

    expect(list).toHaveLength(3);
    // 按 lastUsedAt desc:真目录 → 文件 → 不存在路径。
    expect(list[0].exists).toBe(true);
    expect(list[1].exists).toBe(false);
    expect(list[2].exists).toBe(false);
    expect(typeof list[0].lastUsedAt).toBe('string');
  });
});
