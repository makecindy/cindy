// @vitest-environment jsdom
import Module, { createRequire } from 'node:module';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { lightColors, motionDuration } from '@/theme/tokens';

// #9510 black-box follow-up: the real overlay must release after a gate hides an
// animating view. Existing startupSplashOverlay.test.ts is a node/source guard;
// this unit file needs a DOM lifecycle and an Animated boundary that cancels on
// detach (finished:false). No copied overlay logic, network, or real waiting.
const fixture = vi.hoisted(() => ({ gate: 'passthrough' as 'pending' | 'passthrough' }));
vi.mock('@/theme', () => ({ motionDuration, useTheme: () => ({ mode: 'light', colors: lightColors }) }));
vi.mock('@/auth/loginFirstLaunchGate', () => ({ useLoginFirstLaunchLight: () => fixture.gate }));
vi.mock('@/auth/MobileLoginHandoffContext', () => ({ useLoginHandoffOptional: () => null }));
vi.mock('@/components/CenteredScreen', async () => {
  const { createElement } = await import('react');
  return { CenteredScreen: () => createElement('div', { 'data-testid': 'splash' }) };
});
vi.mock('react-native', async () => {
  const { createElement, useLayoutEffect } = await import('react');
  class Value {
    stopAnimation = () => {};
    constructor(public value: number) {}
    setValue(value: number) { this.stopAnimation(); this.value = value; }
  }
  const flatten = (s: any): any => Array.isArray(s) ? Object.assign({}, ...s.map(flatten)) : s;
  const View = ({ children, style, pointerEvents }: any) => {
    const opacity = flatten(style)?.opacity;
    useLayoutEffect(() => () => opacity?.stopAnimation(), [opacity]);
    return createElement('div', { 'data-pointer-events': pointerEvents }, children);
  };
  return {
    Platform: { OS: 'android' },
    StyleSheet: { create: (s: any) => s, absoluteFill: {} },
    Image: () => createElement('img', { alt: 'Native brand bridge' }),
    Animated: {
      Value, View,
      timing(value: Value, { duration, toValue }: { duration: number; toValue: number }) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let done: ((result: { finished: boolean }) => void) | undefined;
        const finish = (finished: boolean) => {
          clearTimeout(timer);
          const callback = done;
          done = undefined;
          callback?.({ finished });
        };
        return {
          start(callback?: typeof done) {
            value.stopAnimation();
            done = callback;
            value.stopAnimation = () => finish(false);
            timer = setTimeout(() => { value.value = toValue; finish(true); }, duration);
          },
          stop() { finish(false); },
        };
      },
    },
  };
});

let Overlay: typeof import('@/components/StartupSplashOverlay').StartupSplashOverlay;
let useSplash: typeof import('@/components/StartupSplashOverlay').useStartupSplash;
const require = createRequire(import.meta.url);
const oldPng = require.extensions['.png'];
const nodeModule = Module as unknown as { _resolveFilename(request: string, ...args: unknown[]): string };
const oldResolve = nodeModule._resolveFilename;
beforeAll(async () => {
  require.extensions['.png'] = (module, file) => { module.exports = file; };
  nodeModule._resolveFilename = function (request, ...args) {
    return oldResolve.call(this, request.replace(/login-hero\.png$/, 'login-hero@2x.png'), ...args);
  };
  const module = await import('@/components/StartupSplashOverlay');
  Overlay = module.StartupSplashOverlay;
  useSplash = module.useStartupSplash;
});
afterAll(() => {
  nodeModule._resolveFilename = oldResolve;
  if (oldPng) require.extensions['.png'] = oldPng;
  else delete require.extensions['.png'];
});

let root: Root;
let container: HTMLDivElement;
function Content() {
  const { releaseSplash } = useSplash();
  return <button onClick={releaseSplash}>Content ready</button>;
}
async function render(hidden = false) {
  await act(async () => root.render(<Overlay hidden={hidden}><Content /></Overlay>));
}
function advance(ms: number) { act(() => vi.advanceTimersByTime(ms)); }
function release() { act(() => container.querySelector('button')!.click()); }
beforeEach(() => {
  vi.useFakeTimers();
  fixture.gate = 'passthrough';
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

describe('startup overlay interrupted by a blocking gate', () => {
  // Once blocked content is available before theme selection, a real retry (or
  // forced-update withdrawal) can restore this overlay while storage is pending.
  it('restores the native bridge after a blocked-screen retry before theme selection', async () => {
    fixture.gate = 'pending';
    await render();
    await render(true);
    expect(container.querySelector('img')).toBeNull();
    await render(false);
    expect(container.querySelector('img')).not.toBeNull();
    release();
    advance(1000);
    expect(container.querySelector('img')).not.toBeNull();
    fixture.gate = 'passthrough';
    await render();
    advance(motionDuration.fast);
    expect(container.querySelector('img')).toBeNull();
    advance(1000);
    expect(container.querySelector('[data-testid="splash"]')).toBeNull();
  });

  it.each(['native bridge', 'outer overlay'] as const)('releases after hiding during the %s fade', async (phase) => {
    await render();
    if (phase === 'outer overlay') {
      advance(motionDuration.fast);
      release();
    }
    advance(50);
    await render(true);
    expect(container.querySelector('[data-testid="splash"]')).toBeNull();
    await render(false);
    expect(container.querySelector('img')).toBeNull();
    if (phase === 'native bridge') {
      // Retry pending still needs the normal JS splash until real content is ready.
      expect(container.querySelector('[data-testid="splash"]')).not.toBeNull();
      release();
    }
    advance(1000);
    expect(container.querySelector('[data-testid="splash"]')).toBeNull();
    expect(container.textContent).toBe('Content ready');
  });

  it('keeps the native frame until the theme is known, then releases normally', async () => {
    fixture.gate = 'pending';
    await render();
    release();
    advance(1000);
    expect(container.querySelector('img')).not.toBeNull();
    fixture.gate = 'passthrough';
    await render();
    advance(motionDuration.fast);
    expect(container.querySelector('img')).toBeNull();
    advance(1000);
    expect(container.querySelector('[data-testid="splash"]')).toBeNull();
  });
});
