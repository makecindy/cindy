// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderAccountUsageResult } from '../../../../shared/providerAccountUsage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', resolvedLanguage: 'en' },
  }),
}));

import { ProviderAccountUsageModule } from '../ProviderAccountUsageModule';

afterEach(cleanup);

const deepSeek: ProviderAccountUsageResult = {
  status: 'ready',
  stale: false,
  snapshot: {
    kind: 'deepseek-balance',
    isAvailable: true,
    fetchedAt: 1_700_000_000_000,
    balances: [
      { currency: 'CNY', totalBalance: '12', grantedBalance: '2', toppedUpBalance: '10' },
      { currency: 'USD', totalBalance: '3', grantedBalance: '1', toppedUpBalance: '2' },
    ],
  },
};

const openRouter: ProviderAccountUsageResult = {
  status: 'ready',
  stale: false,
  snapshot: {
    kind: 'openrouter-key-usage',
    fetchedAt: 1_700_000_000_000,
    limit: null,
    limitRemaining: null,
    limitReset: null,
    usage: 5,
    usageDaily: 1,
    usageWeekly: 3,
    usageMonthly: 4,
  },
};

describe('ProviderAccountUsageModule', () => {
  it('renders every runtime separately and keeps every DeepSeek currency', () => {
    render(
      <ProviderAccountUsageModule
        runtimes={[
          { agent: 'claude-code', result: deepSeek, refreshing: false },
          { agent: 'codex', result: openRouter, refreshing: false },
        ]}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText('Claude Code')).toBeTruthy();
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.getByText('CNY')).toBeTruthy();
    expect(screen.getByText('USD')).toBeTruthy();
    expect(screen.getByText('providerAccountUsage.openRouter.noKeyQuota')).toBeTruthy();
    expect(screen.getByText('providerAccountUsage.usage.daily')).toBeTruthy();
    expect(screen.queryByText('providerAccountUsage.usage.todayTokens')).toBeNull();
  });

  it('renders nothing when every runtime is unsupported', () => {
    const { container } = render(
      <ProviderAccountUsageModule
        runtimes={[
          { agent: 'codex', result: { status: 'unsupported' }, refreshing: false },
        ]}
        onRefresh={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('keeps stale data, adds a non-color warning, and exposes refresh by label and tooltip', () => {
    const onRefresh = vi.fn();
    render(
      <ProviderAccountUsageModule
        runtimes={[
          {
            agent: 'codex',
            result: { ...openRouter, stale: true, error: 'rate-limited' },
            refreshing: false,
          },
        ]}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByTestId('provider-account-usage-stale')).toBeTruthy();
    expect(screen.getByText('providerAccountUsage.error.rate-limited')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('providerAccountUsage.refresh'));
    expect(onRefresh).toHaveBeenCalledWith('codex');
  });

  it('shows an in-place updating state before the first snapshot arrives', () => {
    render(
      <ProviderAccountUsageModule
        runtimes={[{ agent: 'codex', result: null, refreshing: true }]}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText('providerAccountUsage.updating')).toBeTruthy();
  });

  it('explains unavailable and empty DeepSeek balance responses', () => {
    const unavailable: ProviderAccountUsageResult = {
      status: 'ready',
      stale: false,
      snapshot: {
        kind: 'deepseek-balance',
        isAvailable: false,
        fetchedAt: 1_700_000_000_000,
        balances: [],
      },
    };
    const empty: ProviderAccountUsageResult = {
      status: 'ready',
      stale: false,
      snapshot: {
        kind: 'deepseek-balance',
        isAvailable: true,
        fetchedAt: 1_700_000_000_000,
        balances: [],
      },
    };
    const { rerender } = render(
      <ProviderAccountUsageModule
        runtimes={[{ agent: 'codex', result: unavailable, refreshing: false }]}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText('providerAccountUsage.deepSeek.unavailable')).toBeTruthy();

    rerender(
      <ProviderAccountUsageModule
        runtimes={[{ agent: 'codex', result: empty, refreshing: false }]}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText('providerAccountUsage.deepSeek.empty')).toBeTruthy();
  });

  it('formats DeepSeek decimal strings without losing precision', () => {
    const precise: ProviderAccountUsageResult = {
      status: 'ready',
      stale: false,
      snapshot: {
        kind: 'deepseek-balance',
        isAvailable: true,
        fetchedAt: 1_700_000_000_000,
        balances: [{
          currency: 'USD',
          totalBalance: '12345678901234567890.123456789',
          grantedBalance: '0.000000001',
          toppedUpBalance: '12345678901234567890.123456788',
        }],
      },
    };
    render(
      <ProviderAccountUsageModule
        runtimes={[{ agent: 'codex', result: precise, refreshing: false }]}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText('$12,345,678,901,234,567,890.123456789')).toBeTruthy();
    expect(screen.getByText('$0.000000001')).toBeTruthy();
  });

  it('names the quota meter and keeps refresh focus and motion accessible', () => {
    const limited: ProviderAccountUsageResult = {
      status: 'ready',
      stale: false,
      snapshot: {
        kind: 'openrouter-key-usage',
        fetchedAt: 1_700_000_000_000,
        limit: 10,
        limitRemaining: 8,
        limitReset: null,
        usage: 5,
        usageDaily: 1,
        usageWeekly: 3,
        usageMonthly: 4,
      },
    };
    render(
      <ProviderAccountUsageModule
        runtimes={[{ agent: 'codex', result: limited, refreshing: true }]}
        onRefresh={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('progressbar', {
        name: 'providerAccountUsage.openRouter.usedPercent',
      }),
    ).toBeTruthy();
    const refresh = screen.getByLabelText('providerAccountUsage.refresh');
    expect(refresh.className).toContain('focus-visible:ring-2');
    expect(refresh.querySelector('span.animate-spinner')).toBeTruthy();
    expect(refresh.querySelector('svg.animate-spin')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'providerAccountUsage.openDashboard' }).className,
    ).toContain('focus-visible:ring-2');
  });

  it('does not claim zero percent used when the key quota is zero', () => {
    const zeroQuota: ProviderAccountUsageResult = {
      status: 'ready',
      stale: false,
      snapshot: {
        kind: 'openrouter-key-usage',
        fetchedAt: 1_700_000_000_000,
        limit: 0,
        limitRemaining: 0,
        limitReset: null,
        usage: 0,
        usageDaily: 0,
        usageWeekly: 0,
        usageMonthly: 0,
      },
    };
    render(
      <ProviderAccountUsageModule
        runtimes={[{ agent: 'codex', result: zeroQuota, refreshing: false }]}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText('providerAccountUsage.openRouter.limit')).toBeTruthy();
    expect(screen.getByText('providerAccountUsage.openRouter.remaining')).toBeTruthy();
  });

  it('explains an unavailable state and offers an in-place retry', () => {
    const onRefresh = vi.fn();
    render(
      <ProviderAccountUsageModule
        runtimes={[
          {
            agent: 'pi',
            result: { status: 'unavailable', error: 'auth' },
            refreshing: false,
          },
        ]}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByText('providerAccountUsage.error.auth')).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'providerAccountUsage.retry' });
    expect(retry.className).toContain('focus-visible:ring-2');
    fireEvent.click(retry);
    expect(onRefresh).toHaveBeenCalledWith('pi');
  });
});
