import { usePreventRemove } from 'expo-router/react-navigation';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** Keep the originating editor mounted until the send owns its local snapshot.
 * Only the first departure is replayed, even when Back and a drawer tap race. */
export function useSessionSendNavigation(scope: string) {
  const pending = useRef<{ leave?: () => void } | null>(null);
  const [activeScope, setActiveScope] = useState<string | null>(null);
  useLayoutEffect(() => {
    setActiveScope(null);
    return () => { pending.current = null; };
  }, [scope]);

  const beginSendHandoff = useCallback(() => {
    const handoff: { leave?: () => void } = {};
    pending.current = handoff;
    setActiveScope(scope);
    return () => {
      if (pending.current !== handoff) return false;
      pending.current = null;
      setActiveScope(null);
      handoff.leave?.();
      return !!handoff.leave;
    };
  }, [scope]);

  const deferSendNavigation = useCallback((leave: () => void) => {
    if (!pending.current) return false;
    pending.current.leave ??= leave;
    return true;
  }, []);
  usePreventRemove(activeScope === scope, ({ data, repeat }) => {
    // Account resets must still invalidate the original send.
    if (data.action.type === 'RESET') {
      pending.current = null;
      setActiveScope(null);
      repeat();
    } else if (!deferSendNavigation(repeat)) {
      repeat();
    }
  });
  return { beginSendHandoff, deferSendNavigation };
}
