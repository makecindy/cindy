import { useCallback, useLayoutEffect, useRef } from 'react';

import { restoreSessionAutomaticHistoryLoadAttempts } from '@/lib/sessionScrollStore';

export function useAutomaticHistoryLoadBudget(
  sessionId: string | undefined,
  viewportMaxAttempts: number,
  navRailMaxRounds: number,
  windowSnapshot: {
    historyLoaded: boolean;
    messageCount: number;
    firstMessageClientId: string | null;
  },
) {
  const viewportAttemptsRef = useRef(
    restoreSessionAutomaticHistoryLoadAttempts(sessionId, viewportMaxAttempts),
  );
  const navRailRoundsRef = useRef(
    restoreSessionAutomaticHistoryLoadAttempts(sessionId, navRailMaxRounds),
  );
  const completionSeenRef = useRef(restoreSessionAutomaticHistoryLoadAttempts(sessionId, 1) > 0);
  const previousWindowSnapshotRef = useRef(windowSnapshot);
  const automaticLoadInFlightCountRef = useRef(0);
  const windowInvalidatedDuringAutomaticLoadRef = useRef(false);

  const resetMountedBudgets = useCallback(() => {
    viewportAttemptsRef.current = 0;
    navRailRoundsRef.current = 0;
  }, []);

  // 消费当前窗口失效的既有响应式事实。只看 completed 的 true → false 不够：预算也可能
  // 因连续失败耗尽,那时 marker 始终是 false。反过来,不能在普通 false → false rerender
  // 上归零,否则会绕过两套退化上限。
  useLayoutEffect(() => {
    const completedNow = restoreSessionAutomaticHistoryLoadAttempts(sessionId, 1) > 0;
    const previous = previousWindowSnapshotRef.current;
    const reloadStarted = previous.historyLoaded && !windowSnapshot.historyLoaded;
    const visibleWindowWasTruncated = windowSnapshot.messageCount < previous.messageCount;
    const windowHeadChanged =
      previous.firstMessageClientId !== null &&
      windowSnapshot.firstMessageClientId !== previous.firstMessageClientId;
    const invalidatedWindowShape =
      !completedNow && (visibleWindowWasTruncated || windowHeadChanged);

    if ((completionSeenRef.current && !completedNow) || reloadStarted) {
      resetMountedBudgets();
    } else if (invalidatedWindowShape) {
      if (visibleWindowWasTruncated || automaticLoadInFlightCountRef.current === 0) {
        resetMountedBudgets();
      } else {
        // 正常自动 prepend 与同大小的权威换窗都表现成“首行变化”。请求返回前无法区分，
        // 先记下边沿；成功推进说明是 prepend，false 则说明请求被 epoch 作废，届时复位。
        windowInvalidatedDuringAutomaticLoadRef.current = true;
      }
    }
    completionSeenRef.current = completedNow;
    previousWindowSnapshotRef.current = windowSnapshot;
  });

  const runAutomaticLoad = useCallback(
    async (loadMore: (automatic?: boolean) => Promise<boolean>): Promise<boolean> => {
      automaticLoadInFlightCountRef.current += 1;
      try {
        const advanced = await loadMore(true);
        if (advanced) {
          completionSeenRef.current = true;
          windowInvalidatedDuringAutomaticLoadRef.current = false;
        }
        return advanced;
      } finally {
        automaticLoadInFlightCountRef.current -= 1;
        if (
          automaticLoadInFlightCountRef.current === 0 &&
          windowInvalidatedDuringAutomaticLoadRef.current
        ) {
          windowInvalidatedDuringAutomaticLoadRef.current = false;
          resetMountedBudgets();
        }
      }
    },
    [resetMountedBudgets],
  );

  return { viewportAttemptsRef, navRailRoundsRef, runAutomaticLoad };
}
