import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { __resetStickySessionOriginForTest } from '@/features/device-link/stickySessionOrigin';
// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BotSessionTaskCard, BotSessionTaskMessageTrace } from '../BotCollaborationCard';
import { __resetBotDelegationLiveForTest } from '../botDelegationLive';
import type {
  BotDelegationChangedPayload,
  BotDelegationStatus,
  BotDelegationView,
} from '../../../../shared/botDelegation';
import type { BotCollaborationMeta } from '../../../../shared/botCollaboration';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  remoteBots: [] as any[],
  prRefs: [] as any[],
  prStatuses: new Map(),
  registerPrConsumer: vi.fn(() => () => {}),
  invalidateRemotePrRefs: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/remoteDataOwnerPushFence', () => ({ isDeviceLinkRemotePushCurrent: () => true }));
vi.mock('../useRemoteBots', () => ({ useRemoteBots: () => mocks.remoteBots }));
vi.mock('@/contexts/PrRefsContext', () => ({
  usePrActions: () => ({
    registerPrConsumer: mocks.registerPrConsumer,
    invalidateRemotePrRefs: mocks.invalidateRemotePrRefs,
  }),
  usePrRefsForSession: (id: string) => (id === 'child-1' ? mocks.prRefs : []),
  usePrStatuses: () => ({ statuses: mocks.prStatuses }),
}));
const associatedPr = (n: number) => ({
  id: `pr-${n}`,
  sessionId: 'child-1',
  owner: 'a',
  repo: 'b',
  prNumber: n,
  url: `https://github.com/a/b/pull/${n}`,
  firstSeenAt: 1,
  lastSeenAt: 1,
});
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));

const SESSION_ID = 'parent-session-1';
const DELEGATION_ID = 'delegation-1';

function meta(overrides: Partial<BotCollaborationMeta> = {}): BotCollaborationMeta {
  return {
    v: 1,
    role: 'delegation-request',
    delegationId: DELEGATION_ID,
    fromBotId: 'bot-cindy',
    fromBotName: 'Cindy',
    toBotId: null,
    toBotName: 'Cindy',
    parentSessionId: SESSION_ID,
    childSessionId: 'child-1',
    objective: '做一版方案',
    ...overrides,
  };
}

function delegation(
  status: BotDelegationStatus,
  overrides: Partial<BotDelegationView> = {},
): BotDelegationView {
  return {
    id: DELEGATION_ID,
    requestingBotId: 'bot-cindy',
    targetBotId: null,
    targetBotName: 'Cindy',
    parentSessionId: SESSION_ID,
    childSessionId: 'child-1',
    title: '方案任务',
    objective: '做一版方案',
    contextRefs: [],
    permissionSnapshot: {},
    lineage: [],
    targetProfileVersion: 1,
    depth: 1,
    status,
    pendingInteraction: null,
    resultSummary: null,
    artifacts: [],
    lastError: null,
    createdAt: Date.now() - 8_000,
    acceptedAt: null,
    completedAt: null,
    updatedAt: Date.now(),
    ...overrides,
  };
}

let listeners: Array<(payload: BotDelegationChangedPayload, ownerStamp?: unknown) => void> = [];
let listBotDelegations: ReturnType<typeof vi.fn>;
let cancelBotDelegation: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.prRefs = [];
  mocks.prStatuses = new Map();
  mocks.registerPrConsumer.mockClear();
  mocks.invalidateRemotePrRefs.mockClear();
  listeners = [];
  mocks.remoteBots = [];
  mocks.navigate.mockClear();
  __resetBotDelegationLiveForTest();
  listBotDelegations = vi.fn(async () => ({ ok: true as const, delegations: [] }));
  cancelBotDelegation = vi.fn(async () => ({
    ok: true as const,
    delegationId: DELEGATION_ID,
    childSessionId: 'child-1',
  }));
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      openExternal: vi.fn().mockResolvedValue({ success: true }),
      maker: {
        listBotDelegations: (...args: unknown[]) => listBotDelegations(...args),
        cancelBotDelegation: (...args: unknown[]) => cancelBotDelegation(...args),
        onBotDelegationChanged: (
          cb: (payload: BotDelegationChangedPayload, ownerStamp?: unknown) => void,
        ) => {
          listeners.push(cb);
          return () => {
            listeners = listeners.filter((listener) => listener !== cb);
          };
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
  remoteProjectsStore.clear();
  remoteProjectsStore.__resetPinnedOriginsForTest();
  __resetStickySessionOriginForTest();
  __resetBotDelegationLiveForTest();
});

