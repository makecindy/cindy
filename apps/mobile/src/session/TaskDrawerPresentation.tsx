import { cloneElement, createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { NavigationContext, NavigationRouteContext, useIsFocused } from 'expo-router/react-navigation';
import { useSharedValue } from 'react-native-reanimated';
import { NavigationActionContext } from '@/utils/NavigationActionContext';
import { SessionDrawerNavigationContext } from './SessionDrawerNavigationContext';
import { NativeTaskDrawerHost, NativeHistorySlot } from './NativeResidentHistory';
import { useSessionPaneLayout } from './ResidentHomeList';
import { MessageHistoryOverlay } from './RecentMessageHistories';
import type { SessionListDrawerMotion } from './SessionListDrawer';

type SurfaceProps = {
  open: boolean; persistent?: boolean; width: number; topInset?: number;
  onClosed?(): void; onColumnReady?(): void; retainPresentation?: boolean;
};
type Entry = {
  owner: string; element: ReactElement<SurfaceProps>;
  navigation: React.ContextType<typeof NavigationContext>;
  route: React.ContextType<typeof NavigationRouteContext>;
  action: React.ContextType<typeof NavigationActionContext>;
  handleHref: React.ContextType<typeof SessionDrawerNavigationContext>;
};
const Context = createContext<{
  motion: SessionListDrawerMotion;
  publish(entry: Entry): void;
  release(owner: string): void;
  /** True means the root retained the exit and dispatched the destination now. */
  navigate(action: () => void): boolean;
  isExiting(): boolean;
} | null>(null);

/** Own the floating window and its animation above native routes. Switching a
 * conversation cannot unmount an exiting Modal, gesture tree or shared value. */
export function TaskDrawerPresentationProvider({ children }: { children: ReactNode }) {
  const progress = useSharedValue(0), dragX = useSharedValue(0);
  const tracking = useSharedValue(false), settling = useSharedValue(false);
  const motion = useMemo(() => ({ progress, dragX, tracking, settling }), [progress, dragX, tracking, settling]);
  const [entry, setEntry] = useState<Entry | null>(null);
  const current = useRef<Entry | null>(null);
  const pending = useRef<Entry | null>(null);
  const exit = useRef<Entry | null>(null);
  const [exiting, setExiting] = useState(false);
  useLayoutEffect(() => () => { exit.current = null; pending.current = null; current.current = null; }, []);
  const isExiting = useCallback(() => exit.current !== null, []);
  const pane = useSessionPaneLayout();
  const publish = useCallback((next: Entry) => {
    if (exit.current) { pending.current = next; return; }
    current.current = next;
    setEntry(next);
  }, []);
  const release = useCallback((owner: string) => {
    if (exit.current) {
      if (pending.current?.owner === owner) pending.current = null;
      return;
    }
    if (current.current?.owner !== owner) return;
    current.current = null;
    setEntry(null);
  }, []);
  const navigate = useCallback((action: () => void) => {
    if (exit.current) return true; // First intention owns the entire exit.
    const source = current.current;
    if (!source || source.element.props.persistent || !source.element.props.open) return false;
    exit.current = source;
    pending.current = { ...source, element: cloneElement(source.element, { open: false }) };
    setExiting(true);
    // Navigation and the visual close are independent. No timer, completion
    // callback or unmount commit gates the destination anymore.
    action();
    return true;
  }, []);
  const finish = useCallback(() => {
    const source = exit.current;
    if (!source) return;
    exit.current = null;
    const next = pending.current;
    pending.current = null;
    current.current = next;
    setEntry(next);
    setExiting(false);
    source.element.props.onClosed?.();
  }, []);
  const context = useMemo(() => ({ motion, publish, release, navigate, isExiting }), [motion, publish, release, navigate, isExiting]);
  const supported = !!NativeTaskDrawerHost && !!NativeHistorySlot;
  const surface = useMemo(() => entry && (exiting ? cloneElement(entry.element, {
    open: pane.persistent, persistent: pane.persistent,
    ...(pane.persistent ? { width: pane.sidebarWidth, topInset: undefined } : {}),
    retainPresentation: true, onClosed: finish, onColumnReady: pane.persistent ? finish : undefined,
  }) : entry.element), [entry, exiting, pane.persistent, pane.sidebarWidth, finish]);
  return <Context.Provider value={supported ? context : null}>
    {children}
    {supported && entry ? <NavigationContext.Provider value={entry.navigation}>
      <NavigationRouteContext.Provider value={entry.route}>
        <NavigationActionContext.Provider value={entry.action}>
          <SessionDrawerNavigationContext.Provider value={entry.handleHref}>
            <MessageHistoryOverlay enabled={false}>{surface}</MessageHistoryOverlay>
          </SessionDrawerNavigationContext.Provider>
        </NavigationActionContext.Provider>
      </NavigationRouteContext.Provider>
    </NavigationContext.Provider> : null}
  </Context.Provider>;
}

export function useTaskDrawerPresentation() { return useContext(Context); }

/** Publish the focused route's controls; the root keeps the actual surface. */
export function TaskDrawerPresentation({ element }: { element: ReactElement<SurfaceProps> }) {
  const context = useTaskDrawerPresentation();
  const owner = useId();
  const focused = useIsFocused();
  const navigation = useContext(NavigationContext), route = useContext(NavigationRouteContext);
  const action = useContext(NavigationActionContext), handleHref = useContext(SessionDrawerNavigationContext);
  useLayoutEffect(() => {
    if (focused) context?.publish({ owner, element, navigation, route, action, handleHref });
  }, [context, owner, focused, element, navigation, route, action, handleHref]);
  useLayoutEffect(() => {
    if (!focused) context?.release(owner);
    return () => context?.release(owner);
  }, [context, owner, focused]);
  return null;
}
