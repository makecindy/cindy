// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionInfoMeta } from '../SessionInfoMeta';
import type { SessionWorktreeInfo } from '../sessionWorktreeInfo';

const reveal = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/contexts/PrRefsContext', () => ({
  usePrActions: () => ({ fetchStatusesForSession: vi.fn() }),
  usePrStatus: () => undefined,
}));

beforeEach(() => {
  Object.assign(window, {
    electronAPI: {
      worktreeReveal: reveal,
    },
  });
});

afterEach(() => {
  cleanup();
  reveal.mockReset();
});

const managed: SessionWorktreeInfo = {
  path: '/repo/.cindy-worktrees/steady-goodall',
  name: 'steady-goodall',
  branch: 'cindy/steady-goodall',
  source: 'managed',
  canReveal: true,
};

describe('SessionInfoMeta worktree 徽标', () => {
  it('shows only the worktree icon in task info, not the name', () => {
    render(
      createElement(SessionInfoMeta, {
        pieces: [{ key: 'worktree', text: '' }],
        worktree: managed,
      }),
    );
    expect(screen.getByLabelText('ccAgent.sidebar.taskInfo.openWorktree')).toBeTruthy();
    expect(screen.queryByText('steady-goodall')).toBeNull();
  });

  it('does not make observed worktree icons an action control', () => {
    render(
      createElement(SessionInfoMeta, {
        pieces: [{ key: 'worktree', text: '' }],
        worktree: {
          ...managed,
          source: 'observed',
          canReveal: false,
        },
      }),
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText('ccAgent.sidebar.taskInfo.openWorktree')).toBeNull();
  });
});
