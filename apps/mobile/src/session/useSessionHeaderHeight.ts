import { useLayoutEffect, useRef, useState, useCallback } from 'react';
import { useFocusEffect, useNavigation } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';

// Native Stack starts offscreen routes with an estimated header height. Reuse the
// last measured task header for this geometry until the push has completed.
// Geometry only: no account or task data, and no persisted state.
const measuredHeights = new Map<string, number>();
type HeaderNavigation = {
  addListener(event: 'transitionEnd', callback: (event: { data: { closing: boolean } }) => void): () => void;
};

/**
 * `hold`: the system bar is temporarily hidden; keep the last visible height and do not cache.
 * The bar is restored after `hold` clears, so the hidden measurement can outlive it by a render:
 * keep holding until the native height moves off the value observed while hidden.
 */
export function useSessionHeaderHeight(geometryKey: string, hold = false): number {
  const nativeHeight = useHeaderHeight();
  const heldHeight = useRef<number | null>(null);
  const hiddenNativeHeight = useRef<number | null>(null);
  if (hold) hiddenNativeHeight.current = nativeHeight;
  else if (hiddenNativeHeight.current !== null && hiddenNativeHeight.current !== nativeHeight) hiddenNativeHeight.current = null;
  const holding = hold || hiddenNativeHeight.current !== null;
  const navigation = useNavigation<HeaderNavigation>();
  const [settled, setSettled] = useState(false);
  useFocusEffect(useCallback(() => {
    const unsubscribe = navigation.addListener('transitionEnd', ({ data }) => {
      if (!data.closing) setSettled(true);
    });
    return () => { unsubscribe(); setSettled(false); };
  }, [navigation]));
  useLayoutEffect(() => {
    if (holding || !settled || nativeHeight <= 0 || !Number.isFinite(nativeHeight)) return;
    measuredHeights.delete(geometryKey);
    measuredHeights.set(geometryKey, nativeHeight);
    while (measuredHeights.size > 8) measuredHeights.delete(measuredHeights.keys().next().value!);
  }, [holding, settled, geometryKey, nativeHeight]);
  const height = !settled ? measuredHeights.get(geometryKey) ?? nativeHeight : nativeHeight;
  if (!holding) heldHeight.current = height;
  return heldHeight.current ?? height;
}
