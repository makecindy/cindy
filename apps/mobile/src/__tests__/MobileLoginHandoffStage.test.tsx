// @vitest-environment jsdom
import Module, { createRequire } from 'node:module';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { darkColors, lightColors } from '@/theme/tokens';
import { MobileLoginHandoffProvider, useLoginHandoff, type LoginHandoffContextValue } from '@/auth/MobileLoginHandoffContext';
import { loginHandoffTotalMs, type LoginHandoffAction } from '@/auth/loginHandoff';

// #9510: render the real brand stage and persistent Provider, unlike the existing
// source guards for the root gates/outer splash. Minimal failure: a blocked stage
// with auth-init pending still mounts a spinner. Unit tier; only native rendering,
// animation and Metro asset resolution are adapted to the DOM (no network/storage).
const fixture = vi.hoisted(() => ({
  mode: 'light' as 'light' | 'dark',
  gate: 'passthrough' as 'pending' | 'light' | 'passthrough',
}));
type NativeElement = HTMLDivElement & { nativeStyle?: Record<string, any> };
const flatten = (style: any): Record<string, any> => Array.isArray(style)
  ? Object.assign({}, ...style.map(flatten)) : style ?? {};

vi.mock('react-native', async () => {
  const { createElement: el } = await import('react');
  const View = ({ children, style, testID }: any) => el('div', {
    ref: (node: NativeElement | null) => { if (node) node.nativeStyle = flatten(style); },
    'data-testid': testID,
  }, children);
  class Value {
    constructor(public value: number) {}
    setValue(value: number) { this.value = value; }
    interpolate({ inputRange, outputRange }: { inputRange: number[]; outputRange: number[] | string[] }) {
      const source = this;
      return { get value() {
        const progress = (source.value - inputRange[0]) / (inputRange[1] - inputRange[0]);
        return typeof outputRange[0] === 'number' && typeof outputRange[1] === 'number'
          ? outputRange[0] + progress * (outputRange[1] - outputRange[0]) : outputRange[0];
      } };
    }
  }
  const animation = () => ({ start() {}, stop() {} });
  return {
    View,
    Image: ({ source }: any) => el('img', { 'data-asset': source, alt: '' }),
    Animated: { Value, View, timing: animation, loop: animation, sequence: animation, delay: animation },
    Easing: { linear: (v: number) => v, bezier: () => (v: number) => v },
    StyleSheet: { create: <T,>(s: T) => s, absoluteFill: {} },
    Platform: { OS: 'android' },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    AccessibilityInfo: {
      isReduceMotionEnabled: async () => false,
      addEventListener: () => ({ remove() {} }),
    },
  };
});
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('react-native-svg', async () => {
  const { createElement: el } = await import('react');
  return {
    default: ({ children }: { children: ReactNode }) => el('svg', { 'data-spinner': true }, children),
    Circle: () => null, Path: () => null,
  };
});
vi.mock('@/theme', async () => {
  const { createContext, createElement: el, useContext } = await import('react');
  const Theme = createContext<'light' | 'dark' | null>(null);
  return {
    ThemeOverrideProvider: ({ mode, children }: any) => el(Theme.Provider, { value: mode }, children),
    useTheme: () => {
      const mode = useContext(Theme) ?? fixture.mode;
      return { mode, colors: mode === 'dark' ? darkColors : lightColors };
    },
  };
});
vi.mock('@/auth/loginFirstLaunchGate', () => ({ useLoginFirstLaunchLight: () => fixture.gate }));
vi.mock('@/platform/AdaptiveWindowContext', () => ({
  useAdaptiveWindow: () => ({ width: 390, height: 844, barEdge: 'none' }),
}));

let Stage: typeof import('@/components/MobileLoginHandoffStage').MobileLoginHandoffStage;
const require = createRequire(import.meta.url);
const oldPng = require.extensions['.png'];
const nodeModule = Module as unknown as { _resolveFilename(request: string, ...args: unknown[]): string };
const resolveFilename = nodeModule._resolveFilename;
beforeAll(async () => {
  // Metro resolves these unsuffixed requires to density assets. Load the real
  // component once after installing that native boundary, then restore it below.
  require.extensions['.png'] = (module, file) => { module.exports = file; };
  nodeModule._resolveFilename = function (request, ...args) {
    return resolveFilename.call(this, request.replace(
      /^(\.\.\/\.\.\/assets\/login\/login-(?:hero|slogan(?:-dark)?|wordmark(?:-dark)?))\.png$/,
      '$1@2x.png',
    ), ...args);
  };
  ({ MobileLoginHandoffStage: Stage } = await import('@/components/MobileLoginHandoffStage'));
});
afterAll(() => {
  nodeModule._resolveFilename = resolveFilename;
  if (oldPng) require.extensions['.png'] = oldPng;
  else delete require.extensions['.png'];
});

