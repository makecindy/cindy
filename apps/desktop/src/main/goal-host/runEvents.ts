/**
 * Goal run 结构化观测事件 (#2105, roadmap #2104 P0)
 * ---------------------------------------------------------------------------
 * 让一次 goal 运行可审计:第几个 turn、状态如何迁移、实际派发了什么、最终状态
 * 怎么收口、预算消耗、停滞/重试/恢复。统一 schema + generation 防旧事件串台。
 *
 * 设计约束(维护者 #2104):
 *  - 只加观测、不改状态机语义;不引入宽泛自动恢复(#2091 边界)。
 *  - recordRunEvent 是 GoalControllerDeps 的可选依赖(默认 no-op),不破坏现有测试。
 */

import type { GoalStatus } from './types';

export type GoalRunEventType =
  | 'turn-dispatched' // 本轮已派发给 agent(onDispatching 真实派发边界,accepted:false 不产生)
  | 'turn-finalized' // 本轮收口(finalizeTurn 决策后,含完整预算快照)
  | 'state-transition' // 状态迁移(prev → next,含 quota override 改判)
  | 'budget-consumed' // 预算检查命中(超限转 budgetLimited,含 preflight 停止)
  | 'stall-detected' // 连续空轮撞 noProgressLimit
  | 'resumed' // 手动 resume / resumeActiveGoals 续跑
  | 'terminal'; // 终态落盘(仅 complete / budgetLimited;usageLimited 不是终态不发)

export interface GoalRunEvent {
  type: GoalRunEventType;
  goalSessionId: string;
  /** 生命周期 generation —— 防 Stop/Resume 换代后旧事件串台(与 controller 同语义)。 */
  generation: number;
  /**
   * 回合序号:1-based,= 事件时刻的累计轮数。回合内事件(turn-dispatched /
   * turn-finalized / state-transition / budget-consumed / stall-detected / terminal)
   * 以决策后快照为准(turnIndex=本轮);非回合事件(resumed)保持不递增(可为 0)。
   */
  turnIndex: number;
  from?: GoalStatus;
  to?: GoalStatus;
  /** verdict 原文 / 停滞原因 / 终态 reason。 */
  reason?: string;
  budget?: {
    tokensUsed: number;
    turnsUsed: number;
    noProgressStreak: number;
    budgetTokens: number | null;
    maxTurns: number | null;
    noProgressLimit: number | null;
  };
  at: number;
}

export type RunEventSink = (evt: GoalRunEvent) => void;

/**
 * 内存环记录器:保留最近 N 条,可注入外部 sink(持久化 / push 到 renderer)。
 * 供测试断言与审计查询;容量满时丢弃最旧(观测是 best-effort,不背压主流程)。
 */
export interface GoalRunRecorder {
  record(evt: GoalRunEvent): void;
  snapshot(): readonly GoalRunEvent[];
  clear(): void;
}

export function createRunEventRecorder(limit = 200, sink?: RunEventSink): GoalRunRecorder {
  const ring: GoalRunEvent[] = [];
  return {
    record(evt: GoalRunEvent) {
      ring.push(evt);
      if (ring.length > limit) ring.shift();
      sink?.(evt);
    },
    snapshot() {
      return ring.slice();
    },
    clear() {
      ring.length = 0;
    },
  };
}
