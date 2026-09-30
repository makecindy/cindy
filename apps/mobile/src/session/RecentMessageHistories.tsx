import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSegments } from 'expo-router';
import { NavigationContext, NavigationRouteContext, useIsFocused } from 'expo-router/react-navigation';
import { PaneViewportProvider, usePaneViewport } from '@/platform/AdaptiveWindowContext';
import { getRecentTasks, recentTaskKey, subscribeRecentTasks } from './recentTasks';
import { NativeHistoryHost, NativeHistorySlot, needsResidentHistoryUpgrade } from './NativeResidentHistory';

import { MessageHistoryActive, MessageHistoryPositioning } from './messageHistoryActivity';
export { useMessageHistoryActive, useMessageHistoryPositioning } from './messageHistoryActivity';
type Frame = { left: number; top: number; width: number; height: number };
type Entry = { key: string; owner: string; children: ReactNode; frame: Frame;
  focused: boolean; ready: boolean; topInset: number; bottomInset: number; interactive: boolean };
const Context = createContext<{
  host: React.RefObject<View | null>;
  namespace: string;
  publish(entry: Entry): void;
  release(owner: string): void;
  setOverlay(owner: string, children: ReactNode): void;
} | null>(null);

/** The only owner of mounted histories. Route slots may disappear; these keyed
 * React children remain mounted until LRU eviction or sign-out. On iOS, a plain
 * native content container docks into the route without moving React ownership. */
export function RecentMessageHistoriesProvider({ children }: { children: ReactNode }) {
  const host = useRef<View>(null);
  const namespace = useId();
  const [overlays, setOverlays] = useState<Map<string, ReactNode>>(() => new Map());
  const setOverlay = useCallback((owner: string, content: ReactNode) => {
    setOverlays(previous => {
      const next = new Map(previous);
      if (content === null) next.delete(owner); else next.set(owner, content);
      return next;
    });
  }, []);
  const tasks = useSyncExternalStore(subscribeRecentTasks, getRecentTasks, getRecentTasks);
  const [entries, setEntries] = useState<Map<string, Entry>>(() => new Map());
  const segments = useSegments() as string[];
  const onTaskRoute = segments[0] === 'sessions' && segments[1] === '[sessionId]';
  const allowed = useMemo(() => new Set(tasks.map(task => recentTaskKey(task.params))), [tasks]);
  const publish = useCallback((entry: Entry) => {
    setEntries(previous => {
      if (previous.get(entry.key) === entry) return previous;
      const cached = previous.get(entry.key);
      if (!cached && !entry.ready) return previous;
      // A blurred old route cannot overwrite a newer route for the same task.
      if (cached?.focused && !entry.focused && cached.owner !== entry.owner) return previous;
      const next = new Map(previous);
      if (entry.focused) for (const [key, other] of next) {
        if (key !== entry.key && other.focused) next.set(key, { ...other, focused: false });
      }
      // Do not resize a retained list with a route's initial zero-height chrome
      // or replace its data with the loading shell while that route hydrates.
      next.set(entry.key, cached && !entry.ready
        ? { ...cached, owner: entry.owner, focused: entry.focused, ready: false, interactive: false }
        : entry);
      return next;
    });
  }, []);
  const release = useCallback((owner: string) => {
    setEntries(previous => {
      const next = new Map(previous);
      let changed = false;
      for (const [key, entry] of next) if (entry.owner === owner && entry.focused) {
        next.set(key, { ...entry, focused: false }); changed = true;
      }
      return changed ? next : previous;
    });
  }, []);
  useLayoutEffect(() => {
    setEntries(previous => {
      const next = new Map([...previous].filter(([key]) => allowed.has(key)));
      return next.size === previous.size ? previous : next;
    });
  }, [allowed]);
  const context = useMemo(() => ({ host, namespace, publish, release, setOverlay }), [namespace, publish, release, setOverlay]);
  return <Context.Provider value={context}>
    <View ref={host} collapsable={false} style={styles.container}>
      {children}
      {[...entries].filter(([key]) => allowed.has(key)).map(([key, entry]) => {
        const active = onTaskRoute && entry.focused;
        if (NativeHistoryHost) return <NativeHistoryHost key={key} surfaceId={namespace + key}
          pointerEvents="none" style={{ position: 'absolute', width: entry.frame.width, height: entry.frame.height }}>
          <MessageHistoryPositioning.Provider value={active && entry.ready}>
            <MessageHistoryActive.Provider value={active && entry.ready}>{entry.children}</MessageHistoryActive.Provider>
          </MessageHistoryPositioning.Provider>
        </NativeHistoryHost>;
        // Keep the original list viewport/offset, but restrict this root layer's
        // drawing and hit area to the message body. Native chrome/composer stay in
        // their route and must remain above/outside the resident scroll surface.
        const top = Math.min(entry.frame.height, Math.max(0, entry.topInset));
        const bottom = Math.min(entry.frame.height - top, Math.max(0, entry.bottomInset));
        return <View key={key} pointerEvents={active && entry.interactive ? 'auto' : 'none'}
          accessibilityElementsHidden={!active} importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
          style={[styles.clip, { left: entry.frame.left, top: entry.frame.top + top,
            width: entry.frame.width, height: entry.frame.height - top - bottom, opacity: active ? 1 : 0 }]}>
          <View style={{ position: 'absolute', top: -top, width: entry.frame.width, height: entry.frame.height }}>
            <MessageHistoryPositioning.Provider value={active && entry.ready}>
              <MessageHistoryActive.Provider value={active && entry.ready}>{entry.children}</MessageHistoryActive.Provider>
            </MessageHistoryPositioning.Provider>
          </View>
        </View>;
      })}
      {onTaskRoute ? [...overlays].map(([owner, content]) => <View key={owner}
        pointerEvents="box-none" style={StyleSheet.absoluteFill}>{content}</View>) : null}
    </View>
  </Context.Provider>;
}

