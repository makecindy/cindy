// 阻断屏的"回前台重新核对" —— 纯逻辑(依赖可注入,便于单测)。
//
// 为什么需要:进入强更阻断态后业务树整体不挂载,useResumeUpdateCheck 随之卸载,
// 于是本进程再也不会拉 /latest。服务端撤回误下发的 minVersion 后,用户只能杀进程
// 冷启动才能恢复 —— 普通用户不会想到这一步。所以阻断屏自己补一次检查。
//
// 方向不对称,这是刻意的:
// - **进入**阻断态要求成功拉到 /latest 且判定强更(拉不到就 fail-open 放行,更新服务
//   故障不该锁死用户);
// - **解除**阻断态同样要求成功拉到 /latest 且判定不再强更 —— 拉取失败一律维持阻断,
//   否则断网(飞行模式)就能绕过强更。
//
// 节流比 resume 通道(5 分钟)短得多:用户此刻正被挡在门外,恢复延迟直接可感;
// 但仍要节流,避免在阻断屏上反复切前后台把 /latest 打成高频请求。

import { compareVersions, evaluateBundleUpdate, parseLatestRelease } from './bundleUpdate';
import { withTimeout } from './startupOtaUpdate';

export type ForcedUpdateRecheckOutcome = 'still-forced' | 'cleared' | 'error';

export interface ForcedUpdateRecheckDeps {
  /** 拉 /latest(平台与 channel 已由调用方绑定);返回原始 JSON。 */
  fetchLatest: () => Promise<unknown>;
  getCurrentRuntimeVersion: () => string | null | undefined;
  getCurrentVersion: () => string | null | undefined;
  /**
   * 判定不再强更时调用(实参为 clearForcedUpdate),之后业务树重新挂载。
   * 回传发起时的 revision 做 compare-and-clear:核对期间若有更新的观察写入了强更目标,
   * 这条旧结论必须作废,不能把用户放进业务树。
   */
  onCleared: (expectedRevision?: number) => void;
  /**
   * 仍然强更时把**最新**目标写回(实参为 enterForcedUpdate,对等值目标幂等)。
   * 必须刷新而不是原样保留:服务端修正 installUrl / itmsUrl(坏链接正是最需要救的那种
   * 故障),或发布更高的强更目标时,阻断屏的「去更新」不能继续打开旧链接。
   */
  onStillForced: (
    target: {
      version: string;
      runtimeVersion: string;
      installUrl: string;
      itmsUrl: string;
      releaseNotes?: string;
    },
    expectedRevision?: number,
  ) => void;
  now: () => number;
  /** 阻断屏卸载后使迟到结果失效。 */
  isCurrent?: () => boolean;
  /**
   * 创建时读一次当前 AppState(实参为 () => AppState.currentState)。
   * 必要性:阻断态可能在 App **已经切到后台之后**才被置位(启动 / resume 检查的
   * /latest 迟到返回),此时本实例从未见过 'background' 事件,回前台的第一次
   * 'active' 会被 wasBackground 门挡掉 —— 运维撤回门槛正好发生在用户离开期间时,
   * 用户回来还要再切一次后台才自愈。省略则按 'active' 处理(维持旧行为)。
   */
  getAppState?: () => string;
  /**
   * 发起时读一次 store revision(实参为 getForcedUpdateRevision),落地时回传。
   * 省略则不做 compare-and-set(维持旧行为)。
   */
  getRevision?: () => number;
  /**
   * 当前阻断中的目标(实参为 getForcedUpdateTarget),用于证明本次读到的记录不比它旧。
   * 必要性:`/latest` 背后是**可变指针**,且客户端这条请求既不带 cache-buster 也不发
   * no-cache(见 fetchLatestRelease),CDN 边缘完全可能返回一条更旧的 release 记录
   * (发布链侧对同一现象有明确记载:lib/ios-local.mjs 的 CDN 缓存注释)。旧记录里没有
   * minVersion,就会把仍需强更的用户放进业务树。省略则不做新鲜度校验(维持旧行为)。
   */
  getHeldTarget?: () => { version: string } | null;
}

export interface ForcedUpdateRecheckOptions {
  /** 两次核对的最小间隔(默认 30s)。 */
  minIntervalMs?: number;
  /** /latest 拉取超时(默认 10s,与 resume 通道同口径)。 */
  latestTimeoutMs?: number;
}

const DEFAULT_MIN_INTERVAL_MS = 30_000;
const DEFAULT_LATEST_TIMEOUT_MS = 10_000;

export interface ForcedUpdateRechecker {
  /**
   * AppState 'change' 入口。命中「从后台回到前台 + 间隔满足 + 无在途」才发起;
   * 未触发时返回 null(便于测试断言),触发时返回本次核对的 Promise(永不 reject)。
   */
  handleAppStateChange: (next: string) => Promise<ForcedUpdateRecheckOutcome> | null;
  /**
   * 定时兜底入口(阻断屏挂载期间周期性调用)。只受节流与在途约束,不看 AppState。
   *
   * 为什么必须有:光靠 AppState 跳变不够 —— (1) 用户就坐在阻断屏上不动时没有任何跳变;
   * (2) 阻断态在后台被置位、用户在节流窗口内就回来时,那次 'active' 会被节流丢掉,
   * 而后再没有事件来重试。两种情况下运维撤回门槛 / 修正安装地址都不会被观察到,
   * 阻断屏会一直停在旧状态。
   */
  handleTick: () => Promise<ForcedUpdateRecheckOutcome> | null;
}

