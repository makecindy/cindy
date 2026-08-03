/**
 * responsivenessTracker.test.ts —— 桌面控制端「目标设备无响应」熔断接线的行为锁。
 *
 * 状态机本体(阈值 / 退避 / 代数作废)在 maker-shared 的 deviceResponsiveness.test.ts;
 * 这里锁 main 接线层的语义:门禁快速失败、探测 tick 的单飞与前置条件、恢复回调、
 * 成功 / 失败分类(超时计失败、控制帧成功不定论、探测通道回包关熔断)。
 */
import { describe, expect, it, vi } from 'vitest';
import { DeviceLinkError } from '@cindy/device-link';
import {
  BREAKER_FAILURE_THRESHOLD,
  BREAKER_PROBE_BACKOFF_BASE_MS,
} from '@cindy/maker-shared/device-responsiveness';
import {
  DEVICE_RESPONSIVENESS_PROBE_CHANNEL,
  classifyDeviceSendFailure,
  classifyDeviceSendSuccess,
  createResponsivenessTracker,
} from '../responsivenessTracker';

const DEV = 'device-under-test';

function timeoutError(): DeviceLinkError {
  return new DeviceLinkError('INVOKE_TIMEOUT', 'no invoke-result within 12000ms');
}

function harness(overrides?: {
  probeInvoke?: ReturnType<typeof vi.fn>;
  isProbeEligible?: () => boolean;
}) {
  let at = 1_000_000;
  const probeInvoke = overrides?.probeInvoke ?? vi.fn(async () => [{ id: 's1' }]);
  const onUnresponsiveChanged = vi.fn();
  const tracker = createResponsivenessTracker({
    probeInvoke,
    onUnresponsiveChanged,
    isProbeEligible: overrides?.isProbeEligible ?? (() => true),
    now: () => at,
  });
  return {
    tracker,
    probeInvoke,
    onUnresponsiveChanged,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

/** 连续 N 个超时批次把熔断打开(批次间推进时钟越过 1s 归批窗口,构成独立故障证据)。 */
async function openBreaker(h: ReturnType<typeof harness>): Promise<void> {
  for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) {
    await expect(
      h.tracker.guardInvoke(DEV, 'local-db:sessions:list', () => Promise.reject(timeoutError())),
    ).rejects.toThrow('no invoke-result');
    h.advance(1_100);
  }
  expect(h.tracker.isUnresponsive(DEV)).toBe(true);
}

describe('responsivenessTracker', () => {
  it('成功请求直通,不改变状态', async () => {
    const h = harness();
    await expect(
      h.tracker.guardInvoke(DEV, 'local-db:sessions:list', async () => 'result'),
    ).resolves.toBe('result');
    expect(h.tracker.isUnresponsive(DEV)).toBe(false);
    expect(h.onUnresponsiveChanged).not.toHaveBeenCalled();
  });

  it('连续超时达到阈值 → open,通知 UI,后续请求快速失败且不再上管道', async () => {
    const h = harness();
    await openBreaker(h);
    expect(h.onUnresponsiveChanged).toHaveBeenCalledWith(DEV, true);
    expect(h.tracker.getUnresponsiveDeviceIds()).toEqual([DEV]);

    const run = vi.fn(async () => 'never');
    await expect(h.tracker.guardInvoke(DEV, 'local-db:sessions:list', run)).rejects.toThrow(
      'unresponsive',
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('同一 1s 窗口内的并发超时归入同一批次,单轮 fan-out 不会误开熔断', async () => {
    const h = harness();
    // 同 tick 并发 3 个请求(capabilities/providers/git-safety 预取形态)同时超时:
    // 只算一次独立故障证据,熔断保持关闭。
    await Promise.all(
      Array.from({ length: BREAKER_FAILURE_THRESHOLD }, () =>
        expect(
          h.tracker.guardInvoke(DEV, 'local-db:sessions:list', () =>
            Promise.reject(timeoutError()),
          ),
        ).rejects.toThrow('no invoke-result'),
      ),
    );
    expect(h.tracker.isUnresponsive(DEV)).toBe(false);
    // 再来两个跨窗口的独立超时批次才凑满阈值。
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD - 1; i++) {
      h.advance(1_100);
      await expect(
        h.tracker.guardInvoke(DEV, 'local-db:sessions:list', () => Promise.reject(timeoutError())),
      ).rejects.toThrow('no invoke-result');
    }
    expect(h.tracker.isUnresponsive(DEV)).toBe(true);
  });

  it('非超时失败(NOT_CONNECTED 等)不定论,不累计熔断', async () => {
    const h = harness();
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD + 1; i++) {
      await expect(
        h.tracker.guardInvoke(DEV, 'local-db:sessions:list', () =>
          Promise.reject(new DeviceLinkError('NOT_CONNECTED', 'relay connection lost')),
        ),
      ).rejects.toThrow('relay connection lost');
    }
    expect(h.tracker.isUnresponsive(DEV)).toBe(false);
  });

  it('探测窗口未到 / 前置条件不满足时 probeTick 不发探测;窗口到且合格才单飞', async () => {
    let eligible = false;
    const h = harness({ isProbeEligible: () => eligible });
    await openBreaker(h);

    h.tracker.probeTick(); // 窗口未到
    expect(h.probeInvoke).not.toHaveBeenCalled();

    h.advance(BREAKER_PROBE_BACKOFF_BASE_MS);
    h.tracker.probeTick(); // 窗口已到但不合格(relay 掉线 / presence 不可用)
    expect(h.probeInvoke).not.toHaveBeenCalled();

    eligible = true;
    let resolveProbe!: (v: unknown) => void;
    h.probeInvoke.mockImplementationOnce(
      () => new Promise((res) => {
        resolveProbe = res;
      }),
    );
    h.tracker.probeTick();
    expect(h.probeInvoke).toHaveBeenCalledTimes(1);
    expect(h.probeInvoke).toHaveBeenCalledWith(
      DEV,
      DEVICE_RESPONSIVENESS_PROBE_CHANNEL,
      [1, 'all', { includePinned: true }],
    );
    // 在途探测占住单飞席位:再 tick 不重复发
    h.tracker.probeTick();
    expect(h.probeInvoke).toHaveBeenCalledTimes(1);

    resolveProbe([]);
    await vi.waitFor(() => {
      expect(h.tracker.isUnresponsive(DEV)).toBe(false);
    });
    expect(h.onUnresponsiveChanged).toHaveBeenLastCalledWith(DEV, false);
  });

  it('探测超时 → 保持 open 并加深退避(下个基础窗口不再探测)', async () => {
    const h = harness();
    await openBreaker(h);
    h.advance(BREAKER_PROBE_BACKOFF_BASE_MS);
    h.probeInvoke.mockRejectedValueOnce(timeoutError());
    h.tracker.probeTick();
    await vi.waitFor(() => {
      expect(h.probeInvoke).toHaveBeenCalledTimes(1);
    });
    expect(h.tracker.isUnresponsive(DEV)).toBe(true);

    h.advance(BREAKER_PROBE_BACKOFF_BASE_MS); // 退避已 ×2,一个基础窗口不够
    h.tracker.probeTick();
    expect(h.probeInvoke).toHaveBeenCalledTimes(1);
    h.advance(BREAKER_PROBE_BACKOFF_BASE_MS);
    h.tracker.probeTick();
    expect(h.probeInvoke).toHaveBeenCalledTimes(2);
  });

  it('clearDevice 作废在途请求的晚到超时:清除后旧超时不得重建计数', async () => {
    const h = harness();
    let rejectSlow!: (err: unknown) => void;
    const slow = h.tracker.guardInvoke(
      DEV,
      'local-db:sessions:list',
      () =>
        new Promise((_res, rej) => {
          rejectSlow = rej;
        }),
    );
    h.tracker.clearDevice(DEV);
    rejectSlow(timeoutError());
    await expect(slow).rejects.toThrow('no invoke-result');
    // 旧代结果被忽略:后续仍需完整阈值才会 open
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD - 1; i++) {
      await expect(
        h.tracker.guardInvoke(DEV, 'local-db:sessions:list', () => Promise.reject(timeoutError())),
      ).rejects.toThrow();
    }
    expect(h.tracker.isUnresponsive(DEV)).toBe(false);
  });

  it('resetAll 关闭所有 open 设备并通知恢复', async () => {
    const h = harness();
    await openBreaker(h);
    h.tracker.resetAll();
    expect(h.tracker.getUnresponsiveDeviceIds()).toEqual([]);
    expect(h.onUnresponsiveChanged).toHaveBeenLastCalledWith(DEV, false);
  });
});

describe('classifyDeviceSendFailure / classifyDeviceSendSuccess', () => {
  it('仅 INVOKE_TIMEOUT 计失败,其余不定论', () => {
    expect(classifyDeviceSendFailure(timeoutError())).toBe('timeout');
    expect(
      classifyDeviceSendFailure(new DeviceLinkError('NOT_CONNECTED', 'lost')),
    ).toBe('inconclusive');
    expect(classifyDeviceSendFailure(new Error('random'))).toBe('inconclusive');
  });

  it('控制帧 / dispatch 特判通道的成功不定论;业务 DB 通道的成功是恢复证据', () => {
    expect(classifyDeviceSendSuccess('device-link:subscribe')).toBe('inconclusive');
    expect(classifyDeviceSendSuccess('device-link:media:fetch')).toBe('inconclusive');
    expect(classifyDeviceSendSuccess('local-db:sessions:list')).toBe('responded');
    expect(classifyDeviceSendSuccess('maker:send')).toBe('responded');
  });

  it('持有探测席位时只有探测通道的回包算恢复', () => {
    expect(classifyDeviceSendSuccess('maker:list-agent-commands', true)).toBe('inconclusive');
    expect(classifyDeviceSendSuccess(DEVICE_RESPONSIVENESS_PROBE_CHANNEL, true)).toBe('responded');
  });
});