/** A route publishes current props and a measuring slot; it never owns a list. */
export function RecentMessageHistories({ activeKey, children, topInset = 0, bottomInset = 0, interactive = true, ready = true }: {
  activeKey: string; children: ReactNode; topInset?: number; bottomInset?: number; interactive?: boolean; ready?: boolean;
}) {
  const context = useContext(Context);
  if (!context) throw new Error('RecentMessageHistoriesProvider is missing');
  const { host, publish, release } = context;
  const owner = useId();
  const focused = useIsFocused();
  const navigation = useContext(NavigationContext);
  const route = useContext(NavigationRouteContext);
  const viewport = usePaneViewport();
  const anchor = useRef<View>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const revision = useRef(0);
  const measure = useCallback(() => {
    const version = ++revision.current;
    anchor.current?.measureInWindow((x, y, width, height) => {
      host.current?.measureInWindow((hostX, hostY) => {
        if (version !== revision.current || width <= 0 || height <= 0) return;
        const next = { left: x - hostX, top: y - hostY, width, height };
        setFrame(previous => previous && Object.keys(next).every(k => previous[k as keyof Frame] === next[k as keyof Frame]) ? previous : next);
      });
    });
  }, [host]);
  useLayoutEffect(() => { measure(); return () => { ++revision.current; }; }, [measure, focused, viewport.width, viewport.height]);
  useLayoutEffect(() => () => release(owner), [release, owner]);
  useLayoutEffect(() => {
    if (!frame || needsResidentHistoryUpgrade) return;
    publish({ key: activeKey, owner, frame, focused, ready, topInset, bottomInset, interactive,
      children: <NavigationContext.Provider value={navigation}>
        <NavigationRouteContext.Provider value={route}>
          <PaneViewportProvider value={{ width: viewport.width, height: viewport.height }}>{children}</PaneViewportProvider>
        </NavigationRouteContext.Provider>
      </NavigationContext.Provider> });
  }, [publish, activeKey, owner, frame, focused, ready, topInset, bottomInset, interactive, navigation, route, viewport.width, viewport.height, children]);
  if (needsResidentHistoryUpgrade) return <View style={styles.container}>
    <MessageHistoryActive.Provider value={focused}>{children}</MessageHistoryActive.Provider>
  </View>;
  return <View ref={anchor} collapsable={false} pointerEvents={NativeHistorySlot ? 'auto' : 'none'} onLayout={measure} style={styles.container}>
    {/* Dock retained content immediately. `ready` gates new props and positioning,
        not visibility: a new route starts with unmeasured chrome even on a cache hit. */}
    {NativeHistorySlot ? <NativeHistorySlot surfaceId={context.namespace + activeKey} selected={focused}
      pointerEvents={interactive && ready ? 'auto' : 'none'} style={StyleSheet.absoluteFill} /> : null}
  </View>;
}
const styles = StyleSheet.create({ container: { flex: 1 }, clip: { position: 'absolute', overflow: 'hidden' } });

/** Route-owned drawers must be above the root-owned histories, not beneath them. */
export function MessageHistoryOverlay({ children }: { children: ReactNode }) {
  const context = useContext(Context);
  if (!context) throw new Error('RecentMessageHistoriesProvider is missing');
  const { setOverlay } = context;
  const owner = useId();
  const focused = useIsFocused();
  const navigation = useContext(NavigationContext);
  const route = useContext(NavigationRouteContext);
  useLayoutEffect(() => {
    if (NativeHistorySlot || needsResidentHistoryUpgrade) return;
    setOverlay(owner, focused ? <NavigationContext.Provider value={navigation}>
      <NavigationRouteContext.Provider value={route}>{children}</NavigationRouteContext.Provider>
    </NavigationContext.Provider> : null);
  }, [setOverlay, owner, focused, navigation, route, children]);
  useLayoutEffect(() => () => setOverlay(owner, null), [setOverlay, owner]);
  return NativeHistorySlot || needsResidentHistoryUpgrade ? children : null;
}
