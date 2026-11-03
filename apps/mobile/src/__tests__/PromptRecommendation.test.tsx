// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PromptRecommendation } from '@/session/PromptRecommendation';

const mocks = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: any[]) => void>,
  button: {} as Record<string, any>,
  reduceMotion: false as boolean | null,
  timings: [] as Array<{ duration: number }>,
  x: null as { value: number } | null,
  deferAnimation: false,
  pendingAnimation: null as ((finished: boolean) => void) | null,
}));
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  return {
    Pressable: (props: any) => { mocks.button = props; return createElement('button', { onClick: props.onPress }, props.children); },
    View: (props: any) => createElement('div', {}, props.children),
    StyleSheet: { create: (value: any) => value, hairlineWidth: 1 },
    useWindowDimensions: () => ({ width: 390 }),
  };
});
vi.mock('@/components/AppText', async () => {
  const { createElement } = await import('react');
  return { Text: (props: any) => createElement('span', {}, props.children) };
});
vi.mock('lucide-react-native', () => ({ Sparkles: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-glass-effect', async () => {
  const { createElement } = await import('react');
  return { GlassView: (props: any) => createElement('div', {}, props.children) };
});
vi.mock('@/session/useLiquidGlassAvailable', () => ({ useLiquidGlassAvailable: () => true }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => mocks.reduceMotion }));
vi.mock('@/theme', () => ({
  useTheme: () => ({ mode: 'light', colors: {} }),
  useThemedStyles: (make: any) => make({}),
}));
vi.mock('react-native-worklets', () => ({ scheduleOnRN: (fn: () => void) => fn() }));
vi.mock('react-native-reanimated', async () => {
  const { createElement, useRef } = await import('react');
  return {
    default: { View: (props: any) => createElement('div', {}, props.children) },
    Easing: { bezier: () => undefined },
    cancelAnimation: vi.fn(() => {
      const pending = mocks.pendingAnimation;
      mocks.pendingAnimation = null;
      pending?.(false);
    }),
    useAnimatedStyle: (fn: () => any) => fn(),
    useSharedValue: (initial: any) => {
      const ref = useRef({ value: initial });
      if (mocks.x === null) mocks.x = ref.current;
      return ref.current;
    },
    withTiming: (value: number, config: { duration: number }, done?: (finished: boolean) => void) => {
      mocks.timings.push(config);
      if (mocks.deferAnimation) mocks.pendingAnimation = done ?? null;
      else done?.(true);
      return value;
    },
  };
});
vi.mock('@/platform/gestureHandler', () => ({
  GestureDetector: ({ children }: any) => children,
  Gesture: { Pan: () => {
    const builder: Record<string, any> = {};
    for (const name of ['activeOffsetX', 'failOffsetY', 'onStart', 'onUpdate', 'onEnd', 'onFinalize']) {
      builder[name] = (value: any) => { mocks.handlers[name] = value; return builder; };
    }
    return builder;
  } },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
const onAccept = vi.fn();
const onDismiss = vi.fn();
async function render() {
  await act(async () => root.render(createElement(PromptRecommendation, { prompt: 'Continue work', onAccept, onDismiss })));
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.x = null; mocks.timings = []; mocks.reduceMotion = false;
  mocks.deferAnimation = false; mocks.pendingAnimation = null;
  container = document.createElement('div'); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); });
function swipe(dx: number, velocityX: number, cancelled = false) {
  mocks.handlers.onStart();
  mocks.handlers.onUpdate({ translationX: dx });
  mocks.handlers.onEnd({ velocityX }, !cancelled);
  mocks.handlers.onFinalize();
}

it('tap accepts without dismissing, with a separate accessible dismiss action', async () => {
  await render();
  await act(async () => container.querySelector('button')!.click());
  expect(onAccept).toHaveBeenCalledOnce(); expect(onDismiss).not.toHaveBeenCalled();
  mocks.button.onAccessibilityAction({ nativeEvent: { actionName: 'dismiss' } });
  expect(onDismiss).toHaveBeenCalledOnce();
});

it.each([-1, 1])('dismisses a long swipe in direction %s and ignores a following tap', async (direction) => {
  await render(); swipe(direction * 110, 0);
  expect(onDismiss).toHaveBeenCalledOnce();
  expect(mocks.x!.value).toBe(direction * 390);
  mocks.button.onPress(); expect(onAccept).not.toHaveBeenCalled();
});

it('preserves a committed swipe when hiding cancels the exit animation', async () => {
  mocks.deferAnimation = true;
  await render(); swipe(110, 0);
  expect(onDismiss).not.toHaveBeenCalled();
  await act(async () => root.render(null));
  expect(onDismiss).toHaveBeenCalledOnce();
  await render();
  expect(onDismiss).toHaveBeenCalledOnce();
});

it('accepts a short fast flick but returns a short slow swipe and a cancelled drag', async () => {
  await render(); swipe(20, 0);
  expect(onDismiss).not.toHaveBeenCalled(); expect(mocks.x!.value).toBe(0);
  swipe(120, 800, true);
  expect(onDismiss).not.toHaveBeenCalled(); expect(mocks.x!.value).toBe(0);
  swipe(-30, -800); expect(onDismiss).toHaveBeenCalledOnce();
});

it.each([true, null])('does not animate dismissal when reduced motion is %s', async (preference) => {
  mocks.reduceMotion = preference; await render(); swipe(120, 0);
  expect(onDismiss).toHaveBeenCalledOnce();
  expect(mocks.timings.at(-1)?.duration).toBe(0);
});
