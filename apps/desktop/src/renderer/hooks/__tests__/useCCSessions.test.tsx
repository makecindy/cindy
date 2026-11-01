// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIpcError } from '../../../shared/ipc-errors';
import { useCCSessions } from '../useCCSessions';

const mocks = vi.hoisted(() => ({
  create: vi.fn(), prependCreated: vi.fn(),
  rows: [] as unknown[],
}));
vi.mock('@/lib/sessionService', () => ({ create: mocks.create }));
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: {
  getByFilter: () => mocks.rows,
  subscribe: () => () => {},
  prependCreated: mocks.prependCreated,
} }));

// #7395: the real hook must report the current create error before state commits.
// Existing submission tests inject createSession and cannot observe this boundary.
// A separate jsdom file is needed because the recovery controller suite is pure node.
// Minimal input: two failed creates in one React batch. Tier: component/unit.
describe('useCCSessions creation result compatibility', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('reports each invocation error synchronously without waiting for a React render', async () => {
    const first = createIpcError('WRITABLE_DIRECTORY_AUTHORIZATION_REQUIRED', 'Picker proof required');
    const second = createIpcError('WRITABLE_DIRECTORY_UNAVAILABLE', 'Directory unavailable');
    mocks.create.mockRejectedValueOnce(first).mockRejectedValueOnce(second);
    const { result } = renderHook(() => useCCSessions());
    const observed: unknown[] = [];
    await act(async () => {
      expect(await result.current.createSession({}, (error) => observed.push(error))).toBeNull();
      expect(observed).toEqual([first]);
      expect(await result.current.createSession({}, (error) => observed.push(error))).toBeNull();
      expect(observed).toEqual([first, second]);
    });
    expect(mocks.prependCreated).not.toHaveBeenCalled();
  });

  it('keeps the legacy null result when the caller does not request an error callback', async () => {
    mocks.create.mockRejectedValueOnce(new Error('Storage failure'));
    const { result } = renderHook(() => useCCSessions());
    await act(async () => { expect(await result.current.createSession()).toBeNull(); });
    expect(result.current.error?.message).toBe('Storage failure');
    expect(mocks.prependCreated).not.toHaveBeenCalled();
  });

  it('returns and publishes the created session once without calling the failure handler', async () => {
    const session = { id: 'created-session' };
    mocks.create.mockResolvedValueOnce(session);
    const failed = vi.fn();
    const { result } = renderHook(() => useCCSessions());
    await act(async () => { expect(await result.current.createSession({}, failed)).toBe(session); });
    expect(mocks.prependCreated).toHaveBeenCalledExactlyOnceWith(session);
    expect(failed).not.toHaveBeenCalled();
  });
});
