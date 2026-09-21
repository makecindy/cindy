import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { spacing } from '@/theme/tokens';
import { updateConnectionNoticeVisibility } from './connectionNoticeDelay';

/** Each continuous incident gets one delay; clearing it cancels pending display. */
export function useDelayedConnectionNotice(active: boolean, immediate = false): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    return updateConnectionNoticeVisibility(active, ready, setReady, immediate);
  }, [active, ready, immediate]);
  return active && (immediate || ready);
}

type NoticeFrame = { top: number; left: number; width: number };
type Notice = NoticeFrame & { children: ReactNode };
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
        {[...notices].map(([id, notice]) => <View key={id} pointerEvents="box-none" style={[styles.overlay, { top: notice.top, left: notice.left, width: notice.width }]}>{notice.children}</View>)}
      </View>
    </View>
  </NoticeContext.Provider>;
}

/** Only the zero-height measuring anchor participates in the screen layout. */
export function ConnectionNoticeOverlay({ children }: { children: ReactNode }) {
  const context = useContext(NoticeContext);
  const id = useId();
  const anchor = useRef<View>(null);
  const [frame, setFrame] = useState<NoticeFrame | null>(null);
  const [focused, setFocused] = useState(false);
  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => setFocused(false);
  }, []));
  const { width, height } = useWindowDimensions();
  const measure = useCallback(() => {
    if (context?.host.current) anchor.current?.measureLayout(context.host.current, (x, y, width) => {
      const next = { top: y + spacing.sm, left: x + spacing.md, width: Math.max(0, width - spacing.md * 2) };
      setFrame(previous => previous?.top === next.top && previous.left === next.left && previous.width === next.width ? previous : next);
    });
  }, [context]);
  useEffect(() => { measure(); }, [measure, width, height, focused]);
  useEffect(() => {
    if (focused && frame !== null) context?.publish(id, { ...frame, children });
    else context?.publish(id, null);
    return () => context?.publish(id, null);
  }, [children, focused, id, context, frame]);
  return <View ref={anchor} collapsable={false} pointerEvents="none" onLayout={measure} style={styles.anchor} />;
}

const styles = StyleSheet.create({
  host: { flex: 1 },
  layer: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, zIndex: 20 },
  anchor: { height: 0 },
  overlay: { position: 'absolute' },
});
