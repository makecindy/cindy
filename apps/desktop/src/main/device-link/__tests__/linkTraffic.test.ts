/**
 * 依据：远程连接面板按本机实际走的协议，显示最近 5 分钟、1 小时、24 小时的收发字节。
 * 覆盖缺口：拓扑测试只验证路径与活跃状态，无法发现重连重复累计、跨午夜清零或落盘失败漏计。
 * 最小失败输入：切换协议后旧连接才关闭；跨小时保存时一份成功、另一份失败，再重试并重启。
 * tier：unit；真实计量器、内存历史和可控时钟，无网络和计时等待。
 */
import { afterEach, expect, it, vi } from 'vitest';
import { LinkTrafficMeter, TICKS_PER_HOUR, mergeTrafficBuckets, type TrafficBucket } from '../linkTraffic';

afterEach(() => vi.useRealTimers());

it('keeps actual routes separate through reconnects and expires each rolling window across midnight', () => {
  vi.useFakeTimers();
  const start = Date.UTC(2026, 10, 19, 23, 57);
  vi.setSystemTime(start);
  const meter = new LinkTrafficMeter();
  const counters = { sent: 20, received: 50 };
  const close = meter.track('device-link', () => ({ ...counters }));
  vi.advanceTimersByTime(2_000);
  expect(meter.snapshot()?.last5m['device-link']).toEqual(counters);
  counters.sent = 30;
  close();
  close();
  // A different actual socket starts from zero, even if the preference is still Agent-Net.
  meter.track('device-link', () => ({ sent: 2, received: 3 }))();
  vi.setSystemTime(start + 6 * 60_000);
  meter.record('agent-net', 7, 9);
  const totals = { 'device-link': { sent: 32, received: 53 }, 'agent-net': { sent: 7, received: 9 } };
  const zero = { sent: 0, received: 0 };
  expect(meter.snapshot()).toEqual({ last5m: { ...totals, 'device-link': zero }, lastHour: totals, lastDay: totals });
  vi.setSystemTime(start + 60 * 60_000);
  expect(meter.snapshot()?.lastHour).toEqual({ ...totals, 'device-link': zero });
  vi.setSystemTime(start + 24 * 60 * 60_000);
  expect(meter.snapshot()?.lastDay).toEqual({ ...totals, 'device-link': zero });
  vi.setSystemTime(start + (24 * 60 + 6) * 60_000);
  expect(meter.snapshot()?.lastDay['agent-net']).toEqual(zero);
});

it('keeps pending bytes visible and retries only the uncommitted hour before restoring history', async () => {
  vi.useFakeTimers();
  const start = Date.UTC(2026, 10, 19, 23, 59);
  vi.setSystemTime(start);
  const secondHour = Math.floor(start / 3_600_000) + 1;
  const disk = new Map<number, TrafficBucket[]>();
  const firstWrite = Promise.withResolvers<void>();
  let fail = true;
  const history = {
    read: async () => [...disk.values()].flat(),
    mergeHour: async (hour: number, deltas: TrafficBucket[]) => {
      await firstWrite.promise;
      if (hour === secondHour && fail) throw new Error('offline');
      const rows = mergeTrafficBuckets(disk.get(hour) ?? [], deltas);
      expect(rows.every(row => Math.floor(row[0] / TICKS_PER_HOUR) === hour)).toBe(true);
      disk.set(hour, rows);
      return rows;
    },
    onError: vi.fn(),
  };
  const meter = new LinkTrafficMeter(history);
  await meter.flush();
  meter.record('device-link', 100, 200);
  vi.setSystemTime(start + 60_000);
  meter.record('agent-net', 400, 10);
  const write = meter.flush();
  meter.record('agent-net', 50, 1);
  const expected = { 'device-link': { sent: 100, received: 200 }, 'agent-net': { sent: 450, received: 11 } };
  expect(meter.snapshot()?.lastDay).toEqual(expected);
  firstWrite.resolve();
  await write;
  expect(history.onError).toHaveBeenCalledTimes(1);
  expect(meter.snapshot()?.lastDay).toEqual(expected);
  fail = false;
  await Promise.all([meter.flush(), meter.flush()]);
  const restarted = new LinkTrafficMeter(history);
  await restarted.flush();
  expect(restarted.snapshot()?.lastDay).toEqual(expected);
});