describe('BotSessionTaskCard', () => {
  it('renders nothing when the marker is missing or malformed', () => {
    const { container: empty } = render(<BotSessionTaskCard sessionId={SESSION_ID} />);
    expect(empty.firstChild).toBeNull();
    const { container: broken } = render(
      <BotSessionTaskCard data={{ v: 2, role: 'delegation-request' }} sessionId={SESSION_ID} />,
    );
    expect(broken.firstChild).toBeNull();
  });

  it('renders a Session task as a tracked background task', async () => {
    listBotDelegations.mockResolvedValue({ ok: true, delegations: [delegation('running')] });
    render(<BotSessionTaskCard data={{ ...meta() }} sessionId={SESSION_ID} />);

    expect(screen.queryByText('bots.collab.backgroundTask')).toBeNull();
    await waitFor(() => expect(screen.getByText(/bots\.collab\.status\.running/)).toBeTruthy());
    expect(screen.getByText('bots.collab.stopTask')).toBeTruthy();
  });

  it('ignores historical target-side task mirrors', () => {
    const { container } = render(
      <BotSessionTaskCard
        data={{
          ...meta({ role: 'guest-request' }),
        }}
        sessionId={SESSION_ID}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it('does not roll a completed card back when an older running snapshot arrives late', async () => {
    let finishOldRead!: (value: unknown) => void;
    listBotDelegations.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldRead = resolve;
        }),
    );
    render(<BotSessionTaskCard data={{ ...meta() }} sessionId={SESSION_ID} />);
    listBotDelegations.mockResolvedValue({ ok: true, delegations: [delegation('completed')] });
    await act(async () => {
      for (const listener of listeners)
        listener({
          delegationId: DELEGATION_ID,
          parentSessionId: SESSION_ID,
          childSessionId: 'child-1',
          status: 'completed',
        });
    });
    await screen.findByText(/bots\.collab\.status\.completed/);
    await act(async () => {
      finishOldRead({ ok: true, delegations: [delegation('running')] });
    });
    expect(screen.getByText(/bots\.collab\.status\.completed/)).toBeTruthy();
    expect(screen.queryByText('bots.collab.stopTask')).toBeNull();
  });

  it('stops the delegation through the existing cancel channel', async () => {
    listBotDelegations.mockResolvedValue({ ok: true, delegations: [delegation('waiting')] });
    render(<BotSessionTaskCard data={{ ...meta() }} sessionId={SESSION_ID} />);
    await waitFor(() => expect(screen.getByText('bots.collab.stopTask')).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByText('bots.collab.stopTask'));
    });
    expect(cancelBotDelegation).toHaveBeenCalledWith(SESSION_ID, DELEGATION_ID);
  });

  it('keeps the finished task, duration, and work-process entry visible', async () => {
    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [
        delegation('completed', { createdAt: 1_000, completedAt: 43_000, updatedAt: 43_000 }),
      ],
    });
    render(<BotSessionTaskCard data={{ ...meta() }} sessionId={SESSION_ID} />);

    await screen.findByText(/bots\.collab\.status\.completed/);
    // 用时走 i18n 单位,不再是硬编码的 `42s` —— 中文界面里 `42s` 和「用时」并排
    // 读起来是两套语言。
    expect(screen.getByText(/bots\.collab\.duration\.seconds/).textContent).not.toContain('42s');
    expect(screen.queryByText('bots.collab.stopTask')).toBeNull();
    expect(screen.getByText('方案任务')).toBeTruthy();
    expect(screen.queryByText('做一版方案')).toBeNull();
    fireEvent.click(screen.getByText(/bots\.collab\.watchWork/));
    expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/child-1');
  });

  it('keeps the full returned report out of the compact task card', async () => {
    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [
        delegation('completed', {
          completedAt: Date.now(),
          resultSummary: '三条结论:先砍范围、再补测试、最后再谈发布日期。',
        }),
      ],
    });
    render(<BotSessionTaskCard data={{ ...meta() }} sessionId={SESSION_ID} />);
    await screen.findByText(/bots\.collab\.status\.completed/);
    expect(screen.queryByText(/三条结论/)).toBeNull();
  });

  it('reports a stopped delegation as stopped, not as a failure', async () => {
    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [delegation('cancelled', { completedAt: Date.now() })],
    });
    render(<BotSessionTaskCard data={{ ...meta() }} sessionId={SESSION_ID} />);
    expect(await screen.findByText(/bots\.collab\.status\.cancelled/)).toBeTruthy();
  });

  it('says the work has not started yet while the first handoff is still being retried', async () => {
    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [delegation('waiting', { lastError: 'AGENT_NOT_READY: pi not authenticated' })],
    });
    render(<BotSessionTaskCard data={{ ...meta() }} sessionId={SESSION_ID} />);
    // 「等待开始」和「正在做」以前长得一模一样：用户以为对方在干活，其实一次都没开始。
    expect(await screen.findByText('bots.collab.retrying')).toBeTruthy();
  });

  it('puts the failure reason directly on the task card', async () => {
    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [
        delegation('failed', {
          completedAt: Date.now(),
          lastError: 'ACCOUNT_NOT_READY: 需要登录后才能执行：当前没有可用的账号与模型来源。',
        }),
      ],
    });
    render(<BotSessionTaskCard data={{ ...meta() }} sessionId={SESSION_ID} />);
    const line = await screen.findByText(/需要登录后才能执行/);
    expect(line.textContent).toContain('需要登录后才能执行');
    expect(line.textContent).not.toContain('ACCOUNT_NOT_READY');
  });

  it('renders an interjection as a quiet one-line trace', () => {
    render(
      <BotSessionTaskMessageTrace
        data={{ ...meta({ role: 'interjection' }), text: '先别铺开，我只要三条。' }}
      />,
    );
    expect(screen.getByText(/bots\.collab\.messageSent/)).toBeTruthy();
    expect(screen.getByText(/先别铺开，我只要三条。/)).toBeTruthy();
    expect(screen.queryByText('bots.collab.stopTask')).toBeNull();
  });

  it('keeps the last task state when a later refresh fails', async () => {
    listBotDelegations
      .mockResolvedValueOnce({
        ok: true,
        delegations: [
          delegation('completed', {
            completedAt: Date.now(),
            resultSummary: '已经交付。',
          }),
        ],
      })
      .mockResolvedValueOnce({ ok: false });
    render(<BotSessionTaskCard data={{ ...meta() }} sessionId={SESSION_ID} />);

    await screen.findByText(/bots\.collab\.status\.completed/);
    act(() => {
      listeners[0]?.({
        delegationId: DELEGATION_ID,
        parentSessionId: SESSION_ID,
        childSessionId: 'child-1',
        status: 'completed',
        pendingInteraction: null,
      });
    });
    await waitFor(() => expect(listBotDelegations).toHaveBeenCalledTimes(2));

    expect(screen.getByText(/bots\.collab\.status\.completed/)).toBeTruthy();
    expect(screen.getByText('bots.collab.stale')).toBeTruthy();
    expect(screen.queryByText(/bots\.collab\.status\.unknown/)).toBeNull();
  });
  /*
    空头支票复核 2026-08-19。任务行读不到时（例如首次列表请求失败），卡片以前
    一律回落到「正在开始」+ 呼吸点，而
    操作区又整块不渲染 —— 一张永远在跑、也点不进去的卡。它画出来的「进行中」
    没有任何东西背书。现在必须如实说状态查不到了、停止呼吸，并保留任务过程入口。
  */
  it('says the status is unverifiable instead of faking a forever-running card', async () => {
    listBotDelegations.mockResolvedValue({ ok: false });
    const { container } = render(
      <BotSessionTaskCard data={{ ...meta() }} sessionId={SESSION_ID} />,
    );

    await waitFor(() => expect(screen.getByText(/bots\.collab\.status\.unknown/)).toBeTruthy());
    expect(screen.queryByText(/bots\.collab\.status\.queued/)).toBeNull();
    // 没有背书的状态就不许有"还在跑"的动效。
    expect(container.querySelector('.animate-pulse')).toBeNull();
    expect(screen.queryByText('bots.collab.stopTask')).toBeNull();
    expect(screen.getByText('bots.collab.watchWork')).toBeTruthy();
  });

  it('keeps the optimistic running look while the first fetch is still in flight', async () => {
    // 一直不 resolve —— 模拟「还没读到」，这与「读完了没有」必须区分开。
    listBotDelegations.mockReturnValue(new Promise(() => {}));
    const { container } = render(
      <BotSessionTaskCard data={{ ...meta() }} sessionId={SESSION_ID} />,
    );

    expect(screen.getByText(/bots\.collab\.status\.queued/)).toBeTruthy();
    expect(screen.queryByText(/bots\.collab\.status\.unknown/)).toBeNull();
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });

  it('reports a new failed + TIMEOUT task as timed out, not as a failure', async () => {
    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [
        delegation('timed-out', {
          completedAt: Date.now(),
          lastError: 'TIMEOUT: exceeded the deadline',
        }),
      ],
    });
    render(<BotSessionTaskCard data={{ ...meta() }} sessionId={SESSION_ID} />);

    await waitFor(() => expect(screen.getByText(/bots\.collab\.status\.timed-out/)).toBeTruthy());
    expect(screen.queryByText(/bots\.collab\.status\.failed/)).toBeNull();
  });
});

