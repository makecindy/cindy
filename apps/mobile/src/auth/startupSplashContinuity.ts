import type { LoginFirstLaunchGateState } from './loginFirstLaunchGate';

export type StartupSystemTheme = 'light' | 'dark';

export interface StartupSplashHandoffDecision {
  /** Android 原生品牌帧是否继续盖住 JS 主题舞台。 */
  showNativeBridge: boolean;
  /** 判定完成后的 JS 舞台主题；pending 时不允许提前猜测。 */
  targetTheme: StartupSystemTheme | null;
}

/**
 * #222 / #235 的交接契约：
 * - 原生品牌帧在首启门未决时保持不动，避免先画错主题；
 * - 真首启固定亮色；
 * - 老用户恢复系统主题。
 */
export function resolveStartupSplashHandoff(
  gate: LoginFirstLaunchGateState,
  systemTheme: StartupSystemTheme,
): StartupSplashHandoffDecision {
  if (gate === 'pending') {
    return { showNativeBridge: true, targetTheme: null };
  }
  return {
    showNativeBridge: false,
    targetTheme: gate === 'light' ? 'light' : systemTheme,
  };
}
