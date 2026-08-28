import { useLayoutEffect, type RefObject } from 'react';

/**
 * Locks the catalog scroll surface while the in-place skill preview is open.
 *
 * The preview is not a Radix Dialog, so its host container needs an explicit
 * lock. The previous inline value is restored on close or unmount so this hook
 * does not overwrite another scroll policy owned by the host.
 */
export function useSkillhubPreviewScrollLock(
  locked: boolean,
  scrollLockRef: RefObject<HTMLElement | null>,
): void {
  useLayoutEffect(() => {
    if (!locked) return undefined;
    const container = scrollLockRef.current;
    if (!container) return undefined;

    const previousOverflowY = container.style.overflowY;
    container.style.overflowY = 'hidden';
    return () => {
      container.style.overflowY = previousOverflowY;
    };
  }, [locked, scrollLockRef]);
}
