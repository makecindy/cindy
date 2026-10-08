// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeChromeDrawer } from '@/session/HomeChromeDrawer';

type GestureEvent = { translationX: number; velocityX: number };
const driver = vi.hoisted(() => ({
  reduceMotion: false as boolean | null,
  layout: undefined as (() => void) | undefined,
  gestures: {} as Record<string, (event: GestureEvent, success: boolean) => void>,
  values: [] as Array<{ value: number | boolean }>,
  animations: [] as Array<{ to: number; complete?: (finished: boolean) => void }>,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const View = ({ children, testID, onLayout, onPress }: {
    children?: ReactNode; testID?: string; onLayout?: () => void; onPress?: () => void;
  }) => {
    if (testID === 'home.chromeMenu.panel') driver.layout = onLayout;
    return createElement('div', { 'data-testid': testID, onClick: onPress }, children);
  };
  return {
    View, Pressable: View,
    Image: ({ source }: { source: { uri: string } }) => createElement('img', { src: source.uri }),
    AccessibilityInfo: { setAccessibilityFocus: vi.fn() },
    BackHandler: { addEventListener: () => ({ remove() {} }) },
    findNodeHandle: () => null,
    Platform: { OS: 'ios' },
    StyleSheet: { create: (value: unknown) => value, absoluteFill: {}, hairlineWidth: 1 },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
  };
});
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  const { View } = await import('react-native');
  return {
    default: { View },
    useSharedValue: (value: number | boolean) => {
      const ref = useRef<{ value: number | boolean } | null>(null);
      if (!ref.current) { ref.current = { value }; driver.values.push(ref.current); }
      return ref.current;
    },
    useAnimatedStyle: () => ({}),
    Easing: { bezier: () => undefined },
    cancelAnimation: vi.fn(),
    runOnJS: (fn: unknown) => fn,
    runOnUI: (fn: unknown) => fn,
    withTiming: (to: number, _config: unknown, complete?: (finished: boolean) => void) => {
      driver.animations.push({ to, complete });
      return to;
    },
  };
});
vi.mock('@/platform/gestureHandler', async () => {
  const { View } = await import('react-native');
  return {
    GestureHandlerRootView: View,
    GestureDetector: ({ children }: { children: ReactNode }) => children,
    Gesture: { Pan: () => {
      const chain: Record<string, (...args: any[]) => unknown> = {};
      for (const name of ['enabled', 'activeOffsetX', 'failOffsetX', 'failOffsetY']) chain[name] = () => chain;
      for (const name of ['onStart', 'onUpdate', 'onEnd', 'onFinalize']) {
        chain[name] = callback => { driver.gestures[name] = callback; return chain; };
      }
      return chain;
    } },
  };
});
vi.mock('react-native-screens', () => ({ FullWindowOverlay: ({ children }: { children: ReactNode }) => children }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ left: 0, top: 0, bottom: 0 }) }));
vi.mock('lucide-react-native', () => Object.fromEntries(
  ['Building2', 'LogOut', 'Monitor', 'Puzzle', 'Search', 'Settings', 'UsersRound'].map(name => [name, () => null]),
));
vi.mock('@/components/AppText', async () => ({ Text: (await import('react-native')).View }));
vi.mock('@/theme', () => ({ useThemedStyles: () => ({}), useTheme: () => ({ colors: {} }) }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => driver.reduceMotion }));
// The drawer tests navigation/animation; plugin polling belongs to its own boundary.
vi.mock('@/plugins/PluginMenuUnreadDot', () => ({ PluginMenuUnreadDot: () => null }));
vi.mock('@/session/HomeModeSwitch', () => ({ HomeModeSwitch: () => null }));

