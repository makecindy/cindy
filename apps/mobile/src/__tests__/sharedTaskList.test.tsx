vi.mock('@/session/TaskDrawerPresentation', () => ({ TaskDrawerPresentationProvider: ({ children }: any) => children }));
// @vitest-environment jsdom
// Integration regression: group -> task replaced the whole native sidebar even
// with warm data. Existing drawer tests retained one route, never changed owner.
// Real shared provider/publisher: keep list state, adopt only focused callbacks,
// hide without destroying on other routes, and clear across account boundaries.
import { act, useContext, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NavigationContext, NavigationRouteContext } from 'expo-router/react-navigation';
import { SharedTaskListProvider, SharedTaskListContent } from '@/session/SharedTaskList';
import { SessionDrawerNavigationContext } from '@/session/SessionDrawerNavigationContext';
const state = vi.hoisted(() => ({ segments: ['companions', 'groups', '[groupId]'], persistent: true, mounts: 0, unmounts: 0 }));
vi.mock('react-native', () => ({ View: ({ children, pointerEvents }: any) => <div data-input={pointerEvents}>{children}</div> }));
vi.mock('expo-router', () => ({ useSegments: () => state.segments }));
vi.mock('expo-router/react-navigation', async () => {
  const React = await import('react');
  const NavigationContext = React.createContext<any>(null), NavigationRouteContext = React.createContext<any>(null);
  return { NavigationContext, NavigationRouteContext, useIsFocused: () => React.useContext(NavigationContext).isFocused() };
});
vi.mock('@/session/NativeResidentHistory', () => ({
  NativeTaskDrawerHost: ({ children, surfaceId }: any) => <div data-native-host={surfaceId}>{children}</div>,
  NativeHistorySlot: ({ surfaceId, onDock }: any) => <button data-native-slot={surfaceId} onClick={onDock}>dock</button>,
}));
vi.mock('@/platform/AdaptiveWindowContext', () => ({ useAdaptiveWindow: () => ({ insets: { top: 0, left: 0 } }) }));
vi.mock('@/session/ResidentHomeList', () => ({ LocalHomeList: ({ children }: any) => children, useSessionPaneLayout: () => ({ persistent: state.persistent }) }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: { surface: 'white' } }) }));
const groupAction = vi.fn(() => true), taskAction = vi.fn(() => true);
const groupNav = { isFocused: () => true, addListener: () => () => {} } as any;
const taskNav = { isFocused: () => true, addListener: () => () => {} } as any;
let root: ReturnType<typeof createRoot>, host: HTMLDivElement;
function Home() {
  const [value, setValue] = useState('');
  const action = useContext(SessionDrawerNavigationContext);
  const route = useContext(NavigationRouteContext);
  useEffect(() => { state.mounts++; return () => { state.unmounts++; }; }, []);
  return <><input value={value} onChange={event => setValue(event.target.value)} />
    <button data-select onClick={() => { setValue('kept search'); action?.('/settings'); }}>{route?.name}</button></>;
}
function Owner({ name, active = true, onDock }: { name: 'group' | 'task'; active?: boolean; onDock?: () => void }) {
  const navigation = name === 'group' ? groupNav : taskNav;
  return <NavigationContext.Provider value={navigation}><NavigationRouteContext.Provider value={{ key: name, name }}>
    <SessionDrawerNavigationContext.Provider value={name === 'group' ? groupAction : taskAction}>
      <SharedTaskListContent width={400} height={669} active={active} onDock={onDock}><Home /></SharedTaskListContent>
    </SessionDrawerNavigationContext.Provider>
  </NavigationRouteContext.Provider></NavigationContext.Provider>;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.segments = ['companions', 'groups', '[groupId]']; state.persistent = true; state.mounts = 0; state.unmounts = 0;
  groupNav.isFocused = () => true; taskNav.isFocused = () => true;
  groupAction.mockClear(); taskAction.mockClear(); host = document.createElement('div'); root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));
it('keeps the same sidebar, search and native slot when group and task routes replace each other', () => {
  const show = (name: 'group' | 'task') => act(() => root.render(<SharedTaskListProvider><Owner key={name} name={name} /></SharedTaskListProvider>));
  show('group'); const input = host.querySelector('input')!, slot = host.querySelector('[data-native-slot]');
  act(() => (host.querySelector('[data-select]') as HTMLElement).click());
  show('task');
  expect(host.querySelector('input')).toBe(input); expect(input.value).toBe('kept search');
  expect(host.querySelector('[data-native-slot]')).toBe(slot);
  act(() => (host.querySelector('[data-select]') as HTMLElement).click());
  expect(taskAction).toHaveBeenCalledOnce(); expect(groupAction).toHaveBeenCalledOnce();
  show('group'); expect(state.mounts).toBe(1); expect(state.unmounts).toBe(0);
});
it('ignores a departing route cleanup after its successor has published', () => {
  const show = (old: boolean) => act(() => root.render(<SharedTaskListProvider>
    {old ? <Owner key="group" name="group" /> : null}<Owner key="task" name="task" />
  </SharedTaskListProvider>));
  show(true); show(false);
  expect(host.querySelector('[data-select]')?.textContent).toBe('task');
  expect(host.querySelector('[data-input]')?.getAttribute('data-input')).toBe('auto');
  expect(state.mounts).toBe(1);
});
it('parks the list outside detail routes and acknowledges docking after rotation', () => {
  const onDock = vi.fn();
  const show = () => act(() => root.render(<SharedTaskListProvider><Owner name="group" active={false} onDock={onDock} /></SharedTaskListProvider>));
  show(); const input = host.querySelector('input');
  state.segments = ['settings']; show(); expect(host.querySelector('[data-native-slot]')).toBeNull();
  state.segments = ['sessions', '[sessionId]']; state.persistent = false; show(); expect(host.querySelector('[data-native-slot]')).toBeNull();
  state.persistent = true; show(); act(() => (host.querySelector('[data-native-slot]') as HTMLElement).click());
  expect(onDock).toHaveBeenCalledOnce(); expect(host.querySelector('input')).toBe(input); expect(state.mounts).toBe(1);
});
it('discards the retained list on account replacement', () => {
  const show = (account: string) => act(() => root.render(<SharedTaskListProvider key={account}><Owner name="group" /></SharedTaskListProvider>));
  show('first'); act(() => (host.querySelector('[data-select]') as HTMLElement).click());
  show('second'); expect(host.querySelector('input')?.value).toBe(''); expect(state.mounts).toBe(2); expect(state.unmounts).toBe(1);
});
