import { HeaderHeightContext } from 'expo-router/react-navigation';
import { useContext, useRef } from 'react';

/** iOS's shortest visible navigation bar: the compact bar of a landscape iPhone. */
const MIN_VISIBLE_BAR_HEIGHT = 32;

// The home surface also renders inside the session drawer, where no screen
// header context exists. Only the native-header layout consumes this height.
// UIKit can report a shorter bar while it is still laying it out (Duo's shared
// status row reports 24 before 82) and may settle without another report, for
// example after returning from a task; keep the last real height instead.
export function useOptionalHeaderHeight(): number {
  const reported = useContext(HeaderHeightContext) ?? 0;
  const lastVisible = useRef(0);
  if (reported >= MIN_VISIBLE_BAR_HEIGHT) lastVisible.current = reported;
  return reported > 0 && reported < MIN_VISIBLE_BAR_HEIGHT && lastVisible.current > 0
    ? lastVisible.current
    : reported;
}
