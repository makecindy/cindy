// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  current: { dataOwnerId: 'owner-a' as string | null, dataOwnerRecoveryEpoch: 0, dataOwnerGeneration: 1 },
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => auth.current,
}));

import { useNewMakerPrefsOwnerResync } from '@/hooks/useNewMakerPrefsOwnerResync';

describe('useNewMakerPrefsOwnerResync (#4469)', () => {
  afterEach(() => {
    auth.current = { dataOwnerId: 'owner-a', dataOwnerRecoveryEpoch: 0, dataOwnerGeneration: 1 };
  });

  it('re-pushes when the same owner advances its generation, and only then', () => {
    const sync = vi.fn();
    const { rerender } = renderHook(() => useNewMakerPrefsOwnerResync(sync));
    expect(sync).toHaveBeenCalledTimes(1);

    // Unrelated re-render: same owner, same epoch, same generation → no push.
    rerender();
    expect(sync).toHaveBeenCalledTimes(1);

    // Same-owner projection repair: only the generation moves.
    auth.current = { ...auth.current, dataOwnerGeneration: 2 };
    rerender();
    expect(sync).toHaveBeenCalledTimes(2);

    // A rejected boundary restores the generation and bumps the recovery epoch.
    auth.current = { ...auth.current, dataOwnerRecoveryEpoch: 1 };
    rerender();
    expect(sync).toHaveBeenCalledTimes(3);

    // Owner switch still re-pushes as before.
    auth.current = { dataOwnerId: 'owner-b', dataOwnerRecoveryEpoch: 1, dataOwnerGeneration: 5 };
    rerender();
    expect(sync).toHaveBeenCalledTimes(4);
  });

  it('follows the latest sync callback identity without duplicating pushes', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ sync }) => useNewMakerPrefsOwnerResync(sync), {
      initialProps: { sync: first },
    });
    expect(first).toHaveBeenCalledTimes(1);
    rerender({ sync: second });
    expect(second).toHaveBeenCalledTimes(1);
    auth.current = { ...auth.current, dataOwnerGeneration: 3 };
    rerender({ sync: second });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });
});
