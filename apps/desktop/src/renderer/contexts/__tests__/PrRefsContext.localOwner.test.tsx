// @vitest-environment jsdom

import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

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

import { PrRefsProvider, usePrRefsForSession, usePrActions, usePrStatus, usePrStatuses, useTaskPrArchiveEligibility } from '../PrRefsContext';
import { unresponsiveDevicesStore } from '@/features/device-link/unresponsiveDevicesStore';
import { PR_STATUS_REFRESH_INTERVAL_MS } from '@/lib/prStatus';

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
  // Unit regression: a manager mutation can finish after the last consumer
  // leaves. Existing invalidation tests always kept a consumer registered.
  // One cached (or in-flight) empty result must not suppress a remount within TTL.
  it.each([false, true])(
    'invalidates without consumers before remount (in flight: %s)',
    async (inFlight) => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
      let finish!: (value: unknown[]) => void;
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
            ? await new Promise<unknown[]>((resolve) => {
                finish = resolve;
              })
            : [];
        return [ref];
      });
      window.electronAPI = {
        gitContext: { listAllPrRefs: mocks.listAllPrRefs, onPrRefsChanged: mocks.onPrRefsChanged },
        deviceLink: { invoke },
      } as unknown as typeof window.electronAPI;
      function Probe({ active }: { active: boolean }) {
        const { registerPrConsumer, invalidateRemotePrRefs } = usePrActions();
        const refs = usePrRefsForSession('remote-child');
        useEffect(() => {
          if (active) return registerPrConsumer('remote-child', 'home');
        }, [active, registerPrConsumer]);
        return (
          <button onClick={() => invalidateRemotePrRefs('remote-child')}>count:{refs.length}</button>
        );
      }
      const view = (active: boolean) => (
        <PrRefsProvider>
          <Probe active={active} />
        </PrRefsProvider>
      );
      const { rerender, unmount } = render(view(true));
      try {
        await act(async () => {});
        expect(reads).toBe(1);
        rerender(view(false));
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'count:0' }));
        });
        if (inFlight)
          await act(async () => {
            finish([]);
          });
        expect(reads).toBe(1);
        await act(async () => {
          rerender(view(true));
        });
        expect(screen.getByRole('button', { name: 'count:1' })).toBeTruthy();
        expect(reads).toBe(2);
        rerender(view(false));
        await act(async () => {
          rerender(view(true));
        });
        expect(reads).toBe(2);
      } finally {
        unmount();
        now.mockRestore();
      }
    },
  );

  it('suppresses PR reads while the device circuit is open, then permits a fresh read on recovery', async () => {
    mocks.listAllPrRefs.mockResolvedValue([]);
    const invoke = vi.fn(async () => []);
    window.electronAPI = {
      gitContext: { listAllPrRefs: mocks.listAllPrRefs, onPrRefsChanged: mocks.onPrRefsChanged },
      deviceLink: { invoke },
    } as any;
    unresponsiveDevicesStore.apply('home', true);
    try {
      render(<PrRefsProvider><RemoteRefs /></PrRefsProvider>);
      await act(async () => {});
      fireEvent.click(screen.getByRole('button', { name: 'remote:0' }));
      expect(invoke).not.toHaveBeenCalled();
      unresponsiveDevicesStore.apply('home', false);
      fireEvent.click(screen.getByRole('button', { name: 'remote:0' }));
      await waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    } finally { unresponsiveDevicesStore.clearAll(); }
  });
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

/** A remote task's PR set is asked once per refresh interval. The manual refresh buttons in
 * these tests stand for a later trigger, so each click first steps the clock past that interval. */
function statusClock() {
  let now = 1_000_000;
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
  return {
    advance: (ms: number) => {
      now += ms;
    },
    later: () => {
      now += PR_STATUS_REFRESH_INTERVAL_MS;
    },
    restore: () => spy.mockRestore(),
  };
}

function StatusProbe({ later }: { later?: () => void }) {
  const { statuses, successfulStatuses, fetchStatusesForSession } = usePrStatuses('remote-child');
  const { registerPrConsumer } = usePrActions();
  useEffect(() => registerPrConsumer('remote-child', 'home'), [registerPrConsumer]);
  const latest = statuses.get('github:github.com/a/b#1');
  const confirmed = successfulStatuses.get('github:github.com/a/b#1');
  return (
    <button
      onClick={() => {
        later?.();
        fetchStatusesForSession('remote-child');
      }}
    >
      {confirmed?.ok ? confirmed.status : 'unknown'}:{latest?.ok === false ? 'stale' : 'fresh'}
    </button>
  );
}

