// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeChromeDrawer } from '@/session/HomeChromeDrawer';

/**
 * HomeChromeDrawer 行为测试:Android 独立窗口(Modal)的挂载、返回键接管、
 * 退场生命周期与关闭后动作的执行时机。此前只有源码字符串断言,挂载/返回键/
 * 关闭后导航都无回归覆盖(伙伴页面测试还把整个抽屉 mock 掉了)。
 */
const h = vi.hoisted(() => ({
  timing: [] as Array<(finished: boolean) => void>,
  emit: vi.fn(),
  modal: null as Record<string, any> | null,
  reduceMotion: false,
  platform: {
    OS: 'android' as 'android' | 'ios',
    select: (values: Record<string, unknown>) => values.android ?? values.default,
  },
  auth: {
    user: null as null | Record<string, unknown>,
    accountGeneration: 1,
    logout: vi.fn(),
    beginAddAccount: vi.fn(),
  },
}));

vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  type Props = {
    children?: ReactNode;
    testID?: string;
    onPress?: () => void;
    accessibilityState?: { busy?: boolean; disabled?: boolean };
  };
  const View = ({ children, testID, onPress }: Props) =>
    createElement('div', { 'data-testid': testID, onClick: onPress }, children);
  return {
    View,
    Pressable: View,
    Image: () => null,
    AccessibilityInfo: { setAccessibilityFocus: vi.fn() },
    Alert: { alert: vi.fn() },
    DeviceEventEmitter: { emit: h.emit },
    findNodeHandle: () => null,
    Modal: ({ children, ...props }: Props & Record<string, unknown>) => {
      h.modal = props;
      return createElement('div', { 'data-testid': 'rn.modal' }, children);
    },
    Platform: h.platform,
    StyleSheet: {
      create: (value: unknown) => value,
      hairlineWidth: 1,
      absoluteFill: {},
    },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
  };
});

vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  const { View } = await import('react-native');
  return {
    default: { View },
    useSharedValue: (value: number) => useRef({ value }).current,
    useAnimatedStyle: () => ({}),
    Easing: { bezier: () => undefined },
    runOnJS: (fn: unknown) => fn,
    runOnUI: (fn: (...args: never[]) => void) => fn,
    cancelAnimation: () => {},
    // 退场完成回调由测试手动投递,用来模拟退出动画结束。
    withTiming: (value: number, _config?: unknown, done?: (finished: boolean) => void) => {
      if (done) h.timing.push(done);
      return value;
    },
  };
});

vi.mock('react-native-screens', async () => {
  const { createElement } = await import('react');
  return {
    FullWindowOverlay: ({ children }: { children?: ReactNode }) =>
      createElement('div', { 'data-testid': 'rn.fullWindowOverlay' }, children),
  };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ left: 0, top: 0, bottom: 0 }),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('lucide-react-native', () => ({
  LogOut: () => null, Monitor: () => null, Search: () => null, Settings: () => null, UsersRound: () => null,
}));

vi.mock('@/components/AppText', async () => ({ Text: (await import('react-native')).View }));

vi.mock('@/theme', () => ({ useThemedStyles: () => ({}), useTheme: () => ({ colors: {} }) }));

vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => h.reduceMotion }));

vi.mock('@/platform/gestureHandler', () => {
  const chain = {
    enabled: () => chain, activeOffsetX: () => chain, failOffsetX: () => chain,
    failOffsetY: () => chain, onStart: () => chain, onUpdate: () => chain, onEnd: () => chain, onFinalize: () => chain,
  };
  return {
    Gesture: { Pan: () => chain },
    GestureDetector: ({ children }: { children?: ReactNode }) => children,
    GestureHandlerRootView: ({ children }: { children?: ReactNode }) => children,
  };
});

// Keep native device polling outside the drawer window/lifecycle fixture.
vi.mock('@/plugins/PluginMenuUnreadDot', () => ({ PluginMenuUnreadDot: () => null }));
vi.mock('@/session/HomeModeSwitch', () => ({ HomeModeSwitch: () => null }));

