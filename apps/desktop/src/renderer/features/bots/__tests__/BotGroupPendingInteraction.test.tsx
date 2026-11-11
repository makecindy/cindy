// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BotGroupPendingInteraction } from '../BotGroupPendingInteraction';

const mocks = vi.hoisted(() => ({
  light: {} as Record<string, unknown>,
  activity: null as null | { phase: string },
  respondToPermission: vi.fn(),
  ensureInitialMessages: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) => (options?.name ? `${key}:${options.name}` : key),
  }),
}));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    subscribeLight: () => () => undefined,
    getLightSnapshot: () => mocks.light,
    respondToPermission: mocks.respondToPermission,
    ensureInitialMessages: mocks.ensureInitialMessages,
    answerUserQuestion: vi.fn(),
    setAskUserViewerState: vi.fn(),
    setAskUserDraft: vi.fn(),
  },
}));
vi.mock('@/state/agentIslandActivity', () => ({ useAgentIslandActivity: () => mocks.activity }));
vi.mock('@/components/new-chat/PermissionPrompt', () => ({
  PermissionPrompt: ({
    companion,
    onRespond,
  }: {
    companion: { name: string };
    onRespond: (result: { behavior: string }) => void;
  }) => (
    <button type="button" onClick={() => onRespond({ behavior: 'allow' })}>
      {`permission:${companion.name}`}
    </button>
  ),
}));
vi.mock('@/components/new-chat/AskUserQuestionPrompt', () => ({
  AskUserQuestionPrompt: ({ sessionId }: { sessionId: string }) => <div>{`ask:${sessionId}`}</div>,
}));
// Handoff rendering has its own tests; it is not involved in the missing-card path.
vi.mock('@/features/input-handoff/InputHandoffCard', () => ({
  InputHandoffCard: () => <div>handoff</div>,
}));

const EMPTY = {
  pendingPermission: null,
  pendingAskUser: null,
  pendingPlanReview: null,
  pendingPluginSetup: null,
  pendingIssueConfirm: null,
  pendingRenameSessionsConfirm: null,
  pendingGhostGrantConfirm: null,
  pendingRemoteDesktopConfirmation: null,
  askUserViewerState: 'expanded',
  askUserDraft: null,
};

const bot = { id: 'mimi', name: '咪咪', avatar: '', avatarColor: 'red' };

beforeEach(() => {
  mocks.light = { ...EMPTY };
  mocks.activity = null;
  mocks.respondToPermission.mockReset();
  mocks.ensureInitialMessages.mockReset();
  mocks.navigate.mockReset();
});

afterEach(cleanup);

describe('BotGroupPendingInteraction', () => {
  it('renders nothing while the speaking lane waits on no one', () => {
    const { container } = render(<BotGroupPendingInteraction sessionId="lane" bot={bot} />);
    expect(container.textContent).toBe('');
  });

  it('reuses the task permission card and answers on the lane session', () => {
    mocks.light = { ...EMPTY, pendingPermission: { requestId: 'r1', toolName: 'Bash', input: {} } };
    render(<BotGroupPendingInteraction sessionId="lane" bot={bot} />);
    fireEvent.click(screen.getByRole('button', { name: 'permission:咪咪' }));
    expect(mocks.respondToPermission).toHaveBeenCalledWith('lane', { behavior: 'allow' });
  });

  it('reuses the question card for the lane', () => {
    mocks.light = { ...EMPTY, pendingAskUser: { requestId: 'q1', questions: [] } };
    render(<BotGroupPendingInteraction sessionId="lane" bot={bot} />);
    expect(screen.getByText('ask:lane')).toBeTruthy();
  });

  it('falls back to a status line and re-reads the lane once after a missed push', () => {
    mocks.activity = { phase: 'needs-interaction' };
    const view = render(<BotGroupPendingInteraction sessionId="lane" bot={bot} />);
    expect(screen.getByRole('status').textContent).toBe('bots.groupChat.waitingConfirm:咪咪');
    expect(mocks.ensureInitialMessages).toHaveBeenCalledWith('lane');
    view.rerender(<BotGroupPendingInteraction sessionId="lane" bot={bot} />);
    expect(mocks.ensureInitialMessages).toHaveBeenCalledTimes(1);
  });

  it('opens the original task for confirmations without an inline card', () => {
    mocks.light = { ...EMPTY, pendingPlanReview: { requestId: 'p1' } };
    render(<BotGroupPendingInteraction sessionId="lane" bot={bot} />);
    expect(screen.getByRole('status')).toBeTruthy();
    expect(mocks.ensureInitialMessages).not.toHaveBeenCalled();
    // #7583, unit: a plan confirmation has no inline card; the existing tests
    // only checked its label, leaving the user without a way to answer it.
    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.progress.viewProcess' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/lane');
  });
});
