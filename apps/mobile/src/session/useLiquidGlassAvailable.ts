import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { useMemo } from 'react';

export function useLiquidGlassAvailable(): boolean {
  return useMemo(() => {
    try {
      return isLiquidGlassAvailable();
    } catch {
      return false;
    }
  }, []);
}
