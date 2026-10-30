// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';
import type { TFunction } from 'i18next';
const mocks = vi.hoisted(() => ({
  rates: vi.fn(),
  account: vi.fn(),
  claude: vi.fn(),
  xai: vi.fn(),
}));
vi.mock('@/hooks/useCodexRateLimits', () => ({ useCodexRateLimits: mocks.rates }));
vi.mock('@/hooks/useAccountUsage', () => ({ useAccountUsage: mocks.account }));
vi.mock('@/hooks/useClaudeSubscriptionUsage', () => ({ useClaudeSubscriptionUsage: mocks.claude }));
vi.mock('@/hooks/useXaiSubscriptionUsage', () => ({
  useXaiSubscriptionUsage: mocks.xai,
  requestXaiSubscriptionRefresh: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: { percent: number }) =>
      key === 'quotaCard.remainingPercent' ? `Remaining ${args?.percent}%` : key,
    i18n: { language: 'en' },
  }),
}));
import {
  buildSettingsCodexUsageCard,
  useProviderSubscriptionCard,
} from '@/components/settings/useProviderSubscriptionCard';
import { QuotaHoverCard } from '@/components/status/QuotaHoverCard';
const t = ((key: string) => key) as TFunction;
const now = Date.now();
const makeSnapshot = (): MobileCodexRateLimitsResult => ({
  account: { email: null, accountId: null, planType: null },
  rateLimits: { secondary: { usedPercent: 88, windowMinutes: 10080, resetsAt: now / 1000 + 1000 } },
  rateLimitsByLimitId: null,
  rateLimitResetCredits: { availableCount: 0, credits: [] },
  resetOffer: null,
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('settings subscription card', () => {
  it('renders secondary-only weekly quota and uses the task account plan instead of generic subscription', () => {
    const data = buildSettingsCodexUsageCard(makeSnapshot(), { planType: 'pro' }, t, now);
    expect(data.planLabel).toBe('Pro');
    expect(data.windows).toHaveLength(1);
    render(<QuotaHoverCard variant="embedded" account={data} />);
    expect(screen.getByTestId('quota-plan-badge').textContent).toBe('Pro');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('12');
    expect(screen.getByText('Remaining 12%')).toBeTruthy();
    expect(screen.getByTestId('quota-hover-card').className).not.toContain('w-[340px]');
    expect(screen.getByTestId('quota-hover-card').style.boxShadow).toBe('');
  });
  it('keeps valid plan fallback when direct identity reports unknown and shows plan without counters', () => {
    const snapshot = makeSnapshot();
    snapshot.account.planType = 'unknown';
    snapshot.rateLimits = {};
    const data = buildSettingsCodexUsageCard(snapshot, { planType: 'pro' }, t, now);
    expect(data.planLabel).toBe('Pro');
    expect(data.windows).toHaveLength(0);
  });
  it('never substitutes a promotion bucket for the account pool', () => {
    const snapshot = makeSnapshot();
    snapshot.rateLimitsByLimitId = {
      promotion: { limitId: 'promotion', secondary: { usedPercent: 0, windowMinutes: 10080 } },
    };
    expect(
      buildSettingsCodexUsageCard(snapshot, { primary: { usedPercent: 80 } }, t, now).windows,
    ).toHaveLength(0);
  });
  it('reads both data sources using the exact provider ID and keeps suspended accounts visible in settings', () => {
    mocks.rates.mockImplementation((enabled, id) => ({
      snapshot: enabled
        ? {
            ...makeSnapshot(),
            account: { email: null, accountId: null, planType: id === 'openai' ? 'pro' : 'plus' },
          }
        : null,
    }));
    mocks.account.mockReturnValue(null);
    mocks.claude.mockReturnValue(null);
    mocks.xai.mockReturnValue(null);
    const makeProvider = (id: string): ProviderView => ({
      id,
      name: 'OpenAI',
      source: 'user',
      connected: true,
      suspended: true,
      auth: { method: 'oauth', native: 'codex' },
      access: { kind: 'subscription', product: 'ChatGPT' },
      agents: [],
      models: {},
      routing: {},
    });
    const { result, rerender } = renderHook(
      ({ id }) => useProviderSubscriptionCard(makeProvider(id)),
      { initialProps: { id: 'openai' } },
    );
    expect(result.current?.planLabel).toBe('Pro');
    rerender({ id: 'second-account' });
    expect(result.current?.planLabel).toBe('Plus');
    expect(mocks.rates).toHaveBeenLastCalledWith(true, 'second-account');
    expect(mocks.account).toHaveBeenLastCalledWith(
      undefined,
      'codex',
      'app-server',
      undefined,
      'second-account',
    );
  });
});
