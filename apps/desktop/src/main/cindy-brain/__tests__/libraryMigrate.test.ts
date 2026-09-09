/**
 * libraryMigrate 单测:全链路(文件+sqlite 复制对账、binding 切换、grace
 * 改名)、目标已存在拒、空间不足拒、复制校验失败中止且 binding 未切。
 * sqlite 的复制/校验经注入(真实 better-sqlite3 backup/quick_check 由
 * libraryDbCore 层单测覆盖)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { migrateGhostLibrary, type LibraryMigrateDeps } from '../libraryMigrate.js';

const GHOST_ID = 'mivo-canvas';

describe('migrateGhostLibrary', () => {
  let tmp: string;
  let fromRoot: string;
  let candidate: string;
  let appliedBindings: string[];
  let copySqliteCalls: Array<{ from: string; to: string }>;
  let sqliteHealthy: (to: string) => Promise<boolean>;
  let diskFree: number | null;
  let deps: LibraryMigrateDeps;

  beforeEach(async () => {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-library-migrate-'));
    fromRoot = path.join(tmp, 'owners', 'a', 'libraries', GHOST_ID);
    candidate = path.join(tmp, 'picked');
    await fs.promises.mkdir(path.join(fromRoot, 'canvases', 'c1'), { recursive: true });
    await fs.promises.writeFile(path.join(fromRoot, 'canvases', 'c1', 'a.png'), 'asset-bytes');
    await fs.promises.writeFile(path.join(fromRoot, 'canvases', 'c1', 'canvas.sqlite'), 'fake-sqlite');
    appliedBindings = [];
    copySqliteCalls = [];
    sqliteHealthy = async () => true;
    diskFree = 1024 ** 4;
    deps = {
      getFile: () => path.join(tmp, 'binding.json'),
      getManagedRoots: () => [path.join(tmp, 'managed')],
      getDefaultRoot: (id) => path.join(tmp, 'default', id),
      getDiskFreeBytes: async () => diskFree,
      checkSqliteHealthy: (to) => sqliteHealthy(to),
      copySqlite: async (from, to) => {
        copySqliteCalls.push({ from, to });
        await fs.promises.copyFile(from, to);
      },
    };
  });

  afterEach(async () => {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  const run = () =>
    migrateGhostLibrary({
      ghostId: GHOST_ID,
      fromRoot,
      candidate,
      deps,
      applyBinding: async (c) => {
        appliedBindings.push(c);
        return { ok: true };
      },
    });

  it('全链路:文件与 sqlite 各走各的复制路径,binding 切换,旧目录进 grace', async () => {
    const res = await run();
    if (!res.ok) throw new Error(res.message);
    expect(res.files).toBe(2);
    expect(appliedBindings).toEqual([candidate]);
    // 新位置数据完整。
    expect(await fs.promises.readFile(path.join(candidate, GHOST_ID, 'canvases', 'c1', 'a.png'), 'utf8')).toBe('asset-bytes');
    // sqlite 走注入的备份式复制。
    expect(copySqliteCalls).toHaveLength(1);
    // 旧目录改名进 grace(保留回滚窗)。
    const entries = await fs.promises.readdir(path.join(fromRoot, '..'));
    expect(entries.some((e) => e.startsWith(`${GHOST_ID}.migrated-`))).toBe(true);
    expect(fs.existsSync(fromRoot)).toBe(false);
  });

  it('目标已存在同名目录 → precheck 拒,不动原位置', async () => {
    await fs.promises.mkdir(path.join(candidate, GHOST_ID), { recursive: true });
    const res = await run();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.phase).toBe('precheck');
      expect(appliedBindings).toEqual([]);
    }
    expect(fs.existsSync(path.join(fromRoot, 'canvases', 'c1', 'a.png'))).toBe(true);
  });

  it('空间不足 → precheck 拒', async () => {
    diskFree = 1024; // 远小于用量×1.2
    const res = await run();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.phase).toBe('precheck');
  });

  it('sqlite 完整性校验失败 → verifying 中止,binding 未切换,原位置原样', async () => {
    sqliteHealthy = async () => false;
    const res = await run();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.phase).toBe('verifying');
      expect(appliedBindings).toEqual([]);
    }
    expect(fs.existsSync(path.join(fromRoot, 'canvases', 'c1', 'canvas.sqlite'))).toBe(true);
  });
});
