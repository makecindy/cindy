import { TaskDrawerPresentationProvider } from './TaskDrawerPresentation';
import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { useSegments } from 'expo-router';
import { NavigationContext, NavigationRouteContext, useIsFocused } from 'expo-router/react-navigation';
import { useAdaptiveWindow } from '@/platform/AdaptiveWindowContext';
import { NavigationActionContext } from '@/utils/NavigationActionContext';
import { useTheme } from '@/theme';
import { HomePresentationFocus } from './HomePresentationFocus';
import { NativeTaskDrawerHost, NativeHistorySlot } from './NativeResidentHistory';
import { LocalHomeList, useSessionPaneLayout } from './ResidentHomeList';
import { SessionDrawerNavigationContext } from './SessionDrawerNavigationContext';

type Entry = {
  owner: string; width: number; height: number; active: boolean; children: ReactNode; onDock?: () => void;
  navigation: React.ContextType<typeof NavigationContext>;
  route: React.ContextType<typeof NavigationRouteContext>;
  actionNavigation: React.ContextType<typeof NavigationActionContext>;
  handleHref: React.ContextType<typeof SessionDrawerNavigationContext>;
};
const Context = createContext<{
  surfaceId: string;
  publish(entry: Entry): void;
  release(owner: string): void;
} | null>(null);

/** One native Home per account, above task/group route lifetimes. Persistent
 * columns dock here too, so a new native Screen never covers the list with an
 * empty slot. Floating drawers supply their own slot in the Modal as before. */
export function SharedTaskListProvider({ children }: { children: ReactNode }) {
  const surfaceId = `shared-task-list:${useId()}`;
  const [entry, setEntry] = useState<Entry | null>(null);
  const geometry = useAdaptiveWindow();
  const { persistent } = useSessionPaneLayout();
  const segments = useSegments() as string[];
  const detail = segments[0] === 'sessions' && segments[1] === '[sessionId]'
    || segments[0] === 'companions' && segments[1] === 'groups' && segments[2] === '[groupId]';
  const column = persistent && detail;
  const { colors } = useTheme();
  const publish = useCallback((next: Entry) => setEntry(next), []);
  // Retain the last tree during blur/unmount -> focus/mount handoff. A delayed
  // departure cannot clear the new owner's props or navigation authority.
  const release = useCallback((owner: string) => setEntry(current =>
    current?.owner === owner && current.active ? { ...current, active: false } : current), []);
  const context = useMemo(() => ({ surfaceId, publish, release }), [surfaceId, publish, release]);
  const supported = !!NativeTaskDrawerHost && !!NativeHistorySlot;
  return <Context.Provider value={supported ? context : null}>
    <TaskDrawerPresentationProvider>{children}
    {supported && entry && NativeTaskDrawerHost && NativeHistorySlot ? <>
      <NativeTaskDrawerHost surfaceId={surfaceId} pointerEvents="none" accessibilityElementsHidden
        style={{ position: 'absolute', width: entry.width, height: entry.height }}>
        <NavigationContext.Provider value={entry.navigation}><NavigationRouteContext.Provider value={entry.route}>
          <NavigationActionContext.Provider value={entry.actionNavigation}>
            <SessionDrawerNavigationContext.Provider value={entry.handleHref}>
              <LocalHomeList><HomePresentationFocus active={entry.active}>{entry.children}</HomePresentationFocus></LocalHomeList>
            </SessionDrawerNavigationContext.Provider>
          </NavigationActionContext.Provider>
        </NavigationRouteContext.Provider></NavigationContext.Provider>
      </NativeTaskDrawerHost>
      {column ? <View pointerEvents={entry.active ? 'auto' : 'none'}
        accessibilityElementsHidden={!entry.active}
        style={{ position: 'absolute', left: 0, top: 0, bottom: 0,
          width: entry.width + geometry.insets.left, paddingLeft: geometry.insets.left, paddingTop: geometry.insets.top,
          backgroundColor: colors.surface }}>
        <NativeHistorySlot surfaceId={surfaceId} selected onDock={entry.onDock} style={{ flex: 1 }} />
      </View> : null}
    </> : null}
    </TaskDrawerPresentationProvider>
  </Context.Provider>;
}

export function useSharedTaskList() { return useContext(Context); }

/** Bridge the focused route's callbacks/contexts into the single retained tree.
 * The children element changes props, not its key/type, across route owners. */
export function SharedTaskListContent({ width, height, active, children, onDock, retainPresentation = false }: {
  width: number; height: number; active: boolean; children: ReactNode; onDock?: () => void; retainPresentation?: boolean;
}) {
  const context = useSharedTaskList();
  const owner = useId();
  const focused = useIsFocused();
  const navigation = useContext(NavigationContext);
  const route = useContext(NavigationRouteContext);
  const actionNavigation = useContext(NavigationActionContext);
  const handleHref = useContext(SessionDrawerNavigationContext);
  useLayoutEffect(() => {
    if (!focused && !retainPresentation) return;
    context?.publish({ owner, width, height, active, children, onDock, navigation, route, actionNavigation, handleHref });
  }, [context, owner, focused, retainPresentation, width, height, active, children, onDock, navigation, route, actionNavigation, handleHref]);
  useLayoutEffect(() => {
    if (!focused) context?.release(owner);
    return () => context?.release(owner);
  }, [context, owner, focused]);
  return null;
}
