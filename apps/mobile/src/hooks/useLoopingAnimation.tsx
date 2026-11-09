import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { useReduceMotionEnabled } from './useReduceMotion';

const AnimationVisibility = createContext(true);

/** Visibility belongs to the rendered surface, not the route that supplied its
 * children: a retained home list can also be a visible wide-screen sidebar. */
export function AnimationVisibilityProvider({ visible, children }: { visible: boolean; children: ReactNode }) {
  const parentVisible = useContext(AnimationVisibility);
  return <AnimationVisibility.Provider value={parentVisible && visible}>{children}</AnimationVisibility.Provider>;
}

/** Whether the surface this hook renders in is visible, for content that a native bar renders
 * outside the route's providers and so must carry the answer with it. */
export function useAnimationVisibility(): boolean {
  return useContext(AnimationVisibility);
}

/** Native header callbacks render outside the route's provider subtree. Capture
 * its visibility here and carry it with the content into the navigation header. */
export function useAnimationVisibilityBridge(children: ReactNode): ReactNode {
  const visible = useContext(AnimationVisibility);
  return useMemo(() => (
    <AnimationVisibilityProvider visible={visible}>{children}</AnimationVisibilityProvider>
  ), [visible, children]);
}

// All mounted indicators share one native listener, including indicators outside
// an explicit visibility scope. No polling and no listener after the last unmount.
const listeners = new Set<() => void>();
let subscription: ReturnType<typeof AppState.addEventListener> | undefined;
function subscribeForeground(listener: () => void) {
  listeners.add(listener);
  if (!subscription) {
    subscription = AppState.addEventListener('change', () => {
      listeners.forEach(notify => notify());
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      subscription?.remove();
      subscription = undefined;
    }
  };
}
const isForeground = () => AppState.currentState === 'active';
const serverForeground = () => false;

/** Only the animation is paused; callers retain their status, content and state.
 * Unknown reduced-motion preference remains static, like useReduceMotionEnabled. */
export function useLoopingAnimation(enabled = true): boolean {
  const visible = useContext(AnimationVisibility);
  const foreground = useSyncExternalStore(subscribeForeground, isForeground, serverForeground);
  const reduceMotion = useReduceMotionEnabled();
  return enabled && visible && foreground && reduceMotion === false;
}
