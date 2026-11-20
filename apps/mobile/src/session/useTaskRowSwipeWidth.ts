import { useCallback, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';

export const FULL_SWIPE_RATIO = 0.55;

export function useTaskRowSwipeWidth() {
  const [rowWidth, setRowWidth] = useState(0);
  const onRowLayout = useCallback((event: LayoutChangeEvent) => {
    setRowWidth(event.nativeEvent.layout.width);
  }, []);
  // A row awaiting layout must never arm a full swipe at zero displacement.
  const fullSwipeThreshold = rowWidth > 0 ? rowWidth * FULL_SWIPE_RATIO : Infinity;
  return { rowWidth, fullSwipeThreshold, onRowLayout };
}