it('routes remote task reads, stop, child navigation and push refresh to the same Mac', async () => {
  mocks.remoteBots = [{ deviceId: 'home', online: true }];
  remoteProjectsStore.pinSessionOrigin('home', SESSION_ID);
  let push!: (value: any, stamp?: any) => void;
  let status!: (value: any) => void;
  const invoke = vi.fn(async (_device: string, channel: string) =>
    channel === 'maker:bot-delegations:list'
      ? { ok: true, delegations: [delegation('running')] }
      : { ok: true },
  );
  window.electronAPI.deviceLink = {
    invoke,
    onRemotePush: (fn: any) => {
      push = fn;
      return () => {};
    },
    onStatusChanged: (fn: any) => {
      status = fn;
      return () => {};
    },
  } as any;
  render(<BotSessionTaskCard sessionId={SESSION_ID} data={meta() as any} />);
  const stop = await screen.findByRole('button', { name: 'bots.collab.stopTask' });
  expect(mocks.registerPrConsumer).toHaveBeenCalledWith('child-1', 'home');
  expect(invoke).toHaveBeenCalledWith('home', 'maker:bot-delegations:list', [SESSION_ID]);
  expect(listBotDelegations).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'bots.collab.watchWork' }));
  expect(remoteProjectsStore.getSessionDeviceId('child-1')).toBe('home');
  // Even when reconnect clears the transient registry, stop must never hit the local maker.
  remoteProjectsStore.clear();
  remoteProjectsStore.__resetPinnedOriginsForTest();
  fireEvent.click(stop);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('home', 'maker:bot-delegation:cancel', [
      SESSION_ID,
      DELEGATION_ID,
    ]),
  );
  expect(cancelBotDelegation).not.toHaveBeenCalled();
  const reads = invoke.mock.calls.length;
  act(() =>
    push({
      deviceId: 'office',
      channel: 'maker:bot-delegation:changed',
      payload: { parentSessionId: SESSION_ID },
    }),
  );
  expect(invoke).toHaveBeenCalledTimes(reads);
  mocks.invalidateRemotePrRefs.mockClear();
  invoke.mockResolvedValue({
    ok: true,
    delegations: [
      delegation('completed', { resultSummary: 'Remote done', updatedAt: Date.now() + 1 }),
    ],
  });
  act(() => status({ status: 'online' }));
  await screen.findByText(/bots\.collab\.status\.completed/);
  expect(mocks.invalidateRemotePrRefs).toHaveBeenCalledWith('child-1');
});

