import { describe, expect, it, vi } from 'vitest';
import {
  BREAKER_FAILURE_THRESHOLD,
  BREAKER_PROBE_BACKOFF_BASE_MS,
  BREAKER_PROBE_BACKOFF_MAX_MS,
  createDeviceResponsivenessBreaker,
  isPresenceEligibleForRemoteRequest,
  isPresenceValueEligible,
  type BreakerSendSlot,
} from '../deviceResponsiveness';

describe('automatic recovery presence eligibility', () => {
  it('allows explicit availability and unknown, but blocks explicit unavailable', () => {
    const availability = new Map<string, boolean>([
      ['online', true],
      ['offline', false],
    ]);

    expect(isPresenceValueEligible(true)).toBe(true);
    expect(isPresenceValueEligible(undefined)).toBe(true);
    expect(isPresenceValueEligible(false)).toBe(false);
    expect(isPresenceEligibleForRemoteRequest(availability, 'online')).toBe(true);
    expect(isPresenceEligibleForRemoteRequest(availability, 'unknown')).toBe(true);
    expect(isPresenceEligibleForRemoteRequest(availability, 'offline')).toBe(false);
  });
});

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

type Breaker = ReturnType<typeof harness>['breaker'];

/** closed 态一次「acquire→settle」;acquire 必须是 allow。 */
function settleOnce(
  breaker: Breaker,
  outcome: 'timeout' | 'responded' | 'inconclusive',
  deviceId = DEV,
): void {
  const slot = breaker.acquire(deviceId);
  expect(slot.decision).toBe('allow');
  breaker.settle(deviceId, slot, outcome);
}

function timeoutOnce(breaker: Breaker, deviceId = DEV): void {
  settleOnce(breaker, 'timeout', deviceId);
}

/** 打开熔断:连续 threshold 次超时。 */
function openBreaker(h: ReturnType<typeof harness>): void {
  for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) timeoutOnce(h.breaker);
  expect(h.breaker.isOpen(DEV)).toBe(true);
}

