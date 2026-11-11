import { beforeEach, describe, expect, it, vi } from 'vitest';

const { withSecurityBoundaryLock } = vi.hoisted(() => ({
  withSecurityBoundaryLock: vi.fn(),
}));

vi.mock('../../device-link/crossProcessLock.js', () => ({
  withSecurityBoundaryLock,
}));

import {
  resetGhostOauthMutationLocksForTest,
  withGhostOauthMutationLock,
} from '../ghostOauthMutationLock.js';

describe('ghost OAuth mutation lock', () => {
  beforeEach(() => {
    resetGhostOauthMutationLocksForTest();
    withSecurityBoundaryLock.mockReset();
    withSecurityBoundaryLock.mockImplementation(
      async (_path: string, _opts: unknown, task: (status: { held: true }) => Promise<unknown>) =>
        task({ held: true }),
    );
  });

  it('fails closed when the security-boundary lock cannot be acquired', async () => {
    withSecurityBoundaryLock.mockImplementationOnce(
      async (
        _path: string,
        _opts: unknown,
        task: (status: { held: false; reason: 'busy' }) => Promise<unknown>,
      ) => task({ held: false, reason: 'busy' }),
    );

    await expect(
      withGhostOauthMutationLock('owner-a', 'plugin-a', 'C:/locks/plugin-a.lock', vi.fn()),
    ).rejects.toThrow('Plugin OAuth mutation lock is busy or unavailable');
  });

  it('is reentrant for the same owner and plugin without reacquiring cross-process state', async () => {
    const result = await withGhostOauthMutationLock(
      'owner-a',
      'plugin-a',
      'C:/locks/plugin-a.lock',
      () =>
        withGhostOauthMutationLock('owner-a', 'plugin-a', 'C:/locks/plugin-a.lock', () => 'done'),
    );

    expect(result).toBe('done');
    expect(withSecurityBoundaryLock).toHaveBeenCalledTimes(1);
  });

  it('serializes same-key work before acquiring the next strict lock', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];

    const first = withGhostOauthMutationLock(
      'owner-a',
      'plugin-a',
      'C:/locks/plugin-a.lock',
      async () => {
        events.push('first-start');
        await firstGate;
        events.push('first-end');
      },
    );
    const second = withGhostOauthMutationLock(
      'owner-a',
      'plugin-a',
      'C:/locks/plugin-a.lock',
      async () => {
        events.push('second');
      },
    );

    await vi.waitFor(() => expect(events).toEqual(['first-start']));
    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(['first-start', 'first-end', 'second']);
    expect(withSecurityBoundaryLock).toHaveBeenCalledTimes(2);
  });
});
