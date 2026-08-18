// @vitest-environment jsdom

import { createElement, type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Tooltip } from '@/components/ui/tooltip';
import { SessionTooltip } from '../SessionTooltip';
import type { SessionPrRef } from '@/lib/gitContext.types';
import { prStatusKey } from '@/hooks/useSessionGitContext';

const { loadScheduleSidebarIndexRuns, prStatuses } = vi.hoisted(() => ({
  loadScheduleSidebarIndexRuns: vi.fn(),
  prStatuses: new Map(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      typeof options?.count === 'number' ? `${key}:${options.count}` : key,
  }),
}));

vi.mock('@/features/scheduler/lib/scheduleSidebarIndexRuns', () => ({
  loadScheduleSidebarIndexRuns,
}));

vi.mock('@/contexts/PrRefsContext', () => ({
  usePrStatuses: () => ({
    statuses: prStatuses,
    fetchStatusesForSession: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  loadScheduleSidebarIndexRuns.mockReset();
  prStatuses.clear();
});

const prRef: SessionPrRef = {
  id: 'pr-ref-1',
  sessionId: 'session-1',
  owner: 'makecindy',
  repo: 'xdmaker',
  prNumber: 337,
  url: 'https://github.com/makecindy/cindy/pull/337',
  firstSeenAt: 0,
  lastSeenAt: 0,
};

describe('SessionTooltip', () => {
  it('does not open the PR variant from focus restored to the sidebar row', () => {
    const providerProps = { delayDuration: 0 } as ComponentProps<typeof Tooltip.Provider>;
    const tooltipProps = {
      sessionId: 'session-1',
      prRefs: [prRef],
    } as unknown as ComponentProps<typeof SessionTooltip>;

    render(
      createElement(
        Tooltip.Provider,
        providerProps,
        createElement(
          SessionTooltip,
          tooltipProps,
          createElement('div', { tabIndex: 0 }, 'Session row'),
        ),
      ),
    );

    fireEvent.focus(screen.getByText('Session row'));

    expect(screen.queryByText('makecindy/cindy#337')).toBeNull();
  });

  it('does not open the source variant from focus restored to the sidebar row', () => {
    const providerProps = { delayDuration: 0 } as ComponentProps<typeof Tooltip.Provider>;
    const tooltipProps = {
      sessionId: 'session-1',
      prRefs: [],
      sourceLabel: 'XDMaker',
    } as unknown as ComponentProps<typeof SessionTooltip>;

    render(
      createElement(
        Tooltip.Provider,
        providerProps,
        createElement(
          SessionTooltip,
          tooltipProps,
          createElement('div', { tabIndex: 0 }, 'Session row'),
        ),
      ),
    );

    fireEvent.focus(screen.getByText('Session row'));

    expect(screen.queryByText('XDMaker')).toBeNull();
  });

  it('lets a long repository label shrink without pushing the PR status outside the tooltip', async () => {
    const longRepoRef = {
      ...prRef,
      repo: 'repository-name-that-is-much-wider-than-the-tooltip-content-area',
    };
    prStatuses.set(prStatusKey(longRepoRef), {
      ok: true,
      owner: longRepoRef.owner,
      repo: longRepoRef.repo,
      prNumber: longRepoRef.prNumber,
      status: 'merged',
      branch: 'fix/long-repository-name',
      title: 'Keep the merged state inside the tooltip',
      htmlUrl: longRepoRef.url,
      unresolvedCount: 0,
    });

    render(
      createElement(
        SessionTooltip,
        { sessionId: 'session-1', prRefs: [longRepoRef] } as unknown as ComponentProps<
          typeof SessionTooltip
        >,
        createElement('div', null, 'Session row'),
      ),
    );

    fireEvent.pointerMove(screen.getByText('Session row'), { pointerType: 'mouse' });

    const repoLabels = await screen.findAllByText(
      `makecindy/${longRepoRef.repo}#${longRepoRef.prNumber}`,
    );
    const statusLabels = screen.getAllByText('· ccAgent.gitContext.pr.status.merged');

    for (const repoLabel of repoLabels) {
      expect(repoLabel.classList.contains('min-w-0')).toBe(true);
      expect(repoLabel.classList.contains('truncate')).toBe(true);
      expect(repoLabel.classList.contains('shrink-0')).toBe(false);
    }
    for (const statusLabel of statusLabels) {
      expect(statusLabel.classList.contains('shrink-0')).toBe(true);
      expect(statusLabel.classList.contains('whitespace-nowrap')).toBe(true);
    }
  });

  it('excludes association-only rows from the displayed automation run count', async () => {
    loadScheduleSidebarIndexRuns.mockResolvedValue([
      {
        runId: 'schedule-session-binding:schedule-1:session-1',
        scheduleId: 'schedule-1',
        scheduleName: 'Daily',
        scheduleStatus: 'active',
        sessionId: 'session-1',
        firedAt: 100,
        associationOnly: true,
        status: 'success',
        readAt: 100,
      },
      {
        runId: 'run-1',
        scheduleId: 'schedule-1',
        scheduleName: 'Daily',
        scheduleStatus: 'active',
        sessionId: 'session-2',
        firedAt: 200,
        status: 'success',
        readAt: 200,
      },
      {
        runId: 'run-2',
        scheduleId: 'schedule-1',
        scheduleName: 'Daily',
        scheduleStatus: 'active',
        sessionId: 'session-3',
        firedAt: 300,
        status: 'success',
        readAt: 300,
      },
    ]);

    render(
      createElement(
        SessionTooltip,
        {
          sessionId: 'session-1',
          prRefs: [],
          isAutomationSession: true,
        } as unknown as ComponentProps<typeof SessionTooltip>,
        createElement('div', null, 'Automation row'),
      ),
    );

    fireEvent.pointerMove(screen.getByText('Automation row'), { pointerType: 'mouse' });

    expect((await screen.findAllByText('ccAgent.sidebar.automationGroup.runCount:2')).length).toBeGreaterThan(0);
    expect(screen.queryByText('ccAgent.sidebar.automationGroup.runCount:3')).toBeNull();
  });
});
