// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SheetModal } from '@/session/SheetModal';

const native = vi.hoisted(() => ({
  platform: { OS: 'ios' },
  keyboard: vi.fn((enabled: boolean) => ({ height: enabled ? 300 : 0 })),
  finish: undefined as undefined | ((result: { finished: boolean }) => void),
}));
vi.mock('react-native', () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View, KeyboardAvoidingView: View, Pressable: View,
    Modal: ({ visible, children }: { visible: boolean; children: ReactNode }) => visible ? <div>{children}</div> : null,
    Platform: native.platform,
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    StyleSheet: { absoluteFill: {} },
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
  useAdaptiveWindow: () => ({ height: 844, width: 390, regions: [], barEdge: 'none', insets: { left: 0, right: 0 } }),
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
  native.finish = undefined;
  root = createRoot(document.createElement('div'));
});
afterEach(() => act(() => root.unmount()));
function render(visible: boolean, keyboardAvoiding = true) {
  act(() => root.render(<SheetModal visible={visible} keyboardAvoiding={keyboardAvoiding}
    onRequestClose={() => {}} onBackdropPress={() => {}}>content</SheetModal>));
}
function enabled() { return native.keyboard.mock.calls.at(-1)?.[0]; }

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

it('never subscribes action-only sheets or Android native-resize sheets', () => {
  render(true, false);
  expect(enabled()).toBe(false);
  native.platform.OS = 'android';
  render(true);
  expect(enabled()).toBe(false);
});
