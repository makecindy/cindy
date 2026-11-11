vi.mock('@/session/TaskDrawerPresentation', () => ({ useTaskDrawerPresentation: () => null, TaskDrawerPresentation: () => null }));
vi.mock('@/session/SharedTaskList', () => ({ useSharedTaskList: () => null, SharedTaskListContent: () => null }));
vi.mock('@/session/SessionOptionsExpoSheet', () => ({ SessionOptionsPresenter: () => null }));
vi.mock('@/session/RenameSessionModal', () => ({ RenameSessionModal: () => null }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'test-owner' } }) }));
// @vitest-environment jsdom
import { act, useLayoutEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rubberBand, SessionListDrawer, useSessionListDrawerMotion, useSessionListDrawerOpenGesture } from '@/session/SessionListDrawer';
import { SessionFloatingDrawer, SessionTaskDrawerProvider } from '@/session/SessionTaskDrawer';
import { motionDuration } from '@/theme/tokens';
import type { MobileHomeProps } from '@/session/HomeSurface';
const native = vi.hoisted(() => ({ home: null as MobileHomeProps | null, widths: [] as number[], mounts: 0, unmounts: 0, instances: 0, residentAvailable: true, sharedAvailable: true, handoffAvailable: false, dock: null as (() => void) | null, activeEffects: 0, reduceMotion: true,
  attachedGestures: new Set<unknown>(), routeFocused: true, routeListeners: {} as Record<string, Set<() => void>>,
  timings: [] as { to: number; config: { duration: number }; done?: (finished: boolean) => void }[], values: [] as { value: any }[], divider: null as any, pans: {} as Record<string, Record<string, (event?: any) => void>>, gesture: {} as Record<string, (event?: any) => void>, cancel: vi.fn() }));
