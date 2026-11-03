import { useCallback, useRef } from 'react';

/** 两次点按的最大间隔(与 iOS 系统双击判定同量级)。 */
export const DOUBLE_TAP_INTERVAL_MS = 300;

/**
 * 判断本次点按是否与上一次构成双击。构成双击后清空记录,第三下重新开始计数。
 * 纯函数便于测试;组件层用 useDoubleTap。
 */
export function registerTap(lastTapAt: number | null, now: number): { doubleTap: boolean; lastTapAt: number | null } {
  if (lastTapAt !== null && now - lastTapAt <= DOUBLE_TAP_INTERVAL_MS) {
    return { doubleTap: true, lastTapAt: null };
  }
  return { doubleTap: false, lastTapAt: now };
}

/** 返回点按处理函数:两次点按间隔不超过 DOUBLE_TAP_INTERVAL_MS 时调用 onDoubleTap。 */
export function useDoubleTap(onDoubleTap: (() => void) | undefined): () => void {
  const lastTapAt = useRef<number | null>(null);
  const callback = useRef(onDoubleTap);
  callback.current = onDoubleTap;
  return useCallback(() => {
    const result = registerTap(lastTapAt.current, Date.now());
    lastTapAt.current = result.lastTapAt;
    if (result.doubleTap) callback.current?.();
  }, []);
}
