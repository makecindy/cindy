// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BotDelegationActivityIndicator } from '../BotDelegationActivityIndicator';
import type {
  BotDelegationChangedPayload,
  BotDelegationStatus,
  BotDelegationView,
} from '../../../../shared/botDelegation';

const mocks = vi.hoisted(() => ({
  openBotDelegationsTab: vi.fn(() => Promise.resolve()),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));
vi.mock('@/features/right-sidebar/lib/openBotDelegationsTab', () => ({
  openBotDelegationsTab: mocks.openBotDelegationsTab,
}));

const SESSION_ID = 'parent-session-1';

function delegation(
  id: string,
  status: BotDelegationStatus,
  overrides: Partial<BotDelegationView> = {},
): BotDelegationView {
  return {
    id,
    requestingBotId: 'bot-a',
    targetBotId: `target-${id}`,
    targetBotName: 'Dash',
    parentSessionId: SESSION_ID,
    childSessionId: `child-${id}`,
    objective: 'Investigate the flaky test',
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
    createdAt: Date.now() - 5_000,
    acceptedAt: null,
    completedAt: null,
    updatedAt: Date.now(),
    ...overrides,
  };
}

let listeners: Array<(payload: BotDelegationChangedPayload, ownerStamp?: unknown) => void> = [];
let listBotDelegations: ReturnType<typeof vi.fn>;

function emitChange(payload: Partial<BotDelegationChangedPayload> = {}) {
  const full: BotDelegationChangedPayload = {
    delegationId: 'd1',
    parentSessionId: SESSION_ID,
    childSessionId: 'child-d1',
    status: 'completed',
    ...payload,
  };
  for (const listener of [...listeners]) listener(full);
}

beforeEach(() => {
  listeners = [];
  mocks.openBotDelegationsTab.mockClear();
  listBotDelegations = vi.fn(async () => ({ ok: true as const, delegations: [] }));
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      maker: {
        listBotDelegations: (...args: unknown[]) => listBotDelegations(...args),
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
  vi.useRealTimers();
});

describe('BotDelegationActivityIndicator', () => {
  it('shows the target Bot name and elapsed time for a single active delegation', async () => {
    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [delegation('d1', 'running', { createdAt: Date.now() - 12_000 })],
    });

    render(<BotDelegationActivityIndicator sessionId={SESSION_ID} />);

    const button = await screen.findByRole('button');
    expect(listBotDelegations).toHaveBeenCalledWith(SESSION_ID);
    expect(button.textContent).toContain('rightSidebar.botDelegations.activity.single');
    expect(button.textContent).toContain('Dash');
    expect(button.textContent).toMatch(/1[12]s/);
    // 旋转 loading 图标必须在，且尊重 reduce-motion。
    const spinner = button.querySelector('.animate-spin');
    expect(spinner).not.toBeNull();
    expect(spinner?.className).toContain('motion-reduce:animate-none');
  });

  it('falls back to a count when several delegations are active', async () => {
    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [
        delegation('d1', 'running'),
        delegation('d2', 'queued', { targetBotName: 'Nova' }),
        delegation('d3', 'waiting', { targetBotName: 'Pixel' }),
      ],
    });

    render(<BotDelegationActivityIndicator sessionId={SESSION_ID} />);

    const button = await screen.findByRole('button');
    expect(button.textContent).toContain('rightSidebar.botDelegations.activity.multiple');
    expect(button.textContent).toContain('"count":3');
    expect(button.textContent).not.toContain('Nova');
  });

  it('renders nothing when every delegation reached a terminal state', async () => {
    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [
        delegation('d1', 'completed'),
        delegation('d2', 'failed'),
        delegation('d3', 'cancelled'),
        delegation('d4', 'timed-out'),
      ],
    });

    const { container } = render(<BotDelegationActivityIndicator sessionId={SESSION_ID} />);

    await waitFor(() => expect(listBotDelegations).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('button')).toBeNull());
    expect(container.textContent).toBe('');
  });

  it('reloads on onBotDelegationChanged and disappears once the delegation finishes', async () => {
    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [delegation('d1', 'running')],
    });

    const { container } = render(<BotDelegationActivityIndicator sessionId={SESSION_ID} />);
    await screen.findByRole('button');

    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [delegation('d1', 'completed')],
    });
    await act(async () => {
      emitChange({ status: 'completed' });
    });

    await waitFor(() => expect(container.querySelector('button')).toBeNull());
    expect(listBotDelegations).toHaveBeenCalledTimes(2);
  });

  it('ignores pushes that belong to another parent task', async () => {
    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [delegation('d1', 'running')],
    });

    render(<BotDelegationActivityIndicator sessionId={SESSION_ID} />);
    await screen.findByRole('button');

    await act(async () => {
      emitChange({ parentSessionId: 'some-other-session' });
    });

    expect(listBotDelegations).toHaveBeenCalledTimes(1);
  });

  it('opens the Bot collaboration tab, focusing the row only when a single delegation is active', async () => {
    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [delegation('d1', 'running')],
    });

    const { unmount } = render(<BotDelegationActivityIndicator sessionId={SESSION_ID} />);
    fireEvent.click(await screen.findByRole('button'));

    expect(mocks.openBotDelegationsTab).toHaveBeenCalledWith(SESSION_ID, {
      focusDelegationId: 'd1',
      userInitiated: true,
    });

    unmount();
    mocks.openBotDelegationsTab.mockClear();
    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [delegation('d1', 'running'), delegation('d2', 'queued')],
    });

    render(<BotDelegationActivityIndicator sessionId={SESSION_ID} />);
    fireEvent.click(await screen.findByRole('button'));

    expect(mocks.openBotDelegationsTab).toHaveBeenCalledWith(SESSION_ID, {
      focusDelegationId: undefined,
      userInitiated: true,
    });
  });

  it('hides itself when the delegation list cannot be read', async () => {
    listBotDelegations.mockResolvedValue({
      ok: false,
      errorCode: 'not-found',
      message: 'session gone',
    });

    const { container } = render(<BotDelegationActivityIndicator sessionId={SESSION_ID} />);

    await waitFor(() => expect(listBotDelegations).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('button')).toBeNull());
  });

  it('unsubscribes from delegation pushes on unmount', async () => {
    listBotDelegations.mockResolvedValue({
      ok: true,
      delegations: [delegation('d1', 'running')],
    });

    const { unmount } = render(<BotDelegationActivityIndicator sessionId={SESSION_ID} />);
    await screen.findByRole('button');
    expect(listeners).toHaveLength(1);

    unmount();
    expect(listeners).toHaveLength(0);
  });
});
