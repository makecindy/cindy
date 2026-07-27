/**
 * ensureSystemBinPathForMachineId 单测 —— 启动崩溃的根因修复。
 *
 * machineIdSync 在 macOS 跑 bare `ioreg`;Finder 启动的 GUI 进程 PATH 极简(无 /usr/sbin)
 * 会让它抛、进而在模块顶层崩溃。这里保证取指纹前 PATH 补齐了系统 bin 目录。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';

import { ensureSystemBinPathForMachineId } from '../deviceId';

describe('ensureSystemBinPathForMachineId', () => {
  const originalPath = process.env.PATH;

  beforeEach(() => {
    process.env.PATH = '/usr/bin:/bin';
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  it('darwin/linux 上补齐 /usr/sbin:/sbin', () => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return;
    ensureSystemBinPathForMachineId();
    const dirs = (process.env.PATH ?? '').split(path.delimiter);
    expect(dirs).toContain('/usr/sbin');
    expect(dirs).toContain('/sbin');
  });

  it('幂等:已存在时不重复追加', () => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return;
    ensureSystemBinPathForMachineId();
    const afterFirst = process.env.PATH;
    ensureSystemBinPathForMachineId();
    expect(process.env.PATH).toBe(afterFirst);
  });

  it('不覆盖已有的用户 PATH 项(追加而非前置)', () => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return;
    process.env.PATH = '/opt/homebrew/bin:/usr/bin:/bin';
    ensureSystemBinPathForMachineId();
    const dirs = (process.env.PATH ?? '').split(path.delimiter);
    expect(dirs[0]).toBe('/opt/homebrew/bin'); // 原有优先项仍在最前
    expect(dirs).toContain('/usr/sbin');
  });
});
