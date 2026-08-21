/**
 * 切换模型前的上下文容量预检(纯函数, renderer / main 共用)。
 *
 * 背景: 同一会话内从大窗口模型(1M)切到小窗口模型(200K/272K)时, 若当前上下文
 * 占用已接近 / 超过目标窗口, 切换后不仅对话会超限, 连 `/compact` 自救都可能失败
 * —— 压缩本身是一次 LLM 调用, 要把全量历史喂给"当前模型", 只有还没切走的大窗口
 * 模型能读完整历史。所以必须在**切换前**分级拦截:
 *
 *   - ok       : 占用 < 70% —— 直接切
 *   - warn     : 70% ≤ 占用 < 自动压缩阈值 —— 允许切, 轻提示
 *   - danger   : 自动压缩阈值 ≤ 占用 < 100% —— 允许切, 轻提示(切过去会立即触发自动压缩)
 *   - overflow : 占用 ≥ 100% —— 弹确认；确认后由 host 交接换窗，而不是用新模型压缩
 *
 * danger 档阈值取用户当前的 auto-compact 触发百分比(设置页 50-95%), 语义统一为
 * "切过去就会立刻顶到压缩线"; 读不到 / 非法时回退 90。此时同样走交接，不再先 compact。
 *
 * fail-open 原则: 目标窗口未知(目录查不到)或当前占用未知(=0, 新会话 / 状态未回流)
 * 时一律放行 —— 预检是护栏不是闸门, 缺数据时不能挡住用户操作。
 */

export type ModelSwitchContextLevel = 'ok' | 'warn' | 'danger' | 'overflow';

export interface ModelSwitchContextAssessment {
  level: ModelSwitchContextLevel;
  /** 当前占用相对目标窗口的百分比(四舍五入取整); 无法评估时为 0。 */
  projectedPct: number;
}

const WARN_RATIO = 0.7;
const DEFAULT_DANGER_PCT = 90;
// 与 maker-core AutoCompactController / 设置页 Slider 的合法区间一致。
const MIN_THRESHOLD_PCT = 50;
const MAX_THRESHOLD_PCT = 95;

export interface AssessModelSwitchContextInput {
  /** 当前会话最近一次 API call 的 context 占用(tokens)。0 / 非法 = 未知 → 放行。 */
  contextTokens: number;
  /** 目标模型的上下文窗口(tokens)。undefined / ≤0 = 未知 → 放行。 */
  targetContextWindow: number | undefined;
  /** 用户当前 auto-compact 触发百分比(50-95); 缺省 / 越界回退 90。 */
  autoCompactThresholdPct?: number;
}

export function assessModelSwitchContext(
  input: AssessModelSwitchContextInput,
): ModelSwitchContextAssessment {
  const { contextTokens, targetContextWindow, autoCompactThresholdPct } = input;
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) {
    return { level: 'ok', projectedPct: 0 };
  }
  if (
    targetContextWindow === undefined ||
    !Number.isFinite(targetContextWindow) ||
    targetContextWindow <= 0
  ) {
    return { level: 'ok', projectedPct: 0 };
  }

  const ratio = contextTokens / targetContextWindow;
  const projectedPct = Math.round(ratio * 100);

  let dangerPct = DEFAULT_DANGER_PCT;
  if (
    typeof autoCompactThresholdPct === 'number' &&
    Number.isFinite(autoCompactThresholdPct)
  ) {
    const rounded = Math.round(autoCompactThresholdPct);
    if (rounded >= MIN_THRESHOLD_PCT && rounded <= MAX_THRESHOLD_PCT) {
      dangerPct = rounded;
    }
  }

  if (ratio >= 1) return { level: 'overflow', projectedPct };
  if (ratio >= dangerPct / 100) return { level: 'danger', projectedPct };
  if (ratio >= WARN_RATIO) return { level: 'warn', projectedPct };
  return { level: 'ok', projectedPct };
}

/** danger/overflow = 新窗口装不下当前用量，应交接而不是 compact。 */
export function shouldHandoffAfterContextAssessment(
  assessment: ModelSwitchContextAssessment,
): boolean {
  return assessment.level === 'danger' || assessment.level === 'overflow';
}
