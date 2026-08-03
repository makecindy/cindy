/**
 * responsivenessTracker.ts — 桌面控制端「目标设备无响应」熔断的 main 侧接线(可注入依赖,免 Electron 单测)。
 * ---------------------------------------------------------------------------
 * 状态机本体在 @cindy/maker-shared/device-responsiveness(与 mobile 控制端共享):
 * 连续 INVOKE_TIMEOUT 熔断 → 新请求快速失败(DEVICE_UNRESPONSIVE)→ 周期单飞探测
 * (10s 起 ×2 封顶 120s)→ 真实回包自动恢复。
 *
 * 弱网背景(2026-08 实测):控制端 10s 周期对账 + 超时重试链在链路劣化时把请求堆成
 * 风暴(单日 2253 次 sessions:list 等满 30s 超时),而 UI 因 presence 仍在线毫无感知。
 * 门禁收口在 main 的 remoteInvoke / remoteSubscribe:单实例覆盖所有窗口,且能直接
 * 看到原始 DeviceLinkError 码(renderer 只能拿到映射后的 IPC 码)。
 *
 * 与 mobile 接线的一处刻意差异:探测由 main 的周期 tick 主动驱动(probeTick),不依赖
 * 业务流量被动触发——桌面控制端的 reconciler 在熔断 open 时会快速失败,不再产生
 * 可借用的探测流量。
 */
import {
  createDeviceResponsivenessBreaker,
  type BreakerSendSlot,
  type BreakerSettleOutcome,
} from '@cindy/maker-shared/device-responsiveness';
import {
  DeviceLinkError,
  DL_SUBSCRIBE_CHANNEL,
  DL_UNSUBSCRIBE_CHANNEL,
  type DeviceLinkErrorCode,
} from '@cindy/device-link';

/**
 * DEVICE_UNRESPONSIVE 尚未收编进 @cindy/device-link 的 DeviceLinkErrorCode 联合
 * (与 mobile 同一口径:零接触共享协议包)。下游分类按字符串匹配(maker-shared 的
 * PERMANENT_REMOTE_ERROR_MARKERS / renderer 的 isTransientRemoteError),不依赖联合类型。
 */
export const DEVICE_UNRESPONSIVE_ERROR_CODE = 'DEVICE_UNRESPONSIVE';

export function createDeviceUnresponsiveError(deviceId: string): DeviceLinkError {
  return new DeviceLinkError(
    DEVICE_UNRESPONSIVE_ERROR_CODE as DeviceLinkErrorCode,
    `target device ${deviceId} is unresponsive (circuit open)`,
  );
}

/**
 * 代表性探测请求:half-open 探测必须穿过被控端 runInvoke → dispatchLocalInvoke →
 * local-db 读路径才算数(subscribe / unsubscribe / link-accept 在被控端 dispatch 里
 * 于 runInvoke 之前特判应答,IPC/DB 卡死时它们照常回包,不能作恢复证据)。
 * sessions:list limit=1 是最便宜的真实 DB 读;与 mobile 的探测通道一致。
 */
export const DEVICE_RESPONSIVENESS_PROBE_CHANNEL = 'local-db:sessions:list';

export function buildDeviceResponsivenessProbeArgs(): unknown[] {
  return [1, 'all', { includePinned: true }];
}

/**
 * 被控端 dispatch 在进入 dispatchLocalInvoke(IPC/DB 路径)之前特判应答的通道:
 * 它们的成功只证明对端进程与 device-link 服务活着,不证明 IPC/DB 子系统健康,
 * 统一按不定论收尾(与 mobile 同语义;desktop 额外把 subscribe / unsubscribe 也
 * 列入——它们同样是 pre-runInvoke 特判应答的控制帧)。超时分类不受影响。
 */
export const BREAKER_NEUTRAL_INVOKE_CHANNELS: ReadonlySet<string> = new Set([
  'device-link:media:fetch',
  'device-link:voice:credential-sync',
  'device-link:voice:dictionary-learning',
  'device-link:voice:transcribe',
  DL_SUBSCRIBE_CHANNEL,
  DL_UNSUBSCRIBE_CHANNEL,
]);

/**
 * 失败 → 熔断信号:仅 INVOKE_TIMEOUT(等满超时无回包)计失败;NOT_CONNECTED /
 * relay 层错误 / 发送前本地中止是本机链路问题,不定论。纯函数,便于单测。
 */
export function classifyDeviceSendFailure(error: unknown): BreakerSettleOutcome {
  return error instanceof DeviceLinkError && error.code === 'INVOKE_TIMEOUT'
    ? 'timeout'
    : 'inconclusive';
}

/**
 * 成功 → 熔断信号:持有探测席位时只有代表性探测通道的回包才允许关熔断(普通 IPC
 * handler 里有大量纯内存实现,DB 卡死时照常应答);闭合态按通道分类,dispatch
 * 特判通道不定论,其余为真实恢复证据。
 */
export function classifyDeviceSendSuccess(channel: string, wasProbe = false): BreakerSettleOutcome {
  if (wasProbe && channel !== DEVICE_RESPONSIVENESS_PROBE_CHANNEL) return 'inconclusive';
  return BREAKER_NEUTRAL_INVOKE_CHANNELS.has(channel) ? 'inconclusive' : 'responded';
}

interface TrackerLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

