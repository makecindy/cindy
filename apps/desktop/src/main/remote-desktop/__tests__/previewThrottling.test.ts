import { describe, expect, it, vi } from 'vitest';
import {
  applyBackgroundThrottling,
  holdBackgroundThrottlingOff,
  type ThrottledContents,
} from '../previewThrottling';

function contents(allowed = true) {
  const state = { allowed, destroyed: false };
  const c: ThrottledContents = {
    isDestroyed: () => state.destroyed,
    getBackgroundThrottling: () => state.allowed,
    setBackgroundThrottling: vi.fn((next: boolean) => {
      state.allowed = next;
    }),
  };
  return { c, state };
}

describe('preview background throttling hold', () => {
  it('turns throttling off for the hold and restores exactly what it was', () => {
    for (const original of [true, false]) {
      const { c, state } = contents(original);
      const release = holdBackgroundThrottlingOff(c);
      expect(state.allowed).toBe(false);
      release();
      expect(state.allowed).toBe(original);
      release(); // idempotent
      expect(c.setBackgroundThrottling).toHaveBeenCalledTimes(2);
    }
  });

  it('restores only when the last of several holds is released', () => {
    const { c, state } = contents(true);
    const first = holdBackgroundThrottlingOff(c);
    const second = holdBackgroundThrottlingOff(c);
    first();
    expect(state.allowed).toBe(false);
    second();
    expect(state.allowed).toBe(true);
  });

  it('keeps an owner change made during the hold for the release instead of undoing the hold', () => {
    const { c, state } = contents(true);
    const release = holdBackgroundThrottlingOff(c);
    applyBackgroundThrottling(c, false); // e.g. a turn started
    applyBackgroundThrottling(c, true); // ... and ended while the phone is still watching
    expect(state.allowed).toBe(false);
    applyBackgroundThrottling(c, false);
    release();
    expect(state.allowed).toBe(false);
    // Without a hold the owner's change applies at once.
    applyBackgroundThrottling(c, true);
    expect(state.allowed).toBe(true);
  });

  it('leaves a destroyed contents alone', () => {
    const { c } = contents(true);
    const release = holdBackgroundThrottlingOff(c);
    (c.isDestroyed as () => boolean) = () => true;
    release();
    applyBackgroundThrottling(c, true);
    expect(c.setBackgroundThrottling).toHaveBeenCalledTimes(1);
  });
});
