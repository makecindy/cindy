// @vitest-environment jsdom
import { act, createContext, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
const state = vi.hoisted(() => ({ focused: true, onTask: true, width: 390, height: 844, native: false, upgrade: false, requireAncestor: false, residentEnabled: true, reduceMotion: true }));
vi.mock('@/session/NativeResidentHistory', () => {
  const Host = ({ children, surfaceId }: { children: ReactNode; surfaceId: string }) => <div data-host={surfaceId}>{children}</div>;
  const Slot = ({ surfaceId, selected }: { surfaceId: string; selected: boolean }) => <div data-slot={surfaceId} data-selected={selected} />;
  return { get NativeHistoryHost() { return state.native ? Host : null; },
    get NativeHistorySlot() { return state.native ? Slot : null; },
    get needsResidentHistoryUpgrade() { return state.upgrade; } };
});
vi.mock('expo-router', () => ({ useSegments: () => state.onTask ? ['sessions', '[sessionId]'] : ['index'] }));
vi.mock('expo-router/react-navigation', () => ({ useIsFocused: () => state.focused,
  NavigationContext: createContext(null), NavigationRouteContext: createContext(null) }));
vi.mock('@/platform/AdaptiveWindowContext', () => ({
  usePaneViewport: () => ({ width: state.width, height: state.height }),
  useAdaptiveWindow: () => ({ width: state.width, height: state.height }),
  PaneViewportProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/session/useHomeMode', () => ({ useHomeMode: () => ({ mode: 'tasks' }) }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => state.reduceMotion }));
vi.mock('@/session/sessionPaneLayout', () => ({ sessionPaneLayout: () => ({ persistent: state.residentEnabled }) }));
vi.mock('@/session/remoteSessionStore', () => ({
  RemoteSessionStoreSubscriptionGate: ({ children, enabled }: { children: ReactNode; enabled: boolean }) =>
    <div data-store-gate={String(enabled)}>{children}</div>,
}));
vi.mock('react-native-reanimated', () => ({
  useSharedValue: (value: number) => useRef({ value }).current,
  useAnimatedStyle: (factory: () => unknown) => factory(),
  cancelAnimation: () => {}, withSpring: (target: number) => target, withTiming: (target: number) => target,
  Easing: { bezier: () => undefined }, runOnJS: (fn: unknown) => fn,
  default: {
    View: ({ children, pointerEvents, style, testID }: { children: ReactNode; pointerEvents?: string; style?: unknown; testID?: string }) =>
      <div data-resident-host={pointerEvents ? "true" : undefined} data-testid={testID} data-input={pointerEvents} data-layout={JSON.stringify(style)}>{children}</div>,
  },
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AccessibilityInfo: { setAccessibilityFocus: () => {} },
  BackHandler: { addEventListener: () => ({ remove() {} }) }, findNodeHandle: () => null,
  Pressable: ({ onPress, testID }: { onPress(): void; testID?: string }) => <button onClick={onPress} data-testid={testID} />,
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children, pointerEvents, accessibilityElementsHidden, ref, style, onLayout, testID }: {
    children: ReactNode; pointerEvents?: string; accessibilityElementsHidden?: boolean; ref: Ref<unknown>; style?: unknown; onLayout?: () => void; testID?: string;
  }) => {
    const node = useRef<HTMLDivElement>(null);
    useImperativeHandle(ref, () => ({
      node: node.current,
      measureInWindow: (fn: (...args: number[]) => void) => fn(0, 0, state.width, state.height),
      // Fabric measureLayout requires the target to be a native ancestor.
      measureLayout: (host: { node: HTMLDivElement }, fn: (...args: number[]) => void) => {
        if (state.requireAncestor && !host.node.contains(node.current)) return;
        const sidebar = state.requireAncestor && node.current?.closest('[data-drawer="true"]');
        fn(0, sidebar ? 72 : 0, sidebar ? 286 : state.width, sidebar ? state.height - 72 : state.height);
      },
    }));
    useEffect(() => { onLayout?.(); }, [onLayout]);
    return <div ref={node} data-testid={testID} data-drawer={testID === 'sessionDrawer.overlay' ? "true" : undefined} data-input={pointerEvents} aria-hidden={accessibilityElementsHidden} data-layout={JSON.stringify(style)}>{children}</div>;
  },
}));
vi.mock('@/session/HomeSurface', () => ({ MobileHome: (props: import('@/session/HomeSurface').MobileHomeProps) => {
  const resident = useResidentHomeList();
  const row = <button data-drawer-task-list="true" onClick={() => props.runNavigation?.(() => props.onSelectSession?.({ session: { id: 'next' } } as never))}>Demo task</button>;
  return resident.enabled ? <ResidentHomeList focused top={0} left={0} right={0}>{row}</ResidentHomeList> : row;
} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, left: 0, bottom: 0 }) }));
vi.mock('@/theme', () => ({ useThemedStyles: () => ({}), useTheme: () => ({ colors: {} }) }));
vi.mock('@/platform/gestureHandler', () => ({
  GestureDetector: ({ children }: { children: ReactNode }) => children,
  Gesture: { Pan: () => {
    const chain = { enabled: () => chain, activeOffsetX: () => chain, failOffsetX: () => chain,
      failOffsetY: () => chain, onUpdate: () => chain, onEnd: () => chain };
    return chain;
  } },
}));
import { SessionListDrawerLayer } from '@/session/SessionListDrawerLayer';
import { motionDuration } from '@/theme/tokens';
import { RecentMessageHistories, RecentMessageHistoriesProvider, MessageHistoryOverlay, useMessageHistoryActive, useMessageHistoryPositioning } from '@/session/RecentMessageHistories';
import { ResidentHomeList, ResidentHomeListProvider, useResidentHomeList } from '@/session/ResidentHomeList';
import { recentTaskKey, rememberRecentTask } from '@/session/recentTasks';
const key = (id: string) => recentTaskKey({ deviceId: 'pc', sessionId: id });
const remember = (id: string) => rememberRecentTask({ pathname: '/sessions/[sessionId]', params: { deviceId: 'pc', deviceName: 'PC', sessionId: id } });

