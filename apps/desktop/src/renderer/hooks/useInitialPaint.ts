import { useEffect, useState } from 'react';

/** Let the surrounding shell paint before mounting expensive initial content. */
export function useInitialPaint(shouldDefer: () => boolean): boolean {
  const [ready, setReady] = useState(() => !shouldDefer());
  useEffect(() => {
    if (ready) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setReady(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [ready]);
  return ready;
}
