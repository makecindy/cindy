import { describe, expect, it } from 'vitest';

import {
  computeQuotaPace,
  type QuotaPace,
  type QuotaPaceInput,
} from '../quotaPace';

const NOW_MS = 1_800_000_000_000;
const FIVE_HOUR_MINUTES = 300;
const WEEKLY_MINUTES = 10_080;

/** 按窗口已过比例构造确定性的重置时间，避免测试依赖系统时钟。 */
function inputAtProgress(
  utilization: number,
  progress: number,
  windowMinutes = FIVE_HOUR_MINUTES,
): QuotaPaceInput {
  const durationMs = windowMinutes * 60 * 1000;
  return {
    utilization,
    resetsAt: (NOW_MS + durationMs * (1 - progress)) / 1000,
    windowMinutes,
    nowMs: NOW_MS,
  };
}

function requirePace(input: QuotaPaceInput): QuotaPace {
  const result = computeQuotaPace(input);
  expect(result).not.toBeNull();
  return result!;
}

describe('computeQuotaPace — 防御条件', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['正无穷', Number.POSITIVE_INFINITY],
    ['负无穷', Number.NEGATIVE_INFINITY],
  ] as const)('重置时间为 %s 时返回 null', (_label, resetsAt) => {
    expect(
      computeQuotaPace({
        utilization: 50,
        resetsAt,
        windowMinutes: FIVE_HOUR_MINUTES,
        nowMs: NOW_MS,
      }),
    ).toBeNull();
  });

  it.each([
    ['零', 0],
    ['负数', -1],
    ['NaN', Number.NaN],
    ['正无穷', Number.POSITIVE_INFINITY],
    ['负无穷', Number.NEGATIVE_INFINITY],
  ])('窗口分钟数为%s时返回 null', (_label, windowMinutes) => {
    expect(
      computeQuotaPace({
        utilization: 50,
        resetsAt: NOW_MS / 1000 + 60,
        windowMinutes,
        nowMs: NOW_MS,
      }),
    ).toBeNull();
  });

  it.each([
    ['恰好到期', NOW_MS / 1000],
    ['已经过期', NOW_MS / 1000 - 1],
  ])('%s时返回 null', (_label, resetsAt) => {
    expect(
      computeQuotaPace({
        utilization: 50,
        resetsAt,
        windowMinutes: FIVE_HOUR_MINUTES,
        nowMs: NOW_MS,
      }),
    ).toBeNull();
  });

  it('重置时间超过窗口总时长时返回 null', () => {
    const durationSeconds = FIVE_HOUR_MINUTES * 60;
    expect(
      computeQuotaPace({
        utilization: 50,
        resetsAt: NOW_MS / 1000 + durationSeconds + 1,
        windowMinutes: FIVE_HOUR_MINUTES,
        nowMs: NOW_MS,
      }),
    ).toBeNull();
  });

  it('窗口刚开始且已有用量时返回 null', () => {
    const durationSeconds = WEEKLY_MINUTES * 60;
    expect(
      computeQuotaPace({
        utilization: 1,
        resetsAt: NOW_MS / 1000 + durationSeconds,
        windowMinutes: WEEKLY_MINUTES,
        nowMs: NOW_MS,
      }),
    ).toBeNull();
  });

  it('窗口经过 2.9% 时拒绝预测，恰好 3% 时开始预测', () => {
    expect(computeQuotaPace(inputAtProgress(3, 0.029))).toBeNull();

    const boundary = requirePace(inputAtProgress(3, 0.03));
    expect(boundary).toEqual({
      deltaPercent: 0,
      expectedUsedPercent: 3,
      actualUsedPercent: 3,
      etaSeconds: null,
      willLastToReset: true,
    });
  });
});

describe('computeQuotaPace — 配额节奏预测', () => {
  it('周窗口中段按节奏消耗，恰好能撑到重置', () => {
    expect(requirePace(inputAtProgress(50, 0.5, WEEKLY_MINUTES))).toEqual({
      deltaPercent: 0,
      expectedUsedPercent: 50,
      actualUsedPercent: 50,
      etaSeconds: null,
      willLastToReset: true,
    });
  });

  it('5 小时窗口超速，预计在重置前耗尽', () => {
    const pace = requirePace(inputAtProgress(75, 0.5));
    expect(pace.deltaPercent).toBe(25);
    expect(pace.expectedUsedPercent).toBe(50);
    expect(pace.actualUsedPercent).toBe(75);
    expect(pace.etaSeconds).toBeCloseTo(3_000, 10);
    expect(pace.willLastToReset).toBe(false);
  });

  it('5 小时窗口低于节奏，富余额度能撑到重置', () => {
    expect(requirePace(inputAtProgress(25, 0.5))).toEqual({
      deltaPercent: -25,
      expectedUsedPercent: 50,
      actualUsedPercent: 25,
      etaSeconds: null,
      willLastToReset: true,
    });
  });

  it('已有窗口进度但实际用量为 0，不计算 ETA 且能撑到重置', () => {
    expect(requirePace(inputAtProgress(0, 0.25))).toEqual({
      deltaPercent: -25,
      expectedUsedPercent: 25,
      actualUsedPercent: 0,
      etaSeconds: null,
      willLastToReset: true,
    });
  });

  it('实际用量达到 100% 时立即耗尽', () => {
    expect(requirePace(inputAtProgress(100, 0.25, WEEKLY_MINUTES))).toEqual({
      deltaPercent: 75,
      expectedUsedPercent: 25,
      actualUsedPercent: 100,
      etaSeconds: 0,
      willLastToReset: false,
    });
  });

  it.each([
    {
      label: 'NaN 按 0 处理',
      utilization: Number.NaN,
      actualUsedPercent: 0,
      deltaPercent: -50,
      etaSeconds: null,
      willLastToReset: true,
    },
    {
      label: '负数夹到 0',
      utilization: -5,
      actualUsedPercent: 0,
      deltaPercent: -50,
      etaSeconds: null,
      willLastToReset: true,
    },
    {
      label: '超过上限夹到 100',
      utilization: 250,
      actualUsedPercent: 100,
      deltaPercent: 50,
      etaSeconds: 0,
      willLastToReset: false,
    },
  ])('$label', ({ utilization, actualUsedPercent, deltaPercent, etaSeconds, willLastToReset }) => {
    expect(requirePace(inputAtProgress(utilization, 0.5))).toEqual({
      deltaPercent,
      expectedUsedPercent: 50,
      actualUsedPercent,
      etaSeconds,
      willLastToReset,
    });
  });
});
