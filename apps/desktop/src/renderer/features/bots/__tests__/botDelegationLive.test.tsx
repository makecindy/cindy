// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __testing as dataOwnerTesting,
  getDataOwnerGeneration,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import type { BotDelegationChangedPayload } from '../../../../shared/botDelegation';
import type { DataOwnerPushStamp } from '../../../../shared/dataOwnerPush';
import {
  __resetBotDelegationLiveForTest,
  useBotDelegationList,
  useBotDelegations,
} from '../botDelegationLive';

const { listBotDelegations } = vi.hoisted(() => ({ listBotDelegations: vi.fn() }));
vi.mock('@/lib/makerTransport', () => ({ makerApiForSticky: () => ({ listBotDelegations }) }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: { getSessionDeviceId: () => undefined },
}));
vi.mock('@/contexts/AuthContext', () => ({
  useOptionalDataOwnerGeneration: () =>
    useSyncExternalStore(subscribeOwner, () => getDataOwnerGeneration().generation),
}));

type ChangeListener = (change: BotDelegationChangedPayload, stamp?: DataOwnerPushStamp) => void;
const listeners = new Set<ChangeListener>();
const ownerListeners = new Set<() => void>();

function subscribeOwner(listener: () => void) {
  ownerListeners.add(listener);
  return () => { ownerListeners.delete(listener); };
}

function deferRead() {
  let resolve!: (id: string) => void;
  const response = new Promise((settle) => {
    resolve = id => settle({ ok: true, delegations: [{ id }] });
  });
  return { response, resolve };
}

function publishOtherLane(stamp?: DataOwnerPushStamp, change: Partial<BotDelegationChangedPayload> = {}) {
  for (const listener of listeners) {
    listener({
      delegationId: 'other-lane-task',
      parentSessionId: 'thread',
      childSessionId: 'task',
      status: 'running',
      ...change,
    }, stamp);
  }
}

