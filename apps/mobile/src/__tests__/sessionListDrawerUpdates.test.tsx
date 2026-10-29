vi.mock('@/session/SessionOptionsExpoSheet', () => ({ SessionOptionsPresenter: () => null }));
vi.mock('@/session/RenameSessionModal', () => ({ RenameSessionModal: () => null }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'test-owner' } }) }));
// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionListDrawer } from '@/session/SessionListDrawer';
import { motionDuration } from '@/theme/tokens';
import type { MobileHomeProps } from '@/session/HomeSurface';
const native = vi.hoisted(() => ({ home: null as MobileHomeProps | null, mounts: 0, unmounts: 0, reduceMotion: true,
  values: [] as { value: number }[], gesture: {} as Record<string, (event?: any) => void>, cancel: vi.fn() }));
vi.mock('@/session/HomeSurface', async () => {
  const { useEffect } = await import('react');
  return { MobileHome: (props: MobileHomeProps) => {
    native.home = props;
    useEffect(() => { native.mounts++; return () => { native.unmounts++; }; }, []);
    return null;
  } };
});
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
    Pan: () => {
      const chain = {
        enabled: () => chain,
        activeOffsetX: () => chain,
        failOffsetX: () => chain,
        failOffsetY: () => chain,
        onStart: (callback: () => void) => { native.gesture.start = callback; return chain; },
        onUpdate: (callback: (event: any) => void) => { native.gesture.update = callback; return chain; },
        onEnd: (callback: (event: any) => void) => { native.gesture.end = callback; return chain; },
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
    native.values = []; native.gesture = {};
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
