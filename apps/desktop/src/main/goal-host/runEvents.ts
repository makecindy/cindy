/**
 * Goal run 结构化观测事件 (#2105, roadmap #2104 P0)
 * ---------------------------------------------------------------------------
 * 让一次 goal 运行可审计:第几个 turn、状态如何迁移、实际派发了什么、最终状态
 * 怎么收口、预算消耗、停滞/恢复。统一 schema + generation 防旧事件串台。
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
  /** 生命周期唯一 id(freshTurn 每次换代生成):generation 会被 freshTurn 重置为 0,
   * 同 generation 不证明同生命周期——排序/配对以 lifecycleId 为准。 */
  lifecycleId?: string;
  /** 生命周期 generation —— 防 Stop/Resume 换代后旧事件串台(与 controller 同语义)。 */
  generation: number;
  /**
   * 回合序号:1-based,统一规则 —— turnIndex = 事件时刻的 turnsUsed
   * + (type === 'turn-dispatched' ? 1 : 0)。
   *  - turn-dispatched:派发边界,turnIndex = 派发前 turnsUsed + 1(本轮);
   *  - turn-finalized / state-transition / stall-detected / terminal:
   *    决策后,turnIndex = 含本轮计数;
   *  - budget-consumed:preflight 预算停止等路径无"本轮",turnIndex = 已完成轮数;
   *  - resumed:非回合事件,不递增(可为 0)。
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

export type RunEventSink = (evt: GoalRunEvent) => void | Promise<void>;

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
  // 归一化容量:0 / 负数 / NaN 会让环退化为每次 record 都 shift,行为意外——
  // 下限 1,避免调用方意外禁用/劣化 recorder。
  const capacity = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 200;
  const ring: GoalRunEvent[] = [];
  return {
    record(evt: GoalRunEvent) {
      // 浅拷贝(含嵌套 budget)后存入环:snapshot/sink 消费者若意外修改事件对象,
      // 不会反向污染内存环里的审计数据。sink 仍收原始 evt。
      ring.push({
        ...evt,
        budget: evt.budget ? { ...evt.budget } : undefined,
      });
      if (ring.length > capacity) ring.shift();
      // best-effort:外部 sink 抛错/异步 reject 不得冒泡影响业务流程。
      try {
        Promise.resolve(sink?.(evt)).catch(() => {
          // 观测链路失败静默;环内数据不受影响。
        });
      } catch {
        // 同步 throw 同样静默。
      }
    },
    snapshot() {
      // 与 record 同样浅拷贝(含 budget):返回新对象,消费者修改返回值
      // 不会污染环内数据。
      // 排序不变量(可验证,与评审过程无关):
      //  1. 按 at 升序(快终态时 dispatch 的 at 早于收口,即使落环晚);
      //  2. 同 at 且同 lifecycleId(同生命周期)按 turnIndex 升序;
      //     跨生命周期换代时不用全局 turnIndex(freshTurn 重置 generation=0,
      //     同代不证明同生命周期;新 run 的 turnIndex 小于旧 run 的 terminal,
      //     不得把"新 run 开始"排到"旧 run 结束"之前);
      //  3. 同 at 且仍相等时,派发类(resumed/turn-dispatched)在收口类之前;
      //  4. 其余按显式插入序号(不依赖引擎 sort 稳定性,插入序 = 落环序)。
      const dispatchGroup = new Set(['resumed', 'turn-dispatched']);
      // 收口类:所有派发后的终态/迁移/停滞事件都排在派发类之后(同毫秒全序,
      // state-transition/budget-consumed/stall-detected 也必须 phase 后置)。
      const closeoutGroup = new Set([
        'turn-finalized',
        'state-transition',
        'stall-detected',
        'budget-consumed',
        'terminal',
      ]);
      // lifecycleId 序号(g\d+ 单调递增):同 at 跨生命周期时按序号排序——
      // 旧生命周期的事件(含 terminal)排在新生命周期的 turn-dispatched 之前,
      // 保持因果顺序(同毫秒换代不把"新 run 开始"排到"旧 run 结束"之前)。
      const lifecycleSeqOf = (id?: string): number => {
        if (!id) return Number.MAX_SAFE_INTEGER;
        const m = /^g(\d+)$/.exec(id);
        return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
      };
      // state-transition 例外:resumeGoal 的迁移(to: 'active')在 resumed 标记之前
      // 落环,若当 closeout 会被排到 resumed 后——消费者先看到 resumed 再看到
      // paused→active,因果倒置;只有派发后的迁移(to: complete/budgetLimited 等)
      // 才算收口类(Codex P1)。
      const isCloseout = (evt: GoalRunEvent): boolean =>
        evt.type === 'state-transition' ? evt.to !== 'active' : closeoutGroup.has(evt.type);
      return ring
        .map((evt, idx) => ({
          _seq: idx,
          ...evt,
          budget: evt.budget ? { ...evt.budget } : undefined,
        }))
        .sort((a, b) => {
          const byAt = (a.at ?? 0) - (b.at ?? 0);
          if (byAt !== 0) return byAt;
          // 同 at 且同 lifecycleId(同生命周期)用 turnIndex 与派发/收口类型次序。
          if (a.lifecycleId && a.lifecycleId === b.lifecycleId) {
            const byTurn = a.turnIndex - b.turnIndex;
            if (byTurn !== 0) return byTurn;
            // 仅派发类 vs 收口类跨组时用类型次序,其余保持插入序。
            const aD = dispatchGroup.has(a.type);
            const bD = dispatchGroup.has(b.type);
            const aF = isCloseout(a);
            const bF = isCloseout(b);
            if (aD && bF) return -1;
            if (aF && bD) return 1;
          }
          // 同 at 跨生命周期:按生命周期序号先后(旧生命周期先落)。
          const byLifecycle = lifecycleSeqOf(a.lifecycleId) - lifecycleSeqOf(b.lifecycleId);
          if (byLifecycle !== 0) return byLifecycle;
          // 显式插入序号作最终 tie-breaker(规范不保证 sort 稳定)。
          return a._seq - b._seq;
        })
        .map(({ _seq: _omit, ...evt }) => evt);
    },
    clear() {
      ring.length = 0;
    },
  };
}
