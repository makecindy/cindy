// @vitest-environment jsdom
// Behavior regression: a coherent native/pane snapshot must not be followed by
// redundant renders from the independent Dimensions and safe-area broadcasts.
import { act, createContext, createElement, memo, useContext, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { GeometryContext, PaneViewportProvider, useAdaptiveWindow, useAdaptiveWindowDimensions, usePaneViewport } from '@/platform/AdaptiveWindowContext';
import { useWindowFontScale, useWindowWidth } from '@/platform/windowDimension';
import type { WindowGeometry } from '@/platform/windowGeometry';
const fixture = vi.hoisted(() => ({
  size: { width: 669, height: 951, scale: 2, fontScale: 1 },
  listeners: new Set<() => void>(),
}));
vi.mock('react-native', () => ({
  Dimensions: {
    get: () => fixture.size,
    addEventListener: (_: string, listener: () => void) => {
      fixture.listeners.add(listener);
      return { remove: () => fixture.listeners.delete(listener) };
    },
  },
  useWindowDimensions: () => useSyncExternalStore((listener) => {
    fixture.listeners.add(listener); return () => fixture.listeners.delete(listener);
  }, () => fixture.size),
}));
vi.mock('react-native-safe-area-context', () => {
  const SafeAreaInsetsContext = createContext(null);
  return { SafeAreaInsetsContext, useSafeAreaInsets: () => useContext(SafeAreaInsetsContext) };
});
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
let root: ReturnType<typeof createRoot>;
const insets = { top: 10, bottom: 0, left: 0, right: 0 };
const geometry: WindowGeometry = { width: 669, height: 951, insets,
  regularWidth: true, regularHeight: true, barEdge: 'none', regions: [], reservedRegionsSupported: true };
let renders: number;
let latest: any;
const GeometryConsumer = memo(function GeometryConsumer() { renders++; latest = useAdaptiveWindow(); return null; });
const PaneConsumer = memo(function PaneConsumer() { renders++; latest = usePaneViewport(); return null; });
function resize(size: Partial<typeof fixture.size>) {
  act(() => { fixture.size = { ...fixture.size, ...size }; fixture.listeners.forEach(fn => fn()); });
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  fixture.size = { width: 669, height: 951, scale: 2, fontScale: 1 };
  renders = 0;
  root = createRoot(document.createElement('div'));
});
afterEach(() => { act(() => root.unmount()); expect(fixture.listeners.size).toBe(0); });
it('native geometry consumers ignore independent Dimensions and safe-area broadcasts', () => {
  const render = (safe = insets) => act(() => root.render(
    <SafeAreaInsetsContext.Provider value={safe}><GeometryContext.Provider value={geometry}>
      <GeometryConsumer />
    </GeometryContext.Provider></SafeAreaInsetsContext.Provider>));
  render();
  resize({ width: 951, height: 669 });
  render({ top: 0, bottom: 34, left: 0, right: 0 });
  expect(latest).toEqual(geometry);
  expect(renders).toBe(1);
});
it('independent surfaces still respond to window size and safe-area changes', () => {
  const render = (safe = insets) => act(() => root.render(
    <SafeAreaInsetsContext.Provider value={safe}><GeometryConsumer /></SafeAreaInsetsContext.Provider>));
  render(); resize({ width: 951, height: 669 });
  render({ ...insets, bottom: 34 });
  expect(latest).toMatchObject({ width: 951, height: 669, insets: { bottom: 34 } });
});
it('pane consumers only reflow for their pane and retain live display/text scaling', () => {
  const pane = { width: 371.5, height: 669, x: 495.5, y: 0 };
  const render = (value = pane) => act(() => root.render(<PaneViewportProvider value={value}><PaneConsumer /></PaneViewportProvider>));
  render(); resize({ width: 951, height: 669 });
  expect(latest).toMatchObject(pane);
  expect(renders).toBe(1);
  resize({ fontScale: 1.3, scale: 3 });
  expect(latest).toMatchObject({ ...pane, fontScale: 1.3, scale: 3 });
  expect(renders).toBe(2);
  render({ width: 669, height: 951, x: 0, y: 10 });
  expect(latest).toMatchObject({ width: 669, height: 951, x: 0, y: 10, fontScale: 1.3 });
});
it('export surfaces without a pane retain window dimensions', () => {
  act(() => root.render(<PaneConsumer />)); resize({ width: 951, height: 669 });
  expect(latest).toMatchObject({ width: 951, height: 669, x: 0, y: 0 });
});

it('switches between fallback and provided geometry without losing either subscription', () => {
  const render = (value: WindowGeometry | null) => act(() => root.render(
    <SafeAreaInsetsContext.Provider value={insets}><GeometryContext.Provider value={value}>
      <GeometryConsumer />
    </GeometryContext.Provider></SafeAreaInsetsContext.Provider>));
  render(null); render(geometry);
  const count = renders;
  resize({ width: 951, height: 669 });
  expect(renders).toBe(count);
  render(null);
  expect(latest).toMatchObject({ width: 951, height: 669 });
  resize({ width: 500 });
  expect(latest.width).toBe(500);
});
it('chat dimensions pair native size with live font scale in either event order', () => {
  const Consumer = memo(function Consumer() { renders++; latest = useAdaptiveWindowDimensions(); return null; });
  const render = (value: WindowGeometry) => act(() => root.render(<GeometryContext.Provider value={value}><Consumer /></GeometryContext.Provider>));
  render(geometry);
  resize({ width: 951, height: 669 });
  expect(renders).toBe(1);
  expect(latest).toMatchObject({ width: 669, height: 951 });
  render({ ...geometry, width: 951, height: 669 });
  expect(latest).toMatchObject({ width: 951, height: 669 });
  render(geometry);
  const count = renders;
  resize({ width: 669, height: 951 });
  expect(renders).toBe(count);
  resize({ fontScale: 1.4 });
  expect(latest).toMatchObject({ width: 669, height: 951, fontScale: 1.4 });
});

// Unit: list text/rows share subscriptions but still observe width and Dynamic
// Type changes. Existing pane tests do not cover scalar subscriptions or cleanup.
it('shares selective row subscriptions and catches changes while no row is mounted', () => {
  const samples: Record<string, number[]> = { width: [], font: [] };
  function Width() { samples.width.push(useWindowWidth()); return null; }
  function Font() { samples.font.push(useWindowFontScale()); return null; }
  const rows = <><Width /><Width /><Font /><Font /></>;
  act(() => root.render(rows));
  expect(fixture.listeners.size).toBe(2);
  resize({ height: 600, scale: 3 });
  expect(samples).toEqual({ width: [669, 669], font: [1, 1] });
  resize({ width: 800 });
  expect(samples).toEqual({ width: [669, 669, 800, 800], font: [1, 1] });
  resize({ fontScale: 1.4 });
  expect(samples.font).toEqual([1, 1, 1.4, 1.4]);
  act(() => root.render(null));
  expect(fixture.listeners.size).toBe(0);
  resize({ width: 400, fontScale: 1.2 });
  act(() => root.render(rows));
  expect(samples.width.slice(-2)).toEqual([400, 400]);
  expect(samples.font.slice(-2)).toEqual([1.2, 1.2]);
  expect(fixture.listeners.size).toBe(2);
});
