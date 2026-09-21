import { useHomeMode } from './useHomeMode';
import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSegments } from 'expo-router';
import { useAdaptiveWindow } from '@/platform/AdaptiveWindowContext';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { motionDuration } from '@/theme/tokens';
import { RemoteSessionStoreSubscriptionGate } from './remoteSessionStore';
import { sessionPaneLayout } from './sessionPaneLayout';

type Frame = { left: number; top: number; width: number; height: number };
type Entry = { owner: string; frame: Frame; children: ReactNode };
const Context = createContext<{
  enabled: boolean;
  mounted: { current: boolean };
  publish(entry: Entry): void;
  host: React.RefObject<View | null>;
} | null>(null);

export function useResidentHomeList() {
  const context = useContext(Context);
  return { enabled: context?.enabled ?? false, mounted: context?.mounted };
}

/** The list lives above route lifetimes. Owners only supply its frame and props;
 * never key the host by route, session, or presentation width. */
export function ResidentHomeListProvider({ children }: { children: ReactNode }) {
  const geometry = useAdaptiveWindow();
  const enabled = sessionPaneLayout(geometry).persistent;
  const segments = useSegments() as string[];
  const { mode } = useHomeMode();
  // The retained task list must not overlay the teammate home pane.
  const visible = enabled && ((mode === 'tasks' && (segments.length === 0 || segments[0] === 'index' || (segments[0] === 'devices' && (segments.length === 1 || segments[1] === 'index'))))
    || (segments[0] === 'sessions' && segments[1] === '[sessionId]'));
  const host = useRef<View>(null);
  const mounted = useRef(false);
  const [entry, setEntry] = useState<Entry | null>(null);
  const reduceMotion = useReduceMotionEnabled();
  const publish = useCallback((next: Entry) => { setEntry(next); }, []);
  const context = useMemo(() => ({ enabled, mounted, publish, host }), [enabled, publish]);
  useLayoutEffect(() => {
    mounted.current = enabled && !!entry;
    if (!enabled) setEntry(null);
  }, [enabled, entry]);
  return <Context.Provider value={context}>
    <View ref={host} collapsable={false} style={styles.root}>
      {children}
      {entry ? <Animated.View pointerEvents={visible ? 'box-none' : 'none'}
        accessibilityElementsHidden={!visible}
        importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
        style={[styles.host, entry.frame, {
          opacity: visible ? 1 : 0,
          transitionProperty: ['left', 'top', 'width', 'height'],
          transitionDuration: reduceMotion === false ? motionDuration.fast : 0,
        }]}>
        <RemoteSessionStoreSubscriptionGate enabled={visible}>{entry.children}</RemoteSessionStoreSubscriptionGate>
      </Animated.View> : null}
    </View>
  </Context.Provider>;
}

/** A route supplies a measuring slot, not another native list. Its header stays
 * in the native navigation hierarchy, outside the list's touch bounds. */
export function ResidentHomeList({ children, focused, top, left, right }: {
  children: ReactNode; focused: boolean; top: number; left: number; right: number;
}) {
  const context = useContext(Context);
  const owner = useId();
  const anchor = useRef<View>(null);
  const latest = useRef({ children, focused });
  latest.current = { children, focused };
  const measureRevision = useRef(0);
  const measure = useCallback(() => {
    const revision = ++measureRevision.current;
    if (!context?.enabled || !latest.current.focused || !context.host.current) return;
    anchor.current?.measureLayout(context.host.current, (x, y, width, height) => {
      if (revision !== measureRevision.current || !latest.current.focused || width <= 0 || height <= 0) return;
      context.publish({ owner, frame: { left: x, top: y, width, height }, children: latest.current.children });
    });
  }, [context, owner]);
  useLayoutEffect(() => {
    measure();
    return () => { ++measureRevision.current; };
  }, [measure, children, focused, top, left, right]);
  return <View ref={anchor} collapsable={false} pointerEvents="none" onLayout={measure}
    style={{ flex: 1, marginTop: top, marginLeft: -left, marginRight: -right }} />;
}
const styles = StyleSheet.create({
  root: { flex: 1 },
  host: { position: 'absolute' },
});
