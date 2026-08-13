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
  tx: null as ((name: string, args: unknown) => Promise<unknown>) | null,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: h.webContentsSend } }],
  },
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../client/current', () => ({
  getDbClient: () => ({ drizzle: h.db, tx: h.tx }),
}));

import { tx as runDbTx } from '../../worker/opHandlers/tx';
import { registerRecentWorkdirsIpc, removeRecentWorkdir } from '../recentWorkdirs';

function createDb(): void {
  h.sqlite?.close();
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE recent_workdirs (
      path TEXT PRIMARY KEY NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE INDEX idx_recent_workdirs_last_used_at ON recent_workdirs(last_used_at);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      working_dir TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      workspace_kind TEXT NOT NULL DEFAULT 'project',
      remote_host_id TEXT,
      agent_kind TEXT NOT NULL DEFAULT 'cc'
    );
  `);
  h.sqlite = sqlite;
  h.db = drizzle(sqlite);
  h.tx = async (name: string, args: unknown) => runDbTx(sqlite, { name, args });
}

function seed(path: string, lastUsedAt: number): void {
  h.sqlite!.prepare('INSERT INTO recent_workdirs (path, last_used_at) VALUES (?, ?)').run(
    path,
    lastUsedAt,
  );
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

describe('local-db:recent-workdirs:remove', () => {
  beforeEach(() => {
    h.handlers.clear();
    h.webContentsSend = vi.fn();
    createDb();
    registerRecentWorkdirsIpc();
  });

  it('deletes the row by exact normalized path and broadcasts to windows', async () => {
    seed('/repo/project-a', 1000);
    seed('/repo/project-b', 2000);

    const res = (await invoke('local-db:recent-workdirs:remove', {
      path: '/repo/project-a',
    })) as { deleted: boolean };

    expect(res.deleted).toBe(true);
    expect(rows()).toEqual([{ path: '/repo/project-b' }]);
    // 其它窗口靠这条广播刷新各自的模块级缓存,漏发 = 别的窗口残留可选的已删项目。
    expect(h.webContentsSend).toHaveBeenCalledWith('local-db:recent-workdirs:changed', {
      path: '/repo/project-a',
    });
  });

  it('normalizes separators and trailing slashes before deleting', async () => {
    // 写入侧主键是 posix 归一形态;删除侧必须走同一归一,否则 Windows 路径删不掉。
    seed('E:/foo/bar', 1000);

    const res = (await invoke('local-db:recent-workdirs:remove', {
      path: 'E:\\foo\\bar\\',
    })) as { deleted: boolean };

    expect(res.deleted).toBe(true);
    expect(rows()).toEqual([]);
  });

  it('removes every legacy Windows casing variant for the same drive/UNC identity', async () => {
    seed('D:/Work/Project-A', 1_000);
    seed('d:/work/project-a', 2_000);
    seed('//Server/Share/Project-B', 3_000);
    seed('//server/share/project-b', 4_000);

    await removeRecentWorkdir('D:\\WORK\\PROJECT-A', 'win32');
    await removeRecentWorkdir('\\\\SERVER\\SHARE\\PROJECT-B', 'win32');

    expect(rows()).toEqual([]);
  });

  it('removes every non-ASCII Windows casing variant for the same identity', async () => {
    seed('D:/École/Project-A', 1_000);
    seed('d:/école/project-a', 2_000);

    await removeRecentWorkdir('D:/ÉCOLE/PROJECT-A', 'win32');

    expect(rows()).toEqual([]);
  });

  it('does not fold POSIX path casing when removing on Windows', async () => {
    seed('/Workspace/Project-A', 1_000);
    seed('/workspace/project-a', 2_000);

    await invoke('local-db:recent-workdirs:remove', { path: '/Workspace/Project-A' });

    expect(rows()).toEqual([{ path: '/workspace/project-a' }]);
  });

  it('is idempotent: missing path resolves deleted:false without broadcasting', async () => {
    const res = (await invoke('local-db:recent-workdirs:remove', {
      path: '/not/in/table',
    })) as { deleted: boolean };
    expect(res.deleted).toBe(false);
    expect(h.webContentsSend).not.toHaveBeenCalled();
  });

  it('rejects non-string / blank path with INVALID_PARAMS', async () => {
    await expect(invoke('local-db:recent-workdirs:remove', { path: 42 })).rejects.toThrow(
      /INVALID_PARAMS/,
    );
    await expect(invoke('local-db:recent-workdirs:remove', undefined)).rejects.toThrow(
      /INVALID_PARAMS/,
    );
    await expect(invoke('local-db:recent-workdirs:remove', { path: '   ' })).rejects.toThrow(
      /INVALID_PARAMS/,
    );
  });

  it('treats managed-worktree path as no-op (normalize returns null)', async () => {
    // 这类路径本来进不了表(upsert 同样拒绝),删除侧对齐:归一失败即幂等 no-op。
    seed('/repo/project-a', 1000);
    const res = (await invoke('local-db:recent-workdirs:remove', {
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

    const list = (await invoke('local-db:recent-workdirs:list')) as Array<{
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

  it('returns every explicitly retained project instead of truncating at ten', async () => {
    for (let i = 0; i < 14; i += 1) {
      seed(`/not-mounted/project-${i}`, 1_000 + i);
    }

    const list = (await invoke('local-db:recent-workdirs:list')) as Array<{ path: string }>;

    expect(list).toHaveLength(14);
    expect(list[0]?.path).toBe('/not-mounted/project-13');
    expect(list[13]?.path).toBe('/not-mounted/project-0');
  });

  it('retains agent-kind history after the last project session is soft-deleted', async () => {
    seed('/workspace/codex-only', 1_786_500_000_000);
    h.sqlite!
      .prepare(
        `INSERT INTO sessions (id, working_dir, status, workspace_kind, remote_host_id, agent_kind)
         VALUES (?, ?, 'active', 'project', NULL, 'codex')`,
      )
      .run('codex-session', '/workspace/codex-only');
    h.sqlite!
      .prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?")
      .run('codex-session');

    const list = (await invoke('local-db:recent-workdirs:list')) as Array<{
      path: string;
      knownAgentKinds: string[];
    }>;

    expect(list).toEqual([
      expect.objectContaining({
        path: '/workspace/codex-only',
        knownAgentKinds: ['codex'],
      }),
    ]);
  });
});
