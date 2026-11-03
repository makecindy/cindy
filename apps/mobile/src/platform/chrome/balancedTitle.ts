import { useCallback, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';

/**
 * Horizontal shift for a title laid out against the trailing edge of its slot.
 * A title that fits stays centered on `center` (the bar's midline); one that
 * does not stays against the trailing actions and grows toward the leading
 * edge, where the bar has spare room, before it ellipsizes.
 */
export function balancedTitleShift({ center, contentWidth, slotEnd, slotStart }: {
  center: number;
  contentWidth: number;
  slotEnd: number;
  slotStart: number;
}): number {
  const end = Math.min(slotEnd, Math.max(slotStart + contentWidth, center + contentWidth / 2));
  return Math.min(0, end - slotEnd);
}

export type BalancedTitleSlot = { start: number; end: number; center: number };

/**
 * Callers report where the slot sits relative to the bar's midline; the title
 * itself reports its rendered width. Translating instead of padding keeps the
 * shift out of layout, so the measured width never depends on the shift.
 * `shift` is null until both are known.
 */
export function useBalancedTitle() {
  const [slot, setSlot] = useState<BalancedTitleSlot | null>(null);
  const [contentWidth, setContentWidth] = useState<number | null>(null);
  const onContentLayout = useCallback((event: LayoutChangeEvent) => {
    setContentWidth(event.nativeEvent.layout.width);
  }, []);
  const reportSlot = useCallback((next: BalancedTitleSlot) => {
    setSlot(prev => prev && prev.start === next.start && prev.end === next.end && prev.center === next.center ? prev : next);
  }, []);
  const shift = slot && contentWidth != null && slot.end > slot.start
    ? balancedTitleShift({ center: slot.center, contentWidth, slotEnd: slot.end, slotStart: slot.start })
    : null;
  return { onContentLayout, reportSlot, shift };
}
