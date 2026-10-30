import { describe, expect, it, vi } from 'vitest';
import { shouldTeardownColdStartRuntime } from '../authColdStartBoundary';

describe('auth login-flow reset', () => {


  it('does not call teardown for a fresh signed-out/null cold-start session', () => {
    const teardown = vi.fn();
    const previousAppSession = {
      mode: 'signed-out' as const,
      dataOwnerId: null,
      generation: 0,
    };

    if (shouldTeardownColdStartRuntime(previousAppSession, 'account-1')) {
      teardown();
    }

    expect(teardown).not.toHaveBeenCalled();
  });


  it('tears down only an already-committed runtime that crosses an owner boundary', () => {
    expect(
      shouldTeardownColdStartRuntime(
        { mode: 'cloud', dataOwnerId: 'account-1', generation: 1 },
        'account-1',
      ),
    ).toBe(false);
    expect(
      shouldTeardownColdStartRuntime(
        { mode: 'cloud', dataOwnerId: 'account-1', generation: 1 },
        'account-2',
      ),
    ).toBe(true);
    expect(
      shouldTeardownColdStartRuntime(
        { mode: 'local', dataOwnerId: 'local-v1', generation: 1 },
        'account-1',
      ),
    ).toBe(true);
  });
});