/** 到点探测:acquire 必须拿到 probe 席位,返回票据供 settle。 */
function acquireProbe(h: ReturnType<typeof harness>, deviceId = DEV): BreakerSendSlot {
  const slot = h.breaker.acquire(deviceId, undefined, { allowProbe: true });
  expect(slot.decision).toBe('probe');
  return slot;
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
    expect(h.breaker.acquire(DEV).decision).toBe('reject');
  });

  it('同一显式 fan-out 一起超时只贡献一次 strike,不会误判为三轮故障', () => {
    const h = harness();
    const cohort = h.breaker.createCohort(DEV);
    const batch = [
      h.breaker.acquire(DEV, cohort),
      h.breaker.acquire(DEV, cohort),
      h.breaker.acquire(DEV, cohort),
      h.breaker.acquire(DEV, cohort),
    ];
    expect(new Set(batch.map((slot) => slot.cohort))).toEqual(new Set([cohort]));

    for (const slot of batch) h.breaker.settle(DEV, slot, 'timeout');
    expect(h.breaker.isOpen(DEV)).toBe(false);

    // 后续普通请求没有显式共享 cohort,各自代表新的独立故障观测。
    timeoutOnce(h.breaker);
    expect(h.breaker.isOpen(DEV)).toBe(false);
    timeoutOnce(h.breaker);
    expect(h.breaker.isOpen(DEV)).toBe(true);
  });

  it('未显式分组的同步请求各自使用独立 cohort', () => {
    const h = harness();
    const slots = [
      h.breaker.acquire(DEV),
      h.breaker.acquire(DEV),
      h.breaker.acquire(DEV),
    ];
    expect(new Set(slots.map((slot) => slot.cohort)).size).toBe(3);

    for (const slot of slots) h.breaker.settle(DEV, slot, 'timeout');
    expect(h.breaker.isOpen(DEV)).toBe(true);
  });

  it('每轮 acquire→timeout 的顺序故障仍按独立 cohort 连续累计', () => {
    const h = harness();
    const cohorts: number[] = [];
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) {
      const slot = h.breaker.acquire(DEV);
      cohorts.push(slot.cohort);
      h.breaker.settle(DEV, slot, 'timeout');
    }
    expect(new Set(cohorts).size).toBe(BREAKER_FAILURE_THRESHOLD);
    expect(h.breaker.isOpen(DEV)).toBe(true);
  });

  it('preserves cohort id uniqueness after a generation bump', () => {
    const h = harness();
    const first = h.breaker.createCohort(DEV);
    const stale = h.breaker.acquire(DEV, first);
    timeoutOnce(h.breaker);
    h.breaker.settle(DEV, stale, 'responded');

    const next = h.breaker.acquire(DEV);
    expect(next.cohort).not.toBe(first);
    h.breaker.settle(DEV, next, 'timeout');
    expect(h.breaker.isOpen(DEV)).toBe(false);
  });

  it('真实回包(即使是业务错误应答)重置连续计数', () => {
    const h = harness();
    timeoutOnce(h.breaker);
    timeoutOnce(h.breaker);
    settleOnce(h.breaker, 'responded');
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
    settleOnce(h.breaker, 'inconclusive');
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
    expect(h.breaker.acquire(DEV).decision).toBe('reject');
    // 到点:仅第一个 acquire 拿到探测席位,其余照旧 reject
    h.advance(1);
    acquireProbe(h);
    expect(h.breaker.acquire(DEV).decision).toBe('reject');
  });

  it('探测成功即 close 并通知;后续请求恢复 allow', () => {
    const h = harness();
    openBreaker(h);
    h.advance(BREAKER_PROBE_BACKOFF_BASE_MS);
    const probe = acquireProbe(h);
    h.breaker.settle(DEV, probe, 'responded');
    expect(h.breaker.isOpen(DEV)).toBe(false);
    expect(h.onOpenChanged).toHaveBeenLastCalledWith(DEV, false);
    expect(h.breaker.acquire(DEV).decision).toBe('allow');
  });

  it('探测再超时:回 open 并加深退避(10s→20s→…封顶 120s)', () => {
    const h = harness();
    openBreaker(h);
    let backoff = BREAKER_PROBE_BACKOFF_BASE_MS;
    // 连续探测失败,窗口每轮翻倍直至封顶(时间单调推进,纯 Date.now 差值驱动)
    for (let round = 0; round < 6; round++) {
      h.advance(backoff - 1);
      expect(h.breaker.acquire(DEV).decision).toBe('reject');
      h.advance(1);
      const probe = acquireProbe(h);
      h.breaker.settle(DEV, probe, 'timeout');
      backoff = Math.min(backoff * 2, BREAKER_PROBE_BACKOFF_MAX_MS);
    }
    expect(backoff).toBe(BREAKER_PROBE_BACKOFF_MAX_MS);
    expect(h.breaker.isOpen(DEV)).toBe(true);
  });

  it('open 期间旧请求(非探测)超时不推进退避窗口', () => {
    const h = harness();
    // open 前已在途的请求(同一代,尚未有 responded 翻篇)
    const older1 = h.breaker.acquire(DEV);
    const older2 = h.breaker.acquire(DEV);
    openBreaker(h);
    // 旧请求陆续超时(非探测):不影响 10s 首个探测窗口
    h.breaker.settle(DEV, older1, 'timeout');
    h.breaker.settle(DEV, older2, 'timeout');
    h.advance(BREAKER_PROBE_BACKOFF_BASE_MS);
    acquireProbe(h);
  });

  it('探测 inconclusive(如探测期间掉线)释放单飞,可立即再探测', () => {
    const h = harness();
    openBreaker(h);
    h.advance(BREAKER_PROBE_BACKOFF_BASE_MS);
    const probe = acquireProbe(h);
    h.breaker.settle(DEV, probe, 'inconclusive');
    // 窗口基准未动(早已到点),新的探测立即放行
    acquireProbe(h);
  });

  it('per-device 隔离:一台设备 open 不影响另一台', () => {
    const h = harness();
    openBreaker(h);
    expect(h.breaker.acquire('dev-2').decision).toBe('allow');
    expect(h.breaker.isOpen('dev-2')).toBe(false);
  });

  it('resetAll 清空状态并对 open 中的设备发 close 通知;在途旧代结果作废', () => {
    const h = harness();
    const inFlight = h.breaker.acquire(DEV);
    openBreaker(h);
    h.onOpenChanged.mockClear();
    h.breaker.resetAll();
    expect(h.breaker.isOpen(DEV)).toBe(false);
    expect(h.breaker.acquire(DEV).decision).toBe('allow');
    expect(h.onOpenChanged).toHaveBeenCalledWith(DEV, false);
    // resetAll 前派出的请求超时不再计数(切号后旧账不入新账)
    h.breaker.settle(DEV, inFlight, 'timeout');
    h.breaker.settle(DEV, inFlight, 'timeout');
    h.breaker.settle(DEV, inFlight, 'timeout');
    expect(h.breaker.isOpen(DEV)).toBe(false);
  });
});

