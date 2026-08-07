export interface QuotaPaceInput {
  /** 0-100 已用百分比；允许脏值，由函数内部收敛。 */
  utilization: number;
  /** 配额窗口重置时间，epoch 秒。 */
  resetsAt: number | null | undefined;
  /** 窗口总时长（分钟），例如 5 小时为 300、周窗口为 10080。 */
  windowMinutes: number;
  /** 注入的当前时间，epoch 毫秒。 */
  nowMs: number;
}

export interface QuotaPace {
  /** 实际用量减去按时间推算的期望用量；正数表示超速，负数表示有富余。 */
  deltaPercent: number;
  expectedUsedPercent: number;
  actualUsedPercent: number;
  /** 按当前速率从现在到耗尽的秒数；能撑到重置时不返回 ETA。 */
  etaSeconds: number | null;
  willLastToReset: boolean;
}

const MIN_PREDICTION_PROGRESS = 0.03;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * 根据当前窗口的已用时间和实际用量，预测额度能否撑到下一次重置。
 *
 * 窗口进度不足 3% 时样本过少，不做预测；所有时间均由调用方注入，函数无副作用。
 */
export function computeQuotaPace(input: QuotaPaceInput): QuotaPace | null {
  const { resetsAt, windowMinutes, nowMs } = input;

  if (resetsAt == null || !Number.isFinite(resetsAt)) return null;
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) return null;

  const duration = windowMinutes * 60 * 1000;
  const timeUntilReset = resetsAt * 1000 - nowMs;
  if (timeUntilReset <= 0) return null;
  if (timeUntilReset > duration) return null;

  const elapsed = clamp(duration - timeUntilReset, 0, duration);
  const actual = Number.isFinite(input.utilization)
    ? clamp(input.utilization, 0, 100)
    : 0;

  // 窗口刚开始却已有用量时，无法从零时长估算消耗速率。
  if (elapsed === 0 && actual > 0) return null;
  if (elapsed / duration < MIN_PREDICTION_PROGRESS) return null;

  const expected = clamp((elapsed / duration) * 100, 0, 100);
  const result = {
    deltaPercent: actual - expected,
    expectedUsedPercent: expected,
    actualUsedPercent: actual,
  };

  if (actual >= 100) {
    return { ...result, etaSeconds: 0, willLastToReset: false };
  }

  if (actual === 0) {
    return { ...result, etaSeconds: null, willLastToReset: true };
  }

  const elapsedSeconds = elapsed / 1000;
  const timeUntilResetSeconds = timeUntilReset / 1000;
  const rate = actual / elapsedSeconds;
  const candidate = (100 - actual) / rate;

  if (candidate >= timeUntilResetSeconds) {
    return { ...result, etaSeconds: null, willLastToReset: true };
  }

  return { ...result, etaSeconds: candidate, willLastToReset: false };
}
