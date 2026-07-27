/**
 * resolveDeviceId 单测 —— 取设备 ID 的启动崩溃护栏 + 身份稳定性。
 *
 * 关注点:
 * 1. XDT_DEVICE_ID_OVERRIDE 优先,直接返回、不碰硬件指纹与磁盘;
 * 2. machineIdSync 成功时透传其结果,并持久化;
 * 3. 首次取到的身份被冻结:硬件指纹成功持久化后,后续启动即使 machineIdSync 抛,
 *    也复用已持久化的硬件 ID,绝不改判成陌生 fallback(否则冷启动 refresh 可能登出);
 * 4. machineIdSync 抛(bare `ioreg` not found)时不上抛,回落到持久化 UUID,跨启动稳定;
 * 5. 磁盘已有身份时,直接复用,不被本次 machineIdSync 结果覆盖(并发首写的赢家值胜出);
 * 6. userData 不可用(app 未 ready)时不崩溃,返回临时 fallback 且不因缺 whenReady 抛;
 * 7. ensureSystemBinPathForMachineId 在 darwin/linux 补齐 /usr/sbin:/sbin 且幂等。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const { appMock, machineIdSync } = vi.hoisted(() => ({
  appMock: { getPath: vi.fn((): string => '') },
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

  it('指纹先成功落盘,后续启动指纹抛时复用它(transient 失败不改判、不登出)', async () => {
    // 首启:硬件指纹成功 → 持久化。
    const first = await loadFresh();
    expect(first.resolveDeviceId()).toBe('hw-fingerprint');

    // 次启:同一份 userData,指纹这次抛 —— 必须复用持久化的硬件 ID,而非造 fallback。
    machineIdSync.mockImplementation(() => {
      throw new Error('ioreg: command not found');
    });
    const second = await loadFresh();
    expect(second.resolveDeviceId()).toBe('hw-fingerprint');
  });

  it('machineIdSync 抛时不上抛,回落到持久化 UUID 且跨启动稳定', async () => {
    machineIdSync.mockImplementation(() => {
      throw new Error('ioreg: command not found');
    });

    const first = await loadFresh();
    const id1 = first.resolveDeviceId();
    expect(id1).toMatch(/^fallback-/);

    // 次启读同一份 userData,应拿到同一个持久化 id(不再 churn)。
    const second = await loadFresh();
    expect(second.resolveDeviceId()).toBe(id1);
  });

  it('硬件指纹可用时以其为准,并更新磁盘上的旧值(修复 userData 拷贝/恢复到新机)', async () => {
    // 磁盘上是从别的机器带过来的旧 id;本机指纹可用 → 应以本机指纹为准并回写。
    fs.writeFileSync(path.join(tmpDir, 'device-id'), 'old-machine-id', 'utf8');
    machineIdSync.mockReturnValue('this-machine-hw');

    const { resolveDeviceId } = await loadFresh();
    expect(resolveDeviceId()).toBe('this-machine-hw');
    expect(fs.readFileSync(path.join(tmpDir, 'device-id'), 'utf8')).toBe('this-machine-hw');
  });

  it('machineIdSync 返回空串时视作失败,不落盘空 ID,改用 fallback', async () => {
    machineIdSync.mockReturnValue('   ');
    const { resolveDeviceId } = await loadFresh();
    const id = resolveDeviceId();
    expect(id).toMatch(/^fallback-/);
    // 磁盘持久化的是 fallback,不是空串。
    expect(fs.readFileSync(path.join(tmpDir, 'device-id'), 'utf8').trim()).toBe(id);
  });

  it('落盘内容完整且等于返回值,且不残留 .tmp 文件', async () => {
    machineIdSync.mockImplementation(() => {
      throw new Error('ioreg: command not found');
    });
    const { resolveDeviceId } = await loadFresh();
    const id = resolveDeviceId();

    expect(fs.readFileSync(path.join(tmpDir, 'device-id'), 'utf8')).toBe(id);
    const leftovers = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('userData 不可用时不崩溃,返回临时 fallback', async () => {
    appMock.getPath.mockImplementation(() => {
      throw new Error('app is not ready');
    });
    machineIdSync.mockImplementation(() => {
      throw new Error('ioreg: command not found');
    });

    const { resolveDeviceId } = await loadFresh();
    // 不缺 whenReady 也不抛,拿到一个可用的临时 id。
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
