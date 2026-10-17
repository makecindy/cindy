// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SheetModal } from '@/session/SheetModal';

const native = vi.hoisted(() => ({
  platform: { OS: 'ios' },
  keyboard: vi.fn((enabled: boolean) => (enabled
    ? native.keyboardState
    : { height: 0, visible: false, screenY: null, transition: { current: null } })),
  keyboardState: { height: 0, visible: false, screenY: null as number | null, transition: { current: null } },
  viewStyles: [] as unknown[],
  layouts: [] as ((height: number) => void)[],
  window: { width: 390, height: 844 },
  screen: { width: 390, height: 844 },
  finish: undefined as undefined | ((result: { finished: boolean }) => void),
}));
vi.mock('react-native', () => {
  const View = ({ children, style, onLayout }: { children?: ReactNode; style?: unknown; onLayout?: (event: unknown) => void }) => {
    native.viewStyles.push(style);
    if (onLayout) native.layouts.push((height) => onLayout({ nativeEvent: { layout: { height } } }));
    return <div>{children}</div>;
  };
  return {
    View, KeyboardAvoidingView: View, Pressable: View,
    Modal: ({ visible, children }: { visible: boolean; children: ReactNode }) => visible ? <div>{children}</div> : null,
    Platform: native.platform,
    Dimensions: { get: (key: string) => (key === 'screen' ? native.screen : native.window) },
    useWindowDimensions: () => native.window,
    StyleSheet: { absoluteFill: {}, create: (value: unknown) => value },
    Easing: { bezier: () => 0 },
    Animated: {
      View,
      Value: class { interpolate() { return 0; } },
      timing: () => ({ start: (finish: typeof native.finish) => { native.finish = finish; } }),
    },
  };
});
vi.mock('@/session/useMobileKeyboardState', () => ({ useMobileKeyboardState: native.keyboard }));
vi.mock('@/session/NativeBottomSheet', () => ({ NativeBottomSheet: () => null }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => false }));
vi.mock('@/theme', () => ({ useThemedStyles: () => ({}) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/platform/AdaptiveWindowContext', () => ({
  useAdaptiveWindow: () => ({ height: 844, width: 390, regions: [], barEdge: 'none', insets: { left: 0, right: 0, bottom: 0 } }),
  PaneViewportProvider: ({ children }: { children: ReactNode }) => children,
  FloatingSheetContext: { Provider: ({ children }: { children: ReactNode }) => children },
}));
vi.mock('@/platform/modalLayout', () => ({ modalLayout: () => ({ region: { x: 0, y: 0, width: 390, height: 844 }, floating: false }) }));
vi.mock('@/platform/gestureHandler', () => ({ GestureHandlerRootView: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/session/BlurBackdrop', () => ({ BlurBackdrop: () => null }));

let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  native.platform.OS = 'ios';
  native.keyboard.mockClear();
  native.keyboardState = { height: 0, visible: false, screenY: null, transition: { current: null } };
  native.viewStyles = [];
  native.layouts = [];
  native.window = { width: 390, height: 844 };
  native.screen = { width: 390, height: 844 };
  native.finish = undefined;
  root = createRoot(document.createElement('div'));
});
afterEach(() => act(() => root.unmount()));
function render(visible: boolean, keyboardAvoiding = true) {
  native.viewStyles = [];
  native.layouts = [];
  act(() => root.render(<SheetModal visible={visible} keyboardAvoiding={keyboardAvoiding}
    onRequestClose={() => {}} onBackdropPress={() => {}}>content</SheetModal>));
}
function enabled() { return native.keyboard.mock.calls.at(-1)?.[0]; }
function lift() {
  return native.viewStyles.flatMap((style) => {
    if (!style || typeof style !== 'object') return [];
    if (Array.isArray(style)) return style;
    return [style];
  }).reduce<number>((found, style) => (
    style && typeof style === 'object' && typeof (style as { paddingBottom?: unknown }).paddingBottom === 'number'
      ? (style as { paddingBottom: number }).paddingBottom
      : found
  ), 0);
}
function layout(height: number) {
  const pending = native.layouts;
  native.layouts = [];
  act(() => pending.forEach((measure) => measure(height)));
}
function showAndroidKeyboard(screenY: number, height = 300) {
  native.platform.OS = 'android';
  native.keyboardState = { height, visible: true, screenY, transition: { current: null } };
}

it('subscribes only for an avoiding sheet, through closing and rapid reopening', () => {
  render(false);
  expect(enabled()).toBe(false);
  render(true);
  expect(enabled()).toBe(true);
  render(false);
  expect(enabled()).toBe(true);
  const oldFinish = native.finish;
  render(true);
  act(() => oldFinish?.({ finished: true }));
  expect(enabled()).toBe(true);
  render(false);
  act(() => native.finish?.({ finished: true }));
  expect(enabled()).toBe(false);
});

it('never subscribes action-only sheets', () => {
  render(true, false);
  expect(enabled()).toBe(false);
  native.platform.OS = 'android';
  render(true, false);
  expect(enabled()).toBe(false);
});

it('tracks the Android keyboard so edge-to-edge windows can be avoided', () => {
  // Android 不再只靠 adjustResize:没有缩窗时要自己让位,因此必须订阅键盘。
  native.platform.OS = 'android';
  render(true);
  expect(enabled()).toBe(true);
});

it('lifts an Android sheet that the system did not move and keeps its own height budget', () => {
  showAndroidKeyboard(844);
  render(true);
  expect(lift()).toBe(300);
});

it('leaves iOS to the keyboard-avoiding view', () => {
  native.keyboardState = { height: 300, visible: true, screenY: 544, transition: { current: null } };
  render(true);
  expect(lift()).toBe(0);
});
