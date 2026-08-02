/**
 * attemptLifecycle.test.ts — attempt 阶段机转移表(#1016)。
 * 穷举矩阵钉死:合法边恰为表列(含幂等重入),其余任意相对一律非法——
 * 转移表一旦被无意扩宽/收窄,这里立刻失败,而不是等运行期抛错或静默漏收口。
 */

import { describe, expect, it } from 'vitest';

import type { ScheduleRunPhase } from '../types.js';
import { LEGAL_PHASE_TRANSITIONS, isLegalPhaseTransition } from '../engine/attemptLifecycle.js';

const ALL_PHASES: readonly ScheduleRunPhase[] = [
  'loading',
  'claiming',
  'persisting',
  'running',
  'queued',
  'cancelling',
  'finalizing',
];

describe('isLegalPhaseTransition', () => {
  it('穷举矩阵:合法边 = 表列 ∪ 幂等重入,其余全部非法', () => {
    for (const from of ALL_PHASES) {
      for (const to of ALL_PHASES) {
        const expected = from === to || LEGAL_PHASE_TRANSITIONS[from].includes(to);
        expect(isLegalPhaseTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it('关键语义边逐条钉死(防表被误改)', () => {
    // 两个入口相只能进 persisting。
    expect(isLegalPhaseTransition('claiming', 'persisting')).toBe(true);
    expect(isLegalPhaseTransition('loading', 'persisting')).toBe(true);
    expect(isLegalPhaseTransition('claiming', 'running')).toBe(false);
    expect(isLegalPhaseTransition('loading', 'running')).toBe(false);
    // 排队往返与撤项。
    expect(isLegalPhaseTransition('running', 'queued')).toBe(true);
    expect(isLegalPhaseTransition('queued', 'running')).toBe(true);
    expect(isLegalPhaseTransition('queued', 'cancelling')).toBe(true);
    expect(isLegalPhaseTransition('cancelling', 'queued')).toBe(false);
    expect(isLegalPhaseTransition('cancelling', 'running')).toBe(false);
    // 排队中被 interrupt:runner 直接抛错,不经过 endQueueWait。
    expect(isLegalPhaseTransition('queued', 'finalizing')).toBe(true);
    // controller 注册后、running 置位前的守卫窗口。
    expect(isLegalPhaseTransition('persisting', 'finalizing')).toBe(true);
    // finalizing 是吸收相:幂等重入放行,任何离开都非法。
    expect(isLegalPhaseTransition('finalizing', 'finalizing')).toBe(true);
    for (const to of ALL_PHASES) {
      if (to !== 'finalizing') expect(isLegalPhaseTransition('finalizing', to)).toBe(false);
    }
  });
});
