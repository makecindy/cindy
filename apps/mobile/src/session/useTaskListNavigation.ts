import { useCallback, useContext, useRef } from 'react';
import { useRouter, type Href } from 'expo-router';
import { useGuardedPush, type GuardedNavigationAction } from '@/utils/useGuardedPush';
import { SessionDrawerNavigationContext, TaskListTransitionContext } from './SessionDrawerNavigationContext';
import { existingDrawerConversationState, isTaskListConversation, taskListDestination } from './taskListNavigationPolicy';

/** The only task-list entry: drawer exit, focus/double-tap guard, in-place
 * handling, native shell reuse and transition policy stay in this order.
 * Screens provide their pre-switch cleanup through the context, not another
 * copy of navigation policy. Message links continue to use useGuardedPush. */
export function useTaskListNavigation({ sidebar, runNavigation }: {
  sidebar: boolean;
  runNavigation?: (action: () => void) => void;
}): (href: Href) => void {
  const router = useRouter();
  const handleHref = useContext(SessionDrawerNavigationContext);
  const switchWithoutAnimation = useContext(TaskListTransitionContext);
  const navigate = useCallback<GuardedNavigationAction>((href, navigation) => {
    const sidebarSwitch = sidebar && isTaskListConversation(href);
    const destination = taskListDestination(href, sidebarSwitch);
    if (handleHref?.(destination)) return;
    // POP/RESET consults the departing screen as well as the destination.
    if (sidebarSwitch) navigation.setOptions({ animation: 'none' });
    const dispatch = () => {
      // The options commit may yield a frame: never dispatch from a stale owner.
      if (navigation.isFocused() === false) return;
      const existing = sidebarSwitch ? existingDrawerConversationState(navigation.getState(), destination) : null;
      if (existing) navigation.dispatch({ type: 'RESET', payload: existing });
      else router.push(destination);
    };
    if (sidebarSwitch && switchWithoutAnimation) switchWithoutAnimation(dispatch);
    else dispatch();
  }, [sidebar, router, handleHref, switchWithoutAnimation]);
  const push = useGuardedPush(navigate);
  // A retained Home changes its drawer owner without changing row callbacks.
  const host = useRef(runNavigation);
  host.current = runNavigation;
  return useCallback((href: Href) => {
    if (host.current) host.current(() => push(href));
    else push(href);
  }, [push]);
}