// 测试价值
// - 生产入口与可观察结果:PrRefsProvider 的远程会话状态读取;对方电脑收到的 git-context:pr-status 次数。
// - Bug／规则依据:2026-11-21 MacBook ↔ Mac Studio 联调日志,行挂载、悬停、聚焦每次都经中转重查,
//   三小时约 800 次,688/795 个间隔不到 30 秒。
// - 现有覆盖缺口:相邻用例未覆盖重复触发、或慢查询完成后恰逢定时刷新。
// - 最小失败输入:读完立即再触发一次；第一次定时刷新前 80 秒收到上一轮结果（#11857）。
// - tier:unit(进程内 fake invoke + 假时钟)。
it('coalesces repeat PR reads and refreshes on the next tick after a slow read', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const clock = statusClock();
  const ref = (prNumber: number) => ({ id: `pr-${prNumber}`, sessionId: 'remote-child', owner: 'a',
    repo: 'b', prNumber, url: `https://github.com/a/b/pull/${prNumber}`, firstSeenAt: 1, lastSeenAt: prNumber });
  let refs = [ref(1)];
  const statusQueries: number[][] = [];
  let finishSecondRead!: () => void;
  const secondRead = new Promise<void>((resolve) => { finishSecondRead = resolve; });
  mocks.listAllPrRefs.mockResolvedValue([]);
  type StatusArgs = [{ queries: Array<{ prNumber: number }> }];
  window.electronAPI = {
    gitContext: { listAllPrRefs: mocks.listAllPrRefs, onPrRefsChanged: mocks.onPrRefsChanged },
    deviceLink: { invoke: vi.fn(async (_device: string, channel: string, args: StatusArgs) => {
      if (channel === 'git-context:pr-refs:list') return refs;
      statusQueries.push(args[0].queries.map((q) => q.prNumber));
      if (statusQueries.length === 2) await secondRead;
      return args[0].queries.map((q) => ({ ...ref(q.prNumber), ok: true, status: 'open' }));
    }) },
  } as unknown as typeof window.electronAPI;
  function Probe() {
    const { registerPrConsumer, fetchStatusesForSession, invalidateRemotePrRefs } = usePrActions();
    useEffect(() => registerPrConsumer('remote-child', 'home'), [registerPrConsumer]);
    return <div>
      <button onClick={() => fetchStatusesForSession('remote-child')}>again</button>
      <button onClick={() => invalidateRemotePrRefs('remote-child')}>refs</button>
    </div>;
  }
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const { unmount } = render(<PrRefsProvider><Probe /></PrRefsProvider>);
  try {
    await act(async () => {});
    expect(statusQueries).toEqual([[1]]);
    await act(async () => fireEvent.click(screen.getByText('again')));
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(statusQueries).toEqual([[1]]);
    refs = [ref(2), ref(1)];
    await act(async () => fireEvent.click(screen.getByText('refs')));
    expect(statusQueries).toEqual([[1], [2, 1]]);
    clock.advance(10_000);
    await act(async () => finishSecondRead());
    clock.advance(PR_STATUS_REFRESH_INTERVAL_MS - 10_000);
    await act(async () => { await vi.advanceTimersByTimeAsync(PR_STATUS_REFRESH_INTERVAL_MS); });
    expect(statusQueries).toEqual([[1], [2, 1], [2, 1]]);
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(statusQueries).toHaveLength(3);
  } finally {
    unmount();
    focus.mockRestore();
    clock.restore();
    vi.useRealTimers();
  }
});

it('retains successful session status when a failure arrives while its consumer is unmounted', async () => {
  const clock = statusClock();
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
    <PrRefsProvider>{visible ? <StatusProbe later={clock.later} /> : null}</PrRefsProvider>
  );
  const { rerender, unmount } = render(view(true));
  onTestFinished(clock.restore);
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
      <button onClick={() => { clock.later(); fetchStatusesForSession('remote-child'); }}>statuses</button>
    </div>;
  }
  const clock = statusClock();
  onTestFinished(clock.restore);
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
  const clock = statusClock();
  onTestFinished(clock.restore);
  const view = (visible: boolean) => (
    <PrRefsProvider>{visible ? <StatusProbe later={clock.later} /> : null}</PrRefsProvider>
  );
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

