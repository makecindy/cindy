import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { appendedMessageKeys } from '@cindy/maker-shared/message-presentation';

/** Animate the existing row, without inserting a wrapper or changing scroll geometry. */
export function useMessageEntrance(keys: readonly string[], ready = true) {
  const previous = useRef<readonly string[] | undefined>(undefined);
  const played = useRef(new Set<string>());
  const arriving = useMemo(() => ({ keys: ready ? appendedMessageKeys(previous.current, keys) : new Set<string>(), at: Date.now() }), [keys, ready]);
  useLayoutEffect(() => { previous.current = ready ? keys : undefined; }, [keys, ready]);

  return useCallback((node: HTMLDivElement | null, key: string) => {
    if (!node || !arriving.keys.has(key) || played.current.has(key) || Date.now() - arriving.at > 1000) return;
    played.current.add(key);
    if (played.current.size > 200) played.current.delete(played.current.values().next().value!);
    if (!window.matchMedia || !node.animate) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reduced.matches) return;
    const style = getComputedStyle(node);
    const duration = style.getPropertyValue('--motion-base').trim();
    const milliseconds = Number.parseFloat(duration) * (duration.endsWith('ms') ? 1 : 1000);
    if (!Number.isFinite(milliseconds)) return;
    const animation = node.animate([
      { opacity: 0, transform: 'translateY(6px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: milliseconds, easing: style.getPropertyValue('--motion-ease-out').trim() });
    const stop = () => { if (reduced.matches) animation.cancel(); };
    reduced.addEventListener('change', stop);
    void animation.finished.catch(() => {}).finally(() => reduced.removeEventListener('change', stop));
  }, [arriving]);
}
