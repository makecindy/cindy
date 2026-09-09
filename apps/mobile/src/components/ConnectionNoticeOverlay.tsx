import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { spacing } from '@/theme/tokens';
import { scheduleConnectionNotice } from './connectionNoticeDelay';

/** Each continuous incident gets one delay; clearing it cancels pending display. */
export function useDelayedConnectionNotice(active: boolean): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!active) { setReady(false); return; }
    return scheduleConnectionNotice(() => setReady(true));
  }, [active]);
  return active && ready;
}

type Notice = { top: number; children: ReactNode };
const NoticeContext = createContext<{ publish: (id: string, notice: Notice | null) => void; host: RefObject<View | null> } | null>(null);

/** Render outside clipped headers, with real touch bounds and no modal input capture. */
export function ConnectionNoticeProvider({ children }: { children: ReactNode }) {
  const host = useRef<View>(null);
  const [notices, setNotices] = useState(new Map<string, Notice>());
  const publish = useCallback((id: string, notice: Notice | null) => {
    setNotices((current) => {
      if (!notice && !current.has(id)) return current;
      const next = new Map(current);
      if (notice) next.set(id, notice); else next.delete(id);
      return next;
    });
  }, []);
  const value = useMemo(() => ({ publish, host }), [publish]);
  return <NoticeContext.Provider value={value}>
    <View ref={host} collapsable={false} style={styles.host}>
      {children}
      <View pointerEvents="box-none" style={styles.layer}>
        {[...notices].map(([id, notice]) => <View key={id} style={[styles.overlay, { top: notice.top }]}>{notice.children}</View>)}
      </View>
    </View>
  </NoticeContext.Provider>;
}

/** Only the zero-height measuring anchor participates in the screen layout. */
export function ConnectionNoticeOverlay({ children }: { children: ReactNode }) {
  const context = useContext(NoticeContext);
  const id = useId();
  const anchor = useRef<View>(null);
  const [top, setTop] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => setFocused(false);
  }, []));
  const { width, height } = useWindowDimensions();
  const measure = useCallback(() => {
    if (context?.host.current) anchor.current?.measureLayout(context.host.current, (_x, y) => setTop(y + spacing.sm));
  }, [context]);
  useEffect(() => { measure(); }, [measure, width, height, focused]);
  useEffect(() => {
    if (focused && top !== null) context?.publish(id, { top, children });
    else context?.publish(id, null);
    return () => context?.publish(id, null);
  }, [children, focused, id, context, top]);
  return <View ref={anchor} collapsable={false} pointerEvents="none" onLayout={measure} style={styles.anchor} />;
}

const styles = StyleSheet.create({
  host: { flex: 1 },
  layer: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, zIndex: 20 },
  anchor: { height: 0 },
  overlay: { position: 'absolute', left: spacing.md, right: spacing.md },
});
