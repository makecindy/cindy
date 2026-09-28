// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Tooltip } from '@/components/ui/tooltip';
import type { Session } from '@/lib/ccAgent.types';
import type { SessionGitContext } from '@/hooks/useSessionGitContext';

const { gitContextMock } = vi.hoisted(() => ({
  gitContextMock: vi.fn<() => SessionGitContext>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}));
vi.mock('@/hooks/useSessionGitContext', () => ({
  useSessionGitContext: gitContextMock,
}));

import { GitContextBadge } from '../GitContextBadge';

const dialogueSession = {
  id: 'session-1',
  workspaceKind: 'dialogue',
  workingDir: '/Users/me/Cindy/dialogues/abc',
  remoteHostId: null,
} as Session;

afterEach(() => {
  cleanup();
  gitContextMock.mockReset();
});

describe('GitContextBadge', () => {
  it('对话目录不是 git 仓库时,仍显示消息里的 PR 徽标', () => {
    gitContextMock.mockReturnValue({
      head: null,
      branchSource: null,
      prRefs: [
        {
          id: 'ref-1',
          sessionId: 'session-1',
          owner: 'octo',
          repo: 'repo',
          prNumber: 7,
          url: 'https://github.com/octo/repo/pull/7',
          firstSeenAt: 1,
          lastSeenAt: 2,
        },
      ],
      prStatuses: new Map(),
    });

    render(
      <Tooltip.Provider>
        <GitContextBadge session={dialogueSession} />
      </Tooltip.Provider>,
    );

    expect(screen.getByRole('button').textContent).toContain('#7');
    expect(screen.queryByLabelText(/ccAgent\.gitContext\.branchAria/)).toBeNull();
  });

  it('既无分支也无 PR 时不渲染', () => {
    gitContextMock.mockReturnValue({
      head: null,
      branchSource: null,
      prRefs: [],
      prStatuses: new Map(),
    });

    const { container } = render(
      <Tooltip.Provider>
        <GitContextBadge session={dialogueSession} />
      </Tooltip.Provider>,
    );

    expect(container.innerHTML).toBe('');
  });
});
