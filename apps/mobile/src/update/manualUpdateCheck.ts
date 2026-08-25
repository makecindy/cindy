import type { TFunction } from 'i18next';

/** 手动整包检查结果,供统一流程决定是否继续检查 JS 热更新。 */
export type BundleUpdateCheckOutcome =
  | 'skipped'
  | 'busy'
  | 'up-to-date'
  | 'update-available'
  | 'error';

/** 设置页统一更新检查期间可见的阶段。 */
export type ManualUpdateCheckPhase = 'checking' | 'downloading';

/** 设置页一次统一更新检查的最终结果。 */
export type ManualUpdateCheckOutcome =
  | { kind: 'bundle-update-available' }
  | { kind: 'up-to-date' }
  | { kind: 'ota-unavailable' }
  | { kind: 'reloading' }
  /** 新 bundle 已下载但重启失败:它会在下次冷启动生效,只能引导用户手动重开。 */
  | { kind: 'restart-required' }
  | { kind: 'busy' }
  | { kind: 'error'; reason: 'bundle-check' | 'ota-check'; detail?: string };

/** 统一更新检查所需的外部能力,由设置页注入真实 Expo / 整包更新实现。 */
export interface ManualUpdateCheckDeps {
  /** 自建线传入整包检查;EAS 线省略后直接检查 OTA。 */
  checkBundleUpdate?: () => Promise<BundleUpdateCheckOutcome>;
  otaEnabled: boolean;
  /**
   * 隐私同意闸门(动态判定,非调用瞬间快照):manifest 请求前与资源下载前分别重查。
   * 用户点击「检查更新」后、请求尚未完成时登出撤销同意,这里必须停止继续携带
   * eas-client-id 的请求。缺省(未提供)视为不启用该闸门。
   */
  isConsented?: () => boolean;
  checkOtaUpdate: () => Promise<{ isAvailable: boolean }>;
  /** isNew 表示确实落盘了一个新 bundle(reload 失败时用它区分"已下载待重启"与"什么都没拿到")。 */
  fetchOtaUpdate: () => Promise<{ isNew: boolean }>;
  reload: () => Promise<void>;
  /**
   * expo-updates 是否处于 emergency launch(没有 launchedUpdate,reload 必被原生层拒绝)。
   * 只有这个状态才把 reload 失败判成"已下载待重启";其余 reload 失败仍按失败报,保留详情。
   */
  isEmergencyLaunch: () => boolean;
  onPhase: (phase: ManualUpdateCheckPhase) => void;
}

/**
 * 严格按「整包 → OTA」顺序执行一次手动更新检查。
 * 发现整包或整包检查失败时都会停止,不会继续进入 OTA 通道。
 */
export async function runManualUpdateCheck({
  checkBundleUpdate,
  otaEnabled,
  isConsented,
  checkOtaUpdate,
  fetchOtaUpdate,
  reload,
  isEmergencyLaunch,
  onPhase,
}: ManualUpdateCheckDeps): Promise<ManualUpdateCheckOutcome> {
  onPhase('checking');

  if (checkBundleUpdate) {
    let bundleOutcome: BundleUpdateCheckOutcome;
    try {
      bundleOutcome = await checkBundleUpdate();
    } catch {
      return { kind: 'error', reason: 'bundle-check' };
    }
    if (bundleOutcome === 'update-available') return { kind: 'bundle-update-available' };
    if (bundleOutcome === 'error') return { kind: 'error', reason: 'bundle-check' };
    if (bundleOutcome === 'busy') return { kind: 'busy' };
  }

  if (!otaEnabled) return { kind: 'ota-unavailable' };
  // 整包检查是匿名请求,不受同意门约束;只有 OTA manifest/资源会携带 eas-client-id,
  // 在发起 manifest 请求前先问一次同意(处理「点击检查时未同意」的快照与实况不一致)。
  if (isConsented && !isConsented()) return { kind: 'ota-unavailable' };

  let fetchedNewBundle = false;
  try {
    const ota = await checkOtaUpdate();
    if (!ota.isAvailable) return { kind: 'up-to-date' };
    // manifest 请求期间用户可能登出撤销同意:下载资源前再问一次,不得在撤销后继续
    // 拉取带标识的 bundle。
    if (isConsented && !isConsented()) return { kind: 'ota-unavailable' };
    onPhase('downloading');
    const fetched = await fetchOtaUpdate();
    fetchedNewBundle = fetched.isNew;
    await reload();
    return { kind: 'reloading' };
  } catch (error) {
    // emergency launch(没有 launchedUpdate)下 reload 必被原生层拒绝,而 bundle 已经落盘、
    // 下次冷启动就会生效:这不是一次失败的检查,报"检查更新失败"只会让用户无从下手。
    // 反过来,其它原因的 reload 失败不套用这条 —— 那种情况原始详情才是唯一线索,不能吞掉。
    if (fetchedNewBundle && isEmergencyLaunch()) return { kind: 'restart-required' };
    const detail = error instanceof Error ? error.message.trim() : String(error).trim();
    return {
      kind: 'error',
      reason: 'ota-check',
      ...(detail ? { detail } : {}),
    };
  }
}

/**
 * 在设置页渲染更新检查结果。结果本身只保存语义和动态详情，避免语言切换后保留旧语言的字符串。
 */
export function manualUpdateCheckMessage(
  outcome: ManualUpdateCheckOutcome,
  options: { isTestFlightBuild: boolean; t: TFunction },
): string | null {
  const { isTestFlightBuild, t } = options;
  switch (outcome.kind) {
    case 'bundle-update-available':
      return t('settings.version.bundleUpdateFound');
    case 'up-to-date':
      return t(isTestFlightBuild
        ? 'settings.version.testFlightNoContentUpdate'
        : 'settings.version.upToDate');
    case 'ota-unavailable':
      return t(isTestFlightBuild
        ? 'settings.version.testFlightContentUpdateUnavailable'
        : 'settings.version.bundleUpToDateNoOta');
    case 'reloading':
      return t('settings.version.downloadedRestarting');
    case 'restart-required':
      return t('settings.version.downloadedRestartRequired');
    case 'error':
      if (outcome.reason === 'bundle-check') return t('settings.version.bundleCheckFailed');
      return outcome.detail
        ? t('settings.version.checkFailedDetail', { detail: outcome.detail })
        : t('settings.version.checkFailed');
    case 'busy':
      return null;
  }
}
