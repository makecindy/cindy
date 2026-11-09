// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
import { SessionPaneDivider } from '../session/SessionPaneDivider';

const state = vi.hoisted(() => ({ native: {} as Record<string, (...args: any[]) => any>, pan: {} as Record<string, (...args: any[]) => any> }));
vi.mock('expo-constants', () => ({ default: { executionEnvironment: 'standalone' }, ExecutionEnvironment: { StoreClient: 'storeClient' } }));
vi.mock('@/platform/gestureHandler', () => ({
  GestureDetector: ({ children }: any) => children,
  Gesture: { Pan: () => {
    const handlers: typeof state.native = {}; state.native = handlers;
    const chain = {
      runOnJS: () => chain, activeOffsetX: () => chain, failOffsetY: () => chain,
      onStart: (fn: any) => { handlers.start = fn; return chain; },
      onUpdate: (fn: any) => { handlers.update = fn; return chain; },
      onEnd: (fn: any) => { handlers.end = fn; return chain; },
      onFinalize: (fn: any) => { handlers.finalize = fn; return chain; },
    }; return chain;
  } },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: { textSecondary: 'gray', borderStrong: 'gray' } }) }));
vi.mock('react-native', async () => {
  const React = await import('react');
  return {
    StyleSheet: { create: (v: any) => v },
    PanResponder: { create: (handlers: any) => { state.pan = handlers; return { panHandlers: {} }; } },
    View: ({ children, testID, pointerEvents }: any) =>
      React.createElement('div', { 'data-testid': testID, 'data-pointer': pointerEvents }, children),
  };
});
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => { act(() => roots.splice(0).forEach(root => root.unmount())); });

function setup(grip?: boolean, nativeGesture = false) {
  const onResize = vi.fn(), onStretch = vi.fn(), onSettle = vi.fn();
  const host = document.createElement('div'), root = createRoot(host); roots.push(root);
  act(() => root.render(<SessionPaneDivider nativeGesture={nativeGesture} width={400} left={400} top={0} bottom={0} grip={grip}
    bounds={{ min: 300, max: 529 }} onResize={onResize} elastic={{ onStretch, onSettle }} />));
  return { host, onResize, onStretch, onSettle };
}

// Unit: user request 2026-11-06 (revised) — the floating drawer's edge only resizes;
// past its bounds it reports the overshoot for an elastic stretch, and settles on release.
it('clamps the stored width and reports the overshoot on either side', () => {
  const { onResize, onStretch, onSettle } = setup();
  act(() => state.pan.onPanResponderGrant());
  act(() => state.pan.onPanResponderMove(null, { dx: 100 }));
  expect(onResize).toHaveBeenLastCalledWith(500);
  expect(onStretch).toHaveBeenLastCalledWith(0);
  act(() => state.pan.onPanResponderMove(null, { dx: 260 }));
  expect(onResize).toHaveBeenLastCalledWith(529);
  expect(onStretch).toHaveBeenLastCalledWith(131);
  act(() => state.pan.onPanResponderMove(null, { dx: -160 }));
  expect(onResize).toHaveBeenLastCalledWith(300);
  expect(onStretch).toHaveBeenLastCalledWith(-60);
  expect(onSettle).not.toHaveBeenCalled();
  act(() => state.pan.onPanResponderRelease(null, { dx: 300 }));
  expect(onResize).toHaveBeenLastCalledWith(529);
  expect(onSettle).toHaveBeenCalledOnce();

  act(() => state.pan.onPanResponderGrant());
  act(() => state.pan.onPanResponderMove(null, { dx: 260 }));
  act(() => state.pan.onPanResponderTerminate());
  expect(onResize).toHaveBeenLastCalledWith(400);
  expect(onStretch).toHaveBeenLastCalledWith(0);
  expect(onSettle).toHaveBeenCalledTimes(2);
});

it('draws the grip only when asked', () => {
  expect(setup().host.querySelectorAll('[data-pointer="none"]')).toHaveLength(1);
  expect(setup(false).host.querySelectorAll('[data-pointer="none"]')).toHaveLength(0);
});

// The Modal must recognize the edge in the same native arena as close/stretch;
// JS PanResponder cannot wait for movement after another native recognizer wins.
it('resizes and settles through native events, rolling back only an interrupted drag', () => {
  const { onResize, onStretch, onSettle } = setup(false, true);
  act(() => state.native.start());
  act(() => state.native.update({ translationX: -60 }));
  expect(onResize).toHaveBeenLastCalledWith(340);
  act(() => state.native.end({ translationX: 200 }));
  act(() => state.native.finalize({}, true));
  expect(onResize).toHaveBeenLastCalledWith(529);
  expect(onStretch).toHaveBeenLastCalledWith(71);
  expect(onSettle).toHaveBeenCalledTimes(1);
  act(() => state.native.start());
  act(() => state.native.update({ translationX: -90 }));
  act(() => state.native.finalize({}, false));
  expect(onResize).toHaveBeenLastCalledWith(400);
  expect(onSettle).toHaveBeenCalledTimes(2);
  // A vertical/tap rejection never activated the resize and must not reset it.
  act(() => state.native.finalize({}, false));
  expect(onSettle).toHaveBeenCalledTimes(2);
});
