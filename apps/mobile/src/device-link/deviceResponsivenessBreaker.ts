/**
 * deviceResponsivenessBreaker.ts — per-device「目标设备无响应」熔断器(纯逻辑,node 可单测)。
 * ---------------------------------------------------------------------------
 * 事故链背景(2026-07 生产):桌面端进程活着(relay 心跳 / presence 全正常)但内部
 * 卡死(DB gate 失败),invoke 永不回包。手机端每个请求都等满超时,重试链 + 多触发源
 * 重放把请求堆成风暴,JS 线程停摆(实测最长 114s),期间连超时 timer 都被冻结。
 * 本熔断器把「对同一台无响应设备的持续请求」收敛为周期性单飞探测:
 *
 *   - 失败信号:**仅** INVOKE_TIMEOUT(等满超时无回包)计入连续失败;
 *   - 任何真实回包(成功,或 IPC_ERROR / CHANNEL_NOT_ALLOWED / REMOTE_DISABLED /
 *     ACCESS_REVOKED 等目标设备正常应答的错误)都重置计数并关熔断;
 *   - NOT_CONNECTED / relay 层错误 / 发送前本地中止是本机链路问题,不定论
 *     (inconclusive):既不计失败,也不当作设备健康的证据;
 *   - 连续 failureThreshold 次超时 → open:该设备的新请求快速失败
 *     (DEVICE_UNRESPONSIVE,permanent 不重试);
 *   - half-open:open 后按退避窗口(10s 起 ×2,封顶 120s)放行**单个**探测请求
 *     (单飞),真实回包即 close,再超时回 open 并加深退避。
 *
 * 所有时间判定用 now()(默认 Date.now)差值,不依赖 setTimeout——JS 停摆时计时器
 * 不可信是本次事故的实证(30s 超时 timer 被冻结,超时机制整体失效)。
 */

export type BreakerAcquireDecision = 'allow' | 'probe' | 'reject';

export type BreakerSettleOutcome =
  /** 收到目标设备真实回包(含业务错误应答)。 */
  | 'responded'
  /** 等满超时无回包(INVOKE_TIMEOUT)。 */
  | 'timeout'
  /** 本机链路 / relay 层失败或发送前中止:对设备响应性不定论。 */
  | 'inconclusive';

export const BREAKER_FAILURE_THRESHOLD = 3;
export const BREAKER_PROBE_BACKOFF_BASE_MS = 10_000;
export const BREAKER_PROBE_BACKOFF_MAX_MS = 120_000;

export interface DeviceResponsivenessBreakerOptions {
  /** 连续超时多少次进入 open;默认 3。 */
  failureThreshold?: number;
  /** open 后首个探测窗口;默认 10s。 */
  probeBackoffBaseMs?: number;
  /** 探测退避封顶;默认 120s。 */
  probeBackoffMaxMs?: number;
  /** 时钟注入,测试用;默认 Date.now。 */
  now?: () => number;
  /** open 状态翻转时回调(接 UI store);同状态不重复触发。 */
  onOpenChanged?: (deviceId: string, open: boolean) => void;
}

export interface DeviceResponsivenessBreaker {
  /**
   * 发送前门禁:closed → 'allow';open 且探测窗口已到、无在途探测 → 'probe'
   * (调用方必须以同一 wasProbe 调 settle 释放单飞);其余 → 'reject'(调用方
   * 应快速失败,不上管道)。
   */
  acquire(deviceId: string): BreakerAcquireDecision;
  /** 请求收尾上报。wasProbe 必须回传 acquire 的结果('probe' → true)。 */
  settle(deviceId: string, wasProbe: boolean, outcome: BreakerSettleOutcome): void;
  isOpen(deviceId: string): boolean;
  /**
   * 清除单个设备的全部熔断状态(撤权等「该设备的响应性已无意义」的场景);
   * open 中则触发 onOpenChanged(false)。
   */
  clear(deviceId: string): void;
  /**
   * 只读:open 且探测窗口已到、无在途探测 —— 即「现在发一个请求会成为探测」。
   * 给 rehydrate 这类自动恢复路径做**主动探测**判定用:设备恢复但用户没有发起
   * 任何业务请求时,half-open 不能只靠业务流量被动触发,否则设备会无限期停留
   * 在未响应态(review P1)。不占用探测席位、不改任何状态。
   */
  probeDue(deviceId: string): boolean;
  /** 清空全部状态(登出 / 切号);open 中的设备会触发 onOpenChanged(false)。 */
  resetAll(): void;
}