it('opens the child session associated PR even when the report contains another link', async () => {
  mocks.prRefs = [associatedPr(733)];
  listBotDelegations.mockResolvedValue({
    ok: true,
    delegations: [
      delegation('completed', {
        resultSummary:
          '## Deliverables\n[PR](https://github.com/MakeCindy/Cindy/pull/733/files)\n/private/report.md',
        artifacts: [{ path: '/private/report.md', status: 'added' }],
      }),
    ],
  });
  const { container } = render(<BotSessionTaskCard data={{ ...meta() }} sessionId={SESSION_ID} />);
  const pr = await screen.findByRole('button', { name: 'bots.collab.viewPr' });
  const task = screen.getByRole('button', { name: 'bots.collab.watchWork' });
  expect(pr.className).toBe(task.className);
  expect(pr.className).toContain('h-8');
  expect(container.textContent).not.toContain('/private/report.md');
  expect(container.textContent).not.toContain('## Deliverables');
  fireEvent.click(pr);
  expect(window.electronAPI.openExternal).toHaveBeenCalledWith('https://github.com/a/b/pull/733');
});

it('does not mistake a contextual PR in the objective for the task result', async () => {
  listBotDelegations.mockResolvedValue({ ok: true, delegations: [delegation('completed')] });
  render(
    <BotSessionTaskCard
      data={{ ...meta({ objective: 'Compare https://github.com/a/b/pull/1' }) }}
      sessionId={SESSION_ID}
    />,
  );
  await screen.findByText(/bots\.collab\.status\.completed/);
  expect(screen.queryByRole('button', { name: 'bots.collab.viewPr' })).toBeNull();
});

