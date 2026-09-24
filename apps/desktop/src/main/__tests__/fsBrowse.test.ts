/**
 * fsBrowse.test.ts —— 本机目录浏览纯函数(项目选择器 / device-link 隧道用)。
 *
 * 覆盖:list-dir 只回目录(含 hidden,对齐 SSH `ls -A`)、每项带 host-native 绝对 path、
 * `~` 展开、parent 计算、根 parent=null;Windows 追加可选 drives(非 Windows 不枚举、枚举
 * 为空时省略;超出等待预算时省略 drives 并标 drivesPending);stat 三态;mkdir-p 幂等;错误走 throwIpcError。
 * 断言使用 host-native path 语义;mock node:fs / node:os。
 */
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const HOME = path.resolve('/Users/cindy');
const homePath = (...parts: string[]) => path.join(HOME, ...parts);

const h = vi.hoisted(() => ({
  readdir: vi.fn(),
  stat: vi.fn(),
  mkdir: vi.fn(),
  homedir: vi.fn(() => HOME),
}));

vi.mock('node:fs', () => ({
  promises: { readdir: h.readdir, stat: h.stat, mkdir: h.mkdir },
}));
vi.mock('node:os', () => ({ homedir: h.homedir }));
vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { expandHome, listDir, statPath, mkdirP } from '../fsBrowse/ipc.js';
import { buildDriveOptions } from '../fsBrowse/windowsDrives.js';

/** 造一个 Dirent-ish。 */
function dirent(name: string, kind: 'dir' | 'file' | 'symlink') {
  return {
    name,
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => kind === 'symlink',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.homedir.mockReturnValue(HOME);
});

describe('expandHome', () => {
  it('~ / 空串 → home;~/x → home/x;绝对路径归一', () => {
    expect(expandHome('~')).toBe(HOME);
    expect(expandHome('')).toBe(HOME);
    expect(expandHome('~/Code')).toBe(homePath('Code'));
    expect(expandHome('/tmp/../var')).toBe(path.resolve('/tmp/../var'));
  });
});

