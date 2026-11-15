// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUsageCostDetails } from '../hooks/useUsageCostDetails';
import { setDataOwnerGeneration } from '../contexts/dataOwnerGeneration';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  device: undefined as string | undefined,
  push: undefined as
    ((payload: { deviceId: string; channel: string; payload: unknown }) => void) | undefined,
}));
vi.mock('@/lib/makerTransport', () => ({ estimatedSessionValueFor: mocks.read }));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: () => mocks.device,
}));
vi.mock('@/lib/remoteDataOwnerPushFence', () => ({ isDeviceLinkRemotePushCurrent: () => true }));

// Hook boundary: delayed reads must not expose another task/account; remote
// late billing refreshes only the owning device. No live network or paid models.
beforeEach(() => {
  mocks.read.mockReset();
  mocks.device = undefined;
  mocks.push = undefined;
  setDataOwnerGeneration('owner', 1);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      onUsageMessageTurnCost: () => () => {},
      deviceLink: {
        onRemotePush: (fn: typeof mocks.push) => {
          mocks.push = fn;
          return () => {};
        },
      },
    },
  });
});
describe('cost detail request ownership', () => {
  it('reads only while visible and discards a result crossing the account boundary', async () => {
    let resolve!: (value: { costBreakdown: unknown[] }) => void;
    mocks.read.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { result, rerender } = renderHook(
      ({ visible }) => useUsageCostDetails('s1', visible, 'm1'),
      { initialProps: { visible: false } },
    );
    expect(mocks.read).not.toHaveBeenCalled();
    rerender({ visible: true });
    expect(mocks.read).toHaveBeenCalledWith('s1', { includeBreakdown: true, clientId: 'm1' });
    setDataOwnerGeneration('other', 2);
    await act(async () => resolve({ costBreakdown: [] }));
    expect(result.current).toBeUndefined();
  });
  it('refreshes late fees only from the task owning device', async () => {
    mocks.device = 'host';
    mocks.read.mockResolvedValue({ costBreakdown: [] });
    const { result } = renderHook(() => useUsageCostDetails('s1', true));
    await waitFor(() => expect(result.current).toEqual([]));
    await act(async () =>
      mocks.push?.({
        deviceId: 'other',
        channel: 'usage:message-turn-cost',
        payload: { sessionId: 's1' },
      }),
    );
    expect(mocks.read).toHaveBeenCalledTimes(1);
    await act(async () =>
      mocks.push?.({
        deviceId: 'host',
        channel: 'usage:message-turn-cost',
        payload: { sessionId: 's1' },
      }),
    );
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });
});