it('offers every associated PR without opening an arbitrary first link', async () => {
  mocks.prRefs = [associatedPr(1), associatedPr(2)];
  listBotDelegations.mockResolvedValue({
    ok: true,
    delegations: [
      delegation('completed', {
        resultSummary: 'https://github.com/a/b/pull/1 https://github.com/a/b/pull/2',
      }),
    ],
  });
  render(<BotSessionTaskCard data={{ ...meta() }} sessionId={SESSION_ID} />);
  const button = await screen.findByRole('button', { name: 'bots.collab.viewPr' });
  fireEvent.keyDown(button, { key: 'Enter' });
  const choice = await screen.findByRole('menuitem', { name: 'a/b #2' });
  expect(window.electronAPI.openExternal).not.toHaveBeenCalled();
  fireEvent.click(choice);
  expect(window.electronAPI.openExternal).toHaveBeenCalledWith('https://github.com/a/b/pull/2');
});

it('subscribes to the child session PR state and updates its icon without enlarging actions', async () => {
  mocks.prRefs = [associatedPr(4)];
  mocks.prStatuses = new Map([['a/b#4', { ok: true, status: 'open' }]]);
  listBotDelegations.mockResolvedValue({ ok: true, delegations: [delegation('running')] });
  const { rerender, container } = render(
    <BotSessionTaskCard data={{ ...meta() }} sessionId={SESSION_ID} />,
  );
  await screen.findByRole('button', { name: 'bots.collab.viewPr' });
  expect(mocks.registerPrConsumer).toHaveBeenCalledWith('child-1', undefined);
  const button = screen.getByRole('button', { name: 'bots.collab.viewPr' });
  const before = button.className;
  mocks.prStatuses = new Map([['a/b#4', { ok: true, status: 'merged' }]]);
  rerender(<BotSessionTaskCard data={{ ...meta() }} sessionId={SESSION_ID} />);
  expect(container.querySelector('.lucide-git-merge')).not.toBeNull();
  expect(button.className).toBe(before);
});
