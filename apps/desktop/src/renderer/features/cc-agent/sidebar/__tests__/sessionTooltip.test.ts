// @vitest-environment jsdom

import { createElement, type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Tooltip } from '@/components/ui/tooltip';
import { SessionTooltip } from '../SessionTooltip';
import type { SessionPrRef } from '@/lib/gitContext.types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/contexts/PrRefsContext', () => ({
  usePrStatuses: () => ({
    statuses: new Map(),
    fetchStatusesForSession: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
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
});