describe('generation:恢复前派出的旧请求结果不采信(review P1)', () => {
  it('探测成功关熔断后,恢复前在途的长超时请求陆续超时不会重新 open', () => {
    const h = harness();
    // 事故场景:30/40s 长通道请求先在途(尚未落定)
    const longA = h.breaker.acquire(DEV);
    const longB = h.breaker.acquire(DEV);
    const longC = h.breaker.acquire(DEV);
    // 3 条 15s 请求先超时 → open
    openBreaker(h);
    // 探测成功 → close(设备已恢复)
    h.advance(BREAKER_PROBE_BACKOFF_BASE_MS);
    const probe = acquireProbe(h);
    h.breaker.settle(DEV, probe, 'responded');
    expect(h.breaker.isOpen(DEV)).toBe(false);
    // 恢复前派出的长请求这才等满超时:属旧代,一律忽略,不得把刚恢复的熔断再打开
    h.breaker.settle(DEV, longA, 'timeout');
    h.breaker.settle(DEV, longB, 'timeout');
    h.breaker.settle(DEV, longC, 'timeout');
    expect(h.breaker.isOpen(DEV)).toBe(false);
    // 新一代请求照常计数:3 次新超时仍能 open
    openBreaker(h);
  });

  it('清零失败计数的 responded 翻篇:之前在途请求的晚到超时不计入连续计数', () => {
    const h = harness();
    const stale = h.breaker.acquire(DEV);
    timeoutOnce(h.breaker);
    timeoutOnce(h.breaker);
    settleOnce(h.breaker, 'responded'); // 设备活着,计数清零 + 翻篇
    h.breaker.settle(DEV, stale, 'timeout'); // 晚到的旧超时:忽略
    timeoutOnce(h.breaker);
    timeoutOnce(h.breaker);
    expect(h.breaker.isOpen(DEV)).toBe(false); // 新代只累计了 2 次
  });

  it('健康并发里一个快回包后,同批慢请求一起超时仍只算一个故障批次', () => {
    const h = harness();
    const cohort = h.breaker.createCohort(DEV);
    const slow1 = h.breaker.acquire(DEV, cohort);
    const slow2 = h.breaker.acquire(DEV, cohort);
    const slow3 = h.breaker.acquire(DEV, cohort);
    const fast = h.breaker.acquire(DEV, cohort);
    h.breaker.settle(DEV, fast, 'responded'); // 设备当时没有失败状态,不翻代
    h.breaker.settle(DEV, slow1, 'timeout');
    h.breaker.settle(DEV, slow2, 'timeout');
    h.breaker.settle(DEV, slow3, 'timeout');
    expect(h.breaker.isOpen(DEV)).toBe(false);
    // 后续两轮独立超时仍会补足三次阈值,没有把真实持续卡死静默掉。
    timeoutOnce(h.breaker);
    timeoutOnce(h.breaker);
    expect(h.breaker.isOpen(DEV)).toBe(true);
  });

  it('clear(权威 offline / 撤权)翻篇:整批在途超时不会重建计数', () => {
    const h = harness();
    const stale = [
      h.breaker.acquire(DEV),
      h.breaker.acquire(DEV),
      h.breaker.acquire(DEV),
    ];
    timeoutOnce(h.breaker);
    h.breaker.clear(DEV);
    for (const slot of stale) h.breaker.settle(DEV, slot, 'timeout');
    expect(h.breaker.isOpen(DEV)).toBe(false);
    // 清理不影响之后真正的独立故障检测。
    timeoutOnce(h.breaker);
    timeoutOnce(h.breaker);
    expect(h.breaker.isOpen(DEV)).toBe(false);
    timeoutOnce(h.breaker);
    expect(h.breaker.isOpen(DEV)).toBe(true);
  });

  it('旧代 responded 同样不采信(不会误关新一代已 open 的熔断)', () => {
    const h = harness();
    const stale = h.breaker.acquire(DEV);
    timeoutOnce(h.breaker); // 产生失败计数,让下面的 responded 构成清理性翻篇
    settleOnce(h.breaker, 'responded'); // 翻篇:stale 变旧代
    openBreaker(h); // 新代 open
    h.breaker.settle(DEV, stale, 'responded'); // 旧代晚到成功:忽略
    expect(h.breaker.isOpen(DEV)).toBe(true);
  });

  it('resetAll 覆盖「仅 acquire 过、无任何 settle」的设备(review:切号旧账不入新账)', () => {
    const h = harness();
    // dev-2 只发放过席位,从未 settle:没有 state,代数登记必须发生在 acquire 时
    const stale = h.breaker.acquire('dev-2');
    h.breaker.resetAll();
    h.breaker.settle('dev-2', stale, 'timeout');
    h.breaker.settle('dev-2', stale, 'timeout');
    h.breaker.settle('dev-2', stale, 'timeout');
    expect(h.breaker.isOpen('dev-2')).toBe(false);
    // 新代请求照常计数
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) timeoutOnce(h.breaker, 'dev-2');
    expect(h.breaker.isOpen('dev-2')).toBe(true);
  });
});

