/**
 * resolveDeviceId 单测 —— 取设备 ID 的启动崩溃护栏。
 *
 * 关注点:
 * 1. XDT_DEVICE_ID_OVERRIDE 优先,直接返回、不碰硬件指纹;
 * 2. machineIdSync 成功时透传其结果;
 * 3. machineIdSync 抛(bare `ioreg` not found)时不上抛,回落到 userData 持久化 UUID,
 *    且同一份 userData 跨调用稳定;
 * 4. ensureSystemBinPathForMachineId 在 darwin 补齐 /usr/sbin:/sbin 且幂等。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const { appMock, machineIdSync } = vi.hoisted(() => ({
  appMock: { getPath: vi.fn(() => '') },
  machineIdSync: vi.fn(() => 'hw-fingerprint'),
}));

vi.mock('electron', () => ({ app: appMock }));
vi.mock('node-machine-id', () => ({ machineIdSync }));

async function loadFresh() {
  vi.resetModules();
  return import('../deviceId');
}

describe('resolveDeviceId', () => {
  const originalPath = process.env.PATH;
  const originalOverride = process.env.XDT_DEVICE_ID_OVERRIDE;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-deviceid-'));
    appMock.getPath.mockReturnValue(tmpDir);
    machineIdSync.mockReset();
    machineIdSync.mockReturnValue('hw-fingerprint');
    delete process.env.XDT_DEVICE_ID_OVERRIDE;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalOverride === undefined) delete process.env.XDT_DEVICE_ID_OVERRIDE;
    else process.env.XDT_DEVICE_ID_OVERRIDE = originalOverride;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('override 优先,不调用硬件指纹', async () => {
    process.env.XDT_DEVICE_ID_OVERRIDE = '  custom-device  ';
    const { resolveDeviceId } = await loadFresh();
    expect(resolveDeviceId()).toBe('custom-device');
    expect(machineIdSync).not.toHaveBeenCalled();
  });

  it('machineIdSync 成功时透传结果', async () => {
    const { resolveDeviceId } = await loadFresh();
    expect(resolveDeviceId()).toBe('hw-fingerprint');
  });

  it('machineIdSync 抛时不上抛,回落到持久化 UUID 且跨进程稳定', async () => {
    machineIdSync.mockImplementation(() => {
      throw new Error('ioreg: command not found');
    });

    const first = await loadFresh();
    const id1 = first.resolveDeviceId();
    expect(id1).toMatch(/^fallback-/);

    // 新进程(重置模块缓存)读同一份 userData,应拿到同一个持久化 id。
    const second = await loadFresh();
    expect(second.resolveDeviceId()).toBe(id1);
  });

  it('ensureSystemBinPathForMachineId 在 darwin/linux 补齐系统 bin 且幂等', async () => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return;
    process.env.PATH = '/usr/bin:/bin';
    const { ensureSystemBinPathForMachineId } = await loadFresh();

    ensureSystemBinPathForMachineId();
    const dirs = (process.env.PATH ?? '').split(path.delimiter);
    expect(dirs).toContain('/usr/sbin');
    expect(dirs).toContain('/sbin');

    const afterFirst = process.env.PATH;
    ensureSystemBinPathForMachineId();
    expect(process.env.PATH).toBe(afterFirst);
  });
});
