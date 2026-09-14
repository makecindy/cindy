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

it('queries the latest PRs after the previous reference status request settles', async () => {
  let finish!: (value: unknown) => void;
  let latestNumber = 1;
  const queries: number[][] = [];
  const ref = (n: number) => ({
    id: `pr-${n}`,
    sessionId: 'remote-child',
    owner: 'a',
    repo: 'b',
    prNumber: n,
    url: `https://github.com/a/b/pull/${n}`,
    firstSeenAt: 1,
    lastSeenAt: n,
  });
  mocks.listAllPrRefs.mockResolvedValue([]);
  const invoke = vi.fn(async (_device: string, channel: string, args: any[]) => {
    if (channel === 'git-context:pr-refs:list') return [ref(latestNumber)];
    queries.push(args[0].queries.map((q: any) => q.prNumber));
    if (queries.length === 1)
      return await new Promise((resolve) => {
        finish = resolve;
      });
    return [{ ...ref(latestNumber), ok: true, status: 'merged' }];
  });
  window.electronAPI = {
    gitContext: { listAllPrRefs: mocks.listAllPrRefs, onPrRefsChanged: mocks.onPrRefsChanged },
    deviceLink: { invoke },
  } as any;
  function Probe() {
    const { registerPrConsumer, invalidateRemotePrRefs } = usePrActions();
    const { statuses } = usePrStatuses('remote-child');
    useEffect(() => registerPrConsumer('remote-child', 'home'), [registerPrConsumer]);
    const result = statuses.get('a/b#3');
    return (
      <button onClick={() => invalidateRemotePrRefs('remote-child')}>
        {result?.ok ? result.status : 'pending'}
      </button>
    );
  }
  const { unmount } = render(
    <PrRefsProvider>
      <Probe />
    </PrRefsProvider>,
  );
  await waitFor(() => expect(queries).toEqual([[1]]));
  for (const n of [2, 3]) {
    latestNumber = n;
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'pending' })));
  }
  expect(queries).toEqual([[1]]);
  await act(async () => finish([{ ...ref(1), ok: true, status: 'open' }]));
  expect(await screen.findByRole('button', { name: 'merged' })).toBeTruthy();
  expect(queries).toEqual([[1], [3]]);
  unmount();
});

it('keeps cached PR data stale until both rejected query channels recover, then clears on owner change', async () => {
  mocks.dataOwnerId = 'query-owner';
  mocks.listAllPrRefs.mockResolvedValue([]);
  const ref = { id: 'pr', sessionId: 'remote-child', owner: 'a', repo: 'b', prNumber: 1,
    url: 'https://github.com/a/b/pull/1', firstSeenAt: 1, lastSeenAt: 1 };
  let refsFail = false;
  let statusesFail = false;
  window.electronAPI = {
    gitContext: { listAllPrRefs: mocks.listAllPrRefs, onPrRefsChanged: mocks.onPrRefsChanged },
    deviceLink: { invoke: vi.fn(async (_device: string, channel: string) => {
      if (channel === 'git-context:pr-refs:list') {
        if (refsFail) throw new Error('tunnel timeout');
        return [ref];
      }
      if (statusesFail) throw new Error('tunnel timeout');
      return [{ ...ref, ok: true, status: 'merged' }];
    }) },
  } as any;
  function Probe() {
    const { registerPrConsumer, invalidateRemotePrRefs } = usePrActions();
    const { successfulStatuses, refreshError, fetchStatusesForSession } = usePrStatuses('remote-child');
    const refs = usePrRefsForSession('remote-child');
    const other = usePrStatuses('other-session');
    useEffect(() => registerPrConsumer('remote-child', 'home'), [registerPrConsumer]);
    return <div>
      <span>{refs.length}:{successfulStatuses.size}:{refreshError ? 'stale' : 'fresh'}</span>
      <span>other:{String(other.refreshError)}</span>
      <button onClick={() => invalidateRemotePrRefs('remote-child')}>refs</button>
      <button onClick={() => fetchStatusesForSession('remote-child')}>statuses</button>
    </div>;
  }
  const view = () => <PrRefsProvider><Probe /></PrRefsProvider>;
  const { rerender, unmount } = render(view());
  await screen.findByText('1:1:fresh');
  statusesFail = true;
  await act(async () => fireEvent.click(screen.getByText('statuses')));
  expect(screen.getByText('1:1:stale')).toBeTruthy();
  refsFail = true;
  await act(async () => fireEvent.click(screen.getByText('refs')));
  expect(screen.getByText('1:1:stale')).toBeTruthy();
  expect(screen.getByText('other:false')).toBeTruthy();
  statusesFail = false;
  await act(async () => fireEvent.click(screen.getByText('statuses')));
  expect(screen.getByText('1:1:stale')).toBeTruthy();
  refsFail = false;
  await act(async () => fireEvent.click(screen.getByText('refs')));
  expect(screen.getByText('1:1:fresh')).toBeTruthy();
  refsFail = true;
  await act(async () => fireEvent.click(screen.getByText('refs')));
  mocks.dataOwnerId = 'new-query-owner';
  rerender(view());
  expect(screen.queryByText('1:1:stale')).toBeNull();
  unmount();
});

