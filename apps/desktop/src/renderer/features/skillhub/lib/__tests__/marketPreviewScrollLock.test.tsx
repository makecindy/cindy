// @vitest-environment jsdom

import { cleanup, renderHook } from '@testing-library/react';
import type { RefObject } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { useSkillhubPreviewScrollLock } from '../useSkillhubPreviewScrollLock';

afterEach(() => {
  cleanup();
});

function renderScrollLock(
  locked: boolean,
  scrollLockRef: RefObject<HTMLElement | null>,
): ReturnType<typeof renderHook<void, { locked: boolean }>> {
  return renderHook(
    ({ locked: isLocked }) => useSkillhubPreviewScrollLock(isLocked, scrollLockRef),
    { initialProps: { locked } },
  );
}

describe('useSkillhubPreviewScrollLock', () => {
  it('locks on open and restores the host overflow on close', () => {
    const host = document.createElement('main');
    host.style.overflowY = 'auto';
    const scrollLockRef = { current: host };
    const view = renderScrollLock(true, scrollLockRef);

    expect(host.style.overflowY).toBe('hidden');

    view.rerender({ locked: false });
    expect(host.style.overflowY).toBe('auto');
    host.remove();
  });

  it('restores the host overflow when the preview unmounts', () => {
    const host = document.createElement('main');
    host.style.overflowY = 'scroll';
    const scrollLockRef = { current: host };
    const view = renderScrollLock(true, scrollLockRef);

    expect(host.style.overflowY).toBe('hidden');
    view.unmount();
    expect(host.style.overflowY).toBe('scroll');
    host.remove();
  });
});
