/**
 * useSessionSpend — 订阅当前 session 的"终身累计 cost"。
 *
 * 数据来源：
 *   - 调用方传入 session snapshot 作为首屏初值
 *   - 先订阅 main 推的 `usage:session-spend-changed`，再补拉一次权威 session 账本
 *   - 若补拉期间收到实时事件，以事件为准，避免旧查询覆盖新累计
 *
 * 新会话首轮可能在视图挂载前就完成；只依赖初值 + 广播会永久漏掉这笔费用。
 */

import { useEffect, useState } from 'react';
import { isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import { getSessionFor } from '@/lib/makerTransport';
import {
  legacyUsdMoney,
  normalizeRegionalMoney,
  type RegionalMoney,
} from '../../shared/regionalMoney';

export function useSessionSpend(
  sessionId: string | undefined,
  initialMoney: RegionalMoney | null | undefined,
  initialCostUsd: number | null | undefined,
): RegionalMoney | null {
  const initial =
    normalizeRegionalMoney(initialMoney) ??
    (typeof initialCostUsd === 'number'
      ? legacyUsdMoney(initialCostUsd)
      : null);
  const [money, setMoney] = useState<RegionalMoney | null>(
    initial,
  );

  // 初值只是首屏快照：仅切 session 时使用。同一 session 后到的旧 snapshot
  // 不能覆盖实时事件或下方权威补拉。
  useEffect(() => {
    setMoney(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 初值不拥有同一 session 的后续更新
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return undefined;
    let cancelled = false;
    let receivedCurrentEvent = false;
    const applyMoney = (
      totalMoney: unknown,
      totalCostUsd: number | null | undefined,
    ): void => {
      if (cancelled) return;
      setMoney(
        normalizeRegionalMoney(totalMoney) ??
          (typeof totalCostUsd === 'number'
            ? legacyUsdMoney(totalCostUsd)
            : null),
      );
    };
    const unsubscribe = window.electronAPI.onUsageSessionSpendChanged((res, ownerStamp) => {
      if (!isDataOwnerPushCurrent(ownerStamp)) return;
      if (res.sessionId === sessionId) {
        receivedCurrentEvent = true;
        applyMoney(res.totalMoney, res.totalCostUsd);
      }
    });
    void getSessionFor(sessionId)
      .then((session) => {
        if (!receivedCurrentEvent) {
          applyMoney(session.totalMoney, session.totalCostUsd);
        }
      })
      .catch(() => {
        // 初值与实时广播仍可工作；远端离线或旧被控端不阻断展示。
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sessionId]);

  return money;
}