// Regression (unit): one merged PR in a task with an unrendered second PR must
// not enable archive. The callback retained by leave-time preflight reads the
// current store even after a refresh failure; old successful values cannot win.
it('shares task-wide archive eligibility with the final preflight reader', async () => {
  const refs = [1, 2].map(prNumber => ({ id: `ref-${prNumber}`, sessionId: 'archive',
    owner: 'a', repo: 'b', prNumber, url: '', firstSeenAt: 1, lastSeenAt: 1 }));
  let secondMerged = false;
  let failed = false;
  let read = () => false;
  window.electronAPI = { gitContext: {
    listAllPrRefs: async () => refs, listPrRefs: async () => refs,
    onPrRefsChanged: () => () => {},
    getPrStatuses: async () => {
      if (failed) throw new Error('offline');
      return refs.map((ref, i) => ({ ...ref, ok: true, status: i === 0 || secondMerged ? 'merged' : 'open' }));
    },
  } } as unknown as typeof window.electronAPI;
  function Probe() {
    const { registerPrConsumer, fetchStatusesForSession } = usePrActions();
    const { eligible, checkEligibility } = useTaskPrArchiveEligibility('archive');
    read = checkEligibility;
    useEffect(() => registerPrConsumer('archive'), [registerPrConsumer]);
    return <button onClick={() => fetchStatusesForSession('archive')}>{eligible ? 'complete' : 'incomplete'}</button>;
  }
  const { unmount } = render(<PrRefsProvider><Probe /></PrRefsProvider>);
  await act(async () => {});
  const preflightRead = read;
  expect(preflightRead()).toBe(false);
  secondMerged = true;
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'incomplete' })));
  expect(screen.getByRole('button', { name: 'complete' })).toBeTruthy();
  expect(preflightRead()).toBe(true);
  failed = true;
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'complete' })));
  expect(preflightRead()).toBe(false);
  expect(screen.getByRole('button', { name: 'incomplete' })).toBeTruthy();
  unmount();
});

// Regression (unit): display surfaces show three PRs, but archive eligibility needs
// every associated PR. Statuses beyond the first three must still be fetched, in bounded batches.
it('fetches statuses for every associated PR beyond the displayed three', async () => {
  const refs = [1, 2, 3, 4, 5].map(prNumber => ({ id: `ref-${prNumber}`, sessionId: 'many',
    owner: 'a', repo: 'b', prNumber, url: '', firstSeenAt: 1, lastSeenAt: 1 }));
  const getPrStatuses = vi.fn(async (queries: typeof refs) =>
    queries.map(q => ({ ...q, ok: true, status: 'merged' })));
  window.electronAPI = { gitContext: {
    listAllPrRefs: async () => refs, listPrRefs: async () => refs,
    onPrRefsChanged: () => () => {}, getPrStatuses,
  } } as unknown as typeof window.electronAPI;
  function Probe() {
    const { registerPrConsumer } = usePrActions();
    const { eligible } = useTaskPrArchiveEligibility('many');
    useEffect(() => registerPrConsumer('many'), [registerPrConsumer]);
    return <div>{eligible ? 'complete' : 'incomplete'}</div>;
  }
  const { unmount } = render(<PrRefsProvider><Probe /></PrRefsProvider>);
  await act(async () => {});
  expect(screen.getByText('complete')).toBeTruthy();
  expect(getPrStatuses.mock.calls.flatMap(([queries]) => queries)).toHaveLength(5);
  unmount();
});

