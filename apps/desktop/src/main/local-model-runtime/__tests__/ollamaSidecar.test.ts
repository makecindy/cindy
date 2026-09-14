import { describe, expect, it, vi } from 'vitest';

import { registerManagedSidecarQuitHook } from '../ollamaSidecar.js';

describe('registerManagedSidecarQuitHook', () => {
  it('registers the stop hook only once', () => {
    const register = vi.fn();
    registerManagedSidecarQuitHook(register);
    registerManagedSidecarQuitHook(register);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(expect.any(Function));
  });
});
