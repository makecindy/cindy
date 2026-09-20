import { useLayoutEffect, useMemo } from 'react';
import {
  advanceViewedPriorityHold,
  type MainListPriorityContext,
  type ViewedPriorityHoldState,
} from '../lib/mainListModel';

/** Only a committed route may release the previously viewed task's priority. */
export function useViewedPriorityHold(
  state: ViewedPriorityHoldState,
  viewedSessionId: string | undefined,
  ctx: MainListPriorityContext,
): ViewedPriorityHoldState {
  const projected = useMemo(
    () =>
      advanceViewedPriorityHold(
        {
          prevViewedId: state.prevViewedId,
          heldPriorityRanks: new Map(state.heldPriorityRanks),
          recentlyViewedAtMs: new Map(state.recentlyViewedAtMs),
        },
        viewedSessionId,
        ctx,
        Date.now(),
      ),
    [state, viewedSessionId, ctx],
  );
  useLayoutEffect(() => {
    Object.assign(state, projected);
  }, [state, projected]);
  return projected;
}