// Regression (unit): every refresh tick sent one PR read per visible row of the same remote
// computer at once (logs: 3-4 concurrent ~1.3 s reads per tick to one MacBook), filling the
// background invoke slots. Reads to one device must wait for the previous one; a failed
// read must not hold the lane.
it('sends background PR reads to one remote computer one at a time', async () => {
  const pending: Array<{ sessionId: string; settle: (fail: boolean) => void }> = [];
  const invoke = vi.fn((_device: string, channel: string, args: unknown[]) => {
    if (channel !== 'git-context:pr-refs:list') return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      pending.push({
        sessionId: String(args[0]),
        settle: (fail) => (fail ? reject(new Error('DEVICE_LINK_TIMEOUT')) : resolve([])),
      });
    });
  });
  window.electronAPI = {
    gitContext: { listAllPrRefs: async () => [], onPrRefsChanged: () => () => {} },
    deviceLink: { invoke },
  } as unknown as typeof window.electronAPI;
  function Row({ sessionId }: { sessionId: string }) {
    const { registerPrConsumer } = usePrActions();
    useEffect(() => registerPrConsumer(sessionId, 'home'), [registerPrConsumer, sessionId]);
    return null;
  }
  const { unmount } = render(
    <PrRefsProvider>
      <Row sessionId="a" />
      <Row sessionId="b" />
      <Row sessionId="c" />
    </PrRefsProvider>,
  );
  await act(async () => {});
  expect(pending.map((p) => p.sessionId)).toEqual(['a']);
  await act(async () => pending[0].settle(true));
  expect(pending.map((p) => p.sessionId)).toEqual(['a', 'b']);
  await act(async () => pending[1].settle(false));
  expect(pending.map((p) => p.sessionId)).toEqual(['a', 'b', 'c']);
  unmount();
});

