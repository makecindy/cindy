import { useCallback, useContext } from 'react';
import { useNavigation, useRouter } from 'expo-router';
import { Keyboard } from 'react-native';
import { homeDismissCount } from '@/session/teammateNavigation';
import { TaskListTransitionContext } from '@/session/SessionDrawerNavigationContext';

/** Peer conversations return to the actual list, not the previously viewed peer.
 * Threads and message links keep their own one-level-back behavior. */
export function useTaskListBack(): () => void {
  const router = useRouter();
  const navigation = useNavigation();
  const transition = useContext(TaskListTransitionContext);
  return useCallback(() => {
    Keyboard.dismiss();
    const go = () => {
      if (navigation.isFocused?.() === false) return;
      const state = navigation.getState();
      const routes = state?.routes.slice(0, state.index + 1) ?? [];
      const count = homeDismissCount(routes);
      if (count !== null) {
        if (count > 0) router.dismiss(count);
        return;
      }
      const legacy = routes.findIndex(route => route.name === 'resources/[collectionId]'
        && (route.params as { collectionId?: string } | undefined)?.collectionId === 'teammates');
      if (legacy >= 0) navigation.reset({ ...state, stale: false, index: legacy,
        routes: [...routes.slice(0, legacy), { name: 'devices/index' }],
      } as never);
      else router.dismissTo('/devices');
    };
    if (transition) transition(go); else go();
  }, [navigation, router, transition]);
}
