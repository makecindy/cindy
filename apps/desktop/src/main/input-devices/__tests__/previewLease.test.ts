import { describe, expect, it, vi } from 'vitest';

import { createLayoutPreviewLease, layoutPreviewOwnerFromEvent } from '../previewLease.js';

function fakeOwner(id: number) {
  const listeners = new Map<string, Array<() => void>>();
  return {
    id,
    once(event: 'destroyed' | 'render-process-gone', listener: () => void) {
      const bucket = listeners.get(event) ?? [];
      bucket.push(listener);
      listeners.set(event, bucket);
    },
    emit(event: 'destroyed' | 'render-process-gone') {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
}

describe('createLayoutPreviewLease', () => {
  it('releases preview when the owning renderer disappears', () => {
    const setActive = vi.fn();
    const lease = createLayoutPreviewLease(setActive);
    const owner = fakeOwner(1);

    lease.setActive(true, owner);
    expect(setActive).toHaveBeenCalledWith(true);
    setActive.mockClear();

    owner.emit('destroyed');
    expect(setActive).toHaveBeenCalledWith(false);
  });

  it('ignores a stale owner after another renderer takes the lease', () => {
    const setActive = vi.fn();
    const lease = createLayoutPreviewLease(setActive);
    const first = fakeOwner(1);
    const second = fakeOwner(2);

    lease.setActive(true, first);
    lease.setActive(true, second);
    setActive.mockClear();

    first.emit('destroyed');
    expect(setActive).not.toHaveBeenCalled();

    second.emit('render-process-gone');
    expect(setActive).toHaveBeenCalledWith(false);
  });

  it('extracts a trusted IPC sender and ignores empty events', () => {
    const owner = fakeOwner(7);
    expect(layoutPreviewOwnerFromEvent({ sender: owner })).toEqual(
      expect.objectContaining({ id: 7 }),
    );
    expect(layoutPreviewOwnerFromEvent({})).toBeNull();
  });
});
