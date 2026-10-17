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
    removeListener(event: 'destroyed' | 'render-process-gone', listener: () => void) {
      const bucket = listeners.get(event);
      if (!bucket) return;
      const index = bucket.indexOf(listener);
      if (index >= 0) bucket.splice(index, 1);
    },
    listenerCount(): number {
      let total = 0;
      for (const bucket of listeners.values()) total += bucket.length;
      return total;
    },
    emit(event: 'destroyed' | 'render-process-gone') {
      for (const listener of [...(listeners.get(event) ?? [])]) listener();
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

  it('clears the preview request when the owning renderer disappears', () => {
    const setActive = vi.fn();
    const onOwnerGone = vi.fn();
    const lease = createLayoutPreviewLease(setActive, onOwnerGone);
    const owner = fakeOwner(1);

    lease.setActive(true, owner);
    owner.emit('destroyed');
    expect(onOwnerGone).toHaveBeenCalledOnce();
  });

  it('ignores a stale renderer turning preview off after another window owns it', () => {
    const setActive = vi.fn();
    const lease = createLayoutPreviewLease(setActive);
    const first = fakeOwner(1);
    const second = fakeOwner(2);

    lease.setActive(true, first);
    lease.setActive(true, second);
    setActive.mockClear();

    lease.setActive(false, first);
    expect(setActive).not.toHaveBeenCalled();

    lease.setActive(false, second);
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

  it('removes the release listeners when the same owner deactivates between visits', () => {
    const setActive = vi.fn();
    const lease = createLayoutPreviewLease(setActive);
    const owner = fakeOwner(1);

    lease.setActive(true, owner);
    expect(owner.listenerCount()).toBe(2);
    lease.setActive(false, owner);

    lease.setActive(true, owner);
    lease.setActive(false, owner);

    expect(setActive).toHaveBeenCalledTimes(4);
    expect(owner.listenerCount()).toBe(0);
  });

  it('removes the previous owner listeners when another owner takes the lease', () => {
    const setActive = vi.fn();
    const lease = createLayoutPreviewLease(setActive);
    const first = fakeOwner(1);
    const second = fakeOwner(2);

    lease.setActive(true, first);
    lease.setActive(true, second);

    expect(first.listenerCount()).toBe(0);
    expect(second.listenerCount()).toBe(2);
  });

  it('drops the sibling once listener after the owning renderer disappears', () => {
    const setActive = vi.fn();
    const lease = createLayoutPreviewLease(setActive);
    const owner = fakeOwner(1);

    lease.setActive(true, owner);
    owner.emit('destroyed');

    expect(setActive).toHaveBeenCalledWith(false);
    expect(owner.listenerCount()).toBe(0);
  });

  it('extracts a trusted IPC sender and ignores empty events', () => {
    const owner = fakeOwner(7);
    expect(layoutPreviewOwnerFromEvent({ sender: owner })).toEqual(
      expect.objectContaining({ id: 7 }),
    );
    expect(layoutPreviewOwnerFromEvent({})).toBeNull();
    expect(layoutPreviewOwnerFromEvent({ sender: { id: 3, once: () => undefined } })).toBeNull();
  });
});
