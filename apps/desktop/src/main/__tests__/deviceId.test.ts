/**
 * resolveDeviceId 单测(最小版)—— 取设备 ID 的启动崩溃护栏。
 *
 * 关注点:
 * 1. XDT_DEVICE_ID_OVERRIDE 优先,直接返回、不探测硬件;
 * 2. machineIdSync 成功时透传其结果;
 * 3. machineIdSync 抛(bare `ioreg` not found)时不上抛,回落到随机 fallback;
 * 4. machineIdSync 返回空串时也视作失败,回落 fallback;
 * 5. ensureSystemBinPathForMachineId 在 darwin/linux 补齐 /usr/sbin:/sbin 且幂等。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const { machineIdSync } = vi.hoisted(() => ({
  machineIdSync: vi.fn(() => 'hw-fingerprint'),
}));

vi.mock('node-machine-id', () => ({ machineIdSync }));
// Isolate from the real main logger (touches electron app paths + fs at import).
vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

async function loadFresh() {
  vi.resetModules();
  return import('../deviceId');
}

describe('resolveDeviceId (minimal)', () => {
  const originalPath = process.env.PATH;
  const originalOverride = process.env.XDT_DEVICE_ID_OVERRIDE;

  beforeEach(() => {
    machineIdSync.mockReset();
    machineIdSync.mockReturnValue('hw-fingerprint');
    delete process.env.XDT_DEVICE_ID_OVERRIDE;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalOverride === undefined) delete process.env.XDT_DEVICE_ID_OVERRIDE;
    else process.env.XDT_DEVICE_ID_OVERRIDE = originalOverride;
  });

  it('override 优先,不探测硬件', async () => {
    process.env.XDT_DEVICE_ID_OVERRIDE = '  custom-device  ';
    const { resolveDeviceId } = await loadFresh();
    expect(resolveDeviceId()).toBe('custom-device');
    expect(machineIdSync).not.toHaveBeenCalled();
  });

  it('machineIdSync 成功时透传结果', async () => {
    const { resolveDeviceId } = await loadFresh();
    expect(resolveDeviceId()).toBe('hw-fingerprint');
  });

  it('memoise:多次调用只探测一次', async () => {
    const { resolveDeviceId } = await loadFresh();
    resolveDeviceId();
    resolveDeviceId();
    expect(machineIdSync).toHaveBeenCalledTimes(1);
  });

  it('machineIdSync 抛时不上抛,回落到随机 fallback', async () => {
    machineIdSync.mockImplementation(() => {
      throw new Error('ioreg: command not found');
    });
    const { resolveDeviceId } = await loadFresh();
    expect(resolveDeviceId()).toMatch(/^fallback-/);
  });

  it('machineIdSync 返回空串时视作失败,回落 fallback', async () => {
    machineIdSync.mockReturnValue('   ');
    const { resolveDeviceId } = await loadFresh();
    expect(resolveDeviceId()).toMatch(/^fallback-/);
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