beforeEach(() => {
  setDataOwnerGeneration('owner', 1);
  listBotDelegations.mockReset().mockResolvedValue({ ok: true, delegations: [] });
  vi.stubGlobal('electronAPI', {
    maker: {
      onBotDelegationChanged(listener: ChangeListener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
});

afterEach(() => {
  cleanup();
  __resetBotDelegationLiveForTest();
  vi.unstubAllGlobals();
  dataOwnerTesting.reset();
});

describe('canonical background-task snapshot', () => {
  it('refreshes the shared list for other lanes only while the list is in use', async () => {
    const { result, rerender } = renderHook(({ open }) => ({
      cards: useBotDelegations('canonical'),
      list: useBotDelegationList(open ? 'canonical' : null, 'requester'),
    }), { initialProps: { open: false } });
    await act(async () => {});

    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [{ id: 'other-lane-task', status: 'running' }],
    });
    act(() => publishOtherLane());
    expect(listBotDelegations).toHaveBeenCalledTimes(1);

    rerender({ open: true });
    await waitFor(() => expect(result.current.list.rows).toMatchObject([{ status: 'running' }]));
    expect(result.current.cards).toBe(result.current.list.rows);
    expect(listeners.size).toBe(1);

    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [{ id: 'other-lane-task', status: 'completed' }],
    });
    act(() => publishOtherLane({ dataOwnerId: 'old-owner', ownerGeneration: 1 }));
    expect(listBotDelegations).toHaveBeenCalledTimes(2);
    act(() => publishOtherLane({ dataOwnerId: 'owner', ownerGeneration: 1 }));
    await waitFor(() => expect(result.current.list.rows).toMatchObject([{ status: 'completed' }]));
    expect(listBotDelegations).toHaveBeenCalledTimes(3);

    rerender({ open: false });
    act(() => publishOtherLane());
    expect(listBotDelegations).toHaveBeenCalledTimes(3);
  });

  it('only refreshes an open list for its requester or the shared parent session', async () => {
    const { result } = renderHook(() => useBotDelegationList('canonical', 'requester'));
    await waitFor(() => expect(result.current.resolved).toBe(true));

    await act(async () => publishOtherLane(undefined, { requestingBotId: 'another-bot' }));
    expect(listBotDelegations).toHaveBeenCalledTimes(1);
    await act(async () => publishOtherLane(undefined, { requestingBotId: 'requester' }));
    expect(listBotDelegations).toHaveBeenCalledTimes(2);
    await act(async () => publishOtherLane(undefined, { requestingBotId: 'another-bot', parentSessionId: 'canonical' }));
    expect(listBotDelegations).toHaveBeenCalledTimes(3);
  });

  it('does not flash the previous companion when switching, and retries a failed list read', async () => {
    listBotDelegations.mockImplementation(async (sessionId: string) => (
      sessionId === 'first'
        ? { ok: true, delegations: [{ id: 'first-task' }] }
        : { ok: false, errorCode: 'READ_FAILED', message: 'Temporary error' }
    ));
    const seen: Array<{ sessionId: string; rowIds: string[] }> = [];
    const { result, rerender } = renderHook(({ sessionId }) => {
      const list = useBotDelegationList(sessionId, sessionId);
      seen.push({ sessionId, rowIds: list.rows.map((row) => row.id) });
      return list;
    }, { initialProps: { sessionId: 'first' } });
    await waitFor(() => expect(result.current.rows).toMatchObject([{ id: 'first-task' }]));

    rerender({ sessionId: 'second' });
    await waitFor(() => expect(result.current).toMatchObject({ resolved: true, stale: true, rows: [] }));
    expect(seen.filter((render) => render.sessionId === 'second').every((render) => render.rowIds.length === 0))
      .toBe(true);

    listBotDelegations.mockResolvedValue({ ok: true, delegations: [{ id: 'second-task' }] });
    act(() => result.current.retry());
    await waitFor(() => expect(result.current).toMatchObject({
      resolved: true,
      stale: false,
      rows: [{ id: 'second-task' }],
    }));
  });

  it('reloads a mounted list on a same-owner recommit and rejects the previous generation', async () => {
    const previous = deferRead();
    const current = deferRead();
    listBotDelegations
      .mockResolvedValueOnce({ ok: true, delegations: [{ id: 'previous-confirmed' }] })
      .mockReturnValueOnce(previous.response)
      .mockReturnValueOnce(current.response);
    const { result } = renderHook(() => useBotDelegationList('canonical', 'requester'));
    await waitFor(() => expect(result.current.rows).toMatchObject([{ id: 'previous-confirmed' }]));
    await act(async () => result.current.retry());
    expect(listBotDelegations).toHaveBeenCalledTimes(2);

    await act(async () => {
      setDataOwnerGeneration('owner', 2);
      for (const listener of ownerListeners) listener();
    });
    expect(result.current).toMatchObject({ resolved: false, rows: [] });
    expect(listBotDelegations).toHaveBeenCalledTimes(3);
    await act(async () => previous.resolve('previous-late'));
    expect(result.current.rows).toEqual([]);
    await act(async () => current.resolve('current'));
    expect(result.current.rows).toMatchObject([{ id: 'current' }]);
  });

  it('merges an invalidation burst into one trailing read without publishing the older response', async () => {
    const inFlight = deferRead();
    const trailing = deferRead();
    listBotDelegations.mockReturnValueOnce(inFlight.response).mockReturnValueOnce(trailing.response);
    const { result } = renderHook(() => useBotDelegationList('canonical', 'requester'));
    await act(async () => {});
    expect(listBotDelegations).toHaveBeenCalledTimes(1);

    await act(async () => {
      publishOtherLane();
      publishOtherLane();
      publishOtherLane();
    });
    expect(listBotDelegations).toHaveBeenCalledTimes(1);
    await act(async () => inFlight.resolve('older'));
    expect(listBotDelegations).toHaveBeenCalledTimes(2);
    expect(result.current.rows).toEqual([]);
    await act(async () => trailing.resolve('latest'));
    expect(result.current.rows).toMatchObject([{ id: 'latest' }]);
    expect(listBotDelegations).toHaveBeenCalledTimes(2);
  });
});
