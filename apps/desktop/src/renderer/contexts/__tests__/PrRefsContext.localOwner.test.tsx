// @vitest-environment jsdom

import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dataOwnerId: 'local-v1' as string | null,
  listAllPrRefs: vi.fn(),
  onPrRefsChanged: vi.fn(() => () => undefined),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ dataOwnerId: mocks.dataOwnerId }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), debug: vi.fn() }),
}));

import { PrRefsProvider, usePrRefsForSession, usePrActions, usePrStatuses } from '../PrRefsContext';

function RefCount() {
  return <div>{usePrRefsForSession('session-local').length}</div>;
}

describe('PrRefsProvider local owner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dataOwnerId = 'local-v1';
    mocks.listAllPrRefs.mockResolvedValue([
      {
        id: 'ref-1',
        sessionId: 'session-local',
        owner: 'makecindy',
        repo: 'cindy',
        prNumber: 445,
        url: 'https://github.com/makecindy/cindy/pull/445',
        firstSeenAt: 1,
        lastSeenAt: 2,
      },
    ]);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      gitContext: {
        listAllPrRefs: mocks.listAllPrRefs,
        onPrRefsChanged: mocks.onPrRefsChanged,
        listPrRefs: vi.fn(),
        getPrStatuses: vi.fn(),
      },
    };
  });

  it('loads PR refs for the account-free local data owner', async () => {
    render(
      <PrRefsProvider>
        <RefCount />
      </PrRefsProvider>,
    );

    expect(await screen.findByText('1')).toBeTruthy();
    expect(mocks.listAllPrRefs).toHaveBeenCalledOnce();
    expect(mocks.onPrRefsChanged).toHaveBeenCalledOnce();
  });
});

function RemoteRefs() {
  const { registerPrConsumer, invalidateRemotePrRefs } = usePrActions();
  const refs = usePrRefsForSession('remote-child');
  useEffect(() => registerPrConsumer('remote-child', 'home'), [registerPrConsumer]);
  return (
    <button onClick={() => invalidateRemotePrRefs('remote-child')}>remote:{refs.length}</button>
  );
}

describe('remote task association invalidation', () => {
  afterEach(cleanup);
  it.each([false, true])(
    'refreshes empty refs without waiting for TTL (in flight: %s)',
    async (inFlight) => {
      let finish!: (value: unknown) => void;
      let reads = 0;
      const ref = {
        id: 'pr',
        sessionId: 'remote-child',
        owner: 'a',
        repo: 'b',
        prNumber: 1,
        url: 'https://github.com/a/b/pull/1',
        firstSeenAt: 1,
        lastSeenAt: 1,
      };
      mocks.listAllPrRefs.mockResolvedValue([]);
      const invoke = vi.fn(async (_device: string, channel: string) => {
        if (channel !== 'git-context:pr-refs:list') return [];
        reads += 1;
        if (reads === 1)
          return inFlight
            ? await new Promise((resolve) => {
                finish = resolve;
              })
            : [];
        return [ref];
      });
      window.electronAPI = {
        gitContext: { listAllPrRefs: mocks.listAllPrRefs, onPrRefsChanged: mocks.onPrRefsChanged },
        deviceLink: { invoke },
      } as any;
      render(
        <PrRefsProvider>
          <RemoteRefs />
        </PrRefsProvider>,
      );
      await waitFor(() => expect(reads).toBe(1));
      fireEvent.click(screen.getByRole('button', { name: 'remote:0' }));
      if (inFlight) {
        fireEvent.click(screen.getByRole('button', { name: 'remote:0' }));
        expect(reads).toBe(1);
        await act(async () => finish([]));
      }
      expect(await screen.findByRole('button', { name: 'remote:1' })).toBeTruthy();
      expect(reads).toBe(2);
      expect(invoke).toHaveBeenCalledWith('home', 'git-context:pr-status', [
        { sessionId: 'remote-child', queries: [{ owner: 'a', repo: 'b', prNumber: 1 }] },
      ]);
    },
  );
});

function StatusProbe() {
  const { statuses, successfulStatuses, fetchStatusesForSession } = usePrStatuses('remote-child');
  const { registerPrConsumer } = usePrActions();
  useEffect(() => registerPrConsumer('remote-child', 'home'), [registerPrConsumer]);
  const latest = statuses.get('a/b#1');
  const confirmed = successfulStatuses.get('a/b#1');
  return (
    <button onClick={() => fetchStatusesForSession('remote-child')}>
      {confirmed?.ok ? confirmed.status : 'unknown'}:{latest?.ok === false ? 'stale' : 'fresh'}
    </button>
  );
}

it('retains successful session status when a failure arrives while its consumer is unmounted', async () => {
  let fail!: (value: unknown) => void;
  let statusReads = 0;
  const ref = {
    id: 'pr',
    sessionId: 'remote-child',
    owner: 'a',
    repo: 'b',
    prNumber: 1,
    url: 'https://github.com/a/b/pull/1',
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
  mocks.listAllPrRefs.mockResolvedValue([]);
  const invoke = vi.fn(async (_device: string, channel: string) => {
    if (channel === 'git-context:pr-refs:list') return [ref];
    statusReads += 1;
    if (statusReads === 1) return [{ ...ref, ok: true, status: 'merged' }];
    if (statusReads === 2)
      return await new Promise((resolve) => {
        fail = resolve;
      });
    return [{ ...ref, ok: false, reason: 'fetch-failed' }];
  });
  window.electronAPI = {
    gitContext: { listAllPrRefs: mocks.listAllPrRefs, onPrRefsChanged: mocks.onPrRefsChanged },
    deviceLink: { invoke },
  } as any;
  const view = (visible: boolean) => (
    <PrRefsProvider>{visible ? <StatusProbe /> : null}</PrRefsProvider>
  );
  const { rerender, unmount } = render(view(true));
  fireEvent.click(await screen.findByRole('button', { name: 'merged:fresh' }));
  await waitFor(() => expect(statusReads).toBe(2));
  rerender(view(false));
  await act(async () => fail([{ ...ref, ok: false, reason: 'no-token' }]));
  rerender(view(true));
  expect(await screen.findByRole('button', { name: 'merged:stale' })).toBeTruthy();
  mocks.dataOwnerId = 'another-owner';
  rerender(view(true));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'merged:stale' })).toBeNull());
  unmount();
});
