// @vitest-environment jsdom
import { act, createContext, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
const state = vi.hoisted(() => ({ focused: true, onTask: true, width: 390, height: 844, native: false, upgrade: false,
  sheetParams: {} as Record<string, string> }));
vi.mock('@/session/NativeResidentHistory', () => {
  const Host = ({ children, surfaceId }: { children: ReactNode; surfaceId: string }) => <div data-host={surfaceId}>{children}</div>;
  const Slot = ({ surfaceId, selected }: { surfaceId: string; selected: boolean }) => <div data-slot={surfaceId} data-selected={selected} />;
  return { get NativeHistoryHost() { return state.native ? Host : null; },
    get NativeHistorySlot() { return state.native ? Slot : null; },
    get needsResidentHistoryUpgrade() { return state.upgrade; } };
});
vi.mock('expo-router', () => ({ useSegments: () => state.onTask ? ['sessions', '[sessionId]'] : ['index'],
  useGlobalSearchParams: () => state.sheetParams }));
vi.mock('expo-router/react-navigation', () => ({ useIsFocused: () => state.focused,
  NavigationContext: createContext(null), NavigationRouteContext: createContext(null) }));
vi.mock('@/platform/AdaptiveWindowContext', () => ({
  usePaneViewport: () => ({ width: state.width, height: state.height }),
  useAdaptiveWindow: () => ({ width: state.width, height: state.height }),
  PaneViewportProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/session/useHomeMode', () => ({ useHomeMode: () => ({ mode: 'tasks' }) }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => true }));
vi.mock('@/session/sessionPaneLayout', () => ({ sessionPaneLayout: () => ({ persistent: true }) }));
vi.mock('@/session/remoteSessionStore', () => ({
  RemoteSessionStoreSubscriptionGate: ({ children, enabled }: { children: ReactNode; enabled: boolean }) =>
    <div data-store-gate={String(enabled)}>{children}</div>,
}));
vi.mock('react-native-reanimated', () => ({
  useSharedValue: (value: number) => useRef({ value }).current,
  useAnimatedStyle: (factory: () => unknown) => factory(),
  cancelAnimation: () => {}, withSpring: (target: number) => target,
  default: {
    View: ({ children, pointerEvents, style }: { children: ReactNode; pointerEvents?: string; style?: unknown }) =>
      <div data-resident-host="true" data-input={pointerEvents} data-layout={JSON.stringify(style)}>{children}</div>,
  },
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (values: Record<string, unknown>) => values.android ?? values.default },
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children, pointerEvents, accessibilityElementsHidden, ref, style, onLayout }: {
    children: ReactNode; pointerEvents?: string; accessibilityElementsHidden?: boolean; ref: Ref<unknown>; style?: unknown; onLayout?: () => void;
  }) => {
    useImperativeHandle(ref, () => ({
      measureInWindow: (fn: (...args: number[]) => void) => fn(0, 0, state.width, state.height),
      measureLayout: (_host: unknown, fn: (...args: number[]) => void) => fn(0, 0, state.width, state.height),
    }), []);
    useEffect(() => { onLayout?.(); }, [onLayout]);
    return <div data-input={pointerEvents} aria-hidden={accessibilityElementsHidden} data-layout={JSON.stringify(style)}>{children}</div>;
  },
}));
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
    state.native = false; state.upgrade = false;
    state.sheetParams = {};
    mounts.clear(); unmounts.length = 0;
    container = document.createElement('div'); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); });
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
  // Android modal regression: opening a side chat previously hid its main task.
  // Unit tier: retain only that parent visually; input and live subscriptions stay paused.
  it('keeps the covered parent visible without activating hidden histories', async () => {
    await show('b'); await show('a');
    state.focused = false;
    state.sheetParams = { sideChat: '1', sideChatParentId: 'a', deviceId: 'pc' };
    await show('a');
    const parent = container.querySelector<HTMLElement>('[data-task="a"]')!;
    const clip = parent.closest<HTMLElement>('[data-layout*="opacity"]')!;
    expect(JSON.parse(clip.dataset.layout!).at(-1).opacity).toBe(1);
    expect(clip.dataset.input).toBe('none');
    expect(clip.getAttribute('aria-hidden')).toBe('true');
    expect(parent.dataset.active).toBe('false');
    expect(parent.closest('[data-store-gate]')?.getAttribute('data-store-gate')).toBe('false');
    const other = container.querySelector('[data-task="b"]')!.closest<HTMLElement>('[data-layout*="opacity"]')!;
    expect(JSON.parse(other.dataset.layout!).at(-1).opacity).toBe(0);
    state.sheetParams = { ...state.sheetParams, deviceId: 'another-pc' };
    await show('a');
    expect(JSON.parse(clip.dataset.layout!).at(-1).opacity).toBe(0);
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
  // Regression: preview -> interactive back exposes the native slot before JS
  // focus returns. The slot must accept its retained surface while subscriptions
  // and positioning remain paused. Existing reentry tests only used focused slots.
  it('keeps the native docking slot ready while a file preview covers the task', async () => {
    state.native = true;
    await show('a', 'cached');
    const original = container.querySelector<HTMLButtonElement>('[data-task="a"]')!;
    await act(async () => original.click());
    state.focused = false;
    await show('a', 'cached');
    expect(container.querySelector('[data-slot]')?.getAttribute('data-selected')).toBe('true');
    expect(original.dataset.active).toBe('false');
    expect(original.dataset.positioning).toBe('false');
    expect(original.closest('[data-store-gate]')?.getAttribute('data-store-gate')).toBe('false');
    state.focused = true;
    await show('a', 'cached');
    expect(container.querySelector('[data-task="a"]')).toBe(original);
    expect(original.textContent).toBe('cached:420');
    expect(unmounts).toEqual([]);
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
  it('keeps the detail history above a resident list while the list is dragged', async () => {
    await show('a');
    const history = container.querySelector('[data-task="a"]')!;
    const clip = history.closest<HTMLElement>('[data-layout*="zIndex"]');
    expect(clip?.dataset.layout).toContain('"zIndex":1');
  });
  it('hosts modal drawers after the outer resident task list', async () => {
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
  it('keeps one scrolled list above the persistent panel through home, task switches and back', async () => {
    let mounts = 0;
    const List = ({ task }: { task: string }) => {
      const [offset, setOffset] = useState(0);
      useEffect(() => { mounts++; }, []);
      return <button data-shared-list onClick={() => setOffset(240)}>{task}:{offset}</button>;
    };
    const Scene = ({ task }: { task: string }) => <RecentMessageHistoriesProvider>
      <ResidentHomeListProvider>
        {task === 'home' ? <ResidentHomeList focused top={0} left={0} right={0}>
          <List task={task} />
        </ResidentHomeList> : <MessageHistoryOverlay enabled={false}>
          <div data-panel>
            <span data-panel-title>Tasks</span>
            <ResidentHomeList focused top={0} left={0} right={0}><List task={task} /></ResidentHomeList>
          </div>
        </MessageHistoryOverlay>}
      </ResidentHomeListProvider>
    </RecentMessageHistoriesProvider>;
    state.onTask = false;
    await act(async () => root.render(<Scene task="home" />));
    const list = container.querySelector('[data-shared-list]') as HTMLButtonElement;
    await act(async () => list.click());
    for (const task of ['a', 'b', 'home']) {
      state.onTask = task !== 'home';
      await act(async () => root.render(<Scene task={task} />));
      expect(container.querySelectorAll('[data-shared-list]')).toHaveLength(1);
      expect(container.querySelector('[data-shared-list]')).toBe(list);
      expect(list.textContent).toBe(task + ':240');
      expect(mounts).toBe(1);
      if (state.onTask) {
        const title = container.querySelector('[data-panel-title]')!;
        const host = list.closest('[data-resident-host]')!;
        expect(title.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
        expect(title.closest('[data-layout*="zIndex"]')).toBeNull();
      }
    }
  });
  it('clears all instances at an account boundary', async () => {
    await show('a'); await show('b');
    await act(async () => setMobileAuthOwner('two'));
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(unmounts).toEqual(['a','b']);
  });
});