describe('clear(单设备清除,撤权场景)', () => {
  it('open 中清除:删状态并发 close 通知', () => {
    const h = harness();
    openBreaker(h);
    h.onOpenChanged.mockClear();
    h.breaker.clear(DEV);
    expect(h.breaker.isOpen(DEV)).toBe(false);
    expect(h.onOpenChanged).toHaveBeenCalledWith(DEV, false);
    expect(h.breaker.acquire(DEV).decision).toBe('allow');
  });
});

describe('probeDue(只读探测窗口判定,给 rehydrate 主动探测用)', () => {
  it('closed 设备恒 false;open 后窗口未到 false、窗口到 true', () => {
    const h = harness();
    expect(h.breaker.probeDue(DEV)).toBe(false);
    openBreaker(h);
    expect(h.breaker.probeDue(DEV)).toBe(false);
    h.advance(BREAKER_PROBE_BACKOFF_BASE_MS);
    expect(h.breaker.probeDue(DEV)).toBe(true);
  });

  it('是只读的:不占用探测席位,acquire 仍能拿到 probe', () => {
    const h = harness();
    openBreaker(h);
    h.advance(BREAKER_PROBE_BACKOFF_BASE_MS);
    expect(h.breaker.probeDue(DEV)).toBe(true);
    expect(h.breaker.probeDue(DEV)).toBe(true);
    const probe = acquireProbe(h);
    // 探测在途时 probeDue 收回 false(rehydrate 不应重复带上该设备)
    expect(h.breaker.probeDue(DEV)).toBe(false);
    h.breaker.settle(DEV, probe, 'responded');
    expect(h.breaker.probeDue(DEV)).toBe(false);
    expect(h.breaker.isOpen(DEV)).toBe(false);
  });

  it('half-open 时普通请求不能占用 probe 席位', () => {
    const h = harness();
    openBreaker(h);
    h.advance(BREAKER_PROBE_BACKOFF_BASE_MS);
    expect(h.breaker.acquire(DEV, h.breaker.createCohort(DEV)).decision).toBe('reject');
    expect(h.breaker.acquire(DEV, undefined, { allowProbe: true }).decision).toBe('probe');
  });
});