let root: Root;
let container: HTMLDivElement;
let handoff: LoginHandoffContextValue;
function Probe() { handoff = useLoginHandoff(); return null; }
beforeEach(() => {
  vi.useFakeTimers();
  fixture.mode = 'light';
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

async function renderStage(staticBrand?: boolean, children?: ReactNode) {
  await act(async () => root.render(
    <MobileLoginHandoffProvider>
      <Probe />
      <Stage staticBrand={staticBrand} testID="stage">
        {children ?? <button>{staticBrand ? 'Blocked action' : 'Login action'}</button>}
      </Stage>
    </MobileLoginHandoffProvider>,
  ));
}
function report(...actions: LoginHandoffAction[]) {
  act(() => actions.forEach((action) => handoff.dispatch(action)));
}
function expectStaticBrand() {
  expect(container.querySelector('[data-spinner]')).toBeNull();
  expect(container.querySelectorAll('img')).toHaveLength(3);
  const hero = container.querySelector('img[data-asset*="login-hero"]')!;
  const translation = (hero.parentElement as NativeElement).nativeStyle!.transform[0].translateY;
  expect(translation.value).toBe(0);
  const slogan = container.querySelector('img[data-asset*="login-slogan"]')!;
  expect((slogan.parentElement as NativeElement).nativeStyle!.opacity.value).toBe(1);
}

describe('blocked brand presentation', () => {
  // #9515: the root hides its overlay as soon as a blocking gate is active.
  // Pending first-launch storage must not also swallow the blocked action (or
  // the mounted forced-update rechecker). Previous cases only used a ready gate.
  it.each(['light', 'dark'] as const)('keeps blocked content mounted while theme selection is pending in %s mode', async (mode) => {
    fixture.mode = mode;
    fixture.gate = 'pending';
    const retry = vi.fn();
    const content = <button onClick={retry}>Retry</button>;
    await renderStage(true, content);
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    act(() => button!.click());
    expect(retry).toHaveBeenCalledOnce();
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelector('[data-spinner]')).toBeNull();
    expect((container.querySelector('[data-testid="stage"]') as NativeElement).nativeStyle!.backgroundColor)
      .toBe((mode === 'dark' ? darkColors : lightColors).login.bgBase);
    fixture.gate = 'passthrough';
    await renderStage(true, content);
    expect(container.querySelector('button')).toBe(button);
    expectStaticBrand();
    expect(handoff.ready).toBe(false);
  });

  it('still waits for the first-launch theme on the normal login stage', async () => {
    fixture.mode = 'dark';
    fixture.gate = 'pending';
    await renderStage();
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelectorAll('img')).toHaveLength(0);
    fixture.gate = 'light';
    await renderStage();
    expect(container.querySelector('button')?.textContent).toBe('Login action');
    expect((container.querySelector('[data-testid="stage"]') as NativeElement).nativeStyle!.backgroundColor)
      .toBe(lightColors.login.bgBase);
    expect(container.querySelector('[data-spinner]')).not.toBeNull();
  });

  it.each(['light', 'dark'] as const)('stays static with unfinished startup in %s mode', async (mode) => {
    fixture.mode = mode;
    await renderStage(true);
    report({ type: 'endpoint', status: 'error' });
    expectStaticBrand();
    expect(container.querySelector('button')?.textContent).toBe('Blocked action');
    expect((container.querySelector('[data-testid="stage"]') as NativeElement).nativeStyle!.backgroundColor)
      .toBe((mode === 'dark' ? darkColors : lightColors).login.bgBase);
    const wordmark = container.querySelector('img[data-asset*="login-wordmark"]')!;
    expect(wordmark.getAttribute('data-asset')).toContain(mode === 'dark' ? 'wordmark-dark' : 'wordmark@');
    act(() => vi.advanceTimersByTime(7 * 60_000));
    expectStaticBrand();
    expect(handoff.ready).toBe(false);
    expect(handoff.state).toMatchObject({ phase: 'splash', authInit: 'pending', ota: 'pending', panelMounted: false });
  });

  it('resumes splash after endpoint retry and waits for the real login panel before completing', async () => {
    await renderStage(true);
    report({ type: 'endpoint', status: 'error' });
    expectStaticBrand();
    report({ type: 'endpoint', status: 'pending' });
    await renderStage();
    expect(container.querySelector('[data-spinner]')).not.toBeNull();
    report({ type: 'endpoint', status: 'ready' }, { type: 'ota-ready' }, { type: 'auth-init', authenticated: false });
    expect(handoff.state.phase).toBe('splash');
    expect(container.querySelector('[data-spinner]')).not.toBeNull();
    report({ type: 'panel-mounted' });
    expect(handoff.state.phase).toBe('handoff');
    act(() => vi.advanceTimersByTime(loginHandoffTotalMs('phone')));
    expect(handoff.state.phase).toBe('done');
    expectStaticBrand();
  });

  it('preserves pending authentication through forced-update withdrawal, then completes authenticated startup', async () => {
    await renderStage(true);
    report({ type: 'endpoint', status: 'ready' }, { type: 'ota-ready' });
    expectStaticBrand();
    expect(handoff.state.phase).toBe('splash');
    // Withdrawing the gate restores the normal stage under the same Provider.
    await renderStage();
    expect(container.querySelector('[data-spinner]')).not.toBeNull();
    report({ type: 'auth-init', authenticated: true });
    expect(handoff.state.phase).toBe('done');
    expect(handoff.state.panelMounted).toBe(false);
    expectStaticBrand();
  });
});