it('marks rejected local push refresh stale and recovers through the existing focus refresh', async () => {
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  mocks.dataOwnerId = 'local-refresh-owner';
  const ref = { id: 'local-pr', sessionId: 'session-local', owner: 'a', repo: 'b', prNumber: 1,
    url: 'https://github.com/a/b/pull/1', firstSeenAt: 1, lastSeenAt: 1 };
  let changed!: (data: { sessionId: string }) => void;
  let failed = false;
  const listPrRefs = vi.fn(async () => {
    if (failed) throw new Error('IPC unavailable');
    return [ref];
  });
  window.electronAPI = { gitContext: {
    listAllPrRefs: vi.fn(async () => [ref]),
    listPrRefs,
    getPrStatuses: vi.fn(async () => [{ ...ref, ok: true, status: 'merged' }]),
    onPrRefsChanged: (callback: typeof changed) => { changed = callback; return () => {}; },
  } } as any;
  function Probe() {
    const { registerPrConsumer } = usePrActions();
    const { refreshError } = usePrStatuses('session-local');
    const refs = usePrRefsForSession('session-local');
    useEffect(() => registerPrConsumer('session-local'), [registerPrConsumer]);
    return <span>{refs.length}:{refreshError ? 'stale' : 'fresh'}</span>;
  }
  const { unmount } = render(<PrRefsProvider><Probe /></PrRefsProvider>);
  await screen.findByText('1:fresh');
  failed = true;
  await act(async () => changed({ sessionId: 'session-local' }));
  expect(screen.getByText('1:stale')).toBeTruthy();
  failed = false;
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(screen.getByText('1:fresh')).toBeTruthy();
  failed = true;
  await act(async () => changed({ sessionId: 'session-local' }));
  expect(screen.getByText('1:stale')).toBeTruthy();
  failed = false;
  await act(async () => changed({ sessionId: 'session-local' }));
  expect(screen.getByText('1:fresh')).toBeTruthy();
  unmount();
  focus.mockRestore();
});

it('invalidates confirmed PR status on not-found across remounts and later transient failures', async () => {
  mocks.dataOwnerId = 'not-found-owner';
  mocks.listAllPrRefs.mockResolvedValue([]);
  const ref = { id: 'pr', sessionId: 'remote-child', owner: 'a', repo: 'b', prNumber: 1,
    url: 'https://github.com/a/b/pull/1', firstSeenAt: 1, lastSeenAt: 1 };
  let status: any = { ...ref, ok: true, status: 'merged' };
  window.electronAPI = {
    gitContext: { listAllPrRefs: mocks.listAllPrRefs, onPrRefsChanged: mocks.onPrRefsChanged },
    deviceLink: { invoke: vi.fn(async (_device: string, channel: string) =>
      channel === 'git-context:pr-refs:list' ? [ref] : [status]) },
  } as any;
  const view = (visible: boolean) => <PrRefsProvider>{visible ? <StatusProbe /> : null}</PrRefsProvider>;
  const { rerender, unmount } = render(view(true));
  await screen.findByRole('button', { name: 'merged:fresh' });
  for (const reason of ['not-found', 'fetch-failed', 'no-token']) {
    status = { ...ref, ok: false, reason };
    await act(async () => fireEvent.click(screen.getByRole('button')));
    expect(screen.getByRole('button', { name: 'unknown:stale' })).toBeTruthy();
    rerender(view(false));
    rerender(view(true));
    await screen.findByRole('button', { name: 'unknown:stale' });
  }
  status = { ...ref, ok: true, status: 'merged' };
  await act(async () => fireEvent.click(screen.getByRole('button')));
  expect(screen.getByRole('button', { name: 'merged:fresh' })).toBeTruthy();
  unmount();
});
