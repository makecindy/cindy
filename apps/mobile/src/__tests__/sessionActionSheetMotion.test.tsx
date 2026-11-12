// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { motionDuration, motionEasing } from '@/theme/tokens';

const motion = vi.hoisted(() => ({
  reduced: null as boolean | null,
  setValue: vi.fn(),
  timing: vi.fn(),
  finish: undefined as undefined | ((result: { finished: boolean }) => void),
}));
vi.mock('@/hooks/useReduceMotion', () => ({
  useReduceMotionEnabled: () => motion.reduced,
}));
vi.mock('react-native', () => ({
  Animated: {
    Value: class {
      setValue = motion.setValue;
      interpolate() { return 0; }
    },
    timing: motion.timing,
    View: ({ children }: any) => <div>{children}</div>,
  },
  Easing: { bezier: (...values: number[]) => values },
  Modal: ({ visible, children }: any) => visible ? <div data-testid="modal">{children}</div> : null,
  Pressable: () => null,
  StyleSheet: { create: (value: any) => value, absoluteFill: {} },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/platform/gestureHandler', () => ({
  GestureHandlerRootView: ({ children }: any) => children,
}));
vi.mock('@/session/BlurBackdrop', () => ({ BlurBackdrop: () => null }));

import { SessionActionSheetFrame } from '@/session/SessionActionSheetFrame';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  motion.reduced = null;
  motion.finish = undefined;
  motion.setValue.mockClear();
  motion.timing.mockReset().mockImplementation(() => ({
    start: (callback: typeof motion.finish) => { motion.finish = callback; },
  }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
function render(visible: boolean, onClosed = vi.fn()) {
  act(() => root.render(
    <SessionActionSheetFrame visible={visible} onClose={vi.fn()} onClosed={onClosed}>
      actions
    </SessionActionSheetFrame>,
  ));
}

it.each([true, null])('opens and closes without animation when reduced motion is %s', (reduced) => {
  motion.reduced = reduced;
  const closed = vi.fn(() => expect(container.querySelector('[data-testid="modal"]')).toBeNull());
  render(false, closed);
  expect(closed).not.toHaveBeenCalled();
  render(true, closed);
  expect(container.textContent).toBe('actions');
  expect(motion.setValue).toHaveBeenLastCalledWith(1);
  render(false, closed);
  expect(motion.setValue).toHaveBeenLastCalledWith(0);
  expect(motion.timing).not.toHaveBeenCalled();
  expect(closed).toHaveBeenCalledOnce();
});

it('uses motion tokens and waits for a completed exit before notifying onClosed', () => {
  motion.reduced = false;
  const closed = vi.fn(() => expect(container.querySelector('[data-testid="modal"]')).toBeNull());
  render(true, closed);
  expect(motion.timing).toHaveBeenLastCalledWith(expect.anything(), {
    duration: motionDuration.enter, easing: motionEasing.out, toValue: 1, useNativeDriver: true,
  });
  render(false, closed);
  expect(motion.timing).toHaveBeenLastCalledWith(expect.anything(), {
    duration: motionDuration.exit, easing: motionEasing.in, toValue: 0, useNativeDriver: true,
  });
  expect(closed).not.toHaveBeenCalled();
  act(() => motion.finish?.({ finished: false }));
  expect(container.textContent).toBe('actions');
  expect(closed).not.toHaveBeenCalled();
  act(() => motion.finish?.({ finished: true }));
  expect(closed).toHaveBeenCalledOnce();
});

it('honors a live change to reduced motion on the next close', () => {
  motion.reduced = false;
  render(true);
  motion.reduced = true;
  render(true);
  expect(motion.setValue).toHaveBeenLastCalledWith(1);
  motion.timing.mockClear();
  render(false);
  expect(container.textContent).toBe('');
  expect(motion.timing).not.toHaveBeenCalled();
});