interface DeviceBreakerState {
  consecutiveTimeouts: number;
  open: boolean;
  /** 最近一次 open / 探测失败的时刻(探测窗口基准)。 */
  openedAt: number;
  probeBackoffMs: number;
  probeInFlight: boolean;
}

export function createDeviceResponsivenessBreaker(
  options: DeviceResponsivenessBreakerOptions = {},
): DeviceResponsivenessBreaker {
  const failureThreshold = options.failureThreshold ?? BREAKER_FAILURE_THRESHOLD;
  const probeBackoffBaseMs = options.probeBackoffBaseMs ?? BREAKER_PROBE_BACKOFF_BASE_MS;
  const probeBackoffMaxMs = options.probeBackoffMaxMs ?? BREAKER_PROBE_BACKOFF_MAX_MS;
  const now = options.now ?? Date.now;
  const states = new Map<string, DeviceBreakerState>();

  const acquire = (deviceId: string): BreakerAcquireDecision => {
    const state = states.get(deviceId);
    if (!state?.open) return 'allow';
    if (state.probeInFlight) return 'reject';
    if (now() - state.openedAt < state.probeBackoffMs) return 'reject';
    state.probeInFlight = true;
    return 'probe';
  };

  const settle = (deviceId: string, wasProbe: boolean, outcome: BreakerSettleOutcome): void => {
    const state = states.get(deviceId);
    // 无论结果如何,探测单飞先释放:inconclusive 的探测(如探测期间掉线)不该
    // 永久占住唯一探测席位;窗口基准未动,下一次 acquire 会立即放行新探测。
    if (state && wasProbe) state.probeInFlight = false;
    if (outcome === 'responded') {
      if (!state) return;
      const wasOpen = state.open;
      states.delete(deviceId);
      if (wasOpen) options.onOpenChanged?.(deviceId, false);
      return;
    }
    if (outcome !== 'timeout') return; // inconclusive:不计数、不重置。
    if (state?.open) {
      // open 期间的超时:只有探测请求推进退避。open 前已在途的旧请求可能在
      // open 后陆续超时,若都加深退避,一波并发失败会把窗口直接推到封顶。
      if (wasProbe) {
        state.openedAt = now();
        state.probeBackoffMs = Math.min(state.probeBackoffMs * 2, probeBackoffMaxMs);
      }
      return;
    }
    const next = state ?? {
      consecutiveTimeouts: 0,
      open: false,
      openedAt: 0,
      probeBackoffMs: probeBackoffBaseMs,
      probeInFlight: false,
    };
    states.set(deviceId, next);
    next.consecutiveTimeouts += 1;
    if (next.consecutiveTimeouts >= failureThreshold) {
      next.open = true;
      next.openedAt = now();
      next.probeBackoffMs = probeBackoffBaseMs;
      options.onOpenChanged?.(deviceId, true);
    }
  };

  return {
    acquire,
    settle,
    isOpen: (deviceId) => states.get(deviceId)?.open === true,
    clear: (deviceId) => {
      const state = states.get(deviceId);
      if (!state) return;
      states.delete(deviceId);
      if (state.open) options.onOpenChanged?.(deviceId, false);
    },
    probeDue: (deviceId) => {
      const state = states.get(deviceId);
      if (!state?.open || state.probeInFlight) return false;
      return now() - state.openedAt >= state.probeBackoffMs;
    },
    resetAll: () => {
      const openIds = [...states.entries()].filter(([, s]) => s.open).map(([id]) => id);
      states.clear();
      for (const deviceId of openIds) options.onOpenChanged?.(deviceId, false);
    },
  };
}
