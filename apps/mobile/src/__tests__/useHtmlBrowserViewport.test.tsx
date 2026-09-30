// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useHtmlBrowserViewport } from '@/session/useHtmlBrowserViewport';

const native = vi.hoisted(() => ({
  platform: { OS: 'ios', Version: '25.0' },
  frame: { x: 0, y: 0, width: 402, height: 874 },
  listeners: new Map<string, (event: unknown) => void>(),
  metrics: undefined as undefined | { screenX: number; screenY: number; width: number; height: number },
  crossFade: vi.fn(async () => false),
}));
vi.mock('react-native', () => ({
  View: {}, Platform: native.platform,
  useWindowDimensions: () => native.frame,
  AccessibilityInfo: { prefersCrossFadeTransitions: native.crossFade },
  Keyboard: {
    metrics: () => native.metrics,
    addListener: (name: string, callback: (event: unknown) => void) => {
      native.listeners.set(name, callback);
      return { remove: () => native.listeners.delete(name) };
    },
  },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let latest: ReturnType<typeof useHtmlBrowserViewport>;
function Probe() {
  latest = useHtmlBrowserViewport(native.frame.width === 402
    ? { top: 122, bottom: 94, left: 0, right: 0 } : { top: 60, bottom: 80, left: 62, right: 62 });
  latest.viewRef.current = { measureInWindow: (callback: (...values: number[]) => void) => {
    const { x, y, width, height } = native.frame;
    callback(x, y, width, height);
  } } as any;
  return null;
}
function mount() {
  root = createRoot(document.createElement('div'));
  act(() => root!.render(createElement(Probe)));
}
function value() {
  new Function(latest.script!)();
  return (window as any).cindyViewport;
}
function keyboard(name: string, top = 505) {
  act(() => native.listeners.get(name)?.({ endCoordinates: { screenX: 0, screenY: top, width: 402, height: 874 - top } }));
}
afterEach(() => {
  act(() => root?.unmount());
  (window as any)[Symbol.for('cindy.browserViewport.cleanup')]?.();
  root = undefined; native.metrics = undefined; native.platform.Version = '25.0';
  native.frame = { x: 0, y: 0, width: 402, height: 874 };
});
it('remeasures rotation and updates on keyboard frame/show/hide without remounting', () => {
  mount();
  expect(value()).toMatchObject({ height: 658, availableHeight: 658,
    controls: { top: 0, bottom: 0, left: 0, right: 0 }, insets: { top: 0, bottom: 0, left: 0, right: 0 } });
  expect(latest.viewportStyle).toEqual({ paddingTop: 122, paddingBottom: 94, paddingLeft: 0, paddingRight: 0 });
  keyboard('keyboardWillShow');
  expect(value()).toMatchObject({ height: 383, availableHeight: 383 });
  expect(latest.viewportStyle!.paddingBottom).toBe(369);
  keyboard('keyboardWillChangeFrame', 450);
  expect(value().availableHeight).toBe(328);
  keyboard('keyboardDidHide');
  expect(value().availableHeight).toBe(658);
  native.frame = { x: 0, y: 0, width: 874, height: 402 };
  act(() => root!.render(createElement(Probe)));
  expect(value()).toMatchObject({ availableHeight: 262, availableWidth: 750 });
});
it('starts from an already open keyboard and removes every listener on unmount', () => {
  native.metrics = { screenX: 0, screenY: 505, width: 402, height: 369 };
  mount();
  expect(value().availableHeight).toBe(383);
  act(() => root!.unmount()); root = undefined;
  expect(native.listeners.size).toBe(0);
});
it('ignores a late cross-fade result after keyboard hide', async () => {
  let resolve: (value: boolean) => void = () => {};
  native.crossFade.mockImplementationOnce(() => new Promise<boolean>(done => { resolve = done; }));
  mount();
  keyboard('keyboardWillShow', 0);
  keyboard('keyboardWillHide');
  await act(async () => resolve(false));
  expect(value().availableHeight).toBe(658);
});

it('does not subtract keyboard overlap again after the host window resizes above it', () => {
  native.frame = { x: 0, y: 0, width: 402, height: 505 };
  native.metrics = { screenX: 0, screenY: 505, width: 402, height: 369 };
  mount();
  expect(latest.viewportStyle!.paddingBottom).toBe(94);
  expect(value()).toMatchObject({ height: 289, availableHeight: 289 });
});

it('caps padding to the outer frame when a floating keyboard reaches above the toolbar', () => {
  native.frame = { x: 0, y: 0, width: 874, height: 402 };
  native.metrics = { screenX: 0, screenY: 30, width: 402, height: 300 };
  mount();
  expect(latest.viewportStyle!.paddingTop + latest.viewportStyle!.paddingBottom).toBe(402);
  expect(value()).toMatchObject({ height: 0, availableHeight: 0 });
});

it('keeps iOS 26+ full-bleed and sends chrome separately from keyboard occlusion', () => {
  native.platform.Version = '27.0';
  mount();
  expect(latest.viewportStyle).toBeUndefined();
  expect(latest.obscuredContentInsets).toEqual({ top: 122, bottom: 94, left: 0, right: 0 });
  expect(value()).toMatchObject({ height: 874, availableHeight: 658 });
  keyboard('keyboardWillShow');
  expect(latest.viewportStyle).toBeUndefined();
  expect(latest.obscuredContentInsets?.bottom).toBe(94);
  expect(value()).toMatchObject({ height: 874, availableHeight: 383 });
  native.frame = { x: 0, y: 0, width: 874, height: 402 };
  keyboard('keyboardDidHide');
  act(() => root!.render(createElement(Probe)));
  expect(latest.obscuredContentInsets).toEqual({ top: 60, bottom: 80, left: 62, right: 62 });
  expect(value()).toMatchObject({ height: 402, availableHeight: 262 });
});
