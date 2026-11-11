import { useLayoutEffect, useState, useCallback } from 'react';
import { useFocusEffect, useNavigation } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';

// Native Stack starts offscreen routes with an estimated header height. Reuse the
// last measured task header for this geometry until the push has completed.
// Geometry only: no account or task data, and no persisted state.
const measuredHeights = new Map<string, number>();
type HeaderNavigation = {
  addListener(event: 'transitionEnd', callback: (event: { data: { closing: boolean } }) => void): () => void;
};

export function useSessionHeaderHeight(geometryKey: string): number {
  const nativeHeight = useHeaderHeight();
  const navigation = useNavigation<HeaderNavigation>();
  const [settled, setSettled] = useState(false);
  useFocusEffect(useCallback(() => {
    const unsubscribe = navigation.addListener('transitionEnd', ({ data }) => {
      if (!data.closing) setSettled(true);
    });
    return () => { unsubscribe(); setSettled(false); };
  }, [navigation]));
  useLayoutEffect(() => {
    if (!settled || nativeHeight <= 0 || !Number.isFinite(nativeHeight)) return;
    measuredHeights.delete(geometryKey);
    measuredHeights.set(geometryKey, nativeHeight);
    while (measuredHeights.size > 8) measuredHeights.delete(measuredHeights.keys().next().value!);
  }, [settled, geometryKey, nativeHeight]);
  return !settled ? measuredHeights.get(geometryKey) ?? nativeHeight : nativeHeight;
}
