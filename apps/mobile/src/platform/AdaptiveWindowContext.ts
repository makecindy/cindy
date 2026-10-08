import { createContext, useContext } from 'react';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { WindowGeometry } from './windowGeometry';

export const GeometryContext = createContext<WindowGeometry | null>(null);
const PaneContext = createContext<{ width: number; height: number; x?: number; y?: number } | null>(null);
export const FloatingSheetContext = createContext(false);

export function useAdaptiveWindow(): WindowGeometry {
  const value = useContext(GeometryContext);
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return value ?? { width: window.width, height: window.height, insets,
    regularWidth: window.width >= 600, regularHeight: window.height >= 600,
    barEdge: 'none', regions: [], reservedRegionsSupported: false };
}

/** Descendants measure their pane, while independent export surfaces keep window dimensions. */
export const PaneViewportProvider = PaneContext.Provider;
export function usePaneViewport() {
  const window = useWindowDimensions();
  const pane = useContext(PaneContext);
  return { ...window, ...pane, x: pane?.x ?? 0, y: pane?.y ?? 0 };
}
