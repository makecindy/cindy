/**
 * silentStopContinuationBinding.ts
 * ---------------------------------------------------------------------------
 * silent-stop 自动续跑走 Session.sendHostTurnContinuation()，绕过 send 事务
 * (makerSendTransaction)，因此不会触发把 onTurnReserved 转发给输入协调器的常规
 * 接线。这两条约定必须在 host 续跑侧自己完成，否则协调器里残留的已派发
 * activeTurn 会与真实终态永久失配，输入边界卡在忙（僵尸 activeTurn，2026-09-24
 * 实报：任务永远显示运行中、插话/新消息只能排队不派发）：
 *   1. 预约时（onTurnReserved）把新 vendor generation 交给协调器改绑；
 *   2. send 在派发确认前失败时（Session 会同步回滚 turnGeneration）回滚绑定，
 *      否则失败收口 `settleSilentStopDone` 合成的无 generation done 会被同一
 *      归属守卫丢弃，形成镜像的反向僵尸。
 *
 * 这里把这两条接线收口成一个可单测的装配：行为测试用真实的
 * `Session.sendHostTurnContinuation` 驱动本函数产出的 sendOpts（见
 * __tests__/silentStopContinuationBinding.test.ts），让预约回调时序与失败回滚
 * 被真实流程覆盖；register 侧另有源码契约守住两条失败收口确实调用了
 * `rollbackBinding()`。
 */

export interface SilentStopContinuationBindingDeps {
  /** 预约回调：协调器侧 noteHostTurnContinuation（通常经 holder 可选转发）。 */
  noteHostTurnContinuation: (sessionId: string, vendorTurnGeneration: number) => void;
  /** 失败回滚：协调器侧 noteHostTurnContinuationFailed。 */
  noteHostTurnContinuationFailed: (
    sessionId: string,
    adoptedVendorTurnGeneration: number,
  ) => void;
}

export interface SilentStopContinuationBinding {
  /**
   * 并入 `session.sendHostTurnContinuation` 的 opts。onTurnReserved 在 Session
   * 预约本轮 vendor generation 时同步触发（先于 provider dispatch，任何早期
   * 终态事件也随之落在新绑定上）。
   */
  sendOpts: { onTurnReserved: (reservedGeneration: number) => void };
  /**
   * send 未派发（accepted:false）或抛出时的收口动作：把协调器绑定还原为预约前的
   * generation。尚无预约（回调根本没触发，如派发前被取消）时是 no-op；成功派发
   * 后不得调用。
   */
  rollbackBinding: () => void;
}

export function bindSilentStopContinuationGeneration(
  sessionId: string,
  deps: SilentStopContinuationBindingDeps,
): SilentStopContinuationBinding {
  // 预约到的 generation；失败收口据此回滚（Session 回滚后 bound 必须跟随）。
  let reservedGeneration: number | null = null;
  return {
    sendOpts: {
      onTurnReserved: (reservedTurnGeneration) => {
        reservedGeneration = reservedTurnGeneration;
        deps.noteHostTurnContinuation(sessionId, reservedTurnGeneration);
      },
    },
    rollbackBinding: () => {
      if (reservedGeneration === null) return;
      deps.noteHostTurnContinuationFailed(sessionId, reservedGeneration);
    },
  };
}
