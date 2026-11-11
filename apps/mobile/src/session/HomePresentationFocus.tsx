import { NavigationActionContext } from '@/utils/NavigationActionContext';
import { useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { NavigationContext } from 'expo-router/react-navigation';

/** A retained floating Home has its own visibility within the focused task.
 * Reuse Home's existing focus gates for roster, sync, subscriptions and looping
 * animations. Keep its native views alive: hiding the entire tree would force
 * Fabric to materialize them again when the finger starts pulling the drawer.
 * Navigation actions still belong to the real route. */
export function HomePresentationFocus({ active, children }: { active: boolean; children: ReactNode }) {
  const navigation = useContext(NavigationContext);
  const inheritedActionNavigation = useContext(NavigationActionContext);
  const activeRef = useRef(active);
  const listeners = useMemo(() => ({
    focus: new Set<(event: { type: 'focus' | 'blur' }) => void>(),
    blur: new Set<(event: { type: 'focus' | 'blur' }) => void>(),
  }), []);
  const scopedNavigation = useMemo(() => {
    if (!navigation) return navigation;
    const scoped: typeof navigation = {
      ...navigation,
      isFocused: () => activeRef.current && navigation.isFocused(),
      addListener: (event, listener) => {
        if (event !== 'focus' && event !== 'blur') return navigation.addListener(event, listener);
        const type = event === 'focus' ? 'focus' : 'blur';
        const callback = listener as (event: { type: 'focus' | 'blur' }) => void;
        listeners[type].add(callback);
        const unsubscribe = navigation.addListener(type, value => {
          if (activeRef.current) callback(value);
        });
        return () => { listeners[type].delete(callback); unsubscribe(); };
      },
    };
    return scoped;
  }, [listeners, navigation]);
  useLayoutEffect(() => {
    if (activeRef.current === active) return;
    activeRef.current = active;
    const type = active && navigation?.isFocused() ? 'focus' : 'blur';
    for (const listener of [...listeners[type]]) listener({ type });
  }, [active, listeners, navigation]);
  return <NavigationActionContext.Provider value={inheritedActionNavigation ?? navigation}>
    <NavigationContext.Provider value={scopedNavigation}>{children}</NavigationContext.Provider>
  </NavigationActionContext.Provider>;
}
