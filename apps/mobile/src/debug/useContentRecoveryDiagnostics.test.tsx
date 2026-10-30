// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useContentRecoveryDiagnostics } from './useContentRecoveryDiagnostics';

const native = vi.hoisted(() => ({
  focused: true,
  currentState: 'active',
  listeners: new Set<(state: string) => void>(),
  log: vi.fn(),
}));
vi.mock('react-native', () => ({ AppState: {
  get currentState() { return native.currentState; },
  addEventListener: (_: string, listener: (state: string) => void) => {
    native.listeners.add(listener);
    return { remove: () => native.listeners.delete(listener) };
  },
} }));
vi.mock('expo-router', () => ({
  useFocusEffect: (callback: () => () => void) => {
    useEffect(() => native.focused ? callback() : undefined, [callback, native.focused]);
  },
}));
vi.mock('./mobileDebugLog', () => ({ mobileDebugLog: native.log }));

let now = 0;
let root: Root;
let container: HTMLDivElement;
function Harness({ state, identity }: { state: 'syncing' | 'recovered'; identity: string }) {
  useContentRecoveryDiagnostics(state, identity);
  return null;
}
function render(state: 'syncing' | 'recovered', identity = 'a') {
  act(() => root.render(<Harness state={state} identity={identity} />));
}
function lifecycle(state: string) {
  act(() => {
    native.currentState = state;
    for (const listener of native.listeners) listener(state);
  });
}
function last() { return native.log.mock.calls.at(-1)?.[3]; }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  native.focused = true;
  native.currentState = 'active';
  native.log.mockClear();
  native.listeners.clear();
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  expect(native.listeners.size).toBe(0);
  vi.restoreAllMocks();
});

it('excludes inactive/background time, including repeated lifecycle events', () => {
  render('syncing');
  now = 1000;
  lifecycle('inactive');
  now = 1200;
  lifecycle('background');
  now = 601000;
  lifecycle('active');
  now = 602000;
  lifecycle('active');
  now = 603000;
  render('recovered');
  expect(last()).toEqual({ state: 'recovered', elapsedMs: 3000, foregroundElapsedMs: 3000, wallElapsedMs: 603000 });
});

it('excludes time on another page and starts a fresh measurement for the next recovery', () => {
  render('syncing');
  now = 1000;
  native.focused = false;
  render('syncing');
  expect(native.listeners.size).toBe(0);
  now = 10000;
  native.focused = true;
  render('syncing');
  now = 12000;
  render('recovered');
  expect(last().elapsedMs).toBe(3000);
  render('syncing');
  now = 12500;
  render('recovered');
  expect(last().elapsedMs).toBe(500);
});

it('does not attribute another task or an initially cached page to a completed recovery', () => {
  render('recovered');
  expect(native.log).not.toHaveBeenCalled();
  render('syncing');
  now = 10000;
  render('syncing', 'b');
  now = 11000;
  render('recovered', 'b');
  expect(last().elapsedMs).toBe(1000);
  expect(JSON.stringify(native.log.mock.calls)).not.toContain('identity');
});

it('records zero visible wait when recovery begins and ends entirely in the background', () => {
  lifecycle('background');
  render('syncing');
  now = 10000;
  render('recovered');
  expect(last()).toEqual({ state: 'recovered', elapsedMs: 0, foregroundElapsedMs: 0, wallElapsedMs: 10000 });
});
