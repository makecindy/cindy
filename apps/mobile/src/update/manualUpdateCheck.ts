import { i18n } from '@/i18n';

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
  | { kind: 'error'; message: string };

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
      return { kind: 'error', message: i18n.t('settings.version.bundleCheckFailed') };
    }
    if (bundleOutcome === 'update-available') return { kind: 'bundle-update-available' };
    if (bundleOutcome === 'error') return { kind: 'error', message: i18n.t('settings.version.bundleCheckFailed') };
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
      message: detail
        ? i18n.t('settings.version.checkFailedDetail', { detail })
        : i18n.t('settings.version.checkFailed'),
    };
  }
}