describe('home navigation drawer', () => {
  let root: Root;
  let container: HTMLDivElement;
  const props = {
    open: true, onClose: vi.fn(), onClosed: vi.fn(), onOpenSearch: vi.fn(),
    onOpenAccounts: vi.fn(), onOpenDevices: vi.fn(), onOpenSettings: vi.fn(), onLogout: vi.fn(),
    user: { name: 'Kiro', email: 'kiro@example.com', membershipKind: 'org' as const,
      orgName: 'Example Company', orgLogoUrl: 'https://example.com/org.png', avatar: 'https://example.com/person.png' },
  };
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    driver.reduceMotion = false; driver.layout = undefined;
    driver.values = []; driver.animations = []; driver.gestures = {};
    container = document.createElement('div'); document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const layout = async () => { await act(async () => driver.layout?.()); };
  const gesture = (name: string, translationX = 0, velocityX = 0, success = true) =>
    driver.gestures[name]({ translationX, velocityX }, success);

  it('keeps the user first with a default letter avatar and only a small organization image', async () => {
    await act(async () => root.render(<HomeChromeDrawer {...props} />));
    const account = container.querySelector('[data-testid="home.chromeDrawer.account"]')!;
    expect(account.textContent).toBe('KKirokiro@example.comExample Company');
    expect([...account.querySelectorAll('img')].map(image => image.src)).toEqual([props.user.orgLogoUrl]);
    await act(async () => root.render(<HomeChromeDrawer {...props} user={{ ...props.user, membershipKind: 'personal' }} />));
    expect(account.textContent).not.toContain('Example Company');
    expect(account.querySelector('img')).toBeNull();
  });

  it('waits for native layout before entrance and ignores stale close completion after reopening', async () => {
    await act(async () => root.render(<HomeChromeDrawer {...props} />));
    expect(driver.animations).toHaveLength(0);
    expect(driver.values[0].value).toBe(0);
    await layout();
    expect(driver.animations.at(-1)?.to).toBe(1);
    await act(async () => root.render(<HomeChromeDrawer {...props} open={false} />));
    const closing = driver.animations.at(-1)!;
    expect(closing.to).toBe(0);
    expect(props.onClosed).not.toHaveBeenCalled();
    await act(async () => root.render(<HomeChromeDrawer {...props} />));
    await act(async () => closing.complete?.(true));
    expect(container.querySelector('[data-testid="home.chromeDrawer"]')).not.toBeNull();
    expect(props.onClosed).not.toHaveBeenCalled();
    await act(async () => root.render(<HomeChromeDrawer {...props} open={false} />));
    await act(async () => driver.animations.at(-1)?.complete?.(true));
    expect(container.querySelector('[data-testid="home.chromeDrawer"]')).toBeNull();
    expect(props.onClosed).toHaveBeenCalledOnce();
  });

  it('tracks interrupted entrance from its current position and recovers cancelled drags', async () => {
    await act(async () => root.render(<HomeChromeDrawer {...props} />));
    await layout();
    driver.values[0].value = 0.75;
    gesture('onStart'); gesture('onUpdate', -32);
    expect(driver.values[0].value).toBeCloseTo(0.65);
    gesture('onFinalize', 0, 0, false);
    expect(driver.values[0].value).toBe(1);
    const count = driver.animations.length;
    gesture('onFinalize', 0, 0, false);
    expect(driver.animations).toHaveLength(count);
    gesture('onStart'); gesture('onUpdate', -160); gesture('onEnd', -160);
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it.each([true, null])('does not animate opening, snap-back or closing when reduce motion is %s', async reduceMotion => {
    driver.reduceMotion = reduceMotion;
    await act(async () => root.render(<HomeChromeDrawer {...props} />));
    await layout();
    gesture('onStart'); gesture('onUpdate', -16); gesture('onEnd', -16);
    expect(driver.values[0].value).toBe(1);
    await act(async () => root.render(<HomeChromeDrawer {...props} open={false} />));
    expect(driver.animations).toHaveLength(0);
    expect(props.onClosed).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="home.chromeDrawer"]')).toBeNull();
  });
});
