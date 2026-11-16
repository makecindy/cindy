import { createContext, useCallback, useEffect, useRef, useState } from 'react';
import type { Href } from 'expo-router';
import { forwardNavigationLock } from '@/utils/navigationLock';
import { mobileDebugLog } from '@/debug/mobileDebugLog';

/** Only Home surfaces consume this override. Links inside messages still push. */
export const SessionDrawerNavigationContext = createContext<((href: Href) => boolean) | undefined>(undefined);

/** Task-list selection is a peer switch, not drilling into a message link.
 * The root owns both departing and arriving native screens' animation options. */
export const TaskListTransitionContext = createContext<((action: () => void) => void) | undefined>(undefined);

export function useTaskListTransition() {
  const job = useRef<{ action(): void; dispatched: boolean; startedAt: number } | null>(null);
  const [instant, setInstant] = useState(false);
  const finish = useCallback((event?: unknown) => {
    if (!job.current?.dispatched) return;
    const reason = typeof event === 'string' ? event
      : event && typeof event === 'object' && 'type' in event && event.type === 'state' ? 'state' : 'transition';
    mobileDebugLog('debug', 'performance', 'task list navigation settled', {
      elapsedMs: Math.max(0, performance.now() - job.current.startedAt),
      reason,
    });
    job.current = null;
    forwardNavigationLock.reset();
    setInstant(false);
  }, []);
  const run = useCallback((action: () => void) => {
    if (job.current) return;
    job.current = { action, dispatched: false, startedAt: performance.now() };
    setInstant(true);
  }, []);
  useEffect(() => {
    if (!instant) return;
    const current = job.current;
    // Commit `animation: none` on the source before dispatching the pop/reset;
    // the destination receives it on its first mount, including a cold group.
    const frame = requestAnimationFrame(() => {
      if (!current || job.current !== current) return;
      current.dispatched = true;
      try { current.action(); } catch (error) { finish('error'); throw error; }
    });
    // The root state commit completes instant switches too: native transitionEnd
    // is not guaranteed for animation:none or same-screen parameter changes.
    // This timer is only a fallback for no-op/cancelled dispatches.
    const fallback = setTimeout(() => finish('fallback'), 1500);
    return () => { cancelAnimationFrame(frame); clearTimeout(fallback); };
  }, [instant, finish]);
  return { instant, run, finish };
}
