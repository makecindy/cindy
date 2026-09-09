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
  OPEN_LINK_OBSERVATION_CHANNEL,
  classifyDeviceSendFailure,
  classifyDeviceSendSuccess,
  createResponsivenessTracker,
  isDeviceResponsivenessProbeEligible,
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
  it('重连清空 presence 后 unknown 仍允许单飞探测,明确 false 与其它硬门继续阻止', () => {
    const base = {
      relayOnline: true,
      ownsRelay: true,
      revoked: false,
      locallyDisabled: false,
    };

    expect(isDeviceResponsivenessProbeEligible({
      ...base,
      presenceAvailable: undefined,
    })).toBe(true);
    expect(isDeviceResponsivenessProbeEligible({
      ...base,
      presenceAvailable: true,
    })).toBe(true);
    expect(isDeviceResponsivenessProbeEligible({
      ...base,
      presenceAvailable: false,
    })).toBe(false);
    expect(isDeviceResponsivenessProbeEligible({
      ...base,
      presenceAvailable: undefined,
      relayOnline: false,
    })).toBe(false);
    expect(isDeviceResponsivenessProbeEligible({
      ...base,
      presenceAvailable: undefined,
      ownsRelay: false,
    })).toBe(false);
    expect(isDeviceResponsivenessProbeEligible({
      ...base,
      presenceAvailable: undefined,
      revoked: true,
    })).toBe(false);
    expect(isDeviceResponsivenessProbeEligible({
      ...base,
      presenceAvailable: undefined,
      locallyDisabled: true,
    })).toBe(false);
  });

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
      [1, 'all', { includePinned: false }],
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

  it('熔断已 open 时 relay 换代把 presence 从 false 清为 unknown,下一拍恢复单飞探测', async () => {
    let presenceAvailable: boolean | undefined = false;
    const h = harness({
      isProbeEligible: () => isDeviceResponsivenessProbeEligible({
        relayOnline: true,
        ownsRelay: true,
        presenceAvailable,
        revoked: false,
        locallyDisabled: false,
      }),
    });
    await openBreaker(h);
    h.advance(BREAKER_PROBE_BACKOFF_BASE_MS);

    h.tracker.probeTick();
    expect(h.probeInvoke).not.toHaveBeenCalled();

    // client.onStatusChange 非 online 会清空当代 presence；server 不保证重放全量
    // snapshot，所以同一台仍在线设备可能长期保持 unknown。这个状态必须允许
    // breaker 自己控制的单飞 probe，而不能释放普通 guardInvoke 业务流量。
    presenceAvailable = undefined;
    h.tracker.probeTick();
    await vi.waitFor(() => expect(h.probeInvoke).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(h.tracker.isUnresponsive(DEV)).toBe(false));
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

  it('多 peer 隔离:peer A 静默(熔断 open)期间,peer B 的在途请求、新请求与建链零感知', async () => {
    // 故障半径回归(remote-and-mobile-adaptation「故障半径三问」):控制端的多个
    // 目标设备共享本机唯一 relay 连接,单 peer 静默的全部恢复动作(熔断快速拒绝、
    // 探测退避)必须收在该 deviceId 内——A 的 open 若泄漏到 B,就是把一台设备的
    // 故障放大成所有设备不可用(#1187 判例的控制端对偶形态)。
    const DEV_B = 'device-bystander';
    const h = harness();
    // A 发生故障时 B 正有请求在飞
    let resolveB!: (v: unknown) => void;
    const inflightB = h.tracker.guardInvoke(
      DEV_B,
      'local-db:sessions:list',
      () =>
        new Promise((res) => {
          resolveB = res;
        }),
    );
    await openBreaker(h); // A 连续超时至熔断 open
    expect(h.tracker.getUnresponsiveDeviceIds()).toEqual([DEV]);

    // B 的在途请求照常返回,B 熔断保持关闭
    resolveB('ok');
    await expect(inflightB).resolves.toBe('ok');
    expect(h.tracker.isUnresponsive(DEV_B)).toBe(false);

    // A open 期间,B 的新业务请求与建链(openLink 观测,本 PR 新增的门禁路径)
    // 都照常直通上管道,不被 A 的 open 快速拒绝
    const runB = vi.fn(async () => 'fresh');
    await expect(h.tracker.guardInvoke(DEV_B, 'local-db:sessions:list', runB)).resolves.toBe(
      'fresh',
    );
    const openLinkB = vi.fn(async () => 'accepted');
    await expect(
      h.tracker.guardInvoke(DEV_B, OPEN_LINK_OBSERVATION_CHANNEL, openLinkB),
    ).resolves.toBe('accepted');
    expect(runB).toHaveBeenCalledTimes(1);
    expect(openLinkB).toHaveBeenCalledTimes(1);

    // 状态翻转通知只发给 A,B 从未被标记
    expect(h.onUnresponsiveChanged).toHaveBeenCalledWith(DEV, true);
    expect(h.onUnresponsiveChanged).not.toHaveBeenCalledWith(DEV_B, expect.anything());
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
  it('INVOKE_TIMEOUT 计失败;终态 relay 应答是恢复证据;其余不定论', () => {
    expect(classifyDeviceSendFailure(timeoutError())).toBe('timeout');
    // 终态 = relay/对端在明确应答,「无响应」不成立;presence 竞态下归不定论
    // 会让熔断 open 后的周期探测永远关不上(review P2)。
    expect(
      classifyDeviceSendFailure(new DeviceLinkError('DEVICE_OFFLINE', 'target offline')),
    ).toBe('responded');
    expect(
      classifyDeviceSendFailure(new DeviceLinkError('REMOTE_DISABLED', 'disabled')),
    ).toBe('responded');
    expect(
      classifyDeviceSendFailure(new DeviceLinkError('VERSION_MISMATCH', 'v mismatch')),
    ).toBe('responded');
    expect(
      classifyDeviceSendFailure(new DeviceLinkError('ACCESS_REVOKED', 'revoked')),
    ).toBe('responded');
    expect(
      classifyDeviceSendFailure(new DeviceLinkError('NOT_CONNECTED', 'lost')),
    ).toBe('inconclusive');
    expect(classifyDeviceSendFailure(new Error('random'))).toBe('inconclusive');
  });

  it('结算所有权:同一错误对象只有第一个 settle 的 guard 记账,后续 guard 不定论', async () => {
    // 观测唯一性不变量:openLink in-flight 复用会让同一物理失败冒泡进任意多个
    // guard(跨 250ms cohort 窗口时不同批)。guardInvoke 结算后立刻打标,后续
    // guard 见标一律不定论——三个 guard 共享同一超时,只记 1 个 strike,
    // 熔断保持关闭(无标记时 3 个独立批次恰好误开,review P2 收敛检查点)。
    const h = harness();
    const sharedErr = timeoutError();
    const failing = (): Promise<never> => Promise.reject(sharedErr);
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) {
      await expect(
        h.tracker.guardInvoke(DEV, 'local-db:sessions:list', failing),
      ).rejects.toThrow('no invoke-result');
      h.advance(1_100); // 越过 cohort 归批窗口:各 guard 确为独立批次
    }
    expect(h.tracker.isUnresponsive(DEV)).toBe(false);
    // 标记只影响熔断结算,不改变错误本体(上层错误协议照常)
    expect(sharedErr.code).toBe('INVOKE_TIMEOUT');
    // 独立的新错误对象照常累计:共享错误已记的 1 strike + 两批新超时 = 阈值,
    // 熔断打开——证明标记只去重「同一物理失败」,不吞真实的后续失败。
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD - 1; i++) {
      await expect(
        h.tracker.guardInvoke(DEV, 'local-db:sessions:list', () => Promise.reject(timeoutError())),
      ).rejects.toThrow('no invoke-result');
      h.advance(1_100);
    }
    expect(h.tracker.isUnresponsive(DEV)).toBe(true);
  });

  it('openLink 观测:成功不定论(link-accept 不作恢复证据),超时照常计失败', async () => {
    // link-accept 在被控端 dispatch 于 runInvoke 之前特判应答,IPC/DB 卡死时照常
    // 回包——若凭它关熔断,恢复流程会放进订阅+快照突发再连超时,形成周期性风暴。
    expect(classifyDeviceSendSuccess(OPEN_LINK_OBSERVATION_CHANNEL)).toBe('inconclusive');
    const h = harness();
    await openBreaker(h);
    // open 态下 openLink 走 guardInvoke 会被快速拒绝,不上管道
    const run = vi.fn(async () => 'accepted');
    await expect(
      h.tracker.guardInvoke(DEV, OPEN_LINK_OBSERVATION_CHANNEL, run),
    ).rejects.toThrow('unresponsive');
    expect(run).not.toHaveBeenCalled();
  });

  it('熔断 open 后探测收到终态 relay 应答 → 关熔断(终态 UI 不被「无响应」遮蔽)', async () => {
    // presence 未及时翻转的竞态下,终态应答(DEVICE_OFFLINE 等)是「链路在明确
    // 应答」的恢复证据。open 期间业务 guard 一律快速失败,探测是唯一上管道的
    // 流量,终态应答经探测失败路径进入 classifyDeviceSendFailure 关熔断,让位
    // 给对应终态自己的 UI。
    const h = harness();
    await openBreaker(h);
    h.advance(BREAKER_PROBE_BACKOFF_BASE_MS);
    h.probeInvoke.mockRejectedValueOnce(new DeviceLinkError('DEVICE_OFFLINE', 'target offline'));
    h.tracker.probeTick();
    await vi.waitFor(() => {
      expect(h.tracker.isUnresponsive(DEV)).toBe(false);
    });
    expect(h.onUnresponsiveChanged).toHaveBeenLastCalledWith(DEV, false);
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
