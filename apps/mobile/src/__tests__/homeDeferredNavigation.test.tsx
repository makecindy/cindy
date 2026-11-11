import { taskListScreenAnimation, inheritTaskListEntry } from '@/session/taskListNavigationPolicy';
import { SessionDrawerNavigationContext, TaskListTransitionContext, useTaskListTransition } from '@/session/SessionDrawerNavigationContext';
// @vitest-environment jsdom
import { act, useContext, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NavigationContext } from 'expo-router/react-navigation';
import { HomePresentationFocus } from '@/session/HomePresentationFocus';
import { useTaskListNavigation } from '@/session/useTaskListNavigation';
import { forwardNavigationLock } from '@/utils/navigationLock';
const state = vi.hoisted(() => ({ focused: true, push: vi.fn() }));
vi.mock('expo-router/react-navigation', async () => ({ NavigationContext: (await import('react')).createContext(null) }));
vi.mock('expo-router', () => ({ useNavigation: () => useContext(NavigationContext),
  useRouter: () => ({ push: state.push }), useFocusEffect: (effect: any) => useEffect(effect, [effect]) }));
let root: ReturnType<typeof createRoot>, push: ReturnType<typeof useTaskListNavigation>, visible: boolean;
const navigation = { isFocused: () => state.focused, addListener: () => () => {}, setOptions: vi.fn(), getState: () => undefined } as any;
function Probe() { push = useTaskListNavigation({ sidebar: false }); visible = useContext(NavigationContext)!.isFocused(); return null; }
function render(active: boolean) { act(() => root.render(<NavigationContext.Provider value={navigation}>
  <HomePresentationFocus active={active}><Probe /></HomePresentationFocus></NavigationContext.Provider>)); }
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; state.focused = true; state.push.mockClear(); navigation.setOptions.mockClear(); forwardNavigationLock.reset(); root = createRoot(document.createElement('div')); });
afterEach(() => act(() => root.unmount()));
it('allows a queued companion navigation after the retained list hides', () => {
  render(true); const queued = () => push('/companions/groups/group-1'); render(false);
  act(queued); expect(state.push).toHaveBeenCalledTimes(1);
  act(queued); expect(state.push).toHaveBeenCalledTimes(1);
});
it('still rejects navigation when the owning conversation really loses focus', () => {
  render(true); render(false); state.focused = false;
  act(() => push('/companions/groups/group-1')); expect(state.push).not.toHaveBeenCalled();
});

it('dispatches a retained drawer destination once after closing, with ordinary push fallback', () => {
  const handle = vi.fn((href: unknown) => typeof href === 'object');
  act(() => root.render(<NavigationContext.Provider value={navigation}>
    <SessionDrawerNavigationContext.Provider value={handle}>
      <HomePresentationFocus active={false}><Probe /></HomePresentationFocus>
    </SessionDrawerNavigationContext.Provider>
  </NavigationContext.Provider>));
  const target = { pathname: '/sessions/[sessionId]' as const, params: { sessionId: 'next', deviceId: 'host' } };
  act(() => { push(target); push(target); });
  expect(handle).toHaveBeenCalledExactlyOnceWith(target);
  expect(state.push).not.toHaveBeenCalled();
  forwardNavigationLock.reset();
  act(() => push('/settings'));
  expect(state.push).toHaveBeenCalledExactlyOnceWith('/settings');
  forwardNavigationLock.reset(); state.focused = false;
  act(() => push(target));
  expect(handle).toHaveBeenCalledTimes(2);
});

// Integration: the Home opt-in dispatches the retained route after hiding;
// ordinary message links must continue to push the same URL normally.
it('reuses a group only for Home navigation and preserves ordinary link behavior', () => {
  const href = { pathname: '/companions/groups/[groupId]' as const, params: { deviceId: 'mac', groupId: 'group' } };
  const stack = { stale: false, type: 'stack', key: 'root', index: 2, routeNames: ['index', 'companions/groups/[groupId]', 'sessions/[sessionId]'], routes: [
    { key: 'home', name: 'index' },
    { key: 'group-live', name: 'companions/groups/[groupId]', params: href.params },
    { key: 'task', name: 'sessions/[sessionId]', params: { deviceId: 'mac', sessionId: 'task' } },
  ] };
  const dispatch = vi.fn();
  const owner = { ...navigation, getState: () => stack, dispatch };
  function HomeProbe({ reuse }: { reuse: boolean }) { push = useTaskListNavigation({ sidebar: reuse }); return null; }
  const renderProbe = (reuse: boolean) => act(() => root.render(<NavigationContext.Provider value={owner}>
    <HomePresentationFocus active={false}><HomeProbe reuse={reuse} /></HomePresentationFocus>
  </NavigationContext.Provider>));
  renderProbe(true);
  act(() => { push(href); push(href); });
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch.mock.calls[0][0]).toMatchObject({ type: 'RESET', payload: { index: 1, routes: stack.routes.slice(0, 2) } });
  expect(state.push).not.toHaveBeenCalled();
  forwardNavigationLock.reset(); renderProbe(false);
  act(() => push(href));
  expect(state.push).toHaveBeenCalledExactlyOnceWith(href);
});

