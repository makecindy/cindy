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
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import {
  DEVICE_IDENTITY_FILE,
  ensureSystemBinPathForMachineId,
  resolveRuntimeDeviceId,
  resolveRuntimeDeviceIdentity,
  writeReplacementDeviceId,
} from '../deviceId.js';

const PATCHES_PATH = process.platform === 'darwin' || process.platform === 'linux';

// Host used the hardware id even with XDT_DEVICE_ID_OVERRIDE, colliding with a
// running desktop. Verify the common identity entry without probing hardware.
it('preserves the isolated identity and only probes hardware for a normal instance', () => {
  const originalPath = process.env.PATH;
  try {
    expect(resolveRuntimeDeviceId(() => { throw new Error('must not probe'); }, ' isolated-host ')).toBe('isolated-host');
    expect(resolveRuntimeDeviceId(() => 'physical-device', ' ')).toBe('physical-device');
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

// 2026-11-23：两台 Windows 共用 MachineGuid，用户在冲突提示里给其中一台换了身份。
// 入口：resolveRuntimeDeviceIdentity（Desktop authManager 与 Node Host 共用）。
// 不变量：没换过身份的电脑（没有记录、记录损坏、记录属于别的硬件）一律照旧用硬件身份；
// 换过的只在原硬件上生效，显式隔离覆盖始终优先。最小失败输入：写入记录后再次启动。
describe('replacement device identity', () => {
  const originalPath = process.env.PATH;
  let profileDir: string;
  beforeEach(() => { profileDir = mkdtempSync(path.join(os.tmpdir(), 'cindy-device-identity-')); });
  afterEach(() => {
    rmSync(profileDir, { recursive: true, force: true });
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  it('applies only on the hardware it replaced and never overrides an isolated instance', () => {
    expect(resolveRuntimeDeviceIdentity(() => 'hw-a', ' ', profileDir)).toEqual({ deviceId: 'hw-a', source: 'hardware', hardwareId: 'hw-a' });

    const replacement = writeReplacementDeviceId(profileDir, 'hw-a');
    expect(replacement).toMatch(/^[0-9a-f]{64}$/);
    expect(resolveRuntimeDeviceIdentity(() => 'hw-a', ' ', profileDir))
      .toEqual({ deviceId: replacement, source: 'replacement', hardwareId: 'hw-a' });
    // 数据目录被复制到另一台电脑，或硬件身份变了：回到那台电脑自己的硬件身份。
    expect(resolveRuntimeDeviceId(() => 'hw-b', ' ', profileDir)).toBe('hw-b');
    expect(resolveRuntimeDeviceId(() => 'hw-a', ' isolated ', profileDir)).toBe('isolated');
    // 没传数据目录的调用方(旧入口)不受影响。
    expect(resolveRuntimeDeviceId(() => 'hw-a', ' ')).toBe('hw-a');
  });

  it.each([
    ['not JSON', '{'],
    ['unknown version', JSON.stringify({ version: 2, deviceId: 'a'.repeat(64), replaces: 'hw-a' })],
    ['malformed id', JSON.stringify({ version: 1, deviceId: 'short', replaces: 'hw-a' })],
    ['same as hardware', JSON.stringify({ version: 1, deviceId: 'b'.repeat(64), replaces: 'b'.repeat(64) })],
  ])('falls back to the hardware identity when the record is %s', (_label, contents) => {
    writeFileSync(path.join(profileDir, DEVICE_IDENTITY_FILE), contents);
    const hardware = contents.includes('b'.repeat(64)) ? 'b'.repeat(64) : 'hw-a';
    expect(resolveRuntimeDeviceIdentity(() => hardware, ' ', profileDir)).toMatchObject({ deviceId: hardware, source: 'hardware' });
  });
});

// Execute the production IPC registration adapter without booting Electron.
// A sandbox's auth identity can differ from the raw hardware id; renderer link
// comparisons must receive the same identity that auth uses to register it.
it('get-device-id exposes the auth device identity, including an isolated override', () => {
  const source = readFileSync(new URL('../bootstrap-electron.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  // Device ID');
  const end = source.indexOf('  // CC 网络调试开关', start);
  if (start < 0 || end <= start) throw new Error('device id IPC registration not found');
  let handler!: () => string;
  new Function('ipcMain', 'authManager', 'machineIdSync', source.slice(start, end))(
    { handle: (_name: string, callback: () => string) => { handler = callback; } },
    { getDeviceId: () => 'isolated-device-override' },
    () => 'raw-hardware-id',
  );
  expect(handler()).toBe('isolated-device-override');
});

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
