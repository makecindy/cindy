vi.mock('@/platform/haptics', () => ({ playHaptic: vi.fn() }));
// @vitest-environment jsdom
// Unit integration: the public drawer coordinator must switch the right-hand
// route before visual exit completion. Beta 37 only tested deferred dispatch.
// Minimal failure: open group drawer, select task, synchronously unmount group.
// Keep one root surface/motion and freeze its props until exit acknowledgment.
import { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NavigationContext, NavigationRouteContext } from 'expo-router/react-navigation';
import { TaskDrawerPresentationProvider, TaskDrawerPresentation } from '@/session/TaskDrawerPresentation';
import { useConversationTaskDrawer } from '@/session/useConversationTaskDrawer';
import { SessionTaskDrawerProvider } from '@/session/SessionTaskDrawer';
const state = vi.hoisted(() => ({ persistent: false, mounts: 0, unmounts: 0, surface: null as any, drawer: null as any }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, BackHandler: { addEventListener: () => ({ remove() {} }) } }));
vi.mock('react-native-reanimated', async () => { const { useState } = await import('react'); return { useSharedValue: (value: any) => useState(() => ({ value }))[0], cancelAnimation: () => {} }; });
vi.mock('expo-router/react-navigation', async () => { const React = await import('react');
  const NavigationContext = React.createContext<any>(null), NavigationRouteContext = React.createContext<any>(null);
  return { NavigationContext, NavigationRouteContext, useIsFocused: () => React.useContext(NavigationContext).isFocused() };
});
vi.mock('@/session/NativeResidentHistory', () => ({ NativeTaskDrawerHost: () => null, NativeHistorySlot: () => null }));
vi.mock('@/session/ResidentHomeList', () => ({ useSessionPaneLayout: () => ({ persistent: state.persistent, sidebarWidth: 400 }) }));
vi.mock('@/session/RecentMessageHistories', () => ({ MessageHistoryOverlay: ({ children }: any) => children }));
vi.mock('@/session/SessionListDrawer', () => ({ useSessionListDrawerMotion: () => ({}), useSessionListDrawerOpenGesture: () => ({}) }));
const navigation = { isFocused: () => true } as any;
let root: ReturnType<typeof createRoot>, host: HTMLDivElement, change: (name: string) => void;
function Surface(props: any) {
  state.surface = props;
  useEffect(() => { state.mounts++; return () => { state.unmounts++; }; }, []);
  return <div data-surface data-open={props.open}>{props.name}</div>;
}
function Owner({ name }: { name: string }) {
  const drawer = useConversationTaskDrawer({ enabled: true, persistent: state.persistent, width: 400 });
  state.drawer = drawer;
  return <TaskDrawerPresentation element={<Surface name={name} width={400} open={state.persistent || drawer.sessionListDrawerOpen}
    persistent={state.persistent} onClosed={drawer.handleSessionListDrawerClosed} motion={drawer.sessionListDrawerMotion} />} />;
}
function App({ account = 'one' }: { account?: string }) {
  const [name, setName] = useState('group'); change = setName;
  return <TaskDrawerPresentationProvider key={account}>
    <div data-detail>{name}</div>
    <NavigationContext.Provider value={navigation}><NavigationRouteContext.Provider value={{ key: name, name }}>
      <Owner key={name} name={name} />
    </NavigationRouteContext.Provider></NavigationContext.Provider>
  </TaskDrawerPresentationProvider>;
}
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.persistent = false; state.mounts = 0; state.unmounts = 0;
  host = document.createElement('div'); root = createRoot(host);
  act(() => root.render(<App />));
});
afterEach(() => act(() => root.unmount()));
it('switches immediately while the same floating surface finishes its exit after its route unmounts', () => {
  act(() => state.drawer.openSessionListDrawer());
  const element = host.querySelector('[data-surface]'), motion = state.surface.motion;
  const oldDrawer = state.drawer;
  const selected = vi.fn(() => change('task')), duplicate = vi.fn();
  act(() => { oldDrawer.queueDrawerNavigation(selected); oldDrawer.queueDrawerNavigation(duplicate); });
  expect(selected).toHaveBeenCalledOnce(); expect(duplicate).not.toHaveBeenCalled();
  expect(host.querySelector('[data-detail]')?.textContent).toBe('task');
  expect(host.querySelector('[data-surface]')).toBe(element);
  expect(state.surface.name).toBe('group'); expect(state.surface.open).toBe(false);
  expect(state.surface.retainPresentation).toBe(true);
  const finish = state.surface.onClosed;
  act(() => state.drawer.queueDrawerNavigation(duplicate));
  expect(duplicate).not.toHaveBeenCalled();
  act(() => finish());
  expect(state.surface.name).toBe('task'); expect(state.surface.motion).toBe(motion);
  expect(state.mounts).toBe(1); expect(state.unmounts).toBe(0);
  act(() => finish()); expect(selected).toHaveBeenCalledOnce();
  act(() => state.drawer.openSessionListDrawer()); expect(state.surface.open).toBe(true);
});
it('does not queue an action on the visual completion for an in-place task switch', () => {
  act(() => state.drawer.openSessionListDrawer()); const selected = vi.fn();
  act(() => state.drawer.queueDrawerNavigation(selected)); expect(selected).toHaveBeenCalledOnce();
  act(() => state.surface.onClosed()); expect(selected).toHaveBeenCalledOnce();
  expect(state.drawer.sessionListDrawerOverlayMounted).toBe(false);
});
it('docks an exit interrupted by rotation without dispatching the destination a second time', () => {
  act(() => state.drawer.openSessionListDrawer()); const selected = vi.fn(() => change('task'));
  act(() => state.drawer.queueDrawerNavigation(selected));
  state.persistent = true; act(() => root.render(<App />));
  expect(state.surface.persistent).toBe(true); expect(state.surface.open).toBe(true);
  act(() => state.surface.onColumnReady());
  expect(selected).toHaveBeenCalledOnce(); expect(state.surface.name).toBe('task');
});
it('drops the old presentation on account change and ignores its late completion', () => {
  act(() => state.drawer.openSessionListDrawer());
  act(() => state.drawer.queueDrawerNavigation(() => change('task')));
  const finish = state.surface.onClosed;
  act(() => root.render(<App account="two" />)); const surface = host.querySelector('[data-surface]');
  act(() => finish()); expect(host.querySelector('[data-surface]')).toBe(surface);
  expect(state.surface.name).toBe('task'); expect(state.surface.open).toBe(false);
});
it('keeps the floating drawer visible when the layout re-renders without a shared native drawer', () => {
  // Drag-resize re-renders the layout; its closed column must not publish over the route's open drawer.
  const Column = ({ persistent }: { persistent: boolean; width: number }) =>
    <TaskDrawerPresentation element={<Surface name="column" width={0} open={persistent} persistent={persistent} />} />;
  const Layout = ({ width }: { width: number }) => <SessionTaskDrawerProvider enabled={false} focused windowHeight={900}
    topInset={0} floatingWidth={width} column={<Column persistent={false} width={width} />}>
    <NavigationContext.Provider value={navigation}><NavigationRouteContext.Provider value={{ key: 'group', name: 'group' }}>
      <Owner name="group" />
    </NavigationRouteContext.Provider></NavigationContext.Provider>
  </SessionTaskDrawerProvider>;
  const Page = ({ width }: { width: number }) => <TaskDrawerPresentationProvider><Layout width={width} /></TaskDrawerPresentationProvider>;
  act(() => root.render(<Page width={400} />));
  act(() => state.drawer.openSessionListDrawer());
  act(() => root.render(<Page width={440} />));
  expect(state.surface.name).toBe('group'); expect(state.surface.open).toBe(true);
});