vi.mock('@/auth/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('expo-router', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/utils/useGuardedPush', () => ({ useGuardedPush: () => vi.fn() }));
vi.mock('@/device-link/remoteStatus', () => ({ formatRemoteError: String }));
vi.mock('@/session/AccountSwitcherSheet', () => ({ AccountSwitcherSheet: () => null }));
vi.mock('@/session/remoteSessionStore', () => ({
  remoteSessionStore: { subscribe: () => () => {}, getSessions: () => [], isSessionRunning: () => false },
}));
vi.mock('@/session/useTeammateNavigation', () => ({ useTeammateNavigation: () => ({ chooseMode: vi.fn() }) }));

const drawerProps = (over: Partial<Parameters<typeof HomeChromeDrawer>[0]> = {}) => ({
  onClose: vi.fn(),
  onClosed: vi.fn(),
  onOpenSearch: vi.fn(),
  onOpenAccounts: vi.fn(),
  onOpenDevices: vi.fn(),
  onOpenSettings: vi.fn(),
  onLogout: vi.fn(),
  open: true,
  user: null,
  ...over,
});

const finishTiming = async () => {
  const pending = h.timing.splice(0);
  await act(async () => pending.forEach((done) => done(true)));
};

describe('Android home drawer window and close lifecycle', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    h.modal = null;
    h.timing.splice(0);
    h.reduceMotion = false;
    h.platform.OS = 'android';
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('mounts the drawer in its own transparent window instead of an in-route overlay', async () => {
    await act(async () => root.render(<HomeChromeDrawer {...drawerProps()} />));
    // Android 走独立 Dialog 窗口:整窗透明、状态栏/导航栏可穿透,抽屉自己播动画。
    expect(h.modal).toMatchObject({
      animationType: 'none',
      navigationBarTranslucent: true,
      statusBarTranslucent: true,
      transparent: true,
      visible: true,
    });
    expect(typeof h.modal!.onRequestClose).toBe('function');
    expect(container.querySelector('[data-testid="rn.modal"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="home.chromeDrawer"]')).not.toBeNull();
  });

  it('keeps iOS on the FullWindowOverlay window with no Modal', async () => {
    h.platform.OS = 'ios';
    await act(async () => root.render(<HomeChromeDrawer {...drawerProps()} />));
    expect(h.modal).toBeNull();
    expect(container.querySelector('[data-testid="rn.fullWindowOverlay"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="home.chromeDrawer"]')).not.toBeNull();
  });

  it('turns Android back into close while open, but forwards it to the app during the exit animation', async () => {
    const props = drawerProps();
    await act(async () => root.render(<HomeChromeDrawer {...props} />));
    await act(async () => h.modal!.onRequestClose());
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(h.emit).not.toHaveBeenCalled();
    // 关闭后退场动画期间:back 属于底层页面,不得再调 onClose(会清掉调用方
    // 记下的待执行动作),而是把事件补发回 app 的返回键链。
    await act(async () => root.render(<HomeChromeDrawer {...props} open={false} />));
    await act(async () => h.modal!.onRequestClose());
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(h.emit).toHaveBeenCalledExactlyOnceWith('hardwareBackPress');
    expect(props.onClosed).not.toHaveBeenCalled();
  });

  it('keeps the drawer mounted until the exit animation ends, then reports onClosed after unmount', async () => {
    const props = drawerProps();
    await act(async () => root.render(<HomeChromeDrawer {...props} />));
    await act(async () => root.render(<HomeChromeDrawer {...props} open={false} />));
    // 退场中:窗口还在播离场动画,不能提前卸载,也不提前回调 onClosed。
    expect(h.modal).not.toBeNull();
    expect(container.querySelector('[data-testid="home.chromeDrawer"]')).not.toBeNull();
    expect(props.onClosed).not.toHaveBeenCalled();
    await finishTiming();
    expect(container.querySelector('[data-testid="rn.modal"]')).toBeNull();
    expect(container.querySelector('[data-testid="home.chromeDrawer"]')).toBeNull();
    // onClosed 只在窗口真正卸载后触发一次:调用方的延后动作以此为信号执行。
    expect(props.onClosed).toHaveBeenCalledOnce();
  });
});
