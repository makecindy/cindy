import { useEffect, useState, type RefObject } from 'react';

/** Let the surrounding shell paint before mounting expensive initial content. */
export function useInitialPaint(shouldDefer: () => boolean, placeholder?: RefObject<HTMLElement | null>): boolean {
  const [ready, setReady] = useState(() => !shouldDefer());
  useEffect(() => {
    if (ready) return;
    let frame = 0;
    const painted = () => {
      frame = requestAnimationFrame(() => setReady(true));
    };
    // The morph starts transparent and delays its content fade. Wait for its
    // content to appear, including when reduced motion skips that transition.
    const morph = placeholder?.current?.closest('[data-morph-side]');
    const content = morph?.firstElementChild;
    const waitForShell = () => {
      // Mounting a large catalog during the size transition blocks its
      // remaining frames. Reduced motion has no transition to wait for.
      const resizing = morph?.getAnimations?.().some(animation =>
        animation instanceof CSSTransition &&
        (animation.transitionProperty === 'width' || animation.transitionProperty === 'height'),
      );
      if (resizing || (content && Number(getComputedStyle(content).opacity) < 0.5)) {
        frame = requestAnimationFrame(waitForShell);
      } else {
        painted();
      }
    };
    frame = requestAnimationFrame(waitForShell);
    return () => cancelAnimationFrame(frame);
  }, [ready, placeholder]);
  return ready;
}
