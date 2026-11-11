import { createContext, use, useContext, useMemo, useSyncExternalStore } from 'react';
import { Dimensions, type ScaledSize } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import type { WindowGeometry } from './windowGeometry';

export const GeometryContext = createContext<WindowGeometry | null>(null);
const PaneContext = createContext<{ width: number; height: number; x?: number; y?: number } | null>(null);
export const FloatingSheetContext = createContext(false);

const subscribeWindow = (listener: () => void) => {
  const subscription = Dimensions.addEventListener('change', listener);
  return () => subscription.remove();
};
const noSubscription = () => () => {};
const noWindow = () => null;
const readWindow = () => Dimensions.get('window');

export function useAdaptiveWindow(): WindowGeometry {
  const value = useContext(GeometryContext);
  // The provider already owns fallback Dimensions/insets. Do not wake every
  // consumer for these independent broadcasts after a native snapshot arrives.
  const window = useSyncExternalStore(value ? noSubscription : subscribeWindow, value ? noWindow : readWindow, value ? noWindow : readWindow);
  // React's `use` permits conditional context reads, unlike useContext/hooks.
  const insets = value ? null : use(SafeAreaInsetsContext);
  return useMemo(() => {
    if (value) return value;
    if (!insets || !window) throw new Error('No safe area value available. Make sure you are rendering `<SafeAreaProvider>` at the top of your app.');
    return { width: window.width, height: window.height, insets,
      regularWidth: window.width >= 600, regularHeight: window.height >= 600,
      barEdge: 'none', regions: [], reservedRegionsSupported: false };
  }, [value, window, insets]);
}

/** Subscribe to the effective viewport, while retaining live font/display scale.
 * Raw window changes must not invalidate a pane whose dimensions are unchanged. */
function useViewportDimensions(viewport: { width: number; height: number } | null) {
  const width = viewport?.width;
  const height = viewport?.height;
  const getSnapshot = useMemo(() => {
    let previous: ScaledSize | undefined;
    return () => {
      const window = readWindow();
      const next = { ...window, width: width ?? window.width, height: height ?? window.height };
      if (previous && previous.width === next.width && previous.height === next.height
        && previous.scale === next.scale && previous.fontScale === next.fontScale) return previous;
      previous = next;
      return next;
    };
  }, [width, height]);
  return useSyncExternalStore(subscribeWindow, getSnapshot, getSnapshot);
}

export function useAdaptiveWindowDimensions() {
  return useViewportDimensions(useAdaptiveWindow());
}

/** Descendants measure their pane, while independent export surfaces keep window dimensions. */
export const PaneViewportProvider = PaneContext.Provider;
export function usePaneViewport() {
  const pane = useContext(PaneContext);
  const window = useViewportDimensions(pane);
  return useMemo(() => ({ ...window, x: pane?.x ?? 0, y: pane?.y ?? 0 }), [window, pane?.x, pane?.y]);
}
