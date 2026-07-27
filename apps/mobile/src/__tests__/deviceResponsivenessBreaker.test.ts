import { describe, expect, it, vi } from 'vitest';
import {
  BREAKER_FAILURE_THRESHOLD,
  BREAKER_PROBE_BACKOFF_BASE_MS,
  BREAKER_PROBE_BACKOFF_MAX_MS,
  createDeviceResponsivenessBreaker,
} from '@/device-link/deviceResponsivenessBreaker';

const DEV = 'dev-1';

function harness(startAt = 1_000_000) {
  let at = startAt;
  const onOpenChanged = vi.fn();
  const breaker = createDeviceResponsivenessBreaker({ now: () => at, onOpenChanged });
  return {
    breaker,
    onOpenChanged,
    advance: (ms: number) => { at += ms; },
  };
}

/** closed 态一次「acquire→超时」;acquire 必须是 allow。 */
function timeoutOnce(breaker: ReturnType<typeof harness>['breaker'], deviceId = DEV): void {
  expect(breaker.acquire(deviceId)).toBe('allow');
  breaker.settle(deviceId, false, 'timeout');
}

/** 打开熔断:连续 threshold 次超时。 */
function openBreaker(h: ReturnType<typeof harness>): void {
  for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) timeoutOnce(h.breaker);
  expect(h.breaker.isOpen(DEV)).toBe(true);
}

describe('deviceResponsivenessBreaker', () => {
  it('连续 3 次 INVOKE_TIMEOUT 才 open;不足阈值保持 closed', () => {
    const h = harness();
    timeoutOnce(h.breaker);
    timeoutOnce(h.breaker);
    expect(h.breaker.isOpen(DEV)).toBe(false);
    expect(h.onOpenChanged).not.toHaveBeenCalled();
    timeoutOnce(h.breaker);
    expect(h.breaker.isOpen(DEV)).toBe(true);
    expect(h.onOpenChanged).toHaveBeenCalledTimes(1);
    expect(h.onOpenChanged).toHaveBeenCalledWith(DEV, true);
    // open 后、探测窗口内:新请求快速失败
    expect(h.breaker.acquire(DEV)).toBe('reject');
  });

  it('真实回包(即使是业务错误应答)重置连续计数', () => {
    const h = harness();
    timeoutOnce(h.breaker);
    timeoutOnce(h.breaker);
    h.breaker.settle(DEV, false, 'responded');
    // 重置后再来 2 次超时仍不该 open(等价于从零累计)
    timeoutOnce(h.breaker);
    timeoutOnce(h.breaker);
    expect(h.breaker.isOpen(DEV)).toBe(false);
    timeoutOnce(h.breaker);
    expect(h.breaker.isOpen(DEV)).toBe(true);
  });

  it('inconclusive(NOT_CONNECTED 等本机链路问题)不计数也不重置', () => {
    const h = harness();
    timeoutOnce(h.breaker);
    timeoutOnce(h.breaker);
    h.breaker.settle(DEV, false, 'inconclusive');
    expect(h.breaker.isOpen(DEV)).toBe(false);
    // 计数保留:第 3 次超时直接 open
    timeoutOnce(h.breaker);
    expect(h.breaker.isOpen(DEV)).toBe(true);
  });

  it('half-open:退避窗口(Date.now 差值驱动)到点放行单个探测,单飞互斥', () => {
    const h = harness();
    openBreaker(h);
    // 窗口未到:一律 reject
    h.advance(BREAKER_PROBE_BACKOFF_BASE_MS - 1);
    expect(h.breaker.acquire(DEV)).toBe('reject');
    // 到点:仅第一个 acquire 拿到探测席位,其余照旧 reject
    h.advance(1);
    expect(h.breaker.acquire(DEV)).toBe('probe');
    expect(h.breaker.acquire(DEV)).toBe('reject');
  });

  it('探测成功即 close 并通知;后续请求恢复 allow', () => {
    const h = harness();
    openBreaker(h);
    h.advance(BREAKER_PROBE_BACKOFF_BASE_MS);
    expect(h.breaker.acquire(DEV)).toBe('probe');
    h.breaker.settle(DEV, true, 'responded');
    expect(h.breaker.isOpen(DEV)).toBe(false);
    expect(h.onOpenChanged).toHaveBeenLastCalledWith(DEV, false);
    expect(h.breaker.acquire(DEV)).toBe('allow');
  });

  it('探测再超时:回 open 并加深退避(10s→20s→…封顶 120s)', () => {
    const h = harness();
    openBreaker(h);
    let backoff = BREAKER_PROBE_BACKOFF_BASE_MS;
    // 连续探测失败,窗口每轮翻倍直至封顶(时间单调推进,纯 Date.now 差值驱动)
    for (let round = 0; round < 6; round++) {
      h.advance(backoff - 1);
      expect(h.breaker.acquire(DEV)).toBe('reject');
      h.advance(1);
      expect(h.breaker.acquire(DEV)).toBe('probe');
      h.breaker.settle(DEV, true, 'timeout');
      backoff = Math.min(backoff * 2, BREAKER_PROBE_BACKOFF_MAX_MS);
    }
    expect(backoff).toBe(BREAKER_PROBE_BACKOFF_MAX_MS);
    expect(h.breaker.isOpen(DEV)).toBe(true);
  });

  it('open 期间旧请求(非探测)超时不推进退避窗口', () => {
    const h = harness();
    openBreaker(h);
    // open 前已在途的请求陆续超时(wasProbe=false):不影响 10s 首个探测窗口
    h.breaker.settle(DEV, false, 'timeout');
    h.breaker.settle(DEV, false, 'timeout');
    h.advance(BREAKER_PROBE_BACKOFF_BASE_MS);
    expect(h.breaker.acquire(DEV)).toBe('probe');
  });

  it('探测 inconclusive(如探测期间掉线)释放单飞,可立即再探测', () => {
    const h = harness();
    openBreaker(h);
    h.advance(BREAKER_PROBE_BACKOFF_BASE_MS);
    expect(h.breaker.acquire(DEV)).toBe('probe');
    h.breaker.settle(DEV, true, 'inconclusive');
    // 窗口基准未动(早已到点),新的探测立即放行
    expect(h.breaker.acquire(DEV)).toBe('probe');
  });

  it('per-device 隔离:一台设备 open 不影响另一台', () => {
    const h = harness();
    openBreaker(h);
    expect(h.breaker.acquire('dev-2')).toBe('allow');
    expect(h.breaker.isOpen('dev-2')).toBe(false);
  });

  it('resetAll 清空状态并对 open 中的设备发 close 通知', () => {
    const h = harness();
    openBreaker(h);
    h.onOpenChanged.mockClear();
    h.breaker.resetAll();
    expect(h.breaker.isOpen(DEV)).toBe(false);
    expect(h.breaker.acquire(DEV)).toBe('allow');
    expect(h.onOpenChanged).toHaveBeenCalledWith(DEV, false);
  });
});
