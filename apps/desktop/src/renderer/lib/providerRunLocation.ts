/**
 * 供应商「运行于」：同一个供应商在几台自己的电脑上都能用时，只按一处运行，设置页与模型列表都只显示一项。
 *
 * 默认在这台电脑；只有用户在供应商页改选了另一台(主进程按供应商记下 `runLocation`)才在那台运行。
 * 这台电脑的供应商暂时用不了时不会自动换到别的电脑：模型选择器另列那台电脑的同一供应商，
 * 用之前先问用户(2026-11-18 用户裁决)。改选的电脑此刻不在可用名单里时回到这台电脑。
 */
import { effectiveRunLocation, RUN_LOCATION_LOCAL } from '@cindy/model-providers';

// One run-location rule for Settings and both model pickers (see @cindy/model-providers).
export { effectiveRunLocation, RUN_LOCATION_LOCAL };

/** 同账号另一台电脑，提供了这个供应商且对本机开放。 */
export interface RunLocationCandidate {
  deviceId: string;
  name: string;
  /** Actual route on that computer, which can differ after independent sign-in. */
  providerId: string;
}

export interface RunLocationProvider {
  connected?: boolean;
  suspended?: boolean;
  runLocation?: string;
}
