// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BotGroupPendingInteraction } from '../BotGroupPendingInteraction';

const mocks = vi.hoisted(() => ({
  light: {} as Record<string, unknown>,
  activity: null as null | { phase: string },
  respondToPermission: vi.fn(),
  ensureInitialMessages: vi.fn(),
}));

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
  // 替身按真实组件的行为转发被冻结的 requestId(取自 permission 属性),
  // 这样才能验证「群专线把身份一路送到 store」这条链路,而不是只验证点击发生。
  PermissionPrompt: ({
    companion,
    permission,
    onRespond,
  }: {
    companion: { name: string };
    permission?: { requestId: string };
    onRespond: (result: { behavior: string; requestId?: string }) => void;
  }) => (
    <button
      type="button"
      onClick={() => onRespond({ behavior: 'allow', requestId: permission?.requestId })}
    >
      {`permission:${companion.name}`}
    </button>
  ),
}));
vi.mock('@/components/new-chat/AskUserQuestionPrompt', () => ({
  AskUserQuestionPrompt: ({ sessionId }: { sessionId: string }) => <div>{`ask:${sessionId}`}</div>,
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
    // 群专线必须和任务页一样端到端转发身份:第二个参数带被冻结的 requestId,
    // 第三个参数把它交给 store 做队首校验,否则 A 结束后晋升的 B 会被迟到响应误批。
    expect(mocks.respondToPermission).toHaveBeenCalledWith(
      'lane',
      expect.objectContaining({ behavior: 'allow', requestId: 'r1' }),
      'r1',
    );
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

  it('only notes other pending interactions without re-reading', () => {
    mocks.light = { ...EMPTY, pendingPlanReview: { requestId: 'p1' } };
    render(<BotGroupPendingInteraction sessionId="lane" bot={bot} />);
    expect(screen.getByRole('status')).toBeTruthy();
    expect(mocks.ensureInitialMessages).not.toHaveBeenCalled();
  });
});
