// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
import { SessionPaneDivider } from '../session/SessionPaneDivider';

const state = vi.hoisted(() => ({ pan: {} as Record<string, (...args: any[]) => any> }));
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

function setup(grip?: boolean) {
  const onResize = vi.fn(), onDrag = vi.fn(), onCommit = vi.fn();
  const host = document.createElement('div'), root = createRoot(host); roots.push(root);
  act(() => root.render(<SessionPaneDivider width={400} left={400} top={0} bottom={0} grip={grip}
    bounds={{ min: 300, max: 573 }} onResize={onResize}
    overdrag={{ limit: 669, commitAt: 621, onDrag, onCommit }} />));
  return { host, onResize, onDrag, onCommit };
}

// Unit: user request 2026-11-06 — dragging the floating drawer's edge on to full
// screen goes back to Home; short of it the drawer settles within its range.
it('follows the finger past the range, settles short of full screen and commits near it', () => {
  const { onResize, onDrag, onCommit } = setup();
  act(() => state.pan.onPanResponderGrant());
  act(() => state.pan.onPanResponderMove(null, { dx: 100 }));
  expect(onResize).toHaveBeenLastCalledWith(500);
  expect(onDrag).toHaveBeenLastCalledWith(null);
  act(() => state.pan.onPanResponderMove(null, { dx: 220 }));
  expect(onResize).toHaveBeenLastCalledWith(573);
  expect(onDrag).toHaveBeenLastCalledWith(620);
  act(() => state.pan.onPanResponderMove(null, { dx: 400 }));
  expect(onDrag).toHaveBeenLastCalledWith(669);
  act(() => state.pan.onPanResponderRelease(null, { dx: 200 }));
  expect(onDrag).toHaveBeenLastCalledWith(null);
  expect(onResize).toHaveBeenLastCalledWith(573);
  expect(onCommit).not.toHaveBeenCalled();

  act(() => state.pan.onPanResponderGrant());
  act(() => state.pan.onPanResponderRelease(null, { dx: 230 }));
  // The stored width stays what it was before this drag.
  expect(onDrag).toHaveBeenLastCalledWith(669);
  expect(onResize).toHaveBeenLastCalledWith(400);
  expect(onCommit).toHaveBeenCalledOnce();

  act(() => state.pan.onPanResponderGrant());
  act(() => state.pan.onPanResponderMove(null, { dx: 260 }));
  act(() => state.pan.onPanResponderTerminate());
  expect(onDrag).toHaveBeenLastCalledWith(null);
  expect(onResize).toHaveBeenLastCalledWith(400);
  expect(onCommit).toHaveBeenCalledOnce();
});

it('draws the grip only when asked', () => {
  expect(setup().host.querySelectorAll('[data-pointer="none"]')).toHaveLength(1);
  expect(setup(false).host.querySelectorAll('[data-pointer="none"]')).toHaveLength(0);
});
