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
  | { kind: 'busy' }
  | { kind: 'error'; reason: 'bundle-check' | 'ota-check'; detail?: string };

/** 统一更新检查所需的外部能力,由设置页注入真实 Expo / 整包更新实现。 */
export interface ManualUpdateCheckDeps {
  /** 自建线传入整包检查;EAS 线省略后直接检查 OTA。 */
  checkBundleUpdate?: () => Promise<BundleUpdateCheckOutcome>;
  otaEnabled: boolean;
  checkOtaUpdate: () => Promise<{ isAvailable: boolean }>;
  fetchOtaUpdate: () => Promise<unknown>;
  reload: () => Promise<void>;
  onPhase: (phase: ManualUpdateCheckPhase) => void;
}

/**
 * 严格按「整包 → OTA」顺序执行一次手动更新检查。
 * 发现整包或整包检查失败时都会停止,不会继续进入 OTA 通道。
 */
export async function runManualUpdateCheck({
  checkBundleUpdate,
  otaEnabled,
  checkOtaUpdate,
  fetchOtaUpdate,
  reload,
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

  try {
    const ota = await checkOtaUpdate();
    if (!ota.isAvailable) return { kind: 'up-to-date' };
    onPhase('downloading');
    await fetchOtaUpdate();
    await reload();
    return { kind: 'reloading' };
  } catch (error) {
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
    case 'error':
      if (outcome.reason === 'bundle-check') return t('settings.version.bundleCheckFailed');
      return outcome.detail
        ? t('settings.version.checkFailedDetail', { detail: outcome.detail })
        : t('settings.version.checkFailed');
    case 'busy':
      return null;
  }
}
