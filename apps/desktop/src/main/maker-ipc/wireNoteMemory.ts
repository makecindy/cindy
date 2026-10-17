/**
 * 逐轮环境说明的去重记忆:同一原生上下文里,内容没变的说明不再重复前置。
 *
 * 发给模型的 wire 消息会前置几段"系统每轮自动追加"的环境说明(界面语言、客户端设备、
 * 个人版制作任务说明)。它们刻意不进 system prompt(控制端会中途切换,易变内容只能进
 * per-call 段,见 mobileClientPromptNote.ts 头注释),代价是**每一轮**都重复一遍,并随
 * 用户消息一起被原生引擎持久化:长对话压缩后仍能剩下近百份一模一样的界面语言说明,
 * 既占窗口,又稀释压缩摘要。宿主无法事后从原生历史里剥掉它们,只能在发送时少发。
 *
 * 规则(按 session 记上一次**已被引擎接受**的各段原文):
 *  - 本轮某段与上次相同 → 不发;不同(含从无到有)→ 发;从有到无 → 不发但记住"无"。
 *  - 原生上下文失去连续性时必须整体重发一次:换窗 / 引擎切换的交接首条(调用方传
 *    `force`)、原生自动压缩边界之后、`/clear` 之后(调用方 `reset`)。原生摘要可能已经
 *    把旧说明丢掉,宿主拿不到摘要内容,只能保守重发。
 *  - 进程重启后记忆为空,首轮多发一次,方向保守。
 *
 * 只有跨过不可逆 dispatch 边界(accepted)才 `commit`;被拒 / 抛错不记,下次照常重发。
 * `[消息来源]` 不在此列:它陈述的是"本条"由谁发,逐条都要带。
 */

export type RepeatableWireNoteKind = 'ui-language' | 'client-environment' | 'cindy-make';

export type RepeatableWireNotes = Partial<Record<RepeatableWireNoteKind, string | null>>;

export interface WireNotePlan {
  /** 本轮真正要前置的段(已去掉与上次相同的)。 */
  readonly notes: RepeatableWireNotes;
  /** 引擎接受后调用,把本轮各段原文(含 null)记为上一次已发送状态。 */
  commit(): void;
}

export interface WireNoteMemory {
  plan(sessionId: string, notes: RepeatableWireNotes, opts?: { force?: boolean }): WireNotePlan;
  /** 原生上下文失去连续性(压缩边界 / clear / 重建):下一轮整体重发。 */
  reset(sessionId: string): void;
}

const KINDS: readonly RepeatableWireNoteKind[] = ['ui-language', 'client-environment', 'cindy-make'];

export function createWireNoteMemory(): WireNoteMemory {
  const lastSent = new Map<string, Map<RepeatableWireNoteKind, string | null>>();
  /**
   * 每个会话的重置代次:plan 时记下,commit 时核对。发送在途(Pi 受理前可能先压缩)
   * 期间发生 reset,代次已变,旧 plan 的 commit 不能把"已发过"写回去——否则下一轮
   * 继续省略,而新原生上下文其实没看过这些说明。
   */
  const resetEpoch = new Map<string, number>();
  const epochOf = (sessionId: string): number => resetEpoch.get(sessionId) ?? 0;
  return {
    plan(sessionId, notes, opts) {
      const previous = lastSent.get(sessionId);
      const epoch = epochOf(sessionId);
      const planned: RepeatableWireNotes = {};
      for (const kind of KINDS) {
        const text = notes[kind] ?? null;
        if (text === null) continue;
        // 没有记忆(首轮 / 重启 / reset 之后)或调用方要求整体重发时全发。
        if (opts?.force || !previous || previous.get(kind) !== text) planned[kind] = text;
      }
      return {
        notes: planned,
        commit() {
          // plan 之后 reset 过:这份计划面对的是旧上下文,不记为已发送,下一轮整体重发。
          if (epochOf(sessionId) !== epoch) return;
          const next = new Map<RepeatableWireNoteKind, string | null>();
          for (const kind of KINDS) next.set(kind, notes[kind] ?? null);
          lastSent.set(sessionId, next);
        },
      };
    },
    reset(sessionId) {
      lastSent.delete(sessionId);
      resetEpoch.set(sessionId, epochOf(sessionId) + 1);
    },
  };
}
