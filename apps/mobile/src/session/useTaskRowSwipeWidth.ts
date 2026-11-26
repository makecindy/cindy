import { useCallback, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';

// Keep the 148-point action panel open without arming the primary action.
const MIN_FULL_SWIPE_DISTANCE = 160;

export function fullSwipeDistance(rowWidth: number): number {
  return Math.max(MIN_FULL_SWIPE_DISTANCE, rowWidth * 0.55);
}

export function useTaskRowSwipeWidth() {
  const [rowWidth, setRowWidth] = useState(0);
  const onRowLayout = useCallback((event: LayoutChangeEvent) => {
    setRowWidth(event.nativeEvent.layout.width);
  }, []);
  // A row awaiting layout must never arm a full swipe at zero displacement.
  const fullSwipeThreshold = rowWidth > 0 ? fullSwipeDistance(rowWidth) : Infinity;
  return { rowWidth, fullSwipeThreshold, onRowLayout };
}
