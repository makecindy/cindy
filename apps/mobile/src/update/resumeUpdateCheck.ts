// 后台切回前台(resume)时的静默更新检查 —— 纯逻辑(依赖可注入,便于单测)。
//
// 与启动路径(startupOtaUpdate / useBundleUpdatePrompt)互补:启动只查一次,长期驻留
// 后台的 App 永远吃不到新版本;这里在 background → active 时补一次检查,但表现必须无感:
// - JS OTA:静默 check → fetch,**绝不 reload**(reload 会闪屏断状态);下载好的 bundle
//   由 expo-updates 在下次冷启动自动生效。
// - 整包(runtimeVersion 变化):静默拉 /latest 比对;唯一允许出 UI 的情况是命中
//   minVersion 强更(强更本身无法无感),且同一目标 runtimeVersion 进程内只回调一次;
//   非强更完全静默(启动路径已有一次性提示,不在每次切回时骚扰)。
// - 节流:只认真正的 background → active(iOS 通知中心/来电导致的 inactive 抖动不算),
//   两次检查最小间隔 minIntervalMs;创建时间视为"刚检查过"(冷启动路径刚跑完,首次
//   切回不重复查)。
// - 硬约束:任何异常/超时一律 fail-open 静默吞掉,绝不打扰用户、绝不影响 App 使用。

import { evaluateBundleUpdate, type BundleUpdateEvaluation } from './bundleUpdate';
import { withTimeout } from './startupOtaUpdate';

// 模块级强更提示去重:同一 runtimeVersion 进程内只弹一次,跨启动路径和 resume 路径共享。
// 启动路径(useBundleUpdatePrompt)弹强更时调 markForcedPrompted 写入,resume 路径检查前
// 先查 hasForcedPrompted,避免冷启动已弹过的强更在 5 分钟后 resume 时再弹一次。
const promptedForcedRuntimes = new Set<string>();

/** 标记某 runtimeVersion 的强更已提示过(启动路径弹窗后调用)。 */
export function markForcedPrompted(runtimeVersion: string): void {
  promptedForcedRuntimes.add(runtimeVersion);
}

/** 查询某 runtimeVersion 是否已提示过强更。 */
export function hasForcedPrompted(runtimeVersion: string): boolean {
  return promptedForcedRuntimes.has(runtimeVersion);
}

/** 仅供单测重置模块级状态。 */
export function resetForcedPromptedForTest(): void {
  promptedForcedRuntimes.clear();
}

export type ResumeOtaOutcome = 'skipped' | 'up-to-date' | 'fetched' | 'error';
export type ResumeBundleOutcome = 'skipped' | 'up-to-date' | 'update-available' | 'forced' | 'error';

export interface ResumeUpdateOutcome {
  ota: ResumeOtaOutcome;
  bundle: ResumeBundleOutcome;
}

export interface ResumeUpdateCheckDeps {
  /** JS OTA 是否启用(自建变体 + 非 dev + expo-updates 可用),与启动热更门同一 gate。 */
  otaEnabled: boolean;
  checkForUpdateAsync: () => Promise<{ isAvailable: boolean }>;
  fetchUpdateAsync: () => Promise<{ isNew: boolean }>;
  /** 整包检查是否启用(自建变体),与 useBundleUpdatePrompt 同一 gate。 */
  bundleCheckEnabled: boolean;
  /** 拉 /latest(平台已由调用方绑定);返回原始 JSON。 */
  fetchLatest: () => Promise<unknown>;
  getCurrentRuntimeVersion: () => string | null | undefined;
  getCurrentVersion: () => string | null | undefined;
  /**
   * 强更时的唯一 UI 出口。契约:实现必须在**实际展示**强更提示后调用 markForcedPrompted
   * 标记该 runtimeVersion(见 promptBundleUpdate),本层据此跨路径去重、且只在确认展示后才标记
   * ——若实现因故未展示(如无安装 URL)则不应标记,以便下次 resume 重试。
   */
  onForcedUpdate: (evaluation: BundleUpdateEvaluation) => void;
  now: () => number;
  /** hook 卸载/账号切换后使旧检查失效，避免迟到结果给新账号弹窗。 */
  isCurrent?: () => boolean;
}

