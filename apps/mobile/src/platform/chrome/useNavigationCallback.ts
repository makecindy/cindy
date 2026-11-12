import { useCallback, useLayoutEffect, useRef } from 'react';

/** Native navigation retains handlers in its registered options. Keep their
 * identity stable without retaining an old task's closure. Only committed
 * renders update the target; a removed/unmounted action becomes a no-op. */
export function useNavigationCallback(callback: (() => void) | undefined): () => void {
  const current = useRef(callback);
  useLayoutEffect(() => {
    current.current = callback;
    return () => { current.current = undefined; };
  }, [callback]);
  return useCallback(() => { current.current?.(); }, []);
}
