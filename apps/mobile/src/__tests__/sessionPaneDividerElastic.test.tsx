// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
import { useSessionPaneDivider } from '../session/SessionPaneDivider';

const state = vi.hoisted(() => ({ native: {} as Record<string, (...args: any[]) => any> }));
vi.mock('react-native-reanimated', () => ({ runOnJS: (fn: unknown) => fn }));
vi.mock('expo-constants', () => ({ default: { executionEnvironment: 'standalone' }, ExecutionEnvironment: { StoreClient: 'storeClient' } }));
vi.mock('@/platform/gestureHandler', () => ({
  Gesture: { Pan: () => {
    const handlers: typeof state.native = {}; state.native = handlers;
    const chain: any = new Proxy({}, { get: (_target, key: string) => (value: any) => {
      if (key.startsWith('on')) handlers[key] = value;
      return chain;
    } });
    return chain;
  } },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', async () => {
  const React = await import('react');
  return {
    StyleSheet: { create: (v: any) => v },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    View: ({ children, testID }: any) => React.createElement('div', { 'data-testid': testID }, children),
  };
});
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => { act(() => roots.splice(0).forEach(root => root.unmount())); });

function Edge(props: Omit<Parameters<typeof useSessionPaneDivider>[0], 'enabled' | 'left' | 'top' | 'bottom'>) {
  return <>{useSessionPaneDivider({ ...props, enabled: true, left: 400, top: 0, bottom: 0 }).edge}</>;
}

function setup() {
  const onResize = vi.fn(), onStretch = vi.fn(), onSettle = vi.fn();
  const host = document.createElement('div'), root = createRoot(host); roots.push(root);
  act(() => root.render(<Edge width={400} bounds={{ min: 300, max: 529 }} onResize={onResize} elastic={{ onStretch, onSettle }} />));
  return { onResize, onStretch, onSettle };
}

// Unit: user request 2026-11-06 (revised) — the floating drawer's edge only resizes;
// past its bounds it reports the overshoot for an elastic stretch, and settles on
// release. The edge shares one native gesture with the side-by-side panes.
it('clamps the stored width, reports the overshoot and rolls back only an interrupted drag', () => {
  const { onResize, onStretch, onSettle } = setup();
  act(() => state.native.onStart());
  act(() => state.native.onUpdate({ translationX: 100 }));
  expect(onResize).toHaveBeenLastCalledWith(500);
  expect(onStretch).toHaveBeenLastCalledWith(0);
  act(() => state.native.onUpdate({ translationX: 260 }));
  expect(onResize).toHaveBeenLastCalledWith(529);
  expect(onStretch).toHaveBeenLastCalledWith(131);
  act(() => state.native.onUpdate({ translationX: -160 }));
  expect(onResize).toHaveBeenLastCalledWith(300);
  expect(onStretch).toHaveBeenLastCalledWith(-60);
  expect(onSettle).not.toHaveBeenCalled();
  act(() => state.native.onEnd({ translationX: 200 }));
  act(() => state.native.onFinalize({}, true));
  expect(onResize).toHaveBeenLastCalledWith(529);
  expect(onStretch).toHaveBeenLastCalledWith(71);
  expect(onSettle).toHaveBeenCalledOnce();

  act(() => state.native.onStart());
  act(() => state.native.onUpdate({ translationX: -90 }));
  act(() => state.native.onFinalize({}, false));
  expect(onResize).toHaveBeenLastCalledWith(400);
  expect(onStretch).toHaveBeenLastCalledWith(0);
  expect(onSettle).toHaveBeenCalledTimes(2);
  // A vertical/tap rejection never activated the resize and must not reset it.
  act(() => state.native.onFinalize({}, false));
  expect(onSettle).toHaveBeenCalledTimes(2);
});

// PR #10153 / discussion_r4548014936, unit: a touch near the visible moving
// edge must resize, while the former edge must yield to the scrim. Existing
// elastic tests only start at a fixed edge. No render occurs between touches.
it('gates new drags against the current animated edge', () => {
  let left = 400;
  const onResize = vi.fn();
  const root = createRoot(document.createElement('div')); roots.push(root);
  act(() => root.render(<Edge width={400} getLeft={() => left} bounds={{ min: 300, max: 529 }} onResize={onResize} />));
  const handlers = state.native;
  left = 220;
  const fail = vi.fn();
  handlers.onTouchesDown({ allTouches: [{ x: 400 }] }, { fail });
  expect(fail).toHaveBeenCalledOnce();
  fail.mockClear();
  handlers.onTouchesDown({ allTouches: [{ x: 230 }] }, { fail });
  expect(fail).not.toHaveBeenCalled();
  act(() => handlers.onStart());
  act(() => handlers.onUpdate({ translationX: 40 }));
  expect(onResize).toHaveBeenLastCalledWith(440);
});