export interface ResumeUpdateCheckOptions {
  /** 两次检查的最小间隔(默认 5 分钟)。 */
  minIntervalMs?: number;
  /** OTA check 阶段超时(默认 10s;静默路径不卡 UI,可比启动宽松)。 */
  checkTimeoutMs?: number;
  /** OTA fetch(下载 bundle)阶段超时(默认 60s;超时只是不再等,原生下载可能仍完成)。 */
  fetchTimeoutMs?: number;
  /**
   * 整包 /latest 拉取超时(默认 10s)。注入的 fetchLatestRelease 内部已有 8s AbortController
   * 自限,本 backstop 只在注入实现意外挂起(无内部超时)时兜底,让纯逻辑层的超时保证不依赖
   * 注入实现的内部行为,并与 OTA 路径的 withTimeout 保持对称。
   */
  latestTimeoutMs?: number;
}

const DEFAULT_MIN_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_CHECK_TIMEOUT_MS = 10_000;
const DEFAULT_FETCH_TIMEOUT_MS = 60_000;
const DEFAULT_LATEST_TIMEOUT_MS = 10_000;

export interface ResumeUpdateChecker {
  /**
   * AppState 'change' 事件入口。命中「从后台回到前台 + 间隔满足 + 无在途检查」才发起;
   * 未触发检查时返回 null(便于测试断言),触发时返回本次检查的 Promise(永不 reject)。
   */
  handleAppStateChange: (next: string) => Promise<ResumeUpdateOutcome> | null;
}

/** 创建 resume 检查器(持有节流/在途/已提示状态;一个 App 进程一个实例)。 */
export function createResumeUpdateChecker(
  deps: ResumeUpdateCheckDeps,
  {
    minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
    checkTimeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
    fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    latestTimeoutMs = DEFAULT_LATEST_TIMEOUT_MS,
  }: ResumeUpdateCheckOptions = {},
): ResumeUpdateChecker {
  // 创建时视为刚检查过:冷启动路径(启动热更门 + 整包检查)此刻正在/已经跑,不重复。
  let lastRunAt = deps.now();
  // 只有真正进过 background 再回 active 才算"从后台切回"(过滤 iOS inactive 抖动)。
  let wasBackground = false;
  let inFlight = false;

  async function runOtaCheck(): Promise<ResumeOtaOutcome> {
    if (!deps.otaEnabled) return 'skipped';
    try {
      const check = await withTimeout(deps.checkForUpdateAsync(), checkTimeoutMs);
      if (deps.isCurrent && !deps.isCurrent()) return 'skipped';
      if (!check.isAvailable) return 'up-to-date';
      const fetched = await withTimeout(deps.fetchUpdateAsync(), fetchTimeoutMs);
      if (deps.isCurrent && !deps.isCurrent()) return 'skipped';
      // 静默路径到此为止:不 reload,新 bundle 下次冷启动生效。
      return fetched.isNew ? 'fetched' : 'up-to-date';
    } catch {
      return 'error'; // fail-open:离线/超时静默放过,下次 resume 或冷启动再试
    }
  }

  async function runBundleCheck(): Promise<ResumeBundleOutcome> {
    if (!deps.bundleCheckEnabled) return 'skipped';
    try {
      const latest = await withTimeout(deps.fetchLatest(), latestTimeoutMs);
      if (deps.isCurrent && !deps.isCurrent()) return 'skipped';
      const evaluation = evaluateBundleUpdate({
        currentRuntimeVersion: deps.getCurrentRuntimeVersion(),
        currentVersion: deps.getCurrentVersion(),
        latest,
      });
      if (!evaluation.needsUpdate || !evaluation.target) return 'up-to-date';
      if (!evaluation.forced) return 'update-available'; // 非强更静默:启动路径已负责提示
      // 去重标记由 onForcedUpdate(promptBundleUpdate)在确认展示弹窗后统一负责,
      // 这里只做 guard、不预先标记,避免"caller 已标记但 callee 未展示"竞态。
      if (deps.isCurrent && !deps.isCurrent()) return 'skipped';
      if (!hasForcedPrompted(evaluation.target.runtimeVersion)) deps.onForcedUpdate(evaluation);
      return 'forced';
    } catch {
      return 'error'; // fail-open:连不上更新服务静默放过
    }
  }

  async function run(): Promise<ResumeUpdateOutcome> {
    inFlight = true;
    try {
      const [ota, bundle] = await Promise.all([runOtaCheck(), runBundleCheck()]);
      return { ota, bundle };
    } finally {
      inFlight = false;
    }
  }

  return {
    handleAppStateChange(next: string): Promise<ResumeUpdateOutcome> | null {
      if (next === 'background') {
        wasBackground = true;
        return null;
      }
      if (next !== 'active' || !wasBackground) return null;
      wasBackground = false;
      if (inFlight || deps.now() - lastRunAt < minIntervalMs) return null;
      lastRunAt = deps.now();
      return run();
    },
  };
}
