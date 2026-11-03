// @vitest-environment jsdom

import { createElement, type ComponentProps, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Tooltip } from '@/components/ui/tooltip';
import { SessionTooltip } from '../SessionTooltip';
import {
  resetAutomationSchedulePublishedIndexForTests,
  useAutomationScheduleSessionIndex,
} from '../../hooks/useAutomationScheduleSessionIndex';
import type { ScheduleSidebarIndexRun } from '@/features/scheduler/lib/scheduleSidebarIndexRuns';
import type { SessionPrRef } from '@/lib/gitContext.types';
import { prStatusKey } from '@/hooks/useSessionGitContext';

const { prStatuses } = vi.hoisted(() => ({
  prStatuses: new Map(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'ccAgent.time.future.hour') return `还有 ${options?.count} 小时`;
      if (key === 'ccAgent.sidebar.automationGroup.stopped') return '已停止';
      return key;
    },
  }),
}));

vi.mock('@/contexts/PrRefsContext', () => ({
  usePrStatuses: () => ({
    statuses: prStatuses,
    fetchStatusesForSession: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  prStatuses.clear();
  vi.unstubAllGlobals();
  // publishedIndex 是模块级状态，不清会让后续用例继承本条用例发布的 schedule 信息。
  resetAutomationSchedulePublishedIndexForTests();
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

  it('honors the controlled open state used to suppress row details over inline actions', async () => {
    const renderTooltip = (controlledOpen: boolean) =>
      createElement(
        SessionTooltip,
        {
          sessionId: 'session-1',
          prRefs: [],
          sourceLabel: 'XDMaker',
          controlledOpen,
        } as unknown as ComponentProps<typeof SessionTooltip>,
        createElement('div', null, 'Session row'),
      );

    const { rerender } = render(renderTooltip(false));
    fireEvent.pointerMove(screen.getByText('Session row'), { pointerType: 'mouse' });
    expect(screen.queryByRole('tooltip')).toBeNull();

    rerender(renderTooltip(true));
    expect((await screen.findByRole('tooltip')).textContent).toContain('XDMaker');

    rerender(renderTooltip(false));
    expect(screen.queryByRole('tooltip')).toBeNull();
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

  it('replaces the countdown with the stopped state once the automation is paused', async () => {
    // 停用只改 schedules.status,next_fire_at 保留旧值 —— 气泡若还拿着停用前的快照,
    // 就会继续显示「还有 N 小时」。这里用真实索引入口(useAutomationScheduleSessionIndex
    // + scheduler 'changed' 事件)驱动,验证气泡跟随实时状态。
    const runs: ScheduleSidebarIndexRun[] = [
      {
        runId: 'run-1',
        scheduleId: 'schedule-1',
        scheduleName: 'PR 助手',
        scheduleStatus: 'active',
        status: 'success',
        firedAt: 1,
        sessionId: 'session-1',
        nextFireAt: Date.now() + 2 * 60 * 60 * 1000 + 60_000,
      },
    ];
    let listener: ((event: unknown, ownerStamp: unknown) => void) | undefined;
    const listSidebarIndexRuns = vi.fn(async () => ({
      runs,
      inflightRunIds: [],
      inflightPolicies: [],
    }));
    vi.stubGlobal('electronAPI', {
      maker: {
        schedule: {
          listSidebarIndexRuns,
          onEvent: vi.fn((callback: (event: unknown, ownerStamp: unknown) => void) => {
            listener = callback;
            return () => {
              listener = undefined;
            };
          }),
        },
      },
    });

    const IndexOwner = ({ children }: { children?: ReactNode }) => {
      useAutomationScheduleSessionIndex();
      return children ?? null;
    };

    render(
      createElement(
        IndexOwner,
        null,
        createElement(
          SessionTooltip,
          {
            sessionId: 'session-1',
            prRefs: [],
            isAutomationSession: true,
          } as unknown as ComponentProps<typeof SessionTooltip>,
          createElement('div', null, 'Session row'),
        ),
      ),
    );

    await waitFor(() => expect(listSidebarIndexRuns).toHaveBeenCalled());
    fireEvent.pointerMove(screen.getByText('Session row'), { pointerType: 'mouse' });
    expect((await screen.findByRole('tooltip')).textContent).toContain('还有 2 小时');

    runs[0].scheduleStatus = 'paused';
    await act(async () => {
      listener?.({ type: 'changed', scheduleId: 'schedule-1' }, undefined);
    });

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('已停止');
    expect(tooltip.textContent).not.toContain('还有');
  });
});
