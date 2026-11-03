import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSegments } from 'expo-router';
import { useAdaptiveWindow } from '@/platform/AdaptiveWindowContext';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { motionDuration } from '@/theme/tokens';
import { RemoteSessionStoreSubscriptionGate } from './remoteSessionStore';
import { sessionPaneLayout } from './sessionPaneLayout';
import { SessionPaneDivider } from './SessionPaneDivider';

const PaneLayoutContext = createContext<ReturnType<typeof sessionPaneLayout> | null>(null);

export function useSessionPaneLayout() {
  const geometry = useAdaptiveWindow();
  return useContext(PaneLayoutContext) ?? sessionPaneLayout(geometry);
}

type Frame = { left: number; top: number; width: number; height: number };
type Entry = { owner: string; frame: Frame; children: ReactNode };
const Context = createContext<{
  persistent: boolean;
  mounted: { current: boolean };
  publish(entry: Entry): void;
  unpublish(owner: string): void;
  host: React.RefObject<View | null>;
} | null>(null);

export function useResidentHomeList(embedded = false) {
  const context = useContext(Context);
  // UIKit must find Home's list inside its covered screen during interactive
  // back, before JS focus changes. Keep that ownership at every window width.
  // Android retains the root host; modal drawers always stay in their surface.
  return { enabled: !!context && (embedded ? context.persistent : Platform.OS !== 'ios'), mounted: context?.mounted };
}

/** Preserve the resident-list owner when route content is re-hosted above this
 * provider. React context follows the render destination, so an explicit bridge
 * is required for Android root overlays that otherwise fall back to an inline
 * Home list. */
export function useResidentHomeListContextBridge(children: ReactNode) {
  const context = useContext(Context);
  return useMemo(
    () => <Context.Provider value={context}>{children}</Context.Provider>,
    [children, context],
  );
}

/** The list lives above route lifetimes. Owners only supply its frame and props;
 * never key the host by route, session, or presentation width. */
export function ResidentHomeListProvider({ children }: { children: ReactNode }) {
  const geometry = useAdaptiveWindow();
  // Window preference, shared by retained routes; rotation clamps only the
  // displayed width, so returning to a wide window restores the user's choice.
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null);
  const paneLayout = useMemo(() => sessionPaneLayout(geometry, sidebarWidth), [geometry, sidebarWidth]);
  const { persistent } = paneLayout;
  const segments = useSegments() as string[];
  const homeRoute = segments.length === 0 || segments[0] === 'index'
    || (segments[0] === 'devices' && (segments.length === 1 || segments[1] === 'index'));
  // iOS Home keeps its list in its own route; Android draws it here on the home too.
  const rootHome = Platform.OS !== 'ios';
  const visible = (rootHome && homeRoute)
    || (persistent && segments[0] === 'sessions'
      && (segments[1] === '[sessionId]' || segments[1] === 'new'));
  const host = useRef<View>(null);
  const mounted = useRef(false);
  const [entry, setEntry] = useState<Entry | null>(null);
  const reduceMotion = useReduceMotionEnabled();
  const publish = useCallback((next: Entry) => { setEntry(next); }, []);
  const unpublish = useCallback((owner: string) => {
    setEntry(current => current?.owner === owner ? null : current);
  }, []);
  const context = useMemo(() => ({ persistent, mounted, publish, unpublish, host }), [persistent, publish, unpublish]);
  useLayoutEffect(() => {
    mounted.current = !!entry;
  }, [entry]);
  return <PaneLayoutContext.Provider value={paneLayout}><Context.Provider value={context}>
    <View ref={host} collapsable={false} style={styles.root}>
      {children}
      {entry ? <Animated.View collapsable={false} pointerEvents={visible ? 'box-none' : 'none'}
        accessibilityElementsHidden={!visible}
        importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
        style={[styles.host, entry.frame, {
          transitionProperty: ['left', 'top', 'width', 'height'],
          // The measured slot already follows the divider. Do not start a
          // second size animation when the final asynchronous measure arrives
          // after release; keep the sidebar's native host above the route.
          transitionDuration: !persistent && reduceMotion === false ? motionDuration.fast : 0,
        }, { opacity: visible ? 1 : 0 }]}>
        <RemoteSessionStoreSubscriptionGate enabled={visible}>{entry.children}</RemoteSessionStoreSubscriptionGate>
      </Animated.View> : null}
      {visible && !homeRoute && paneLayout.resizeBounds ? <SessionPaneDivider
        width={paneLayout.sidebarWidth} bounds={paneLayout.resizeBounds}
        left={paneLayout.detail.x} top={geometry.insets.top} bottom={geometry.insets.bottom}
        onResize={setSidebarWidth}
      /> : null}
    </View>
  </Context.Provider></PaneLayoutContext.Provider>;
}

/** A route supplies a measuring slot, not another native list. Its header stays
 * in the native navigation hierarchy, outside the list's touch bounds. */
export function ResidentHomeList({ children, focused, top, left, right }: {
  children: ReactNode; focused: boolean; top: number; left: number; right: number;
}) {
  const context = useContext(Context);
  const unpublish = context?.unpublish;
  const owner = useId();
  const anchor = useRef<View>(null);
  const latest = useRef({ children, focused });
  latest.current = { children, focused };
  const measureRevision = useRef(0);
  const measure = useCallback(() => {
    const revision = ++measureRevision.current;
    if (!context || !latest.current.focused || !context.host.current) return;
    anchor.current?.measureInWindow((x, y, width, height) => {
      context.host.current?.measureInWindow((hostX, hostY) => {
        if (revision !== measureRevision.current || !latest.current.focused || width <= 0 || height <= 0) return;
        context.publish({ owner, frame: { left: x - hostX, top: y - hostY, width, height }, children: latest.current.children });
      });
    });
  }, [context, owner]);
  useLayoutEffect(() => {
    measure();
    return () => { ++measureRevision.current; };
  }, [measure, children, focused, top, left, right]);
  // iOS Home lives in its native route, so an unmounted drawer has no successor
  // in this host. Android retains the root list through route-owner handoffs.
  // Layout/prop updates keep the live list; an old owner cannot clear a new one.
  useLayoutEffect(() => {
    if (Platform.OS === 'ios') return () => { unpublish?.(owner); };
  }, [unpublish, owner]);
  return <View ref={anchor} collapsable={false} pointerEvents="none" onLayout={measure}
    style={{ flex: 1, marginTop: top, marginLeft: -left, marginRight: -right }} />;
}
const styles = StyleSheet.create({
  root: { flex: 1 },
  host: { position: 'absolute', zIndex: 1 },
});
