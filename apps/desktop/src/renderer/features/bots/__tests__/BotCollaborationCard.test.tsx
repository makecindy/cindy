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

    expect(interjectBotDelegation).toHaveBeenCalledWith(SESSION_ID, DELEGATION_ID, '怎么样了？');
    // 送出后收起输入层，避免同一句话被连点两次。
    await waitFor(() =>
      expect(screen.queryByPlaceholderText('bots.collab.nudgePlaceholder')).toBeNull(),
    );
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
    expect(report.textContent).toContain('42s');
    // 收拢后不再提供催 / 停：委派已经结束，按钮留着只会误导。
    expect(screen.queryByText('bots.collab.nudge')).toBeNull();
    expect(screen.queryByText('bots.collab.stop')).toBeNull();

    fireEvent.click(report);
    expect(screen.getByText('给伙伴协作做一版方案')).toBeTruthy();
    fireEvent.click(screen.getByText(/bots\.collab\.openTask/));
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
    fireEvent.click(await screen.findByText(/bots\.collab\.report\.done/));

    const cards = screen.getAllByTestId('bot-artifact-card');
    expect(cards.map((card) => card.getAttribute('data-artifact-category'))).toEqual([
      'image',
      'deck',
    ]);
    // 原始协议地址不再直接示人。
    expect(screen.queryByText('cindy-media://blobs/hero.png')).toBeNull();
  });

  it('reports a stopped delegation as stopped, not as a failure', async () => {
    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [delegation('cancelled', { completedAt: Date.now() })],
    });
    render(<BotCollaborationCard data={{ ...meta() }} sessionId={SESSION_ID} />);
    expect(await screen.findByText(/bots\.collab\.report\.stopped/)).toBeTruthy();
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
});
