/**
 * attemptLifecycle —— InflightAttempt 阶段机的合法转移表(纯逻辑,#1016)。
 *
 * 背景:PR #944 的 review 里「某条出口分支漏做收口动作」同型缺陷出现了四次——
 * attempt 的生命周期有多个隐式出口,每个出口都靠手工记得做全套收口。本表把
 * 阶段转移显式化:所有 phase 写入统一走 Scheduler.transitionAttempt,非法转移
 * **抛错**而不是静默容忍(多数漏项的表现正是「静默少做一件事」)。
 *
 * 表由现网全部 7 处写点穷举推导(fireOneInner / runNowInner / updateInflightAttempt /
 * buildOnQueueWaitStart / buildEndQueueWait ×2 / forceReleaseStalledRun):
 *
 *   claiming ──→ persisting ──→ running ⇄ queued ──→ cancelling
 *   loading ───↗                  │         │            │
 *                                 └────→ finalizing ←────┘
 *
 *  - 'claiming'(自动 fire)与 'loading'(runNow)是两个入口相,只能进 'persisting';
 *    认领失败 / 行读不到等早退不经过任何转移,直接删除(删除 = 任意相合法出口,
 *    出口清单由 finishInflightAttempt 的单一出口统一执行)。
 *  - 'finalizing' 是吸收相:强制收口与迟到 settle 会各自尝试置一次,幂等重入
 *    (from === to)按 no-op 放行,其余任何离开 'finalizing' 的转移都非法。
 *  - 'queued' → 'finalizing' 合法:排队中的 turn 被 interrupt 时 runner 直接抛错,
 *    不经过 endQueueWait。
 *  - 'persisting' → 'finalizing' 合法:controller 在 registerInflight 后、
 *    'running' 置位前的窗口内就可能被卡死守卫强制收口。
 */

import type { ScheduleRunPhase } from '../types.js';

export const LEGAL_PHASE_TRANSITIONS: Readonly<
  Record<ScheduleRunPhase, readonly ScheduleRunPhase[]>
> = Object.freeze({
  claiming: ['persisting'],
  loading: ['persisting'],
  persisting: ['running', 'finalizing'],
  running: ['queued', 'finalizing'],
  queued: ['running', 'cancelling', 'finalizing'],
  cancelling: ['finalizing'],
  finalizing: [],
});

/** 幂等重入(from === to)合法;其余按表判定。 */
export function isLegalPhaseTransition(from: ScheduleRunPhase, to: ScheduleRunPhase): boolean {
  if (from === to) return true;
  return (LEGAL_PHASE_TRANSITIONS[from] ?? []).includes(to);
}
