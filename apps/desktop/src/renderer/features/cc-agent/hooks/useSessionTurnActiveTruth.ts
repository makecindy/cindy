/**
 * 「应用退出中断」横幅的运行态真值回填(#4513;决策见 sessionInterruptBannerModel.ts)。
 *
 * 双时间戳候选对任何在飞 turn 都成立,而运行态抑制依赖的 status(isRunning) 事件在协同
 * worker 会话上可能缺失/迟到。候选出现(activeTurnStartedAt 变化)时向数据所属设备查一次
 * 权威运行态;null = 未确认,在真值回来前不把候选当中断证据。
 *
 * - device-link 远程会话问被控端(时间戳也来自被控端):控制端本机 main 没有这个 turn,
 *   永远答 false,控制端重启后活动镜像回放前会把被控端在跑的任务误判成中断。
 * - 查询失败(被控端离线 / 隧道不通)按未确认处理;`online` 由不在线翻回在线时重查,
 *   否则被控端恢复后真中断的横幅要等用户切走再回来才出现。
 * - 真值绑定所属会话:路由复用视图(无 key 的 :sessionId 路由),A(在飞)→B(真中断)
 *   切会话时 effect 先置 null,但同批次读者仍能看到旧快照 —— 返回值按 sessionId 过滤,
 *   旧会话残留的 true 不得锁存新会话的 ack(P1)。
 */

import { useEffect, useState } from 'react';

import { getSessionTurnActiveOn } from '@/lib/makerTransport';

export function useSessionTurnActiveTruth({
  sessionId,
  activeTurnStartedAt,
  deviceId,
  online,
}: {
  sessionId: string | undefined;
  activeTurnStartedAt: number | null;
  /** 数据所属设备:null = 本机会话。 */
  deviceId: string | null;
  /** 到所属设备的链路是否可用(本机会话恒 true)。 */
  online: boolean;
}): boolean | null {
  const [truth, setTruth] = useState<{ sessionId: string; inTurn: boolean } | null>(null);
  useEffect(() => {
    if (!sessionId || activeTurnStartedAt == null || !online) {
      setTruth(null);
      return;
    }
    let cancelled = false;
    setTruth(null);
    getSessionTurnActiveOn(sessionId, deviceId)
      .then((inTurn) => {
        if (!cancelled) setTruth({ sessionId, inTurn });
      })
      .catch(() => {
        // 查询失败按未确认处理:宁可漏显横幅,不把在飞 turn 误判成中断。
        if (!cancelled) setTruth(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, activeTurnStartedAt, deviceId, online]);
  return truth && truth.sessionId === sessionId ? truth.inTurn : null;
}