vi.mock('@/session/HomeSurface', async () => {
  const { useCallback, useContext, useEffect, useState, useSyncExternalStore } = await import('react');
  const { NavigationContext } = await import('expo-router/react-navigation');
  return { MobileHome: (props: MobileHomeProps) => {
    const navigation = useContext(NavigationContext);
    const subscribe = useCallback((callback: () => void) => {
      const a = navigation?.addListener('focus', callback);
      const b = navigation?.addListener('blur', callback);
      return () => { a?.(); b?.(); };
    }, [navigation]);
    const focused = useSyncExternalStore(subscribe, () => navigation?.isFocused() ?? false);
    useEffect(() => { if (!focused) return; native.activeEffects++; return () => { native.activeEffects--; }; }, [focused]);
    useState(() => ++native.instances);
    native.home = props; native.widths.push(props.width!);
    useEffect(() => { native.mounts++; return () => { native.unmounts++; }; }, []);
    return <input data-testid="home.retainedSearch" defaultValue="" />;
  } };
});
vi.mock('expo-router/react-navigation', async () => {
  const { createContext } = await import('react');
  return { useIsFocused: () => native.routeFocused, NavigationContext: createContext({ isFocused: () => native.routeFocused,
    addListener: (event: string, listener: () => void) => {
      const set = native.routeListeners[event] ??= new Set();
      set.add(listener); return () => { set.delete(listener); };
    } }) };
});
vi.mock('@/session/ResidentHomeList', () => ({ LocalHomeList: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/session/RecentMessageHistories', () => ({ MessageHistoryOverlay: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/session/NativeResidentHistory', async () => {
  const { View } = await import('react-native');
  const Slot = (props: any) => { if (props.onDock) native.dock = props.onDock; return <View {...props} />; };
  return { get taskDrawerHandoffAvailable() { return native.handoffAvailable; }, get NativeHistoryHost() { return native.residentAvailable ? View : null; },
    get NativeTaskDrawerHost() { return native.sharedAvailable ? View : null; },
    get NativeHistorySlot() { return native.residentAvailable ? Slot : null; } };
});
vi.mock('@/session/SessionPaneDivider', () => ({ SessionPaneDivider: (props: any) => {
  native.divider = props;
  return <div data-testid="session.paneDivider" />;
} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  type Props = {
    children?: ReactNode;
    testID?: string;
    onPress?: () => void;
    accessibilityState?: { selected?: boolean };
    pointerEvents?: string;
    accessibilityElementsHidden?: boolean;
    importantForAccessibility?: string;
    ref?: import("react").Ref<HTMLDivElement>;
  };
  const View = ({
    children,
    testID,
    onPress,
    accessibilityState,
    pointerEvents,
    accessibilityElementsHidden,
    importantForAccessibility,
    ref,
  }: Props) =>
    createElement(
      "div",
      {
        "data-testid": testID,
        onClick: onPress,
        "aria-selected": accessibilityState?.selected,
        "data-pointer-events": pointerEvents,
        "data-accessibility-hidden": accessibilityElementsHidden,
        "data-accessibility-importance": importantForAccessibility,
        ref,
      },
      children,
    );
  return {
    View,
    Pressable: View,
    Modal: ({ children, visible }: { children: ReactNode; visible: boolean }) => visible ? <div data-testid="native.modal">{children}</div> : null,
    AccessibilityInfo: { setAccessibilityFocus: vi.fn() },
    AppState: {
      get currentState() { return 'active'; },
      addEventListener: (_event: string, listener: (state: string) => void) => {
        return { remove() {} };
      },
    },
    BackHandler: { addEventListener: () => ({ remove() {} }) },
    findNodeHandle: () => null,
    StyleSheet: {
      create: (value: unknown) => value,
      hairlineWidth: 1,
      absoluteFill: {},
    },
    Platform: {
      OS: "ios",
      select: (values: Record<string, unknown>) => values.ios ?? values.default,
    },
  };
});
vi.mock("react-native-reanimated", async () => {
  const { useRef } = await import("react");
  const { View } = await import("react-native");
  return {
    default: { View },
    useSharedValue: (value: number) => {
      const ref = useRef({ value });
      if (!native.values.includes(ref.current)) native.values.push(ref.current);
      return ref.current;
    },
    useAnimatedStyle: () => ({}),
    useAnimatedReaction: () => undefined,
    Easing: { bezier: () => undefined },
    cancelAnimation: native.cancel,
    runOnJS: (fn: unknown) => fn,
    withRepeat: (value: number) => value,
    withTiming: (value: number, config: { duration: number }, done?: (finished: boolean) => void) => { native.timings.push({ to: value, config, done }); return value; },
  };
});
vi.mock("@/platform/gestureHandler", async () => {
  const { useLayoutEffect } = await import('react');
  return {
  GestureDetector: ({ children, gesture }: { children: ReactNode; gesture: unknown }) => {
    useLayoutEffect(() => {
      // Native Gesture Handler mutates handlerTag on attachment. Sharing one
      // gesture between the handoff window and column causes worklet warnings.
      if (native.attachedGestures.has(gesture)) throw new Error('Gesture attached to two containers');
      native.attachedGestures.add(gesture);
      return () => { native.attachedGestures.delete(gesture); };
    }, [gesture]);
    return children;
  },
  GestureHandlerRootView: ({ children }: { children: ReactNode }) => children,
  Gesture: {
    // panel: activeOffsetX(-16); dimmed area: activeOffsetX([-16, 16]); task pull-out: activeOffsetX(16).
    Pan: () => {
      const handlers: Record<string, (event?: any) => void> = {};
      const chain = {
        enabled: () => chain,
        activeOffsetX: (offset: number | number[]) => {
          const kind = Array.isArray(offset) ? 'scrim' : offset < 0 ? 'panel' : 'open';
          if (kind === 'panel') native.gesture = handlers; else native.pans[kind] = handlers;
          return chain;
        },
        failOffsetX: () => chain,
        failOffsetY: () => chain,
        onStart: (callback: (event?: any) => void) => { handlers.start = callback; return chain; },
        onUpdate: (callback: (event: any) => void) => { handlers.update = callback; return chain; },
        onEnd: (callback: (event: any) => void) => { handlers.end = callback; return chain; },
        onFinalize: (callback: () => void) => { handlers.finalize = callback; return chain; },
      };
      return chain;
    },
  },
}; });
vi.mock("lucide-react-native", () => ({
  ChevronDown: () => null, ChevronRight: () => null, Folder: () => null, FolderOpen: () => null, MessagesSquare: () => null,
  House: () => null,
  LoaderCircle: () => null,
  SquarePen: () => null,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ left: 0, top: 0, bottom: 0 }),
}));
vi.mock("@/components/AppText", async () => ({
  Text: (await import("react-native")).View,
}));
vi.mock("@/theme", () => ({
  useThemedStyles: () => ({}),
  useTheme: () => ({ colors: {} }),
}));
vi.mock("@/hooks/useReduceMotion", () => ({
  useReduceMotionEnabled: () => native.reduceMotion,
}));

describe('shared Home drawer host', () => {
  let root: Root;
  let container: HTMLDivElement;
  const props = { currentSessionId: 's1', onClose: vi.fn(), onClosed: vi.fn(),
    onSelectSession: vi.fn(), runNavigation: vi.fn((action: () => void) => action()), open: true, width: 320 };
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    native.home = null; native.widths = []; native.mounts = 0; native.unmounts = 0; native.instances = 0; native.residentAvailable = true; native.sharedAvailable = true; native.handoffAvailable = false; native.dock = null; native.activeEffects = 0;
    native.attachedGestures = new Set(); native.routeFocused = true; native.routeListeners = {};
    native.values = []; native.gesture = {}; native.divider = null; native.pans = {};
    native.reduceMotion = true; native.timings = [];
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => setTimeout(callback, 0));
    vi.stubGlobal('cancelIdleCallback', (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('keeps the departing column mounted on blur and pauses its work', async () => {
    const render = (focused: boolean) => root.render(
      <SessionTaskDrawerProvider enabled focused={focused} windowHeight={900} topInset={0} floatingWidth={400}
        column={<SessionListDrawer {...props} persistent open width={400} />}>
        {null}
      </SessionTaskDrawerProvider>,
    );
    await act(async () => render(true));
    const home = container.querySelector('[data-testid="home.retainedSearch"]');
    await act(async () => {
      native.routeFocused = false;
      for (const listener of native.routeListeners.blur ?? []) listener();
      render(false);
    });
    expect(container.querySelector('[data-testid="home.retainedSearch"]')).toBe(home);
    expect(native.instances).toBe(1);
    expect(native.unmounts).toBe(0);
    expect(native.activeEffects).toBe(0);
  });
  it('keeps separate presentations on binaries without cross-controller docking', async () => {
    native.sharedAvailable = false;
    const render = (persistent: boolean) => root.render(
      <SessionTaskDrawerProvider enabled focused windowHeight={900} topInset={0} floatingWidth={400}
        column={<SessionListDrawer {...props} persistent={persistent} open={persistent} width={300} />}>
        {!persistent ? <SessionFloatingDrawer {...props} aboveSystemBar retainedHeight={900}
          width={400} open overlayMounted /> : null}
      </SessionTaskDrawerProvider>,
    );
    await act(async () => render(false));
    const floating = container.querySelector('[data-testid="home.retainedSearch"]');
    await act(async () => render(true));
    expect(container.querySelector('[data-testid="home.retainedSearch"]')).not.toBe(floating);
    expect(native.instances).toBe(2);
    expect(native.unmounts).toBe(1);
  });
  it('uses one Home across task changes and column/floating ownership handoffs', async () => {
    const columnSelect = vi.fn();
    const floatingSelect = vi.fn();
    const render = (persistent: boolean, open = false, overlayMounted = open, session = 's1') => root.render(
      <SessionTaskDrawerProvider enabled focused windowHeight={persistent ? 600 : 900} topInset={0} floatingWidth={400}
        column={<SessionListDrawer {...props} currentSessionId={session} persistent={persistent} open={persistent}
          width={persistent ? 300 : 0} onSelectSession={columnSelect} />}>
        {!persistent || overlayMounted ? <SessionFloatingDrawer key={session} {...props} currentSessionId={session}
          aboveSystemBar width={400} open={open} overlayMounted={overlayMounted} onSelectSession={floatingSelect} /> : null}
      </SessionTaskDrawerProvider>,
    );
    await act(async () => render(true));
    const search = container.querySelector<HTMLInputElement>('[data-testid="home.retainedSearch"]')!;
    search.value = 'kept filter';
    expect(native.home?.onSelectSession).toBe(columnSelect);
    await act(async () => render(false));
    expect(native.activeEffects).toBe(0);
    await act(async () => render(false, true));
    expect(native.home?.onSelectSession).toBe(floatingSelect);
    // Rotation completes the old overlay handoff without hiding the list.
    props.onClosed.mockClear();
    await act(async () => render(true, false, true));
    expect(props.onClosed).toHaveBeenCalledTimes(1);
    expect(native.home?.newSessionInHeader).toBe(false);
    await act(async () => render(true));
    expect(native.home?.onSelectSession).toBe(columnSelect);
    await act(async () => render(false, true, true, 's2'));
    expect(native.home?.currentSessionId).toBe('s2');
    expect(native.home?.onSelectSession).toBe(floatingSelect);
    expect(container.querySelector('[data-testid="home.retainedSearch"]')).toBe(search);
    expect(search.value).toBe('kept filter');
    expect(native.instances).toBe(1);
    expect(native.unmounts).toBe(0);
    expect(container.querySelectorAll('[data-testid="sessionDrawer.retainedHost"]')).toHaveLength(1);
  });
  it.each([true, false])('docks immediately with open=%s, without an exit animation or focus gap', async openAtRotation => {
    native.reduceMotion = false;
    let motion!: ReturnType<typeof useSessionListDrawerMotion>;
    function Scene({ persistent, open }: { persistent: boolean; open: boolean }) {
      motion = useSessionListDrawerMotion(1);
      return (
        <SessionTaskDrawerProvider enabled focused windowHeight={900} topInset={0} floatingWidth={400}
          column={<SessionListDrawer {...props} persistent={persistent} open={persistent} width={300} />}>
          <SessionFloatingDrawer {...props} aboveSystemBar width={400} open={open} overlayMounted motion={motion} />
        </SessionTaskDrawerProvider>
      );
    }
    const render = (persistent: boolean, open = true) => root.render(<Scene persistent={persistent} open={open} />);
    await act(async () => render(false));
    motion.dragX.value = -20;
    motion.tracking.value = true;
    motion.settling.value = true;
    const list = container.querySelector('[data-testid="home.retainedSearch"]');
    native.timings = [];
    await act(async () => render(true, openAtRotation));
    expect(container.querySelector('[data-testid="sessionDrawer.scrim"]')).toBeNull();
    expect(native.home?.width).toBe(300);
    expect(native.activeEffects).toBe(1);
    expect(props.onClosed).toHaveBeenCalledTimes(1);
    expect(motion.progress.value).toBe(0);
    expect(motion.tracking.value).toBe(false);
    expect(motion.settling.value).toBe(false);
    // A late route close update must not replay exit or invoke navigation twice.
    await act(async () => render(true, false));
    await act(async () => vi.advanceTimersByTime(motionDuration.exit + motionDuration.enter));
    expect(props.onClosed).toHaveBeenCalledTimes(1);
    expect(native.timings.filter(timing => timing.to === 0)).toHaveLength(0);
    expect(container.querySelector('[data-testid="home.retainedSearch"]')).toBe(list);
    expect(native.instances).toBe(1);
    expect(native.unmounts).toBe(0);
    // Returning quickly to portrait and opening again starts a new handoff,
    // while keeping the same list and completing each presentation only once.
    await act(async () => render(false, false));
    await act(async () => render(false));
    await act(async () => render(true));
    expect(props.onClosed).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="home.retainedSearch"]')).toBe(list);
  });
  it.each([true, false])('keeps the original Modal until native docking, including an interrupted close (open=%s)', async openAtRotation => {
    native.handoffAvailable = true;
    const render = (persistent: boolean, open = true) => root.render(
      <SessionTaskDrawerProvider enabled focused windowHeight={900} topInset={0} floatingWidth={400}
        column={<SessionListDrawer {...props} persistent={persistent} open={persistent} width={300} />}>
        <SessionFloatingDrawer {...props} aboveSystemBar width={400} open={open} overlayMounted />
      </SessionTaskDrawerProvider>,
    );
    await act(async () => render(false));
    const modal = container.querySelector('[data-testid="native.modal"]');
    const slot = modal?.querySelector('[data-testid="sessionDrawer.retainedSlot"]');
    const list = container.querySelector('[data-testid="home.retainedSearch"]');
    await act(async () => render(true, openAtRotation));
    expect(container.querySelector('[data-testid="native.modal"]')).toBe(modal);
    expect(modal?.querySelector('[data-testid="sessionDrawer.retainedSlot"]')).toBe(slot);
    expect(container.querySelectorAll('[data-testid="sessionDrawer.retainedSlot"]')).toHaveLength(2);
    expect(container.querySelector('[data-testid="sessionDrawer.scrim"]')).toBeNull();
    expect(props.onClosed).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(props.onClosed).not.toHaveBeenCalled();
    await act(async () => native.dock!());
    expect(container.querySelector('[data-testid="native.modal"]')).toBeNull();
    expect(props.onClosed).toHaveBeenCalledTimes(1);
    await act(async () => native.dock!());
    expect(props.onClosed).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="home.retainedSearch"]')).toBe(list);
    expect(native.instances).toBe(1);
    expect(native.unmounts).toBe(0);
    expect(native.activeEffects).toBe(1);
  });
  it('ignores a late column acknowledgment after rotating back or beginning a newer handoff', async () => {
    native.handoffAvailable = true;
    const render = (persistent: boolean) => root.render(<SessionListDrawer {...props}
      persistent={persistent} aboveSystemBar={!persistent} retainedHeight={900} />);
    await act(async () => render(false));
    await act(async () => render(true));
    const dock = native.dock!;
    await act(async () => render(false));
    await act(async () => dock());
    expect(container.querySelector('[data-testid="native.modal"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="sessionDrawer.retainedSlot"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="sessionDrawer.scrim"]')).not.toBeNull();
    expect(native.instances).toBe(1);
    expect(props.onClosed).not.toHaveBeenCalled();
    await act(async () => render(true));
    await act(async () => dock());
    expect(container.querySelector('[data-testid="native.modal"]')).not.toBeNull();
    await act(async () => native.dock!());
    expect(container.querySelector('[data-testid="native.modal"]')).toBeNull();
  });
  it('keeps the same Home instance when its native slot moves between Modal and column', async () => {
    await act(async () => root.render(<SessionListDrawer {...props} aboveSystemBar retainedHeight={900} />));
    const instances = native.instances;
    for (const persistent of [true, false, true, false]) {
      await act(async () => root.render(<SessionListDrawer {...props} persistent={persistent}
        aboveSystemBar={!persistent} retainedHeight={persistent ? 600 : 900} width={persistent ? 300 : 400} />));
      expect(native.instances).toBe(instances);
      expect(native.unmounts).toBe(0);
      expect(native.home?.width).toBe(persistent ? 300 : 400);
      expect(container.querySelectorAll('[data-testid="sessionDrawer.retainedHost"]')).toHaveLength(1);
    }
  });
  it('prepares one native Home with background work paused and reuses it after closing', async () => {
    const render = (open: boolean, currentSessionId = 's1') => root.render(
      <SessionListDrawer {...props} open={open} currentSessionId={currentSessionId} aboveSystemBar retainedHeight={900} />,
    );
    await act(async () => render(false));
    expect(native.instances).toBe(0);
    await act(async () => vi.advanceTimersByTime(0));
    expect(native.instances).toBe(1);
    expect(native.mounts).toBe(1);
    expect(native.activeEffects).toBe(0);
    expect(container.querySelector('[data-testid="sessionDrawer.overlay"]')).toBeNull();
    await act(async () => render(true));
    expect(native.instances).toBe(1);
    expect(native.mounts).toBe(1);
    expect(container.querySelector('[data-testid="sessionDrawer.retainedSlot"]')).not.toBeNull();
    await act(async () => render(false));
    expect(native.unmounts).toBe(0);
    expect(native.activeEffects).toBe(0);
    expect(props.onClosed).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="sessionDrawer.overlay"]')).toBeNull();
    await act(async () => render(true, 's2'));
    expect(native.instances).toBe(1);
    expect(native.home?.currentSessionId).toBe('s2');
    expect(native.mounts - native.unmounts).toBe(1);
    expect(native.activeEffects).toBe(1);
  });
  it('releases the prepared Home when inner-screen eligibility ends', async () => {
    await act(async () => root.render(<SessionListDrawer {...props} aboveSystemBar retainedHeight={900} />));
    await act(async () => root.render(<SessionListDrawer {...props} open={false} aboveSystemBar retainedHeight={900} />));
    expect(native.instances).toBe(1);
    await act(async () => root.render(<SessionListDrawer {...props} open={false} aboveSystemBar />));
    expect(container.querySelector('[data-testid="sessionDrawer.retainedHost"]')).toBeNull();
    await act(async () => root.render(<SessionListDrawer {...props} aboveSystemBar retainedHeight={900} />));
    expect(native.instances).toBe(2);
  });
  it('pauses retained Home on route blur and ignores task focus while the drawer is closed', async () => {
    const focus = async (focused: boolean) => act(async () => {
      native.routeFocused = focused;
      for (const listener of [...(native.routeListeners[focused ? 'focus' : 'blur'] ?? [])]) listener();
    });
    await act(async () => root.render(<SessionListDrawer {...props} aboveSystemBar retainedHeight={900} />));
    expect(native.activeEffects).toBe(1);
    await focus(false);
    expect(native.activeEffects).toBe(0);
    await focus(true);
    expect(native.activeEffects).toBe(1);
    await act(async () => root.render(<SessionListDrawer {...props} open={false} aboveSystemBar retainedHeight={900} />));
    await focus(false);
    await focus(true);
    expect(native.activeEffects).toBe(0);
    expect(native.instances).toBe(1);
  });
  it('keeps on-demand mounting on older binaries without a native host', async () => {
    native.residentAvailable = false;
    await act(async () => root.render(<SessionListDrawer {...props} open={false} aboveSystemBar retainedHeight={900} />));
    expect(native.instances).toBe(0);
    await act(async () => root.render(<SessionListDrawer {...props} aboveSystemBar retainedHeight={900} />));
    expect(native.instances).toBe(1);
  });
  it.each([false, true])('mounts the drawer in the opening commit (above system bar: %s)', async (aboveSystemBar) => {
    const firstCommit: boolean[] = [];
    function Probe({ open }: { open: boolean }) {
      useLayoutEffect(() => { if (open) firstCommit.push(!!container.querySelector('[data-testid="sessionDrawer.panel"]')); }, [open]);
      return <SessionListDrawer {...props} open={open} aboveSystemBar={aboveSystemBar} />;
    }
    await act(async () => root.render(<Probe open={false} />));
    await act(async () => root.render(<Probe open />));
    expect(firstCommit).toEqual([true]);
    expect(native.mounts).toBe(1);
  });
  it.each(['running', 'finished'])('does not replay a fast pull when React opens after its native animation is %s', async (phase) => {
    native.reduceMotion = false;
    let motion: ReturnType<typeof useSessionListDrawerMotion>;
    function Probe({ open }: { open: boolean }) {
      motion = useSessionListDrawerMotion();
      useSessionListDrawerOpenGesture({ motion, enabled: true, width: 320,
        onOpen: () => {}, onCancel: () => {}, onSettle: () => {} });
      return <SessionListDrawer {...props} open={open} motion={motion} />;
    }
    await act(async () => root.render(<Probe open={false} />));
    const pull = native.pans.open!;
    pull.start!({ translationX: 20 });
    pull.update!({ translationX: 256 });
    pull.end!({ translationX: 256, velocityX: 1200 });
    pull.finalize!();
    motion!.progress.value = phase === 'running' ? 0.85 : 1;
    if (phase === 'finished') native.timings[0]!.done!(true);
    const count = native.timings.length;
    await act(async () => root.render(<Probe open />));
    expect(native.timings).toHaveLength(count);
    expect(motion!.progress.value).toBe(phase === 'running' ? 0.85 : 1);
    expect(native.timings[0]!.config.duration).toBeCloseTo(motionDuration.enter * 0.2);
  });
  it.each([false, true, null])('uses the release position and respects reduced motion (%s)', async (preference) => {
    native.reduceMotion = preference as boolean;
    let motion: ReturnType<typeof useSessionListDrawerMotion>;
    const onCancel = vi.fn();
    function Probe() {
      motion = useSessionListDrawerMotion();
      useSessionListDrawerOpenGesture({ motion, enabled: true, width: 320,
        onOpen: () => {}, onCancel, onSettle: () => {} });
      return null;
    }
    await act(async () => root.render(<Probe />));
    const pull = native.pans.open!;
    pull.start!({ translationX: 20 });
    pull.update!({ translationX: 60 });
    // Last onUpdate is below threshold; the release moved beyond it without a flick.
    pull.end!({ translationX: 256, velocityX: 0 });
    expect(onCancel).not.toHaveBeenCalled();
    expect(motion!.progress.value).toBe(1);
    expect(native.timings).toHaveLength(preference === false ? 1 : 0);
    if (preference === false) expect(native.timings[0]!.config.duration).toBeCloseTo(50);
  });
  it('takes over an unfinished rebound on horizontal activation and still closes a full left swipe', async () => {
    native.reduceMotion = false;
    await act(async () => root.render(<SessionListDrawer {...props} />));
    const [progress, dragX] = native.values;
    native.gesture.start!();
    native.gesture.update!({ translationX: -40 });
    native.gesture.end!({ translationX: -40, velocityX: 0 });
    expect(props.onClose).not.toHaveBeenCalled();
    expect(dragX!.value).toBe(0);
    // The UI thread is halfway through that return when a second pan activates.
    progress!.value = 0.9;
    native.cancel.mockClear();
    native.gesture.start!();
    expect(native.cancel).toHaveBeenCalledWith(progress);
    expect(native.cancel).toHaveBeenCalledWith(dragX);
    expect(progress!.value).toBe(0.9);
    native.gesture.update!({ translationX: -24 });
    expect((progress!.value - 1) * props.width + dragX!.value).toBeCloseTo(-56);
    native.gesture.end!({ translationX: -24, velocityX: 0 });
    expect(progress!.value).toBe(1);
    expect(dragX!.value).toBe(0);
    expect(props.onClose).not.toHaveBeenCalled();
    native.gesture.start!();
    native.gesture.update!({ translationX: -160 });
    native.gesture.end!({ translationX: -160, velocityX: 0 });
    expect(props.onClose).toHaveBeenCalledOnce();
  });
  it.each([
    { translationX: -40, velocityX: 0, closes: true },
    { translationX: -20, velocityX: 0, closes: false },
    { translationX: -20, velocityX: -900, closes: true },
  ])('uses the inherited rebound position when releasing a second swipe ($translationX, $velocityX)', async ({ translationX, velocityX, closes }) => {
    native.reduceMotion = false;
    await act(async () => root.render(<SessionListDrawer {...props} />));
    const [progress, dragX] = native.values;
    native.gesture.start!();
    native.gesture.update!({ translationX: -100 });
    native.gesture.end!({ translationX: -100, velocityX: 0 });
    expect(props.onClose).not.toHaveBeenCalled();
    // The first 100-point swipe is rebounding and still leaves 80 points hidden.
    progress!.value = 0.75;
    native.gesture.start!();
    native.gesture.update!({ translationX });
    native.gesture.end!({ translationX, velocityX });
    expect(props.onClose).toHaveBeenCalledTimes(closes ? 1 : 0);
    if (!closes) {
      expect(progress!.value).toBe(1);
      expect(dragX!.value).toBe(0);
    }
  });
  // User request 2026-11-06: the floating drawer's edge drags the shared width like the
  // side column, without showing a grip. The handle is a sibling of the panel, never the close gesture's child.
  it('resizes the floating drawer from its edge and drops the handle when docked or closing', async () => {
    native.reduceMotion = false;
    const onResize = vi.fn();
    const resize = { bounds: { min: 300, max: 648 }, onResize };
    await act(async () => root.render(<SessionListDrawer {...props} resize={resize} />));
    const divider = container.querySelector('[data-testid="session.paneDivider"]');
    expect(divider).not.toBeNull();
    expect(container.querySelector('[data-testid="sessionDrawer.panel"]')?.contains(divider)).toBe(false);
    expect(native.divider).toMatchObject({ width: 320, left: 320, bounds: resize.bounds, grip: false });
    native.divider.onResize(480);
    expect(onResize).toHaveBeenCalledWith(480);
    expect(divider?.parentElement?.getAttribute('data-pointer-events')).toBe('box-none');
    // Mid-exit the drawer is still mounted; its edge must not take a new drag.
    await act(async () => root.render(<SessionListDrawer {...props} resize={resize} open={false} />));
    expect(container.querySelector('[data-testid="session.paneDivider"]')?.parentElement
      ?.getAttribute('data-pointer-events')).toBe('none');
    await act(async () => root.render(<SessionListDrawer {...props} resize={resize} persistent />));
    expect(container.querySelector('[data-testid="session.paneDivider"]')).toBeNull();
  });
  // User request 2026-11-06 (revised): the edge only resizes, elastic past its bounds;
  // the dimmed area takes the leaving gestures. Right stretches, then becomes Home mid-drag.
  it('stretches elastically from the edge and springs back without leaving', async () => {
    const resize = { bounds: { min: 300, max: 529 }, onResize: vi.fn(), home: { width: 669, open: vi.fn() } };
    await act(async () => root.render(<SessionListDrawer {...props} resize={resize} />));
    const stretch = native.values[4]!;
    native.divider.elastic.onStretch(60);
    expect(stretch.value).toBeCloseTo(rubberBand(60));
    expect(rubberBand(60)).toBeGreaterThan(0);
    expect(rubberBand(60)).toBeLessThan(60);
    expect(rubberBand(10_000)).toBeLessThan(120);
    expect(rubberBand(-60)).toBeCloseTo(-rubberBand(60));
    native.divider.elastic.onSettle();
    expect(stretch.value).toBe(0);
    expect(resize.home.open).not.toHaveBeenCalled();
  });
  it('turns the list into Home mid-drag on the dimmed area, without a slide-out', async () => {
    native.reduceMotion = false;
    const openHome = vi.fn();
    const resize = { bounds: { min: 300, max: 529 }, onResize: vi.fn(), home: { width: 669, open: openHome } };
    await act(async () => root.render(<SessionListDrawer {...props} resize={resize} />));
    const [progress, dragX, , , stretch] = native.values;
    const scrim = native.pans.scrim!;
    scrim.start!({ absoluteX: 400, translationX: 0 });
    scrim.update!({ translationX: 40 });
    expect(stretch!.value).toBeCloseTo(rubberBand(40));
    expect(dragX!.value).toBe(0);
    expect(openHome).not.toHaveBeenCalled();
    await act(async () => scrim.update!({ translationX: 100 }));
    expect(openHome).toHaveBeenCalledOnce();
    expect(native.home?.width).toBe(669);
    scrim.update!({ translationX: 140 });
    scrim.end!({ translationX: 140, velocityX: 0 });
    expect(openHome).toHaveBeenCalledOnce();
    expect(progress!.value).toBe(1);
    await act(async () => root.render(<SessionListDrawer {...props} resize={resize} open={false} />));
    expect(container.querySelector('[data-testid="sessionDrawer.overlay"]')).toBeNull();
    // Reopening starts from the stored width and animates normally again.
    await act(async () => root.render(<SessionListDrawer {...props} resize={resize} />));
    expect(native.home?.width).toBe(320);
    await act(async () => root.render(<SessionListDrawer {...props} resize={resize} open={false} />));
    expect(container.querySelector('[data-testid="sessionDrawer.overlay"]')).not.toBeNull();
  });
  it('slides away left on the dimmed area and settles back after a short drag either way', async () => {
    const resize = { bounds: { min: 300, max: 529 }, onResize: vi.fn(), home: { width: 669, open: vi.fn() } };
    await act(async () => root.render(<SessionListDrawer {...props} resize={resize} />));
    const [progress, dragX, , , stretch] = native.values;
    const scrim = native.pans.scrim!;
    scrim.start!({ absoluteX: 600, translationX: 0 });
    scrim.update!({ translationX: -20 });
    expect(dragX!.value).toBe(-20);
    scrim.end!({ translationX: -20, velocityX: 0 });
    expect(props.onClose).not.toHaveBeenCalled();
    expect(progress!.value).toBe(1);
    expect(dragX!.value).toBe(0);
    // Starting near the screen edge, Home sits closer: 0.6 of the 69pt of room.
    scrim.start!({ absoluteX: 600, translationX: 0 });
    scrim.update!({ translationX: 30 });
    scrim.end!({ translationX: 30, velocityX: 0 });
    expect(stretch!.value).toBe(0);
    expect(resize.home.open).not.toHaveBeenCalled();
    scrim.start!({ absoluteX: 600, translationX: 0 });
    scrim.update!({ translationX: -150 });
    scrim.end!({ translationX: -150, velocityX: 0 });
    expect(props.onClose).toHaveBeenCalledOnce();
  });
  // User request 2026-11-08: selecting a task must visibly slide the floating
  // list left, just like dismissing it. The old instant-close test missed this
  // visual lifetime; unit tier uses a real drawer with fake animation timers.
  it('keeps a selected-task exit visible until the slide finishes, then releases navigation once', async () => {
    native.reduceMotion = false;
    const onClosed = vi.fn(() => expect(container.querySelector('[data-testid="sessionDrawer.overlay"]')).toBeNull());
    await act(async () => root.render(<SessionListDrawer {...props} onClosed={onClosed} />));
    await act(async () => root.render(<SessionListDrawer {...props} onClosed={onClosed} open={false} />));
    expect(container.querySelector('[data-testid="sessionDrawer.overlay"]')).not.toBeNull();
    expect(onClosed).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(motionDuration.exit - 1));
    expect(container.querySelector('[data-testid="sessionDrawer.overlay"]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(1));
    expect(onClosed).toHaveBeenCalledOnce();
    await act(async () => vi.runAllTimers());
    expect(onClosed).toHaveBeenCalledOnce();
  });
  it('releases a quarter-open cancelled pull before a full exit would finish', async () => {
    native.reduceMotion = false;
    let motion: ReturnType<typeof useSessionListDrawerMotion>;
    function Probe({ open }: { open: boolean }) {
      motion = useSessionListDrawerMotion(1);
      return <SessionListDrawer {...props} open={open} motion={motion} />;
    }
    await act(async () => root.render(<Probe open />));
    motion!.progress.value = 0.25;
    await act(async () => root.render(<Probe open={false} />));
    expect(props.onClosed).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(50));
    expect(container.querySelector('[data-testid="sessionDrawer.overlay"]')).toBeNull();
    expect(props.onClosed).toHaveBeenCalledOnce();
  });
  it('unmounts the invisible blocker even when the animation never calls completion', async () => {
    native.reduceMotion = false;
    await act(async () => root.render(<SessionListDrawer {...props} />));
    const content = () => container.querySelector('[data-testid="sessionDrawer.panel"]')!.firstElementChild!;
    expect(content().getAttribute('data-pointer-events')).toBe('auto');
    await act(async () => root.render(<SessionListDrawer {...props} open={false} />));
    expect(container.querySelector('[data-testid="sessionDrawer.overlay"]')).not.toBeNull();
    // PR #7079: RN's native input/accessibility contract must stop a second selection during
    // exit; otherwise it updates lastTeammate while the coordinator retains the first route.
    // Existing close-settlement coverage only checked eventual unmount. Unit tier, fake clock.
    expect(content().getAttribute('data-pointer-events')).toBe('none');
    expect(content().getAttribute('data-accessibility-hidden')).toBe('true');
    expect(content().getAttribute('data-accessibility-importance')).toBe('no-hide-descendants');
    expect(props.onClosed).not.toHaveBeenCalled();
    // withTiming deliberately never delivers a completion in this test driver.
    await act(async () => vi.advanceTimersByTime(motionDuration.exit));
    expect(container.querySelector('[data-testid="sessionDrawer.overlay"]')).toBeNull();
    expect(native.unmounts).toBe(1);
    expect(props.onClosed).toHaveBeenCalledOnce();
  });
  it('cancels pending close settlement when reopened, then closes the new presentation once', async () => {
    native.reduceMotion = false;
    await act(async () => root.render(<SessionListDrawer {...props} />));
    await act(async () => root.render(<SessionListDrawer {...props} open={false} />));
    await act(async () => vi.advanceTimersByTime(motionDuration.exit / 2));
    await act(async () => root.render(<SessionListDrawer {...props} />));
    await act(async () => vi.advanceTimersByTime(motionDuration.exit));
    expect(container.querySelector('[data-testid="sessionDrawer.overlay"]')).not.toBeNull();
    const content = container.querySelector('[data-testid="sessionDrawer.panel"]')!.firstElementChild!;
    expect(content.getAttribute('data-pointer-events')).toBe('auto');
    expect(content.getAttribute('data-accessibility-hidden')).toBe('false');
    expect(content.getAttribute('data-accessibility-importance')).toBe('auto');
    expect(props.onClosed).not.toHaveBeenCalled();
    await act(async () => root.render(<SessionListDrawer {...props} open={false} />));
    await act(async () => vi.advanceTimersByTime(motionDuration.exit));
    expect(props.onClosed).toHaveBeenCalledOnce();
    expect(native.unmounts).toBe(1);
  });
  it('hosts the complete Home with container width, selection and the navigation coordinator', async () => {
    await act(async () => root.render(<SessionListDrawer {...props} persistent newSessionInSystemBar />));
    expect(native.home).toMatchObject({ width: 320, currentSessionId: 's1', newSessionInSystemBar: true,
      onSelectSession: props.onSelectSession, runNavigation: props.runNavigation });
    expect(container.querySelector('[data-testid="sessionDrawer.home"]')).toBeNull();
    expect(container.querySelector('[data-testid="sessionDrawer.scrim"]')).toBeNull();
  });
  it('keeps the Home menu in the temporary panel, puts New task in its header, and closes from the scrim', async () => {
    await act(async () => root.render(<SessionListDrawer {...props} />));
    expect(container.querySelector('[data-testid="sessionDrawer.home"]')).toBeNull();
    expect(native.home).not.toHaveProperty('onDismiss');
    expect(native.home?.newSessionInHeader).toBe(true);
    (container.querySelector('[data-testid="sessionDrawer.scrim"]') as HTMLElement).click();
    expect(props.onClose).toHaveBeenCalledOnce();
  });
  it('keeps Home mounted while changing task, width, or drawer presentation', async () => {
    await act(async () => root.render(<SessionListDrawer {...props} persistent />));
    await act(async () => root.render(<SessionListDrawer {...props} currentSessionId="s2" width={360} persistent={false} />));
    expect(native.home).toMatchObject({ width: 360, currentSessionId: 's2' });
    expect(native.mounts).toBe(1); expect(native.unmounts).toBe(0);
  });
  it('collapses a persistent column without a modal exit or a leftover scrim', async () => {
    await act(async () => root.render(<SessionListDrawer {...props} persistent />));
    await act(async () => root.render(<SessionListDrawer {...props} persistent={false} open={false} width={0} />));
    // Rotation must remove the column without rendering its Home at 1pt first.
    expect(native.widths.every(width => width >= 320)).toBe(true);
    expect(container.querySelector('[data-testid="sessionDrawer.overlay"]')).toBeNull();
    expect(props.onClosed).not.toHaveBeenCalled();
    expect(native.unmounts).toBe(1);
  });
  it('finishes an overlay exit after unmount so queued navigation cannot race its native views', async () => {
    await act(async () => root.render(<SessionListDrawer {...props} />));
    await act(async () => root.render(<SessionListDrawer {...props} open={false} />));
    expect(native.unmounts).toBe(1);
    expect(props.onClosed).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="sessionDrawer.overlay"]')).toBeNull();
  });
});