// Component regression: a sidebar group selection used normal native PUSH/POP,
// so the whole conversation slid in. Existing tests only checked the route key.
it('commits instant native options before a cold group switch and restores ordinary links after completion', () => {
  const frames: FrameRequestCallback[] = [];
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  let transition: ReturnType<typeof useTaskListTransition>;
  function HomeProbe() { push = useTaskListNavigation({ sidebar: true }); return null; }
  function StackProbe() {
    transition = useTaskListTransition();
    return <TaskListTransitionContext.Provider value={transition.run}><HomeProbe /></TaskListTransitionContext.Provider>;
  }
  try {
    act(() => root.render(<NavigationContext.Provider value={navigation}><StackProbe /></NavigationContext.Provider>));
    const group = { pathname: '/companions/groups/[groupId]' as const, params: { groupId: 'group', deviceId: 'mac' } };
    act(() => { push(group); push(group); });
    expect(transition!.instant).toBe(true);
    expect(state.push).not.toHaveBeenCalled();
    act(() => transition!.finish()); // An older route's completion cannot cancel the queued selection.
    expect(transition!.instant).toBe(true);
    act(() => frames.shift()!(0));
    expect(state.push).toHaveBeenCalledExactlyOnceWith({ ...group, params: { ...group.params, taskListEntry: 'sidebar' } });
    act(() => transition!.finish());
    expect(transition!.instant).toBe(false);
    forwardNavigationLock.reset();
    act(() => push('/settings'));
    expect(state.push).toHaveBeenLastCalledWith('/settings');
    expect(transition!.instant).toBe(false);
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});

it('cancels a task-list switch that loses its route owner during the options commit', () => {
  const frames: FrameRequestCallback[] = [];
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  let transition: ReturnType<typeof useTaskListTransition>;
  function HomeProbe() { push = useTaskListNavigation({ sidebar: true }); return null; }
  function StackProbe() {
    transition = useTaskListTransition();
    return <TaskListTransitionContext.Provider value={transition.run}><HomeProbe /></TaskListTransitionContext.Provider>;
  }
  try {
    act(() => root.render(<NavigationContext.Provider value={navigation}><StackProbe /></NavigationContext.Provider>));
    act(() => push({ pathname: '/companions/groups/[groupId]', params: { groupId: 'group' } }));
    state.focused = false;
    act(() => frames.shift()!(0));
    expect(state.push).not.toHaveBeenCalled();
    act(() => vi.runAllTimers());
    expect(transition!.instant).toBe(false);
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});

it('accepts the next peer after the navigation state commit without waiting for transitionEnd or a timer', () => {
  const frames: FrameRequestCallback[] = [];
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  let transition: ReturnType<typeof useTaskListTransition>;
  function Probe() { transition = useTaskListTransition(); push = useTaskListNavigation({ sidebar: true });
    return <TaskListTransitionContext.Provider value={transition.run}><Child /></TaskListTransitionContext.Provider>; }
  function Child() { push = useTaskListNavigation({ sidebar: true }); return null; }
  try {
    act(() => root.render(<NavigationContext.Provider value={navigation}><Probe /></NavigationContext.Provider>));
    const first = { pathname: '/companions/groups/[groupId]' as const, params: { groupId: 'first' } };
    const second = { pathname: '/companions/cloud/[actorId]' as const, params: { actorId: 'second' } };
    act(() => push(first));
    act(() => frames.shift()!(0));
    // Root Stack's `state` event: animation:none may never emit transitionEnd.
    act(() => transition!.finish());
    act(() => push(second));
    act(() => frames.shift()!(1));
    expect(state.push.mock.calls).toEqual([first, second].map(href => [{ ...href, params: { ...href.params, taskListEntry: 'sidebar' } }]));
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});

it.each(['/sessions/[sessionId]', '/companions/cloud/[actorId]', '/companions/groups/[groupId]'])(
  'preserves native entry animation for single-column %s', pathname => {
    const instant = vi.fn();
    function SingleColumnHome() { push = useTaskListNavigation({ sidebar: false }); return null; }
    act(() => root.render(<NavigationContext.Provider value={navigation}>
      <TaskListTransitionContext.Provider value={instant}><SingleColumnHome /></TaskListTransitionContext.Provider>
    </NavigationContext.Provider>));
    const href = { pathname, params: { deviceId: 'mac', sessionId: 'task', actorId: 'peer', groupId: 'group' } } as any;
    act(() => push(href));
    expect(state.push).toHaveBeenCalledExactlyOnceWith(href);
    expect(instant).not.toHaveBeenCalled();
  });

// Regression: JS `state` finished before native PUSH mounted the teammate. The
// transient flag was already false, so floating group -> teammate slid in again.
const destinations = [
  { pathname: '/sessions/[sessionId]', params: { deviceId: 'mac', sessionId: 'task' } },
  { pathname: '/sessions/[sessionId]', params: { deviceId: 'mac', sessionId: 'peer', resourceId: 'peer', resourceKind: 'bot', resourceCollectionId: 'teammates' } },
  { pathname: '/companions/groups/[groupId]', params: { deviceId: 'mac', groupId: 'group' } },
  { pathname: '/companions/cloud/[actorId]', params: { deviceId: 'mac', actorId: 'cloud' } },
  { pathname: '/resources/[collectionId]/[resourceId]', params: { deviceId: 'mac', resourceKind: 'bot', collectionId: 'teammates', resourceId: 'unresolved' } },
];
it.each(destinations)('keeps sidebar entry motion after early state completion: $pathname $params', href => {
  const frames: FrameRequestCallback[] = [];
  vi.useFakeTimers(); vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  let transition: ReturnType<typeof useTaskListTransition>;
  function Child() { push = useTaskListNavigation({ sidebar: true }); return null; }
  function Stack() { transition = useTaskListTransition(); return <TaskListTransitionContext.Provider value={transition.run}>
    <HomePresentationFocus active={false}><Child /></HomePresentationFocus></TaskListTransitionContext.Provider>; }
  try {
    act(() => root.render(<NavigationContext.Provider value={navigation}><Stack /></NavigationContext.Provider>));
    act(() => push(href as any));
    expect(navigation.setOptions).toHaveBeenCalledExactlyOnceWith({ animation: 'none' });
    act(() => frames.shift()!(0));
    act(() => transition!.finish({ type: 'state' }));
    expect(transition!.instant).toBe(false);
    const dispatched = state.push.mock.calls[0][0];
    expect(taskListScreenAnimation(dispatched.params, transition!.instant)).toBe('none');
    // The final task after an asynchronous resource resolution must preserve entry motion.
    const resolved = inheritTaskListEntry({ pathname: '/sessions/[sessionId]', params: { sessionId: 'resolved', deviceId: 'mac' } }, dispatched.params) as { params: object };
    expect(resolved.params).toEqual({ sessionId: 'resolved', deviceId: 'mac', taskListEntry: 'sidebar' });
    expect(taskListScreenAnimation(resolved.params)).toBe('none');
    expect(taskListScreenAnimation({ sessionId: 'ordinary-message-link' })).toBe('default');
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});
it.each(destinations)('keeps single-column native entry: $pathname $params', href => {
  function Child() { push = useTaskListNavigation({ sidebar: false }); return null; }
  act(() => root.render(<NavigationContext.Provider value={navigation}><Child /></NavigationContext.Provider>));
  act(() => push(href as any));
  expect(state.push).toHaveBeenCalledExactlyOnceWith(href);
  expect(navigation.setOptions).not.toHaveBeenCalled();
  expect(taskListScreenAnimation(state.push.mock.calls[0][0].params)).toBe('default');
});

// Integration: the public entry now owns drawer exit scheduling; earlier tests
// manually ran the action after hiding and could miss a dispatch before close.
// Minimal case: choose a group, hide Home, then finish drawer exit (no real timer).
it('waits for drawer exit, then dispatches once using the live route owner', () => {
  const queued: Array<() => void> = [];
  function List() { push = useTaskListNavigation({ sidebar: true, runNavigation: action => queued.push(action) }); return null; }
  const show = (active: boolean) => act(() => root.render(<NavigationContext.Provider value={navigation}>
    <HomePresentationFocus active={active}><List /></HomePresentationFocus></NavigationContext.Provider>));
  const href = { pathname: '/companions/groups/[groupId]' as const, params: { groupId: 'next' } };
  show(true);
  act(() => push(href));
  expect(state.push).not.toHaveBeenCalled();
  show(false);
  act(() => { queued[0](); queued[0](); });
  expect(state.push).toHaveBeenCalledExactlyOnceWith({ ...href, params: { ...href.params, taskListEntry: 'sidebar' } });
});
