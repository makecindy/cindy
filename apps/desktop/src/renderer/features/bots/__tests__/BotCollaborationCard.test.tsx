// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BotCollaborationCard } from '../BotCollaborationCard';
import { __resetBotDelegationLiveForTest } from '../botDelegationLive';
import type {
  BotDelegationChangedPayload,
  BotDelegationStatus,
  BotDelegationView,
} from '../../../../shared/botDelegation';
import type { BotCollaborationMeta } from '../../../../shared/botCollaboration';

const mocks = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../botStore', () => ({ useBotProfiles: () => [] }));
// BotAvatar 拉了一串图片资源，jsdom 下解析不了；卡片本身只关心「谁的头像」这个位置。
vi.mock('../BotAvatar', () => ({
  BotAvatar: ({ bot }: { bot: { name: string } }) => <span data-avatar={bot.name} />,
}));

const SESSION_ID = 'parent-session-1';
const DELEGATION_ID = 'delegation-1';

function meta(overrides: Partial<BotCollaborationMeta> = {}): BotCollaborationMeta {
  return {
    v: 1,
    role: 'delegation-request',
    delegationId: DELEGATION_ID,
    fromBotId: 'bot-cindy',
    fromBotName: 'Cindy',
    toBotId: 'bot-planner',
    toBotName: 'Planner',
    parentSessionId: SESSION_ID,
    childSessionId: 'child-1',
    objective: '给伙伴协作做一版方案',
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
    targetBotId: 'bot-planner',
    targetBotName: 'Planner',
    parentSessionId: SESSION_ID,
    childSessionId: 'child-1',
    objective: '给伙伴协作做一版方案',
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
let interjectBotDelegation: ReturnType<typeof vi.fn>;
let cancelBotDelegation: ReturnType<typeof vi.fn>;

beforeEach(() => {
  listeners = [];
  mocks.navigate.mockClear();
  __resetBotDelegationLiveForTest();
  listBotDelegations = vi.fn(async () => ({ ok: true as const, delegations: [] }));
  interjectBotDelegation = vi.fn(async () => ({
    ok: true as const,
    delegationId: DELEGATION_ID,
    childSessionId: 'child-1',
    queued: false,
  }));
  cancelBotDelegation = vi.fn(async () => ({
    ok: true as const,
    delegationId: DELEGATION_ID,
    childSessionId: 'child-1',
  }));
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      maker: {
        listBotDelegations: (...args: unknown[]) => listBotDelegations(...args),
        interjectBotDelegation: (...args: unknown[]) => interjectBotDelegation(...args),
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
  __resetBotDelegationLiveForTest();
});

describe('BotCollaborationCard', () => {
  it('renders nothing when the marker is missing or malformed', () => {
    const { container: empty } = render(<BotCollaborationCard sessionId={SESSION_ID} />);
    expect(empty.firstChild).toBeNull();
    const { container: broken } = render(
      <BotCollaborationCard data={{ v: 2, role: 'delegation-request' }} sessionId={SESSION_ID} />,
    );
    expect(broken.firstChild).toBeNull();
  });

  it('renders a named-Bot call as a tracked task, never as joining the conversation', async () => {
    listBotDelegations.mockResolvedValue({ ok: true, delegations: [delegation('running')] });
    render(<BotCollaborationCard data={{ ...meta() }} sessionId={SESSION_ID} />);

    expect(screen.getByText(/bots\.collab\.taskAssignedTo/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/bots\.collab\.status\.running/)).toBeTruthy());
    expect(screen.getByText('bots.collab.stopTask')).toBeTruthy();
    expect(screen.queryByText(/bots\.collab\.joined/)).toBeNull();
    expect(screen.queryByText('bots.collab.nudge')).toBeNull();
  });

  it('renders a plain Cindy Session call with the same task-card contract', async () => {
    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [
        delegation('running', {
          targetBotId: null,
          targetBotName: 'Cindy',
          objective: '做一个 2048 小游戏（单文件网页版）',
        }),
      ],
    });
    render(
      <BotCollaborationCard
        data={{
          ...meta({
            toBotId: null,
            toBotName: 'Cindy',
            objective: '做一个 2048 小游戏（单文件网页版）',
          }),
        }}
        sessionId={SESSION_ID}
      />,
    );

    expect(await screen.findByText('bots.collab.backgroundTask')).toBeTruthy();
    expect(screen.getByText('做一个 2048 小游戏（单文件网页版）')).toBeTruthy();
    expect(screen.getByText(/bots\.collab\.status\.running/)).toBeTruthy();
    expect(screen.queryByText(/bots\.collab\.joined/)).toBeNull();
  });

  it('shows the inbound card on the target task without requester controls', async () => {
    listBotDelegations.mockResolvedValue({ ok: true, delegations: [delegation('running')] });
    render(
      <BotCollaborationCard
        data={{ ...meta({ role: 'guest-request' }) }}
        sessionId="target-canonical"
      />,
    );

    expect(screen.getByText(/bots\.collab\.taskFrom/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/bots\.collab\.status\.running/)).toBeTruthy());
    expect(screen.queryByText('bots.collab.nudge')).toBeNull();
    expect(screen.queryByText('bots.collab.stopTask')).toBeNull();
    expect(listBotDelegations).toHaveBeenCalledWith(SESSION_ID);
    fireEvent.click(screen.getByText(/bots\.collab\.watchWork/));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-planner/session/child-1');
  });

  it('stops the delegation through the existing cancel channel', async () => {
    listBotDelegations.mockResolvedValue({ ok: true, delegations: [delegation('waiting')] });
    render(<BotCollaborationCard data={{ ...meta() }} sessionId={SESSION_ID} />);
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
    render(<BotCollaborationCard data={{ ...meta() }} sessionId={SESSION_ID} />);

    await screen.findByText(/bots\.collab\.status\.completed/);
    // 用时走 i18n 单位,不再是硬编码的 `42s` —— 中文界面里 `42s` 和「用时」并排
    // 读起来是两套语言。
    expect(screen.getByText(/bots\.collab\.duration\.seconds/).textContent).not.toContain('42s');
    expect(screen.queryByText('bots.collab.nudge')).toBeNull();
    expect(screen.queryByText('bots.collab.stopTask')).toBeNull();
    expect(screen.getByText('给伙伴协作做一版方案')).toBeTruthy();
    fireEvent.click(screen.getByText(/bots\.collab\.watchWork/));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-planner/session/child-1');
  });

  it('shows the returned result directly on the task card', async () => {
    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [
        delegation('completed', {
          completedAt: Date.now(),
          resultSummary: '三条结论:先砍范围、再补测试、最后再谈发布日期。',
        }),
      ],
    });
    render(<BotCollaborationCard data={{ ...meta() }} sessionId={SESSION_ID} />);
    expect(await screen.findByText(/三条结论/)).toBeTruthy();
  });

  it('reports a stopped delegation as stopped, not as a failure', async () => {
    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [delegation('cancelled', { completedAt: Date.now() })],
    });
    render(<BotCollaborationCard data={{ ...meta() }} sessionId={SESSION_ID} />);
    expect(await screen.findByText(/bots\.collab\.status\.cancelled/)).toBeTruthy();
  });

  it('says the work has not started yet while the first handoff is still being retried', async () => {
    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [delegation('waiting', { lastError: 'AGENT_NOT_READY: pi not authenticated' })],
    });
    render(<BotCollaborationCard data={{ ...meta() }} sessionId={SESSION_ID} />);
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
    render(<BotCollaborationCard data={{ ...meta() }} sessionId={SESSION_ID} />);
    const line = await screen.findByText(/需要登录后才能执行/);
    expect(line.textContent).toContain('需要登录后才能执行');
    expect(line.textContent).not.toContain('ACCOUNT_NOT_READY');
  });

  it('renders an interjection as a quiet one-line trace', () => {
    render(
      <BotCollaborationCard
        data={{ ...meta({ role: 'interjection' }), text: '先别铺开，我只要三条。' }}
        sessionId={SESSION_ID}
      />,
    );
    expect(screen.getByText(/bots\.collab\.interjected/)).toBeTruthy();
    expect(screen.getByText(/先别铺开，我只要三条。/)).toBeTruthy();
    expect(screen.queryByText('bots.collab.stopTask')).toBeNull();
  });
  /*
    空头支票复核 2026-08-19。委派行读不到时（列表请求失败，或这条委派已经掉出
    listDelegations 的 100 行上限），卡片以前一律回落到「正在开始」+ 呼吸点，而
    操作区又整块不渲染 —— 一张永远在跑、永远停不掉、也点不进去的卡。它画出来的
    「进行中」没有任何东西背书。现在必须如实说状态查不到了，并且停止呼吸。
  */
  it('says the status is unverifiable instead of faking a forever-running card', async () => {
    listBotDelegations.mockResolvedValue({ ok: false });
    const { container } = render(
      <BotCollaborationCard data={{ ...meta() }} sessionId={SESSION_ID} />,
    );

    await waitFor(() => expect(screen.getByText(/bots\.collab\.status\.unknown/)).toBeTruthy());
    expect(screen.queryByText(/bots\.collab\.status\.queued/)).toBeNull();
    // 没有背书的状态就不许有"还在跑"的动效。
    expect(container.querySelector('.animate-pulse')).toBeNull();
    // 也不该假装给得出操作。
    expect(screen.queryByText('bots.collab.stopTask')).toBeNull();
    expect(screen.queryByText('bots.collab.nudge')).toBeNull();
  });

  it('keeps the optimistic running look while the first fetch is still in flight', async () => {
    // 一直不 resolve —— 模拟「还没读到」，这与「读完了没有」必须区分开。
    listBotDelegations.mockReturnValue(new Promise(() => {}));
    const { container } = render(
      <BotCollaborationCard data={{ ...meta() }} sessionId={SESSION_ID} />,
    );

    expect(screen.getByText(/bots\.collab\.status\.queued/)).toBeTruthy();
    expect(screen.queryByText(/bots\.collab\.status\.unknown/)).toBeNull();
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('reports a timed-out delegation as timed out, not as a failure', async () => {
    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [delegation('timed-out', { completedAt: Date.now() })],
    });
    render(<BotCollaborationCard data={{ ...meta() }} sessionId={SESSION_ID} />);

    await waitFor(() => expect(screen.getByText(/bots\.collab\.status\.timed-out/)).toBeTruthy());
    expect(screen.queryByText(/bots\.collab\.status\.failed/)).toBeNull();
  });
});
