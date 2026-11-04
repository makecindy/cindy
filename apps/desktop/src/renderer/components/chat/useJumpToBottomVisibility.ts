import { useCallback, useEffect, useRef, useState } from 'react';

export const SCROLL_DIRECTION_DEAD_ZONE_PX = 1;
const JUMP_DOWN_IDLE_MS = 2000;

/** Shared session/group policy: downwards in history, until idle, up or at the tail. */
export function useJumpToBottomVisibility() {
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setVisible(false);
  }, []);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);
  const onScroll = useCallback((delta: number, nearBottom: boolean) => {
    if (nearBottom || delta < -SCROLL_DIRECTION_DEAD_ZONE_PX) {
      clear();
    } else if (delta > SCROLL_DIRECTION_DEAD_ZONE_PX) {
      setVisible(true);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(clear, JUMP_DOWN_IDLE_MS);
    }
  }, [clear]);
  return { visible, onScroll };
}
