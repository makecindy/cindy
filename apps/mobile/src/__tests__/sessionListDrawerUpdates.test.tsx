vi.mock('@/session/SessionOptionsExpoSheet', () => ({ SessionOptionsPresenter: () => null }));
vi.mock('@/session/RenameSessionModal', () => ({ RenameSessionModal: () => null }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'test-owner' } }) }));
// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rubberBand, SessionListDrawer, useSessionListDrawerMotion, useSessionListDrawerOpenGesture } from '@/session/SessionListDrawer';
import { motionDuration } from '@/theme/tokens';
import type { MobileHomeProps } from '@/session/HomeSurface';
const native = vi.hoisted(() => ({ home: null as MobileHomeProps | null, mounts: 0, unmounts: 0, reduceMotion: true,
  values: [] as { value: any }[], divider: null as any, pans: {} as Record<string, Record<string, (event?: any) => void>>, gesture: {} as Record<string, (event?: any) => void>, cancel: vi.fn() }));
vi.mock('@/session/HomeSurface', async () => {
  const { useEffect } = await import('react');
  return { MobileHome: (props: MobileHomeProps) => {
    native.home = props;
    useEffect(() => { native.mounts++; return () => { native.unmounts++; }; }, []);
    return null;
  } };
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
    withTiming: (value: number) => value,
  };
});
vi.mock("@/platform/gestureHandler", () => ({
  GestureDetector: ({ children }: { children: ReactNode }) => children,
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
}));
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
    native.home = null; native.mounts = 0; native.unmounts = 0;
    native.values = []; native.gesture = {}; native.divider = null; native.pans = {};
    native.reduceMotion = true;
    vi.clearAllMocks();
    vi.useFakeTimers();
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
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
    const stretch = native.values[3]!;
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
    const [progress, dragX, , stretch] = native.values;
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
    const [progress, dragX, , stretch] = native.values;
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
    await act(async () => root.render(<SessionListDrawer {...props} persistent={false} open={false} />));
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
    pull.start!();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(motion!.tracking.value).toBe(true);
    pull.update!({ translationX: 96 });
    expect(motion!.progress.value).toBeCloseTo(0.3);
    pull.end!({ translationX: 96, velocityX: 0 });
    pull.finalize!();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSettle).toHaveBeenCalledOnce();
    pull.start!();
    pull.update!({ translationX: 200 });
    pull.end!({ translationX: 200, velocityX: 0 });
    expect(motion!.progress.value).toBe(1);
    expect(onCancel).toHaveBeenCalledOnce();
    pull.start!();
    pull.update!({ translationX: 40 });
    pull.end!({ translationX: 40, velocityX: 1200 });
    expect(motion!.progress.value).toBe(1);
    // A gesture cancelled by the system while pulling lets the list go.
    pull.start!();
    pull.finalize!();
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onSettle).toHaveBeenCalledTimes(4);
    await act(async () => probeRoot.unmount());
  });
});