export interface ResponsivenessTrackerDeps {
  /**
   * 探测请求的发送函数(绕开 guardInvoke 的外层门禁,由 probeTick 内部经 acquire
   * 拿到探测席位后调用;实现方直接走 client.invoke,不要再套 remoteInvoke)。
   */
  probeInvoke(deviceId: string, channel: string, args: unknown[]): Promise<unknown>;
  /** 熔断 open/close 翻转回调(广播给 renderer + 恢复时重放订阅)。同状态不重复触发。 */
  onUnresponsiveChanged(deviceId: string, unresponsive: boolean): void;
  /** 探测前置条件:本实例持有 relay、链路 online、目标设备 presence 可用。 */
  isProbeEligible(deviceId: string): boolean;
  /** 时钟注入(测试用;默认 Date.now)。 */
  now?: () => number;
  log?: TrackerLogger;
}

export interface DeviceResponsivenessTracker {
  /**
   * 发送门禁 + 收尾上报,包住一次对目标设备的隧道请求:
   * 熔断 open 且无探测窗口 → 立即抛 DEVICE_UNRESPONSIVE(不占管道、不等超时);
   * 否则执行 run 并按结果 settle(超时计失败,真实回包按通道分类)。
   */
  guardInvoke<T>(deviceId: string, channel: string, run: () => Promise<T>): Promise<T>;
  /** 周期探测 tick:对每个熔断 open、探测窗口已到且前置条件满足的设备发一发单飞探测。 */
  probeTick(): void;
  isUnresponsive(deviceId: string): boolean;
  getUnresponsiveDeviceIds(): string[];
  /** 撤权 / presence 不可用等「响应性已无意义」的场景:清单个设备并作废其在途结果。 */
  clearDevice(deviceId: string): void;
  /** 登出 / 失去持有权:清空全部状态(open 中的设备会触发 onUnresponsiveChanged(false))。 */
  resetAll(): void;
}

export function createResponsivenessTracker(
  deps: ResponsivenessTrackerDeps,
): DeviceResponsivenessTracker {
  const log = deps.log ?? { info: () => {}, warn: () => {}, debug: () => {} };
  const now = deps.now ?? Date.now;
  const unresponsive = new Set<string>();
  const breaker = createDeviceResponsivenessBreaker({
    now: deps.now,
    onOpenChanged: (deviceId, open) => {
      if (open) unresponsive.add(deviceId);
      else unresponsive.delete(deviceId);
      log.info(
        `device ${deviceId.slice(0, 8)} responsiveness circuit ${open ? 'opened' : 'closed'}`,
      );
      deps.onUnresponsiveChanged(deviceId, open);
    },
  });

  const settle = (deviceId: string, slot: BreakerSendSlot, outcome: BreakerSettleOutcome): void => {
    breaker.settle(deviceId, slot, outcome);
  };

  // 同一设备短时间窗内的并发请求共享一个熔断批次(cohort):renderer 的 fan-out
  // 预取(capabilities / providers / git-safety 同 tick 并发)在一次短暂链路中断里
  // 会同时超时,逐请求独立记账会让单轮并发直接凑满 3 次阈值误开熔断(review P2)。
  // 窗口取 250ms:真实 fan-out 在同一事件循环 tick 或几十 ms 内发出,250ms 足够
  // 覆盖;而用户手动发起的独立操作极少落进同一 250ms,不至于把独立超时误并
  // (review P1 权衡)。更根本地,窗口内"独立"操作若同时超时,反映的也是同一
  // 时刻的链路状态,证据价值与一次 fan-out 等同——阈值语义要的是时间上分离的
  // 多次观察。窗口从批首请求起算,不滑动。
  const COHORT_WINDOW_MS = 250;
  const activeCohorts = new Map<string, { id: number; startedAt: number }>();
  const cohortFor = (deviceId: string): number => {
    const nowMs = now();
    const entry = activeCohorts.get(deviceId);
    if (entry && nowMs - entry.startedAt < COHORT_WINDOW_MS) return entry.id;
    const id = breaker.createCohort(deviceId);
    activeCohorts.set(deviceId, { id, startedAt: nowMs });
    return id;
  };

  const guardInvoke = async <T>(
    deviceId: string,
    channel: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    const slot = breaker.acquire(deviceId, cohortFor(deviceId));
    if (slot.decision === 'reject') throw createDeviceUnresponsiveError(deviceId);
    const wasProbe = slot.decision === 'probe';
    try {
      const result = await run();
      settle(deviceId, slot, classifyDeviceSendSuccess(channel, wasProbe));
      return result;
    } catch (err) {
      settle(deviceId, slot, classifyDeviceSendFailure(err));
      throw err;
    }
  };

  const probeTick = (): void => {
    for (const deviceId of [...unresponsive]) {
      if (!breaker.probeDue(deviceId)) continue;
      if (!deps.isProbeEligible(deviceId)) continue;
      log.debug(`probing unresponsive device ${deviceId.slice(0, 8)}`);
      void guardInvoke(deviceId, DEVICE_RESPONSIVENESS_PROBE_CHANNEL, () =>
        deps.probeInvoke(
          deviceId,
          DEVICE_RESPONSIVENESS_PROBE_CHANNEL,
          buildDeviceResponsivenessProbeArgs(),
        ),
      ).catch((err) => {
        log.debug(`responsiveness probe failed for ${deviceId.slice(0, 8)}`, err);
      });
    }
  };

  return {
    guardInvoke,
    probeTick,
    isUnresponsive: (deviceId) => unresponsive.has(deviceId),
    getUnresponsiveDeviceIds: () => [...unresponsive],
    clearDevice: (deviceId) => {
      activeCohorts.delete(deviceId);
      breaker.clear(deviceId);
    },
    resetAll: () => {
      activeCohorts.clear();
      breaker.resetAll();
    },
  };
}
