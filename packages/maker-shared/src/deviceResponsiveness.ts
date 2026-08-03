/**
 * deviceResponsiveness.ts — per-device「目标设备无响应」熔断器(纯逻辑,node 可单测)。
 * ---------------------------------------------------------------------------
 * desktop / mobile 控制端共享(原 apps/mobile/src/device-link/deviceResponsivenessBreaker.ts,
 * 2026-08 提炼到 maker-shared 供桌面控制端复用;两端各自持有 UI 镜像 store 与接线)。
 *
 * 事故链背景(2026-07 生产):桌面端进程活着(relay 心跳 / presence 全正常)但内部
 * 卡死(DB gate 失败),invoke 永不回包。手机端每个请求都等满超时,重试链 + 多触发源
 * 重放把请求堆成风暴,JS 线程停摆(实测最长 114s),期间连超时 timer 都被冻结。
 * 弱网场景同理:请求到不了对端或响应回不来,同样表现为连续 INVOKE_TIMEOUT。
 * 本熔断器把「对同一台无响应设备的持续请求」收敛为周期性单飞探测:
 *
 *   - 失败信号:**仅** INVOKE_TIMEOUT(等满超时无回包)计入连续失败;
 *   - 任何真实回包(成功,或 IPC_ERROR / CHANNEL_NOT_ALLOWED / REMOTE_DISABLED /
 *     ACCESS_REVOKED 等目标设备正常应答的错误)都重置计数并关熔断;
 *   - NOT_CONNECTED / relay 层错误 / 发送前本地中止是本机链路问题,不定论
 *     (inconclusive):既不计失败,也不当作设备健康的证据;
 *   - 连续 failureThreshold 个独立超时批次 → open:该设备的新请求快速失败
 *     (DEVICE_UNRESPONSIVE,permanent 不重试);
 *   - half-open:open 后按退避窗口(10s 起 ×2,封顶 120s)放行**单个**探测请求
 *     (单飞),真实回包即 close,再超时回 open 并加深退避。
 *
 * 所有时间判定用 now()(默认 Date.now)差值,不依赖 setTimeout——JS 停摆时计时器
 * 不可信是本次事故的实证(30s 超时 timer 被冻结,超时机制整体失效)。
 */

export type BreakerAcquireDecision = 'allow' | 'probe' | 'reject';

/**
 * acquire 发放的席位票据,settle 时原样带回。generation 是发放时该设备的代数:
 * 清理性事件(responded 关闭 open / 清零失败计数、clear、resetAll)递增代数,
 * settle 时代数不匹配 = 这是恢复(或清除)之前派出的旧请求,其结果一律不采信
 * (review P1:熔断 open 前派出的 30/40s 长超时请求,会在探测成功关熔断之后
 * 才陆续超时,若照常计数,3 条陈旧超时会立刻把刚恢复的熔断重新打开)。
 * cohort 由已知 fan-out 调用方显式分配并传入:同一批请求因一次链路抖动一起
 * 超时只贡献一次 strike;未传 cohort 的普通请求各自创建独立观测。
 */
