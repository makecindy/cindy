/**
 * ensureSystemBinPathForMachineId 单测 —— 启动崩溃的根因修复。
 *
 * machineIdSync 在 macOS 跑 bare `ioreg`;Finder 启动的 GUI 进程 PATH 极简(无 /usr/sbin)
 * 会让它抛、进而在模块顶层崩溃。这里保证取指纹前 PATH 补齐了系统 bin 目录。
 *
 * 每个用例在所有平台都断言:darwin/linux 断言补齐,其它平台(Windows)断言 no-op,
 * 避免非目标平台上整套用例空跑通过。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';

import { ensureSystemBinPathForMachineId } from '../deviceId.js';

const PATCHES_PATH = process.platform === 'darwin' || process.platform === 'linux';

describe('ensureSystemBinPathForMachineId', () => {
  const originalPath = process.env.PATH;

  beforeEach(() => {
    process.env.PATH = '/usr/bin:/bin';
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  it('darwin/linux 补齐 /usr/sbin:/sbin;其它平台为 no-op', () => {
    ensureSystemBinPathForMachineId();
    const dirs = (process.env.PATH ?? '').split(path.delimiter);
    if (PATCHES_PATH) {
      expect(dirs).toContain('/usr/sbin');
      expect(dirs).toContain('/sbin');
    } else {
      expect(process.env.PATH).toBe('/usr/bin:/bin'); // Windows: 不动 PATH
    }
  });

  it('幂等:两次调用结果一致', () => {
    ensureSystemBinPathForMachineId();
    const afterFirst = process.env.PATH;
    ensureSystemBinPathForMachineId();
    expect(process.env.PATH).toBe(afterFirst);
  });

  it('追加而非前置:不覆盖已有的用户 PATH 项', () => {
    process.env.PATH = '/opt/homebrew/bin:/usr/bin:/bin';
    ensureSystemBinPathForMachineId();
    if (PATCHES_PATH) {
      const dirs = (process.env.PATH ?? '').split(path.delimiter);
      expect(dirs[0]).toBe('/opt/homebrew/bin'); // 原有优先项仍在最前
      expect(dirs).toContain('/usr/sbin');
    } else {
      expect(process.env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin'); // Windows: 不动 PATH
    }
  });

  it('保留原 PATH 的空段(Unix 下代表 CWD),不改语义', () => {
    // 中间的空段(::)在 Unix 下表示当前目录;补齐时不能把它过滤掉。
    process.env.PATH = '/usr/bin::/bin';
    ensureSystemBinPathForMachineId();
    if (PATCHES_PATH) {
      expect(process.env.PATH).toBe('/usr/bin::/bin:/usr/sbin:/sbin');
    } else {
      expect(process.env.PATH).toBe('/usr/bin::/bin');
    }
  });

  it('PATH 未设置(undefined)时:darwin/linux 只置系统目录,其它平台维持 undefined', () => {
    delete process.env.PATH;
    ensureSystemBinPathForMachineId();
    if (PATCHES_PATH) {
      // 空/未设 PATH 只置系统目录,不刻意保留空段 / CWD(见 deviceId.ts)。
      expect(process.env.PATH).toBe('/usr/sbin:/sbin');
    } else {
      expect(process.env.PATH).toBeUndefined();
    }
  });
});