// User request 2026-11-06: in floating mode a rightward swipe on the task pulls the
// list out under the finger instead of going back; too short a pull settles back.
describe('pulling the floating list out from the task', () => {
  it('follows the finger, opens past a third or a flick, and otherwise cancels', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    native.values = []; native.pans = {};
    const onOpen = vi.fn(), onCancel = vi.fn(), onSettle = vi.fn();
    let motion: ReturnType<typeof useSessionListDrawerMotion>;
    function Probe() {
      motion = useSessionListDrawerMotion();
      useSessionListDrawerOpenGesture({ motion, enabled: true, width: 320, onOpen, onCancel, onSettle });
      return null;
    }
    const host = document.createElement('div'), probeRoot = createRoot(host);
    await act(async () => probeRoot.render(<Probe />));
    const pull = native.pans.open!;
    pull.start!({ translationX: 24 });
    expect(motion!.progress.value).toBeCloseTo(24 / 320);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(motion!.tracking.value).toBe(true);
    pull.update!({ translationX: 96 });
    expect(motion!.progress.value).toBeCloseTo(0.3);
    pull.end!({ translationX: 96, velocityX: 0 });
    pull.finalize!();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSettle).toHaveBeenCalledOnce();
    pull.start!({ translationX: 16 });
    pull.update!({ translationX: 200 });
    pull.end!({ translationX: 200, velocityX: 0 });
    expect(motion!.progress.value).toBe(1);
    expect(onCancel).toHaveBeenCalledOnce();
    pull.start!({ translationX: 16 });
    pull.update!({ translationX: 40 });
    pull.end!({ translationX: 40, velocityX: 1200 });
    expect(motion!.progress.value).toBe(1);
    // A gesture cancelled by the system while pulling lets the list go.
    pull.start!({ translationX: 16 });
    pull.finalize!();
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onSettle).toHaveBeenCalledTimes(4);
    await act(async () => probeRoot.unmount());
  });
});
