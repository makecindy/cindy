/**
 * 测试价值
 * - 生产入口与可观察结果：createDeviceIdentityConflictMonitor 的 noteReplaced / reset；
 *   可观察结果是 onChange 是否确认冲突(设置页提示、重连冷却都只跟它走)以及是否额外读设备目录。
 * - Bug／规则依据：2026-11-23 两台 Windows 共用 MachineGuid 互踢 318 次(issue #9095、#8898)；
 *   用户要求「不能让没问题的用户连不上」，误判只能多一个提示，且没被反复顶替的用户不多发请求。
 * - 现有覆盖缺口：新模块；client.test.ts 只覆盖宿主确认后的重连冷却，不覆盖确认条件本身。
 * - 最小失败输入：10 分钟内被顶替 2 次，且目录里本机这一行的上报名是另一台电脑的名字。
 * - tier：unit(内存 fake + 假时钟，无网络)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDeviceIdentityConflictMonitor,
  DEVICE_IDENTITY_CONFLICT_QUIET_MS,
  type DeviceIdentityConflict,
  type DeviceIdentityDirectoryRow,
} from '../deviceIdentityConflict.js';

function harness(localNames: string[], rows: () => Promise<readonly DeviceIdentityDirectoryRow[]>) {
  const changes: Array<DeviceIdentityConflict | null> = [];
  const readDirectory = vi.fn(rows);
  const monitor = createDeviceIdentityConflictMonitor({
    selfDeviceId: () => 'self-id',
    localDeviceNames: () => localNames,
    readDirectory,
    onChange: (conflict) => changes.push(conflict),
  });
  return { monitor, changes, readDirectory };
}

describe('device identity conflict monitor', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_700_000_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  it.each([
    ['the same name', 'MY-PC'],
    ['the same name with different case and spacing', '  my-pc '],
    ['a server-truncated long name', 'A'.repeat(64)],
  ])('a computer that reports %s is never flagged, and one replacement reads nothing', async (_label, reported) => {
    const local = reported.startsWith('A') ? ['A'.repeat(90)] : ['MY-PC'];
    const h = harness(local, async () => [{ deviceId: 'self-id', isSelf: true, selfName: reported }]);
    h.monitor.noteReplaced();
    // 同一次顶替关掉了几条连接：仍算一次，不读目录。
    h.monitor.noteReplaced();
    expect(h.readDirectory).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_000);
    h.monitor.noteReplaced();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.readDirectory).toHaveBeenCalledTimes(1);
    expect(h.changes).toEqual([]);
    expect(h.monitor.current()).toBeNull();
  });

  it('confirms another computer by its reported name, reads at most once a minute, and clears after a quiet period', async () => {
    // 自建中转上本机的设备 ID 与账号设备 ID 不同：以服务端标出的 isSelf 为准。
    const h = harness(['MY-PC'], async () => [
      { deviceId: 'peer', isSelf: false, selfName: 'Laptop' },
      { deviceId: 'relay-self', isSelf: true, selfName: 'A-AAA-202611-14' },
    ]);
    h.monitor.noteReplaced();
    await vi.advanceTimersByTimeAsync(15_000);
    h.monitor.noteReplaced();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.changes).toEqual([{ otherDeviceName: 'A-AAA-202611-14', detectedAt: 1_700_000_015_000 }]);

    // 已确认后继续被顶替：不再读目录，也不重复通知。
    await vi.advanceTimersByTimeAsync(15_000);
    h.monitor.noteReplaced();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.readDirectory).toHaveBeenCalledTimes(1);
    expect(h.changes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(DEVICE_IDENTITY_CONFLICT_QUIET_MS);
    expect(h.changes.at(-1)).toBeNull();
    expect(h.monitor.current()).toBeNull();
  });

  it('drops a directory answer that arrives after an account switch', async () => {
    let answer!: (rows: readonly DeviceIdentityDirectoryRow[]) => void;
    const h = harness(['MY-PC'], () => new Promise((resolve) => { answer = resolve; }));
    h.monitor.noteReplaced();
    await vi.advanceTimersByTimeAsync(15_000);
    h.monitor.noteReplaced();
    h.monitor.reset();
    answer([{ deviceId: 'self-id', isSelf: true, selfName: 'Other-PC' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.changes).toEqual([]);
  });
});
