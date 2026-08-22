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
    artifactRefs: [],
    outputArtifacts: [],
    completionDelivery: null,
    permissionSnapshot: {},
    lineage: [],
    targetProfileVersion: 1,
    depth: 1,
    budgetTokens: null,
    tokensUsed: 0,
    status,
    resultSummary: null,
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

  it('announces the guest joining and shows live status while the work runs', async () => {
    listBotDelegations.mockResolvedValue({ ok: true, delegations: [delegation('running')] });
    render(<BotCollaborationCard data={{ ...meta() }} sessionId={SESSION_ID} />);

    expect(screen.getByText(/bots\.collab\.joined/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/bots\.collab\.status\.running/)).toBeTruthy());
    // 停止与催一下都只在还没落终态时出现。
    expect(screen.getByText('bots.collab.stop')).toBeTruthy();
    expect(screen.getByText('bots.collab.nudge')).toBeTruthy();
  });

  it('shows the inbound card on the target task without requester controls', async () => {
    listBotDelegations.mockResolvedValue({ ok: true, delegations: [delegation('running')] });
    render(
      <BotCollaborationCard
        data={{ ...meta({ role: 'guest-request' }) }}
        sessionId="target-canonical"
      />,
    );

    expect(screen.getByText(/bots\.collab\.inboundJoined/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/bots\.collab\.status\.running/)).toBeTruthy());
    expect(screen.queryByText('bots.collab.nudge')).toBeNull();
    expect(screen.queryByText('bots.collab.stop')).toBeNull();
    expect(listBotDelegations).toHaveBeenCalledWith(SESSION_ID);
    fireEvent.click(screen.getByText(/bots\.collab\.watchWork/));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-planner/session/child-1');
  });

  it('sends a nudge to the running delegation through the host channel', async () => {
    listBotDelegations.mockResolvedValue({ ok: true, delegations: [delegation('running')] });
    render(<BotCollaborationCard data={{ ...meta() }} sessionId={SESSION_ID} />);
    await waitFor(() => expect(screen.getByText('bots.collab.nudge')).toBeTruthy());

    fireEvent.click(screen.getByText('bots.collab.nudge'));
    const input = await screen.findByPlaceholderText('bots.collab.nudgePlaceholder');
    fireEvent.change(input, { target: { value: '怎么样了？' } });
    await act(async () => {
      fireEvent.click(screen.getByText('bots.collab.nudgeSend'));
    });

    // 第 4 个参数是幂等键:重放 / 双击 / 重挂载都落到同一个 clientId 上,对方只被
    // 真的催一次。值由 renderer 生成,只校验它存在且非空。
    expect(interjectBotDelegation).toHaveBeenCalledTimes(1);
    const [callerSessionId, delegationId, text, idempotencyKey] =
      interjectBotDelegation.mock.calls[0] as [string, string, string, string];
    expect([callerSessionId, delegationId, text]).toEqual([
      SESSION_ID,
      DELEGATION_ID,
      '怎么样了？',
    ]);
    expect(typeof idempotencyKey).toBe('string');
    expect(idempotencyKey.length).toBeGreaterThan(0);
    // 送出后收起输入层，避免同一句话被连点两次。
    await waitFor(() =>
      expect(screen.queryByPlaceholderText('bots.collab.nudgePlaceholder')).toBeNull(),
    );
  });

  it('reuses one idempotency key while the same nudge is being retried', async () => {
    listBotDelegations.mockResolvedValue({ ok: true, delegations: [delegation('running')] });
    interjectBotDelegation.mockResolvedValue({
      ok: false as const,
      errorCode: 'DISPATCH_FAILED',
      message: 'nope',
    });
    render(<BotCollaborationCard data={{ ...meta() }} sessionId={SESSION_ID} />);
    await waitFor(() => expect(screen.getByText('bots.collab.nudge')).toBeTruthy());
    fireEvent.click(screen.getByText('bots.collab.nudge'));
    const input = await screen.findByPlaceholderText('bots.collab.nudgePlaceholder');
    fireEvent.change(input, { target: { value: '怎么样了？' } });

    await act(async () => {
      fireEvent.click(screen.getByText('bots.collab.nudgeSend'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('bots.collab.nudgeSend'));
    });

    // 同一句话重试,幂等键不变 —— 服务端按 clientId 去重,不会催两遍。
    expect(interjectBotDelegation).toHaveBeenCalledTimes(2);
    const first = interjectBotDelegation.mock.calls[0] as unknown[];
    const second = interjectBotDelegation.mock.calls[1] as unknown[];
    expect(second[3]).toBe(first[3]);

    // 改了正文就必须换一个键,否则新的一句会被当成旧那句的重放而被静默吞掉。
    fireEvent.change(input, { target: { value: '换个说法' } });
    await act(async () => {
      fireEvent.click(screen.getByText('bots.collab.nudgeSend'));
    });
    expect((interjectBotDelegation.mock.calls[2] as unknown[])[3]).not.toBe(first[3]);
  });

  it('stops the delegation through the existing cancel channel', async () => {
    listBotDelegations.mockResolvedValue({ ok: true, delegations: [delegation('waiting')] });
    render(<BotCollaborationCard data={{ ...meta() }} sessionId={SESSION_ID} />);
    await waitFor(() => expect(screen.getByText('bots.collab.stop')).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByText('bots.collab.stop'));
    });
    expect(cancelBotDelegation).toHaveBeenCalledWith(SESSION_ID, DELEGATION_ID);
  });

  it('collapses into a one-line report once the delegation reaches a terminal state', async () => {
    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [
        delegation('completed', { createdAt: 1_000, completedAt: 43_000, updatedAt: 43_000 }),
      ],
    });
    render(<BotCollaborationCard data={{ ...meta() }} sessionId={SESSION_ID} />);

    const report = await screen.findByText(/bots\.collab\.report\.done/);
    // 用时走 i18n 单位,不再是硬编码的 `42s` —— 中文界面里 `42s` 和「用时」并排
    // 读起来是两套语言。
    expect(report.textContent).toContain('bots.collab.duration.seconds:{\\"n\\":42}');
    expect(report.textContent).not.toContain('42s');
    // 收拢后不再提供催 / 停：委派已经结束，按钮留着只会误导。
    expect(screen.queryByText('bots.collab.nudge')).toBeNull();
    expect(screen.queryByText('bots.collab.stop')).toBeNull();

    fireEvent.click(report);
    expect(screen.getByText('给伙伴协作做一版方案')).toBeTruthy();
    fireEvent.click(screen.getByText(/bots\.collab\.watchWork/));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-planner/session/child-1');
  });

  it('shows what the guest delivered as deliverable cards, not raw refs', async () => {
    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [
        delegation('completed', {
          completedAt: Date.now(),
          outputArtifacts: [
            { ref: 'cindy-media://blobs/hero.png', kind: 'image' },
            { ref: 'xdt-file://q3.pptx', kind: 'file' },
          ],
        }),
      ],
    });
    render(<BotCollaborationCard data={{ ...meta() }} sessionId={SESSION_ID} />);
    // 真交了东西的战报说的是「交付 N 件」,不是一句「完成」——后者没有回答
    // 「TA 到底交出来什么」。
    fireEvent.click(await screen.findByText(/bots\.collab\.report\.delivered/));

    const cards = screen.getAllByTestId('bot-artifact-card');
    expect(cards.map((card) => card.getAttribute('data-artifact-category'))).toEqual([
      'image',
      'deck',
    ]);
    // 原始协议地址不再直接示人。
    expect(screen.queryByText('cindy-media://blobs/hero.png')).toBeNull();
  });

  it('puts the result summary in the expanded report, above the original objective', async () => {
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
    const report = await screen.findByText(/bots\.collab\.report\.done/);

    // 折叠态只说结束了,结论要点开才看到 —— 但必须看得到:否则协作卡只留下
    // 「当初想干什么」,用户拿不到结论就得跳去子任务。
    expect(screen.queryByText(/三条结论/)).toBeNull();
    fireEvent.click(report);
    const summary = screen.getByText(/三条结论/);
    const objective = screen.getByText('给伙伴协作做一版方案');
    expect(summary).toBeTruthy();
    // 先结论、后当初的目标。
    expect(summary.compareDocumentPosition(objective) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('reports a stopped delegation as stopped, not as a failure', async () => {
    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [delegation('cancelled', { completedAt: Date.now() })],
    });
    render(<BotCollaborationCard data={{ ...meta() }} sessionId={SESSION_ID} />);
    expect(await screen.findByText(/bots\.collab\.report\.stopped/)).toBeTruthy();
  });

  it('says the work has not started yet while the first handoff is still being retried', async () => {
    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [
        delegation('waiting', { lastError: 'AGENT_NOT_READY: pi not authenticated' }),
      ],
    });
    render(<BotCollaborationCard data={{ ...meta() }} sessionId={SESSION_ID} />);
    // 「等待开始」和「正在做」以前长得一模一样：用户以为对方在干活，其实一次都没开始。
    expect(await screen.findByText('bots.collab.retrying')).toBeTruthy();
  });

  it('puts the failure reason on the collapsed report line so it needs no expanding', async () => {
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
    const line = await screen.findByText(/bots\.collab\.report\.failedReason/);
    // 机读前缀不进人话，原因本身必须出现在折叠行上。
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
    expect(screen.queryByText('bots.collab.stop')).toBeNull();
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
    expect(screen.queryByText('bots.collab.stop')).toBeNull();
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

    await waitFor(() => expect(screen.getByText(/bots\.collab\.report\.timedOut/)).toBeTruthy());
    expect(screen.queryByText(/bots\.collab\.report\.failed/)).toBeNull();
  });
});
