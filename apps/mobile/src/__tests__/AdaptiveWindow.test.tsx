// @vitest-environment jsdom
// Component: Android fold bridge -> shared geometry. Existing pure geometry
// tests cannot detect lost native events, stale bounds after rotation/IME resize,
// or safe-area updates being overwritten by an Android snapshot.
import { act, createElement, useContext } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AdaptiveWindowProvider } from '@/platform/AdaptiveWindow';
import { GeometryContext } from '@/platform/AdaptiveWindowContext';
import type { WindowGeometry } from '@/platform/windowGeometry';

const fixture = vi.hoisted(() => ({
  size: { width: 700, height: 900 },
  insets: { top: 24, bottom: 24, left: 0, right: 0 },
  emit: null as null | ((event: { nativeEvent: Partial<WindowGeometry> }) => void),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  View: ({ children }: any) => createElement('div', {}, children),
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
  useWindowDimensions: () => fixture.size,
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => fixture.insets }));
vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: (name: string) => name === 'CindyWindowLayout' ? { windowLayoutAvailable: true } : null,
  requireNativeViewManager: () => ({ onGeometryChange }: any) => { fixture.emit = onGeometryChange; return null; },
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let latest: WindowGeometry;
function Consumer() { latest = useContext(GeometryContext)!; return null; }
function render() { act(() => root.render(<AdaptiveWindowProvider><Consumer /></AdaptiveWindowProvider>)); }
function emit(snapshot: Partial<WindowGeometry>) { act(() => fixture.emit!({ nativeEvent: snapshot })); }
const fold = { kind: 'division' as const, x: 0, y: 450, width: 700, height: 0 };
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  fixture.size = { width: 700, height: 900 };
  fixture.insets = { top: 24, bottom: 24, left: 0, right: 0 };
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

it('keeps responsive fallback until a native snapshot arrives and clears the fold when flat', () => {
  render();
  expect(latest).toMatchObject({ regions: [], reservedRegionsSupported: false });
  emit({ ...fixture.size, regions: [fold], reservedRegionsSupported: true });
  expect(latest).toMatchObject({ regions: [fold], insets: fixture.insets, barEdge: 'none' });
  fixture.insets = { top: 0, bottom: 32, left: 24, right: 0 };
  render();
  expect(latest.insets).toEqual(fixture.insets);
  emit({ ...fixture.size, regions: [], reservedRegionsSupported: true });
  expect(latest.regions).toEqual([]);
});

it('drops stale bounds during window resize and accepts the next local-dp snapshot', () => {
  render();
  emit({ ...fixture.size, regions: [fold], reservedRegionsSupported: true });
  fixture.size = { width: 900, height: 700 };
  render();
  expect(latest).toMatchObject({ ...fixture.size, regions: [] });
  const rotated = { ...fold, x: 450, y: 0, width: 0, height: 700 };
  emit({ ...fixture.size, regions: [rotated], reservedRegionsSupported: true });
  expect(latest.regions).toEqual([rotated]);
});
