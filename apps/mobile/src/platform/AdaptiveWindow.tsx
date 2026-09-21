import { useMemo, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions, type ViewProps } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { WindowGeometry } from './windowGeometry';

import { GeometryContext } from './AdaptiveWindowContext';
const native = Platform.OS === 'ios'
  ? requireOptionalNativeModule<{ windowLayoutAvailable?: boolean }>('XdtIosActionSheet') : null;
const Probe = native?.windowLayoutAvailable
  ? requireNativeViewManager<ViewProps & { onGeometryChange(event: { nativeEvent: WindowGeometry }): void }>('XdtIosActionSheet') : null;

/** One observation source per window; old packages and other platforms keep normal responsive layout. */
export function AdaptiveWindowProvider({ children }: { children: ReactNode }) {
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [geometry, setGeometry] = useState<WindowGeometry | null>(null);
  const current = geometry && Math.abs(geometry.width - window.width) < 1 && Math.abs(geometry.height - window.height) < 1
    ? geometry : null;
  const value = useMemo<WindowGeometry>(() => current ?? ({
    width: window.width, height: window.height, insets,
    regularWidth: window.width >= 600, regularHeight: window.height >= 600,
    barEdge: 'none', regions: [], reservedRegionsSupported: false,
  }), [current, window.width, window.height, insets]);
  return <GeometryContext.Provider value={value}>
    <View style={styles.root}>
      {children}
      {Probe ? <Probe pointerEvents="none" style={StyleSheet.absoluteFill}
        onGeometryChange={(event) => setGeometry(event.nativeEvent)} /> : null}
    </View>
  </GeometryContext.Provider>;
}

const styles = StyleSheet.create({ root: { flex: 1 } });
