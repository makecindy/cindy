import { useSyncExternalStore } from 'react';
import { Dimensions, type ScaledSize } from 'react-native';

/** Text and swipe rows need one dimension, not every keyboard/window event.
 * Share the native subscription across mounted rows and notify only when that
 * dimension changes. Read through Dimensions so a change before subscription
 * (or while no rows are mounted) is still observed by useSyncExternalStore. */
function dimensionStore(key: keyof ScaledSize) {
  const listeners = new Set<() => void>();
  let subscription: ReturnType<typeof Dimensions.addEventListener> | undefined;
  const getSnapshot = () => Dimensions.get('window')[key];
  const subscribe = (listener: () => void) => {
    if (listeners.size === 0) {
      let previous = getSnapshot();
      subscription = Dimensions.addEventListener('change', () => {
        const next = getSnapshot();
        if (Object.is(previous, next)) return;
        previous = next;
        listeners.forEach(notify => notify());
      });
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        subscription?.remove();
        subscription = undefined;
      }
    };
  };
  return { subscribe, getSnapshot };
}

const width = dimensionStore('width');
const fontScale = dimensionStore('fontScale');

export function useWindowWidth(): number {
  return useSyncExternalStore(width.subscribe, width.getSnapshot, width.getSnapshot);
}

export function useWindowFontScale(): number {
  return useSyncExternalStore(fontScale.subscribe, fontScale.getSnapshot, fontScale.getSnapshot);
}
