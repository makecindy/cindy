/**
 * fsBrowseWindowsDrives.test.ts —— 目录浏览的 Windows 盘符枚举。
 *
 * 覆盖:GetLogicalDrives 输出解析、当前盘标记与补全(Windows 路径语义,用 path.win32 固定)、
 * 缓存 / 过期后先回旧值再后台刷新 / 并发合并、失败降级为空列表。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  buildDriveOptions,
  createWindowsDriveRootLister,
  parseLogicalDriveRoots,
} from '../fsBrowse/windowsDrives.js';

describe('parseLogicalDriveRoots', () => {
  it('每行一个根,去重、统一大写并排序;忽略空行与非盘符行', () => {
    expect(parseLogicalDriveRoots('E:\\\r\nc:\\\r\n\r\nD:\\\r\nC:\\\r\nnoise\r\n\\\\srv\\share\\\r\n'))
      .toEqual(['C:\\', 'D:\\', 'E:\\']);
  });
});

describe('buildDriveOptions(Windows 路径语义)', () => {
  it('标出当前所在盘,盘符大小写不敏感', () => {
    expect(buildDriveOptions(['C:\\', 'D:\\'], 'd:\\work\\cindy')).toEqual([
      { name: 'C:', path: 'C:\\', current: false },
      { name: 'D:', path: 'D:\\', current: true },
    ]);
  });

  it('当前盘不在枚举结果里(枚举后新挂载)→ 补进列表并按盘符排序', () => {
    expect(buildDriveOptions(['C:\\', 'E:\\'], 'D:\\'))
      .toEqual([
        { name: 'C:', path: 'C:\\', current: false },
        { name: 'D:', path: 'D:\\', current: true },
        { name: 'E:', path: 'E:\\', current: false },
      ]);
  });

  it('当前位于 UNC 共享 → 追加该共享根作为当前项', () => {
    expect(buildDriveOptions(['C:\\'], '\\\\nas\\team\\proj')).toEqual([
      { name: 'C:', path: 'C:\\', current: false },
      { name: '\\\\nas\\team', path: '\\\\nas\\team\\', current: true },
    ]);
  });
});

describe('createWindowsDriveRootLister', () => {
  it('调用 PowerShell 的 GetLogicalDrives,隐藏窗口且带超时', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: 'C:\\\r\nD:\\\r\n' });
    const list = createWindowsDriveRootLister({ run });
    expect(await list()).toEqual(['C:\\', 'D:\\']);
    const [file, args, options] = run.mock.calls[0]!;
    expect(file).toMatch(/powershell\.exe$/i);
    expect(args).toContain('[System.IO.Directory]::GetLogicalDrives()');
    expect(options).toMatchObject({ windowsHide: true, timeout: expect.any(Number) });
  });

  it('缓存期内不重复起进程;并发调用合并为一次', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: 'C:\\\r\n' });
    const list = createWindowsDriveRootLister({ run, now: () => 0 });
    await Promise.all([list(), list()]);
    await list();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('过期后先回旧值,后台刷新完成后返回新值', async () => {
    let clock = 0;
    const run = vi.fn()
      .mockResolvedValueOnce({ stdout: 'C:\\\r\n' })
      .mockResolvedValueOnce({ stdout: 'C:\\\r\nF:\\\r\n' });
    const list = createWindowsDriveRootLister({ run, now: () => clock });
    expect(await list()).toEqual(['C:\\']);
    clock = 60_000;
    expect(await list()).toEqual(['C:\\']);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => expect(await list()).toEqual(['C:\\', 'F:\\']));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('PowerShell 失败 / 超时 → 空列表,不 reject', async () => {
    const run = vi.fn().mockRejectedValue(Object.assign(new Error('timeout'), { killed: true }));
    const list = createWindowsDriveRootLister({ run });
    await expect(list()).resolves.toEqual([]);
  });
});
