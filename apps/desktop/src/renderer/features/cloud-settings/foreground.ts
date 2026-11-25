import { useEffect, useState } from 'react';
import { HIDDEN_ANIMATION_ATTR } from '@/lib/hiddenAnimationGate';

/**
 * Whether the cloud pages are in front of the user, the condition for their instance polls
 * (engineering-conventions §8.3). A window that turned off background throttling keeps
 * `visibilityState` visible when it is hidden or minimised, so the host's hide/minimise
 * broadcast is read from the attribute the hidden-animation gate keeps on the document.
 * The browser pages have no such gate and rely on `visibilityState` alone.
 */
export function isForeground(): boolean {
  return (
    document.visibilityState !== 'hidden' &&
    !document.documentElement.hasAttribute(HIDDEN_ANIMATION_ATTR)
  );
}

/** Calls `listener` whenever {@link isForeground} changes; returns the unsubscribe. */
export function onForegroundChange(listener: (foreground: boolean) => void): () => void {
  let last = isForeground();
  const update = () => {
    const next = isForeground();
    if (next === last) return;
    last = next;
    listener(next);
  };
  document.addEventListener('visibilitychange', update);
  const observer = new MutationObserver(update);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [HIDDEN_ANIMATION_ATTR],
  });
  return () => {
    document.removeEventListener('visibilitychange', update);
    observer.disconnect();
  };
}

/** {@link isForeground} as React state, followed only while `enabled`. */
export function useForeground(enabled = true): boolean {
  const [foreground, setForeground] = useState(isForeground);
  useEffect(() => {
    if (!enabled) return;
    setForeground(isForeground());
    return onForegroundChange(setForeground);
  }, [enabled]);
  return foreground;
}
