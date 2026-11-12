import { beforeEach, describe, expect, it } from 'vitest';
import {
  acquireDeviceSendSlot,
  noteAppLifecycleState,
  resetDeviceResponsivenessTracking,
  settleDeviceSend,
  unresponsiveDevicesStore,
} from '@/device-link/unresponsiveDevicesStore';

const DEVICE = 'desktop-under-test';

function timeOut(count: number): void {
  const slots = Array.from({ length: count }, () => acquireDeviceSendSlot(DEVICE));
  for (const slot of slots) settleDeviceSend(DEVICE, slot, 'timeout');
}

describe('App 挂起期间的请求超时不计入「电脑端未响应」熔断', () => {
  beforeEach(() => {
    noteAppLifecycleState('active');
    resetDeviceResponsivenessTracking();
  });

  it('前台连续超时仍照常打开熔断(基线)', () => {
    timeOut(3);
    expect(unresponsiveDevicesStore.has(DEVICE)).toBe(true);
  });

  it('前台发出、退后台后才到点的超时按不定论处理', () => {
    const slots = Array.from({ length: 3 }, () => acquireDeviceSendSlot(DEVICE));
    noteAppLifecycleState('inactive');
    noteAppLifecycleState('background');
    for (const slot of slots) settleDeviceSend(DEVICE, slot, 'timeout');
    expect(unresponsiveDevicesStore.has(DEVICE)).toBe(false);
  });

  it('后台发出、计时器在 active 事件送达前到点的超时同样不计数(2026-10-05 线上时序)', () => {
    noteAppLifecycleState('background');
    timeOut(4);
    expect(unresponsiveDevicesStore.has(DEVICE)).toBe(false);
  });

  it('回到前台后新发出的请求超时重新正常计数', () => {
    noteAppLifecycleState('background');
    timeOut(3);
    noteAppLifecycleState('active');
    expect(unresponsiveDevicesStore.has(DEVICE)).toBe(false);
    timeOut(3);
    expect(unresponsiveDevicesStore.has(DEVICE)).toBe(true);
  });

  it('跨越生命周期的真实回包仍作为健康证据清零此前的连续超时', () => {
    timeOut(2);
    const answered = acquireDeviceSendSlot(DEVICE);
    noteAppLifecycleState('background');
    settleDeviceSend(DEVICE, answered, 'responded');
    noteAppLifecycleState('active');
    timeOut(2);
    expect(unresponsiveDevicesStore.has(DEVICE)).toBe(false);
  });
});