// Unit regression #10537: serialization tests kept every row mounted and one owner.
// Queue refs and statuses behind one read, then remove consumers or switch identity;
// the production provider must discard the queued work before invoking the device.
it.each(['leave', 'owner'])('discards queued remote reads after %s', async (change) => {
  mocks.dataOwnerId = 'queue-old-owner';
  const sentOwners: Array<string | null> = [];
  let finish!: (value: unknown[]) => void;
  const invoke = vi.fn((_device: string, channel: string, args: unknown[]) => {
    sentOwners.push(mocks.dataOwnerId);
    if (channel === 'git-context:pr-refs:list' && args[0] === 'a') {
      return new Promise<unknown[]>((resolve) => {
        finish = resolve;
      });
    }
    return Promise.resolve([]);
  });
  const ref = {
    id: 'b-pr',
    sessionId: 'b',
    owner: 'a',
    repo: 'b',
    prNumber: 1,
    url: '',
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
  window.electronAPI = {
    gitContext: { listAllPrRefs: async () => [ref], onPrRefsChanged: () => () => {} },
    deviceLink: { invoke },
  } as unknown as typeof window.electronAPI;
  function Rows() {
    const { registerPrConsumer } = usePrActions();
    useEffect(() => {
      const offA = registerPrConsumer('a', 'home');
      const offB = registerPrConsumer('b', 'home');
      return () => {
        offA();
        offB();
      };
    }, [registerPrConsumer]);
    return null;
  }
  const view = render(
    <PrRefsProvider>
      <Rows />
    </PrRefsProvider>,
  );
  await act(async () => {});
  expect(invoke).toHaveBeenCalledTimes(1);
  if (change === 'leave') view.rerender(<PrRefsProvider>{null}</PrRefsProvider>);
  else {
    mocks.dataOwnerId = 'queue-new-owner';
    view.rerender(
      <PrRefsProvider>
        <Rows />
      </PrRefsProvider>,
    );
  }
  await act(async () => finish([]));
  // New-owner work may run, but the old queued refs + statuses must never send.
  expect(sentOwners.filter((owner) => owner === 'queue-old-owner')).toHaveLength(1);
  expect(invoke).toHaveBeenCalledTimes(change === 'leave' ? 1 : 2);
  if (change === 'owner') expect(invoke.mock.calls[1][1]).toBe('git-context:pr-status');
  view.unmount();
});

// Unit regression: main pushes live PR status updates via git-context:pr-status-changed so
// topbar/sidebar/PR-card badges update without waiting for the 90s polling timer or triggering
// extra IPC invokes. Must isolate remote device-link sessions, keep unrelated local rows stable,
// and unsubscribe cleanly on owner switch/unmount.
it('applies pushed PR status immediately to matching local sessions without affecting remote or unrelated rows', async () => {
  mocks.dataOwnerId = 'live-push-owner';
  const statusPushRef: { current: ((status: Record<string, unknown>) => void) | null } = { current: null };
  const unsubStatus = vi.fn();
  const localRef = {
    id: 'ref-local',
    sessionId: 'local-session',
    owner: 'makecindy',
    repo: 'cindy',
    prNumber: 419,
    url: 'https://github.com/makecindy/cindy/pull/419',
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
  const unrelatedRef = {
    id: 'ref-other',
    sessionId: 'other-local-session',
    owner: 'makecindy',
    repo: 'cindy',
    prNumber: 999,
    url: 'https://github.com/makecindy/cindy/pull/999',
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
  const remoteRef = { ...localRef, id: 'ref-remote', sessionId: 'remote-session' };
  const getPrStatuses = vi.fn(async (queries: Array<{ owner: string; repo: string; prNumber: number }>) =>
    queries.map((q) => ({ ...q, ok: true, status: 'open', title: 't', htmlUrl: '', branch: 'b' })),
  );
  const invoke = vi.fn(async (_device: string, channel: string) => {
    if (channel === 'git-context:pr-refs:list') return [remoteRef];
    if (channel === 'git-context:pr-status') {
      return [{ owner: 'makecindy', repo: 'cindy', prNumber: 419, ok: true, status: 'draft', title: 'r', htmlUrl: '', branch: 'b' }];
    }
    return [];
  });
  window.electronAPI = {
    gitContext: {
      listAllPrRefs: async () => [localRef, unrelatedRef],
      listPrRefs: async () => [localRef],
      onPrRefsChanged: () => () => {},
      onPrStatusChanged: (cb: (status: Record<string, unknown>) => void) => {
        statusPushRef.current = cb;
        return unsubStatus;
      },
      getPrStatuses,
    },
    deviceLink: { invoke },
  } as unknown as typeof window.electronAPI;

  let unrelatedRenders = 0;
  function LocalProbe() {
    const { registerPrConsumer } = usePrActions();
    const status = usePrStatus('local-session', 'makecindy/cindy#419');
    const { eligible } = useTaskPrArchiveEligibility('local-session');
    useEffect(() => registerPrConsumer('local-session'), [registerPrConsumer]);
    return (
      <div data-testid="local">
        {status?.ok ? status.status : 'none'}:{eligible ? 'archive' : 'keep'}
      </div>
    );
  }
  function UnrelatedProbe() {
    unrelatedRenders += 1;
    const status = usePrStatus('other-local-session', 'makecindy/cindy#999');
    return <div data-testid="unrelated">{status?.ok ? status.status : 'none'}</div>;
  }
  function RemoteProbe() {
    const { registerPrConsumer } = usePrActions();
    const status = usePrStatus('remote-session', 'makecindy/cindy#419');
    useEffect(() => registerPrConsumer('remote-session', 'home-mac'), [registerPrConsumer]);
    return <div data-testid="remote">{status?.ok ? status.status : 'none'}</div>;
  }

  const view = render(
    <PrRefsProvider>
      <LocalProbe />
      <UnrelatedProbe />
      <RemoteProbe />
    </PrRefsProvider>,
  );
  await waitFor(() => {
    expect(screen.getByTestId('local').textContent).toBe('open:keep');
    expect(screen.getByTestId('remote').textContent).toBe('draft');
  });
  const readsBeforePush = getPrStatuses.mock.calls.length;
  const rendersBeforePush = unrelatedRenders;

  await act(async () => {
    statusPushRef.current?.({
      owner: 'makecindy',
      repo: 'cindy',
      prNumber: 419,
      ok: true,
      status: 'merged',
      title: 't',
      htmlUrl: 'https://github.com/makecindy/cindy/pull/419',
      branch: 'b',
      observedAt: 2_000,
      revision: 'rev-2',
    });
  });

  expect(screen.getByTestId('local').textContent).toBe('merged:archive');
  expect(screen.getByTestId('remote').textContent).toBe('draft');
  expect(getPrStatuses).toHaveBeenCalledTimes(readsBeforePush);
  expect(unrelatedRenders).toBe(rendersBeforePush);

  // Switching to signed-out owner unsubscribes and ignores stale pushes.
  mocks.dataOwnerId = null;
  view.rerender(
    <PrRefsProvider>
      <LocalProbe />
    </PrRefsProvider>,
  );
  expect(unsubStatus).toHaveBeenCalledOnce();
  const stalePush = statusPushRef.current;
  await act(async () => {
    stalePush?.({
      owner: 'makecindy',
      repo: 'cindy',
      prNumber: 419,
      ok: true,
      status: 'closed',
      title: 't',
      htmlUrl: '',
      branch: 'b',
    });
  });
  expect(screen.getByTestId('local').textContent).toBe('none:keep');
  view.unmount();
});
