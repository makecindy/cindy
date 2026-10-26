// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useSmoothMessageFollow } from '@/session/useSmoothMessageFollow';
import { motionDuration } from '@/theme/tokens';

// Unit: production hook, modeled UI-thread timing completion/native commands.
// Repeated tail measurements cannot postpone settling. User touch must stop
// following without issuing a new scroll, and reduced motion must be immediate.
// Scroll-policy tests do not exercise this native animation ownership boundary.
const native = vi.hoisted(() => ({ scrollTo: vi.fn(), reduced: false, reactions: new Set<() => void>(), keyboard: { value: false } }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => native.reduced }));
vi.mock('@/session/useNativeKeyboardTransition', () => ({ useNativeKeyboardTransition: () => native.keyboard }));
vi.mock('react-native-reanimated', async () => {
  const { useEffect, useRef } = await import('react');
  function flush() { for (const reaction of native.reactions) reaction(); }
  function useSharedValue(initial: unknown) {
    const ref = useRef<any>(null);
    if (!ref.current) {
      let value = initial;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => { clearTimeout(timer); timer = undefined; };
      ref.current = {
        cancel,
        get value() { return value; },
        set value(next: any) {
          cancel();
          if (next?.timing) timer = setTimeout(() => { value = next.to; flush(); }, next.duration);
          else { value = next; flush(); }
        },
      };
    }
    return ref.current;
  }
  return {
    useSharedValue,
    useAnimatedRef: () => useRef(() => {}).current,
    useScrollOffset: () => useSharedValue(0),
    useAnimatedReaction: (read: () => number, effect: (next: number) => void) => {
      useEffect(() => {
        let previous = read();
        const reaction = () => { const next = read(); if (next !== previous) { previous = next; effect(next); } };
        native.reactions.add(reaction);
        return () => { native.reactions.delete(reaction); };
      }, []);
    },
    runOnUI: (fn: (...args: any[]) => void) => (...args: any[]) => { fn(...args); flush(); },
    cancelAnimation: (value: any) => value.cancel(),
    scrollTo: native.scrollTo,
    Easing: { bezier: () => undefined },
    withSpring: (to: number, config: { duration: number }) => ({ timing: true, to, duration: config.duration }),
  };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let follow: ReturnType<typeof useSmoothMessageFollow>;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
  native.scrollTo.mockReset();
  native.reduced = false;
  native.keyboard.value = false;
});
function mount(nativeKeyboardOwned = false, nativeFollower?: Parameters<typeof useSmoothMessageFollow>[2]) {
  vi.useFakeTimers();
  function Host() { follow = useSmoothMessageFollow(true, nativeKeyboardOwned, nativeFollower); return null; }
  root = createRoot(document.createElement('div'));
  act(() => root!.render(createElement(Host)));
}

it.each([100, 200])('settles on the original deadline unless the destination changes to %s', target => {
  mount();
  act(() => follow.move(100, true));
  expect(native.scrollTo).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(motionDuration.base / 2));
  act(() => follow.move(target, true));
  act(() => vi.advanceTimersByTime(motionDuration.base / 2));
  if (target === 100) expect(native.scrollTo).toHaveBeenLastCalledWith(expect.anything(), 0, 100, false);
  else expect(native.scrollTo).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(motionDuration.base / 2));
  expect(native.scrollTo).toHaveBeenLastCalledWith(expect.anything(), 0, target, false);
});

it('makes an immediate correction to the same target without leaving an animation behind', () => {
  mount();
  act(() => follow.move(100, true));
  act(() => follow.move(100, false));
  expect(native.scrollTo).toHaveBeenLastCalledWith(expect.anything(), 0, 100, false);
  native.scrollTo.mockClear();
  act(() => vi.advanceTimersByTime(motionDuration.base));
  expect(native.scrollTo).not.toHaveBeenCalled();
});

it('hands control to touch without moving the native reading position', () => {
  mount();
  act(() => follow.move(100, true));
  act(() => { follow.scrollOffset.value = 37; follow.cancel(); });
  act(() => vi.advanceTimersByTime(motionDuration.base));
  expect(native.scrollTo).not.toHaveBeenCalled();
});

it('honors reduced motion even when the caller asks for animation', () => {
  native.reduced = true;
  mount();
  act(() => follow.move(100, true));
  expect(native.scrollTo).toHaveBeenLastCalledWith(expect.anything(), 0, 100, false);
});

// Native Android receives the virtual list's chosen destination, not an
// independently estimated end. A second Reanimated writer must stay silent.
it('keeps virtual-list targets and cancellation when Android owns the trajectory', () => {
  const controller = { moveTo: vi.fn(), cancelFollowing: vi.fn() };
  mount(false, { current: controller });
  act(() => { follow.move(430, false); follow.move(520, true); follow.cancel(); });
  expect(controller.moveTo.mock.calls).toEqual([[430, false], [520, true]]);
  expect(controller.cancelFollowing).toHaveBeenCalledOnce();
  act(() => vi.advanceTimersByTime(motionDuration.base));
  expect(native.scrollTo).not.toHaveBeenCalled();
});

// The native keyboard starts before its JS callback. An old scroll animation
// and queued layout correction must both yield in that interval; otherwise the
// message position reverses while UIKit is already moving the viewport.
it('yields to the native keyboard without waiting for a React cancellation', () => {
  mount(true);
  act(() => follow.move(100, true));
  act(() => {
    native.keyboard.value = true;
    for (const reaction of native.reactions) reaction();
    follow.move(200, false);
    vi.advanceTimersByTime(motionDuration.base);
  });
  expect(native.scrollTo).not.toHaveBeenCalled();
  act(() => {
    native.keyboard.value = false;
    for (const reaction of native.reactions) reaction();
    follow.move(300, true);
    vi.advanceTimersByTime(motionDuration.base);
  });
  expect(native.scrollTo).toHaveBeenLastCalledWith(expect.anything(), 0, 300, false);
});
