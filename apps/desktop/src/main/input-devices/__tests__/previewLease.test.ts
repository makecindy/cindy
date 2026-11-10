import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { createLayoutPreviewLease, layoutPreviewOwnerFromEvent } from '../previewLease.js';

function fakeOwner(id: number) {
  return Object.assign(new EventEmitter(), { id });
}

describe('createLayoutPreviewLease', () => {
  // Unit regression: the production lease used by Xbox/Work Louder retained two
  // callbacks after every preview close. The old fake did not model removal or
  // once semantics. One open/close already leaks; repeated cycles must return to
  // baseline and must not let a retired owner stop a later preview.
  it('returns both listener counts to baseline after repeated preview and window lifecycles', () => {
    const setActive = vi.fn();
    const onOwnerGone = vi.fn();
    const lease = createLayoutPreviewLease(setActive, onOwnerGone);
    for (let window = 0; window < 3; window++) {
      const owner = fakeOwner(window);
      for (let round = 0; round < 25; round++) {
        lease.setActive(true, owner);
        lease.setActive(true, owner);
        expect(owner.listenerCount('destroyed')).toBe(1);
        expect(owner.listenerCount('render-process-gone')).toBe(1);
        lease.setActive(false, owner);
        expect(owner.listenerCount('destroyed')).toBe(0);
        expect(owner.listenerCount('render-process-gone')).toBe(0);
      }
      setActive.mockClear();
      owner.emit('destroyed');
      expect(setActive).not.toHaveBeenCalled();
      expect(onOwnerGone).not.toHaveBeenCalled();
    }
  });

  it('detaches replaced owners and the companion callback after crashes, including renderer restarts', () => {
    const setActive = vi.fn();
    const onOwnerGone = vi.fn();
    const lease = createLayoutPreviewLease(setActive, onOwnerGone);
    const first = fakeOwner(1);
    const second = fakeOwner(2);
    lease.setActive(true, first);
    lease.setActive(true, second);
    expect(first.listenerCount('destroyed')).toBe(0);
    expect(first.listenerCount('render-process-gone')).toBe(0);
    for (let round = 0; round < 25; round++) {
      lease.setActive(true, second);
      second.emit('render-process-gone');
      expect(second.listenerCount('destroyed')).toBe(0);
      expect(second.listenerCount('render-process-gone')).toBe(0);
      expect(onOwnerGone).toHaveBeenCalledTimes(round + 1);
    }
    setActive.mockClear();
    first.emit('destroyed');
    second.emit('destroyed');
    expect(setActive).not.toHaveBeenCalled();
    expect(onOwnerGone).toHaveBeenCalledTimes(25);
  });

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

  it('extracts a trusted IPC sender and ignores empty events', () => {
    const owner = fakeOwner(7);
    expect(layoutPreviewOwnerFromEvent({ sender: owner })).toEqual(
      expect.objectContaining({ id: 7 }),
    );
    expect(layoutPreviewOwnerFromEvent({})).toBeNull();
  });
});