describe('resident five-task message lists outside route lifetimes', () => {
  let root: Root;
  let container: HTMLDivElement;
  const mounts = new Map<string, number>();
  const unmounts: string[] = [];
  function History({ id, text }: { id: string; text: string }) {
    const active = useMessageHistoryActive();
    const positioning = useMessageHistoryPositioning();
    const [position, setPosition] = useState(0);
    useEffect(() => {
      mounts.set(id, (mounts.get(id) ?? 0) + 1);
      return () => { unmounts.push(id); };
    }, [id]);
    return <button data-task={id} data-active={active} data-positioning={positioning} onClick={() => setPosition(420)}>{text}:{position}</button>;
  }
  function DrawerHomeProbe() {
    const resident = useResidentHomeList();
    return <div data-drawer="true" data-resident-enabled={resident.enabled}>
      {resident.enabled ? <ResidentHomeList focused top={0} left={0} right={0}>
        <button data-drawer-task-list="true">Drawer tasks</button>
      </ResidentHomeList> : <button data-inline-task-list="true">Inline tasks</button>}
    </div>;
  }
  async function show(id: string | null, text = id ?? '', ready = true) {
    state.onTask = id !== null;
    await act(async () => {
      if (id) remember(id);
      root.render(<RecentMessageHistoriesProvider>{id ?
        <RecentMessageHistories key={id} activeKey={key(id)} ready={ready} topInset={ready ? 90 : 0} bottomInset={ready ? 80 : 0}>
          <History id={id} text={text} />
        </RecentMessageHistories> : <p>Home</p>}
      </RecentMessageHistoriesProvider>);
    });
  }
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    setMobileAuthOwner(null); setMobileAuthOwner('one'); state.focused = true; state.onTask = true;
    state.width = 390; state.height = 844;
    state.native = false; state.upgrade = false; state.requireAncestor = false;
    state.residentEnabled = true; state.reduceMotion = true;
    mounts.clear(); unmounts.length = 0;
    container = document.createElement('div'); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });
  it('keeps the exact list instance after its route is destroyed, then publishes fresh props', async () => {
    await show('a');
    const original = container.querySelector<HTMLButtonElement>('[data-task="a"]')!;
    await act(async () => original.click());
    await show(null);
    expect(original.dataset.active).toBe('false');
    expect(original.dataset.positioning).toBe('false');
    expect(unmounts).toEqual([]);
    await show('b'); await show(null); await show('a', 'updated');
    expect(container.querySelector('[data-task="a"]')).toBe(original);
    expect(original.textContent).toBe('updated:420');
    expect(mounts.get('a')).toBe(1);
  });
  it('pauses store subscriptions of every retained list that is not the visible task', async () => {
    const gateOf = (id: string) => container.querySelector(`[data-task="${id}"]`)!
      .closest<HTMLElement>('[data-store-gate]')!.dataset.storeGate;
    await show('a'); await show('b');
    expect(gateOf('a')).toBe('false');
    expect(gateOf('b')).toBe('true');
    await show(null);
    expect(gateOf('a')).toBe('false');
    expect(gateOf('b')).toBe('false');
    await show('a');
    expect(gateOf('a')).toBe('true');
  });
  it('resizes the same list on rotation without changing its state', async () => {
    await show('a');
    const original = container.querySelector<HTMLButtonElement>('button')!;
    await act(async () => original.click());
    state.width = 844; state.height = 390; await show('a');
    expect(container.querySelector('button')).toBe(original);
    expect(original.textContent).toBe('a:420');
    expect(original.closest('[data-layout*="844"]')).not.toBeNull();
    expect(mounts.get('a')).toBe(1);
  });
  it('keeps native-host children when route slots disappear and reconnects the same surface', async () => {
    state.native = true;
    await show('a');
    const original = container.querySelector<HTMLButtonElement>('[data-task="a"]')!;
    const host = container.querySelector('[data-host]');
    const surface = host?.getAttribute('data-host');
    expect(container.querySelector('[data-slot]')?.getAttribute('data-slot')).toBe(surface);
    await act(async () => original.click());
    await show(null);
    expect(container.querySelector('[data-slot]')).toBeNull();
    expect(container.querySelector('[data-host]')).toBe(host);
    await show('b'); await show('a');
    expect(container.querySelector('[data-task="a"]')).toBe(original);
    expect(original.textContent).toBe('a:420');
    expect(container.querySelector('[data-slot]')?.getAttribute('data-slot')).toBe(surface);
    expect(unmounts).toEqual([]);
  });
  it('keeps old iOS binaries route-local instead of blocking native gestures with an overlay', async () => {
    state.upgrade = true;
    await show('a'); await show(null);
    expect(container.querySelector('button')).toBeNull();
    expect(unmounts).toEqual(['a']);
  });
  it('shows cached native content before new route data and chrome are ready', async () => {
    state.native = true;
    await show('a', 'cached');
    const original = container.querySelector<HTMLButtonElement>('[data-task="a"]')!;
    await act(async () => original.click());
    await show('b'); await show(null); await show('a', 'loading', false);
    expect(container.querySelector('[data-slot]')?.getAttribute('data-selected')).toBe('true');
    expect(container.querySelector('[data-task="a"]')).toBe(original);
    expect(original.textContent).toBe('cached:420');
    expect(original.dataset.positioning).toBe('false');
    expect(unmounts).toEqual([]);
    await show('a', 'fresh');
    expect(original.textContent).toBe('fresh:420');
    expect(mounts.get('a')).toBe(1);
  });
  it('evicts only the least recently used task when opening a sixth', async () => {
    for (const id of ['a','b','c','d','e','a','f']) await show(id);
    expect(unmounts).toEqual(['b']);
    expect(container.querySelectorAll('button')).toHaveLength(5);
    await show('b'); expect(mounts.get('b')).toBe(2);
  });
  it('pauses hidden lists and disables their input/accessibility without removing them', async () => {
    await show('a'); await show(null);
    const original = container.querySelector<HTMLButtonElement>('button')!;
    expect(original.dataset.active).toBe('false');
    expect(original.closest('[data-input="none"]')).not.toBeNull();
    expect(original.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(unmounts).toEqual([]);
  });
  it('does not replace retained content with a new route loading shell', async () => {
    await show('a', 'cached'); await show(null); await show('a', 'loading', false);
    const original = container.querySelector<HTMLButtonElement>('button')!;
    expect(original.textContent).toBe('cached:0');
    expect(original.dataset.active).toBe('false');
    expect(original.closest('[data-store-gate]')?.parentElement?.parentElement?.getAttribute('data-layout'))
      .toContain('\"top\":90');
    expect(original.closest('[data-input="none"]')).not.toBeNull();
    await show('a', 'fresh'); expect(original.textContent).toBe('fresh:0');
  });
  it('keeps route drawers above the retained list and removes them on route exit', async () => {
    await show('a');
    await act(async () => root.render(<RecentMessageHistoriesProvider>
      <MessageHistoryOverlay><button data-drawer="true">Drawer</button></MessageHistoryOverlay>
    </RecentMessageHistoriesProvider>));
    const nodes = container.querySelectorAll('button');
    expect(nodes[0]?.dataset.task).toBe('a');
    expect(nodes[1]?.dataset.drawer).toBe('true');
    expect(nodes[1]?.closest('[data-layout]')?.getAttribute('data-layout')).toContain('"zIndex":40');
    await show(null);
    expect(container.querySelector('[data-drawer]')).toBeNull();
    expect(container.querySelector('[data-task="a"]')).not.toBeNull();
  });
  it('hosts route drawers after the outer resident task list on persistent layouts', async () => {
    remember('a');
    await act(async () => root.render(
      <RecentMessageHistoriesProvider>
        <ResidentHomeListProvider>
          <ResidentHomeList focused top={0} left={0} right={0}>
            <button data-resident-task-list="true">Tasks</button>
          </ResidentHomeList>
          <RecentMessageHistories activeKey={key('a')}>
            <History id="a" text="Messages" />
          </RecentMessageHistories>
          <MessageHistoryOverlay><DrawerHomeProbe /></MessageHistoryOverlay>
        </ResidentHomeListProvider>
      </RecentMessageHistoriesProvider>,
    ));
    const residentHost = container.querySelector('[data-resident-host="true"]')!;
    const drawer = container.querySelector('[data-drawer="true"]')!;
    expect(drawer.getAttribute('data-resident-enabled')).toBe('true');
    expect(container.querySelector('[data-inline-task-list="true"]')).toBeNull();
    expect(residentHost.querySelector('[data-drawer-task-list="true"]')).not.toBeNull();
    expect(residentHost.contains(drawer)).toBe(false);
    expect(residentHost.compareDocumentPosition(drawer) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(drawer.closest('[data-layout]')?.getAttribute('data-layout')).toContain('"zIndex":40');
  });

  it.each([false, true])('keeps a persistent sidebar measurable and above its background (home first: %s)', async (homeFirst) => {
    state.requireAncestor = true;
    state.width = 840; state.height = 640;
    const render = async (home: boolean) => {
      state.onTask = !home;
      await act(async () => root.render(
        <RecentMessageHistoriesProvider>
          <ResidentHomeListProvider>
            {home ? <ResidentHomeList focused top={0} left={0} right={0}>
              <button data-home-list="true">Home tasks</button>
            </ResidentHomeList> : <SessionListDrawerLayer currentSessionId="demo" persistent overlayMounted={false}
              sidebarWidth={286} width={320} open={false} onClose={() => {}} onSelectSession={() => {}} runNavigation={action => action()} />}
          </ResidentHomeListProvider>
        </RecentMessageHistoriesProvider>,
      ));
    };
    if (homeFirst) await render(true);
    await render(false);
    const drawer = container.querySelector('[data-drawer="true"]')!;
    const residentHost = container.querySelector('[data-resident-host="true"]');
    expect(residentHost, 'the measuring slot must remain a native descendant of the resident host').not.toBeNull();
    expect(residentHost?.querySelector('[data-drawer-task-list="true"]')).not.toBeNull();
    expect(residentHost?.getAttribute('data-layout')).toContain('"width":286');
    expect(residentHost?.getAttribute('data-layout')).toContain('"top":72');
    expect(container.querySelector('[data-home-list="true"]')).toBeNull();
    // The opaque panel belongs to the route before the resident list, never to
    // the outer overlay that would paint over that list and retain stale bounds.
    expect(drawer.compareDocumentPosition(residentHost!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(drawer.closest('[data-layout*="zIndex"]')).toBeNull();
  });
  // Production page composition: the layer owns both the drawer presentation and
  // its history host. Previously tests passed inline directly and missed wiring.
  // Unit regression: start closing a modal, widen before exit, then drain timers.
  it('settles the real modal once before moving its persistent column into the resident host', async () => {
    vi.useFakeTimers();
    state.requireAncestor = true; state.reduceMotion = false; state.residentEnabled = false;
    state.width = 840; state.height = 390;
    const closed = vi.fn(); const navigate = vi.fn();
    function Page({ persistent }: { persistent: boolean }) {
      const [overlayMounted, setOverlayMounted] = useState(true);
      const [open, setOpen] = useState(true);
      const pending = useRef<(() => void) | null>(null);
      return <SessionListDrawerLayer currentSessionId="demo" persistent={persistent} overlayMounted={overlayMounted}
        sidebarWidth={286} width={320} open={open} onClose={() => setOpen(false)}
        runNavigation={action => { pending.current = action; setOpen(false); }} onSelectSession={navigate}
        onClosed={() => { closed(); setOverlayMounted(false); const action = pending.current; pending.current = null; action?.(); }} />;
    }
    const render = async (persistent: boolean) => act(async () => root.render(
      <RecentMessageHistoriesProvider><ResidentHomeListProvider><Page persistent={persistent} /></ResidentHomeListProvider></RecentMessageHistoriesProvider>,
    ));
    const outerDrawers = () => container.querySelectorAll('[data-layout*="zIndex"] [data-drawer="true"]');
    await render(false);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-drawer-task-list="true"]')!.click());
    state.residentEnabled = true; state.height = 640;
    await render(true);
    expect(outerDrawers()).toHaveLength(1);
    expect(container.querySelector('[data-testid="sessionDrawer.scrim"]')).not.toBeNull();
    expect(closed).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(motionDuration.exit));
    expect(closed).toHaveBeenCalledOnce(); expect(navigate).toHaveBeenCalledOnce();
    expect(outerDrawers()).toHaveLength(0);
    expect(container.querySelector('[data-testid="sessionDrawer.scrim"]')).toBeNull();
    expect(container.querySelectorAll('[data-drawer="true"]')).toHaveLength(1);
    expect(container.querySelector('[data-resident-host="true"] [data-drawer-task-list="true"]')).not.toBeNull();
    expect(container.querySelector('[data-resident-host="true"]')?.getAttribute('data-layout')).toContain('"width":286');
    await act(async () => vi.advanceTimersByTime(motionDuration.enter + motionDuration.exit));
    expect(closed).toHaveBeenCalledOnce(); expect(navigate).toHaveBeenCalledOnce();
  });
  it('clears all instances at an account boundary', async () => {
    await show('a'); await show('b');
    await act(async () => setMobileAuthOwner('two'));
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(unmounts).toEqual(['a','b']);
  });
});