/** 创建阻断屏核对器(持有节流/在途状态;阻断屏挂载期间一个实例)。 */
export function createForcedUpdateRechecker(
  deps: ForcedUpdateRecheckDeps,
  {
    minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
    latestTimeoutMs = DEFAULT_LATEST_TIMEOUT_MS,
  }: ForcedUpdateRecheckOptions = {},
): ForcedUpdateRechecker {
  // 与 resume 通道不同:阻断屏刚挂载时那次检查刚跑完,所以创建时刻同样视为"刚查过"
  // (节流仍然生效:用户离开不足 minIntervalMs 就回来时,重查是冗余的)。
  let lastRunAt = deps.now();
  // 挂载时若 App 已不在前台,视同"已经进过后台":下一次回前台就该核对,
  // 不必等用户再走一个完整的切后台→回前台周期。
  let wasBackground = deps.getAppState ? deps.getAppState() !== 'active' : false;
  let inFlight = false;

  async function run(): Promise<ForcedUpdateRecheckOutcome> {
    inFlight = true;
    // 必须在 await 之前读:这是"本次核对看到的世界"的版本号。
    const startRevision = deps.getRevision?.();
    try {
      const latest = await withTimeout(deps.fetchLatest(), latestTimeoutMs);
      if (deps.isCurrent && !deps.isCurrent()) return 'still-forced';
      // null 只在服务端 404 时出现(网络 / 5xx 都抛错),是服务端**明确声明**该平台当前
      // 没有整包记录 —— 记录不存在,门槛也就不存在。必须解除:同样的 404 在冷启动路径上
      // 根本不会进入阻断(evaluateBundleUpdate 对 null 返回无更新),运行中的进程不该比
      // 冷启动更严,否则用户被卡到杀进程为止。
      if (latest === null) {
        deps.onCleared(startRevision);
        return 'cleared';
      }
      // 解除必须建立在"真的比出来了不再低于门槛"之上。record 解析不出(指针损坏 /
      // 被中间层改坏)或拿不到本机 version 时,evaluateBundleUpdate 会 fail-open 报
      // 无更新 —— 那是**进入**方向的正确取向,拿到解除方向就成了漏洞:一条坏记录
      // 就能放行所有被强更的装机。这里显式挡掉,按拉取失败处理。
      // currentRuntimeVersion 同样是必需条件:拿不到它(expo-updates 未启用 / 返回空)时
      // evaluateBundleUpdate 会 fail-open 报无更新 —— 那是进入方向的取向,用在解除方向
      // 就成了绕过强更的口子。
      const record = parseLatestRelease(latest);
      const currentRuntimeVersion = String(deps.getCurrentRuntimeVersion() ?? '').trim();
      const currentVersion = String(deps.getCurrentVersion() ?? '').trim();
      if (!record || !currentRuntimeVersion || !currentVersion) return 'error';
      // 新鲜度门:读到的记录不得比正在阻断的目标更旧。可变指针 + 无 cache-buster 的请求
      // 会撞上 CDN 边缘的旧记录,那条记录没有 minVersion → 会把仍需强更的用户放出去。
      // 记录缺 version(parseLatestRelease 容许空串)同样证明不了新鲜度,一并挡掉。
      // 只有两边都有版本号时才比较。held.version 为空按"无新鲜度约束"处理而不是维持阻断
      // ——否则一条无 version 的记录会把用户永久钉在阻断屏上(定时与回前台核对都过不去)。
      // 这种情况现在不可达:evaluateBundleUpdate 要求 record 带 version 才判 forced,
      // 所以能进入阻断的目标必然有版本号。此处只是不给自己留死锁的余地。
      const held = deps.getHeldTarget?.();
      if (held?.version && (!record.version
        || compareVersions(record.version, held.version) < 0)) {
        return 'error';
      }
      const evaluation = evaluateBundleUpdate({
        currentRuntimeVersion,
        currentVersion,
        latest,
      });
      // 仍然强更(门槛还在,或换了更高的目标)→ 维持阻断,但把最新 target 写回:
      // 服务端可能只修正了 installUrl / itmsUrl(坏链接恰恰是最需要救的故障),
      // 或发布了更高的强更目标 —— 继续用旧 target 会让「去更新」一直打开旧链接。
      if (evaluation.forced) {
        if (evaluation.target) deps.onStillForced(evaluation.target, startRevision);
        return 'still-forced';
      }
      deps.onCleared(startRevision);
      return 'cleared';
    } catch {
      return 'error'; // 拉不到就维持阻断(见文件头:解除方向 fail-closed)
    } finally {
      inFlight = false;
    }
  }

  /** 节流 + 在途门:两个入口共用,通过则占用本轮并发起。 */
  function tryRun(): Promise<ForcedUpdateRecheckOutcome> | null {
    if (inFlight || deps.now() - lastRunAt < minIntervalMs) return null;
    lastRunAt = deps.now();
    return run();
  }

  return {
    handleAppStateChange(next: string): Promise<ForcedUpdateRecheckOutcome> | null {
      if (next === 'background') {
        wasBackground = true;
        return null;
      }
      if (next !== 'active' || !wasBackground) return null;
      wasBackground = false;
      return tryRun();
    },
    handleTick(): Promise<ForcedUpdateRecheckOutcome> | null {
      return tryRun();
    },
  };
}
