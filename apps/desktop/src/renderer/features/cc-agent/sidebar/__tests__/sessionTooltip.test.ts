// @vitest-environment jsdom

import { createElement, type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Tooltip } from '@/components/ui/tooltip';
import { SessionTooltip } from '../SessionTooltip';
import type { SessionPrRef } from '@/lib/gitContext.types';
import { prStatusKey } from '@/hooks/useSessionGitContext';

const { prStatuses } = vi.hoisted(() => ({
  prStatuses: new Map(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
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
});