describe('listDir', () => {
  it('只回目录 + 指向目录的 symlink(文件 / dangling symlink 跳过),每项带绝对 path,按名排序', async () => {
    h.readdir.mockResolvedValueOnce([
      dirent('Code', 'dir'),
      dirent('.config', 'dir'),
      dirent('readme.md', 'file'),
      dirent('Applications', 'dir'),
      dirent('linkToDir', 'symlink'),
      dirent('linkToFile', 'symlink'),
    ]);
    // 两个 symlink 的 stat:第一个指向目录,第二个指向文件。
    h.stat.mockImplementation(async (p: string) => ({
      isDirectory: () => p.endsWith('linkToDir'),
    }));

    const res = await listDir('~');
    expect(res.resolvedPath).toBe(HOME);
    expect(res.entries.map((e) => e.name)).toEqual(['.config', 'Applications', 'Code', 'linkToDir']);
    expect(res.entries.find((e) => e.name === 'Code')).toMatchObject({
      kind: 'dir',
      path: homePath('Code'),
    });
    expect(res.entries.find((e) => e.name === 'linkToDir')?.kind).toBe('symlink');
    expect(res.parent).toBe(path.dirname(HOME));
  });

  it('根目录 parent=null', async () => {
    h.readdir.mockResolvedValueOnce([]);
    const root = path.parse(process.cwd()).root;
    const res = await listDir(root);
    expect(res.resolvedPath).toBe(root);
    expect(res.parent).toBeNull();
  });

  it('readdir 失败 → throwIpcError(FS_BROWSE_FAILED)', async () => {
    h.readdir.mockRejectedValueOnce(new Error('EACCES'));
    await expect(listDir('/root/secret', { platform: 'darwin' })).rejects.toThrow('[FS_BROWSE_FAILED]');
  });

  it('Windows:追加 drives(盘符根 + 当前盘标记由 buildDriveOptions 生成)', async () => {
    h.readdir.mockResolvedValueOnce([]);
    // 盘符根是 Windows wire 格式(被控端 host-native),固定写反斜杠。resolvedPath 由宿主
    // path 决定(Windows 开发机上会落在某个盘),当前盘标记的细节见 fsBrowseWindowsDrives.test。
    const roots = ['C:\\', 'D:\\'];
    const listDriveRoots = vi.fn().mockResolvedValue(roots);
    const res = await listDir('~', { platform: 'win32', listDriveRoots });
    expect(listDriveRoots).toHaveBeenCalledTimes(1);
    expect(res.drives).toEqual(buildDriveOptions(roots, res.resolvedPath));
    expect(res.drives?.map((d) => d.path)).toEqual(expect.arrayContaining(roots));
    expect(res).not.toHaveProperty('drivesPending');
  });

  it('非 Windows 不枚举盘符,也不带 drives 字段', async () => {
    h.readdir.mockResolvedValueOnce([]);
    const listDriveRoots = vi.fn().mockResolvedValue(['C:\\']);
    const res = await listDir('~', { platform: 'darwin', listDriveRoots });
    expect(listDriveRoots).not.toHaveBeenCalled();
    expect(res).not.toHaveProperty('drives');
  });

  it('Windows 盘符枚举为空 / 失败 → 省略 drives,目录列表照常返回', async () => {
    h.readdir.mockResolvedValue([dirent('Code', 'dir')]);
    const empty = await listDir('~', { platform: 'win32', listDriveRoots: async () => [] });
    expect(empty).not.toHaveProperty('drives');
    expect(empty).not.toHaveProperty('drivesPending');
    const failed = await listDir('~', {
      platform: 'win32',
      listDriveRoots: () => Promise.reject(new Error('boom')),
    });
    expect(failed.entries.map((e) => e.name)).toEqual(['Code']);
    expect(failed).not.toHaveProperty('drives');
    expect(failed).not.toHaveProperty('drivesPending');
  });

  it('Windows 盘符枚举超出等待预算 → 先不带 drives 返回,并标记 pending 供控制端刷新', async () => {
    vi.useFakeTimers();
    try {
      h.readdir.mockResolvedValueOnce([]);
      const pending = listDir('~', { platform: 'win32', listDriveRoots: () => new Promise<string[]>(() => {}) });
      await vi.advanceTimersByTimeAsync(1_500);
      const res = await pending;
      expect(res.resolvedPath).toBe(HOME);
      expect(res).not.toHaveProperty('drives');
      expect(res.drivesPending).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('statPath', () => {
  it('目录 → dir', async () => {
    h.stat.mockResolvedValueOnce({ isDirectory: () => true });
    expect(await statPath('~/Code')).toEqual({ kind: 'dir', resolvedPath: homePath('Code') });
  });
  it('文件 → file', async () => {
    h.stat.mockResolvedValueOnce({ isDirectory: () => false });
    expect((await statPath('~/x.txt')).kind).toBe('file');
  });
  it('ENOENT → missing(不抛)', async () => {
    h.stat.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'ENOENT' }));
    expect(await statPath('~/new-proj')).toEqual({ kind: 'missing', resolvedPath: homePath('new-proj') });
  });
  it('其它错误 → throwIpcError', async () => {
    h.stat.mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(statPath('/root/x')).rejects.toThrow('[FS_BROWSE_FAILED]');
  });
});

describe('mkdirP', () => {
  it('成功 → 返回 resolvedPath', async () => {
    h.mkdir.mockResolvedValueOnce(undefined);
    expect(await mkdirP('~/new-proj')).toEqual({ resolvedPath: homePath('new-proj') });
    expect(h.mkdir).toHaveBeenCalledWith(homePath('new-proj'), { recursive: true });
  });
  it('失败 → throwIpcError', async () => {
    h.mkdir.mockRejectedValueOnce(new Error('EROFS'));
    await expect(mkdirP('/readonly/x')).rejects.toThrow('[FS_BROWSE_FAILED]');
  });
});
