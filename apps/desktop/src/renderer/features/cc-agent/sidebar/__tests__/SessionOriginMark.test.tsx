// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：SessionOriginMark（侧边栏来源图标）与 SessionOriginChip（任务头部来源按钮），
 *   验证 orcaRemoteLead、createdBySession 与普通用户任务的渲染差异以及点击回跳行为。
 * - Bug／规则依据：补齐 orcaRemoteLead 在侧边栏缺失的来源标记，并为 send_to_session 新建任务提供
 *   不打扰普通用户任务的克制来源标示与可点击回跳。
 * - 现有覆盖缺口：此前无任何测试覆盖侧边栏 orcaRemoteLead 标记或会话级 createdBySession 渲染与回跳。
 * - 最小失败输入：三条最小 Session（普通任务、createdBySession 任务、orcaRemoteLead 任务）。
 * - tier：unit（jsdom）。
 */

import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openCrossDeviceTarget: vi.fn(async () => {}),
  pinSessionOrigin: vi.fn(),
  delegatingBot: null as { id: string; name: string } | null,
  navigationMode: 'route-owner' as 'route-owner' | 'sidebar-embedded' | 'split-pane',
  liveTitle: null as string | null,
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
  }),
}));

vi.mock('@/hooks/useStableTranslation', () => ({
  useStableTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
  }),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ text, children }: { text?: string; children: ReactNode }) => (
    <span data-tip={text ?? ''}>{children}</span>
  ),
}));

vi.mock('@/components/chat/SessionLinkChip', () => ({
  useSessionLinkTarget: () => ({ openTarget: mocks.openCrossDeviceTarget }),
}));

vi.mock('@/features/bots/botFollowScopes', () => ({
  useSessionDelegatingBot: () => mocks.delegatingBot,
}));

vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: { pinSessionOrigin: mocks.pinSessionOrigin },
  useRemoteSessionTitle: () => null,
}));

vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: () => undefined,
}));

vi.mock('@/lib/sessionsStore', () => ({
  sessionsStore: {
    subscribe: () => () => {},
    getTitleById: () => mocks.liveTitle,
  },
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn() },
}));

vi.mock('../../embeddedSessionNavigation', () => ({
  useSessionNavigationMode: () => mocks.navigationMode,
  isInteractiveSessionNavigationMode: (mode: string) => mode !== 'sidebar-embedded',
}));

import { SessionOriginChip } from '../../SessionOriginChip';
import { SessionOriginMark } from '../SessionOriginMark';

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    userId: '',
    title: overrides.id,
    workingDir: '/repo',
    projectDir: '/repo',
    workspaceKind: 'project',
    model: 'claude-sonnet-4-6',
    effort: 'high',
    permissionMode: 'ask',
    status: 'active',
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindow: 0,
    fastMode: false,
    clearedAt: null,
    pinnedAt: null,
    userSendAt: null,
    agentKind: 'cc',
    source: 'desktop',
    orcaRole: null,
    parentSessionId: null,
    forkedAtMessageId: null,
    worktreePath: null,
    usedProjectContext: false,
    extraDirs: [],
    createdAt: '2026-11-26T10:00:00.000Z',
    updatedAt: '2026-11-26T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.openCrossDeviceTarget.mockReset();
  mocks.pinSessionOrigin.mockReset();
  mocks.delegatingBot = null;
  mocks.navigationMode = 'route-owner';
  mocks.liveTitle = null;
});

afterEach(cleanup);

describe('SessionOriginMark', () => {
  it('renders nothing for ordinary user-created tasks', () => {
    const { container } = render(<SessionOriginMark session={makeSession({ id: 'plain' })} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a remote Orca Worker sidebar badge with device provenance', () => {
    render(
      <SessionOriginMark
        session={makeSession({
          id: 'remote-worker',
          orcaRemoteLead: {
            leadDeviceId: 'dev-a',
            leadDeviceName: 'Office Mac',
            leadSessionId: 'lead-1',
            leadTitle: 'Release',
            workerLabel: 'w1',
          },
        })}
      />,
    );
    const badge = screen.getByTestId('session-origin-orca-remote-remote-worker');
    expect(badge.getAttribute('aria-label')).toContain('Office Mac');
  });

  it('renders a restrained task-origin mark for createdBySession and suppresses when requested', () => {
    const session = makeSession({
      id: 'child',
      createdBySession: { kind: 'session', sessionId: 'parent-1', title: 'Issue triage' },
    });
    const { rerender } = render(<SessionOriginMark session={session} />);
    const mark = screen.getByTestId('session-origin-task-child');
    expect(mark.getAttribute('aria-label')).toContain('Issue triage');

    rerender(<SessionOriginMark session={session} suppressTaskOrigin />);
    expect(screen.queryByTestId('session-origin-task-child')).toBeNull();
  });
});

describe('SessionOriginChip', () => {
  it('navigates back to the local originating task and pins remote device when viewing a remote session', () => {
    const session = makeSession({
      id: 'child',
      deviceLinkDeviceId: 'work-mac',
      createdBySession: { kind: 'session', sessionId: 'parent-1', title: 'Main PR' },
    });
    render(<SessionOriginChip session={session} />);
    const chip = screen.getByTestId('session-header-origin-child');
    expect(chip.tagName).toBe('BUTTON');
    fireEvent.click(chip);
    expect(mocks.pinSessionOrigin).toHaveBeenCalledWith('work-mac', 'parent-1');
    expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/parent-1');
  });

  it('uses deep-link navigation for cross-computer createdBySession and hides when a buddy owner chip owns the header', () => {
    const session = makeSession({
      id: 'remote-child',
      createdBySession: {
        kind: 'session',
        sessionId: 'dev-a::parent-1',
        title: 'Lead Plan',
        deviceId: 'dev-a',
        deviceName: 'Office Mac',
      },
    });
    const { rerender } = render(<SessionOriginChip session={session} />);
    fireEvent.click(screen.getByTestId('session-header-origin-remote-child'));
    expect(mocks.openCrossDeviceTarget).toHaveBeenCalledWith(false);

    mocks.delegatingBot = { id: 'bot-1', name: 'Alex' };
    rerender(<SessionOriginChip session={session} />);
    expect(screen.queryByTestId('session-header-origin-remote-child')).toBeNull();
  });
});
