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
const OTHER_DEV = 'other-device';

function timeoutError(): DeviceLinkError {
  return new DeviceLinkError('INVOKE_TIMEOUT', 'no invoke-result within 12000ms');
}

function harness(overrides?: {
  probeInvoke?: ReturnType<typeof vi.fn>;
  isProbeEligible?: () => boolean;
  recoverLink?: ReturnType<typeof vi.fn>;
}) {
  let at = 1_000_000;
  const probeInvoke = overrides?.probeInvoke ?? vi.fn(async () => [{ id: 's1' }]);
  const onUnresponsiveChanged = vi.fn();
  const tracker = createResponsivenessTracker({
    probeInvoke,
    onUnresponsiveChanged,
    isProbeEligible: overrides?.isProbeEligible ?? (() => true),
    recoverLink: overrides?.recoverLink,
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
async function openBreaker(
  h: ReturnType<typeof harness>,
  deviceId = DEV,
): Promise<void> {
  for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) {
    await expect(
      h.tracker.guardInvoke(deviceId, 'local-db:sessions:list', () =>
        Promise.reject(timeoutError()),
      ),
    ).rejects.toThrow('no invoke-result');
    h.advance(1_100);
  }
  expect(h.tracker.isUnresponsive(deviceId)).toBe(true);
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

  it('首次业务超时触发一次 peer link 重开,并对并发超时去重', async () => {
    const recoverLink = vi.fn(() => new Promise<void>(() => {}));
    const h = harness({ recoverLink });
    for (let i = 0; i < 2; i++) {
      await expect(
        h.tracker.guardInvoke(DEV, 'local-db:sessions:list', () => Promise.reject(timeoutError())),
      ).rejects.toThrow();
    }
    expect(recoverLink).toHaveBeenCalledTimes(1);
    expect(recoverLink).toHaveBeenCalledWith(DEV);
  });

  it('同一设备的独立并发超时分别计数,避免吞掉独立故障', async () => {
    const h = harness();
    const requests = Array.from({ length: BREAKER_FAILURE_THRESHOLD }, () =>
      h.tracker.guardInvoke(DEV, 'local-db:sessions:list', () => Promise.reject(timeoutError())),
    );
    await expect(Promise.all(requests)).rejects.toThrow('no invoke-result');
    expect(h.tracker.isUnresponsive(DEV)).toBe(true);
  });

  it('启动只读 fan-out 同批超时只计一次,跨批次仍按独立故障熔断', async () => {
    const h = harness();
    const channels = [
      'maker:get-capabilities',
      'maker:get-capabilities',
      'maker:get-capabilities',
      'maker:provider:list',
      'maker:git-safety:get',
    ];
    const timeoutBatch = async (): Promise<void> => {
      const results = await Promise.allSettled(
        channels.map((channel) =>
          h.tracker.guardInvoke(DEV, channel, () => Promise.reject(timeoutError())),
        ),
      );
      expect(results.every((result) => result.status === 'rejected')).toBe(true);
    };

    await timeoutBatch();
    expect(h.tracker.isUnresponsive(DEV)).toBe(false);

    h.advance(250);
    await timeoutBatch();
    expect(h.tracker.isUnresponsive(DEV)).toBe(false);

    h.advance(250);
    await timeoutBatch();
    expect(h.tracker.isUnresponsive(DEV)).toBe(true);
  });

  it('探测窗口未到 / 前置条件不满足时 probeTick 不发探测;窗口到且合格才单飞', async () => {
    let eligible = false;
    const h = harness({ isProbeEligible: () => eligible });
    await openBreaker(h);

    h.tracker.probeTick(); // 窗口未到
    expect(h.probeInvoke).not.toHaveBeenCalled();

    h.advance(BREAKER_PROBE_BACKOFF_BASE_MS);
    const run = vi.fn(async () => 'business-result');
    await expect(h.tracker.guardInvoke(DEV, 'maker:send', run)).rejects.toThrow('unresponsive');
    expect(run).not.toHaveBeenCalled();
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

  it('探测超时会再次重开该 peer link,不影响其它设备', async () => {
    let resolveInitialRecovery!: () => void;
    const initialRecovery = new Promise<void>((resolve) => {
      resolveInitialRecovery = resolve;
    });
    const recoverLink = vi
      .fn()
      .mockImplementationOnce(() => initialRecovery)
      .mockResolvedValue(undefined);
    const h = harness({ recoverLink });
    await openBreaker(h);
    expect(recoverLink).toHaveBeenCalledTimes(1);
    expect(recoverLink).toHaveBeenCalledWith(DEV);

    await expect(
      h.tracker.guardInvoke(OTHER_DEV, 'local-db:sessions:list', async () => 'other-ok'),
    ).resolves.toBe('other-ok');
    resolveInitialRecovery();
    await initialRecovery;

    h.advance(BREAKER_PROBE_BACKOFF_BASE_MS);
    h.probeInvoke.mockRejectedValueOnce(timeoutError());
    h.tracker.probeTick();
    await vi.waitFor(() => {
      expect(recoverLink).toHaveBeenCalledTimes(2);
    });
    expect(recoverLink).toHaveBeenNthCalledWith(2, DEV);
    expect(h.tracker.isUnresponsive(OTHER_DEV)).toBe(false);
    await expect(
      h.tracker.guardInvoke(OTHER_DEV, 'local-db:sessions:list', async () => 'still-ok'),
    ).resolves.toBe('still-ok');
  });

  it('clearDevice 后晚到的探测超时不再触发 link recovery', async () => {
    let rejectProbe!: (err: unknown) => void;
    const recoverLink = vi.fn(async () => {});
    const h = harness({ recoverLink });
    await openBreaker(h);
    recoverLink.mockClear();

    h.advance(BREAKER_PROBE_BACKOFF_BASE_MS);
    h.probeInvoke.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectProbe = reject;
        }),
    );
    h.tracker.probeTick();
    h.tracker.clearDevice(DEV);
    rejectProbe(timeoutError());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.tracker.isUnresponsive(DEV)).toBe(false);
    expect(recoverLink).not.toHaveBeenCalled();
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

  it('clearDevice 清理在途 recovery 后允许再次触发恢复', async () => {
    const recoverLink = vi.fn(() => new Promise<void>(() => {}));
    const h = harness({ recoverLink });
    await expect(
      h.tracker.guardInvoke(DEV, 'local-db:sessions:list', () => Promise.reject(timeoutError())),
    ).rejects.toThrow();
    expect(recoverLink).toHaveBeenCalledTimes(1);
    h.tracker.clearDevice(DEV);
    await expect(
      h.tracker.guardInvoke(DEV, 'local-db:sessions:list', () => Promise.reject(timeoutError())),
    ).rejects.toThrow();
    expect(recoverLink).toHaveBeenCalledTimes(2);
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