export interface BreakerSendSlot {
  decision: BreakerAcquireDecision;
  generation: number;
  cohort: number;
}

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
  /** 连续多少个独立超时批次进入 open;默认 3。 */
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
  /** 为一轮明确的 fan-out 批次分配共享 id;该批 acquire 必须原样传回。 */
  createCohort(deviceId: string): number;
  /**
   * 发送前门禁:closed → 'allow';同一 fan-out 可传共享 cohort,省略则每次调用
   * 创建独立 cohort。open 且探测窗口已到、无在途探测 → 'probe';其余 → 'reject'。
   */
  acquire(deviceId: string, cohort?: number): BreakerSendSlot;
  /** 请求收尾上报。slot 必须是 acquire 返回的票据;代数不匹配的旧请求被忽略。 */
  settle(deviceId: string, slot: BreakerSendSlot, outcome: BreakerSettleOutcome): void;
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
  // 每设备代数:清理性事件(responded 清态、clear、resetAll)递增。settle 只
  // 采信「派发时代数仍是当前代」的结果——恢复前派出的长超时请求晚到的超时
  // 不再污染新一代计数。
  const generations = new Map<string, number>();
  const nextCohorts = new Map<string, number>();
  const countedTimeoutCohorts = new Map<string, Set<number>>();
  const generationOf = (deviceId: string): number => generations.get(deviceId) ?? 0;
  const bumpGeneration = (deviceId: string): void => {
    generations.set(deviceId, generationOf(deviceId) + 1);
    // cohort id 保持单调递增:它可能先于 acquire 被补齐流程暂存,翻代后若从 1
    // 重新发号,会与新一代普通请求碰撞并把独立 timeout 误判成已计数。
    countedTimeoutCohorts.delete(deviceId);
  };
  const newCohort = (deviceId: string): number => {
    const next = (nextCohorts.get(deviceId) ?? 0) + 1;
    nextCohorts.set(deviceId, next);
    return next;
  };

  const acquire = (deviceId: string, cohort?: number): BreakerSendSlot => {
    // 首次发放即登记(review):仅 acquire 过、还没有任何 settle/state 的设备也
    // 必须被 resetAll 的全量翻篇覆盖,否则登出前的在途请求会在切号后按当前代
    // 被采信,把旧账号的超时累进新账号的计数。
    if (!generations.has(deviceId)) generations.set(deviceId, 0);
    const generation = generationOf(deviceId);
    const state = states.get(deviceId);
    if (!state?.open) return { decision: 'allow', generation, cohort: cohort ?? newCohort(deviceId) };
    if (state.probeInFlight) return { decision: 'reject', generation, cohort: 0 };
    if (now() - state.openedAt < state.probeBackoffMs) {
      return { decision: 'reject', generation, cohort: 0 };
    }
    state.probeInFlight = true;
    return { decision: 'probe', generation, cohort: 0 };
  };

  const settle = (deviceId: string, slot: BreakerSendSlot, outcome: BreakerSettleOutcome): void => {
    // 旧代请求(恢复 / 清除之前派出):结果一律不采信。探测席位也无需释放——
    // 代数递增的同时旧 state 必然已被删除,新一代 state 的 probeInFlight 从
    // false 起步。
    if (slot.generation !== generationOf(deviceId)) return;
    const wasProbe = slot.decision === 'probe';
    const state = states.get(deviceId);
    // 无论结果如何,探测单飞先释放:inconclusive 的探测(如探测期间掉线)不该
    // 永久占住唯一探测席位;窗口基准未动,下一次 acquire 会立即放行新探测。
    if (state && wasProbe) state.probeInFlight = false;
    if (outcome === 'responded') {
      // 只在真的清理了状态(open 关闭 / 失败计数清零)时才翻代(review:
      // 早先「每次 responded 都翻代」会让健康并发场景里一个较快的回包把
      // 同期在途请求随后的超时全部作废——连续超时被低估,熔断反而难打开)。
      // 无状态时的 responded 没有可作废的东西,不翻代,同期超时照常累计。
      if (!state) return;
      bumpGeneration(deviceId);
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
    const counted = countedTimeoutCohorts.get(deviceId) ?? new Set<number>();
    if (counted.has(slot.cohort)) return;
    counted.add(slot.cohort);
    countedTimeoutCohorts.set(deviceId, counted);
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
    createCohort: newCohort,
    acquire,
    settle,
    isOpen: (deviceId) => states.get(deviceId)?.open === true,
    clear: (deviceId) => {
      // 清除同样翻篇:撤权等场景下,在途请求的任何结果都不该再影响该设备。
      bumpGeneration(deviceId);
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
      // 全量翻篇(登出 / 切号):所有已知设备代数递增,在途结果全部作废。
      for (const deviceId of new Set([...states.keys(), ...generations.keys()])) {
        bumpGeneration(deviceId);
      }
      const openIds = [...states.entries()].filter(([, s]) => s.open).map(([id]) => id);
      states.clear();
      nextCohorts.clear();
      countedTimeoutCohorts.clear();
      for (const deviceId of openIds) options.onOpenChanged?.(deviceId, false);
    },
  };
}
