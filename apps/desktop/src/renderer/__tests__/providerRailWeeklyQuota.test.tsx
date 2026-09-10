// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';

const reads = vi.hoisted(() => ({ codex: vi.fn(), claude: vi.fn(), xai: vi.fn() }));
vi.mock('@/hooks/useCodexRateLimits', () => ({ useCodexRateLimits: reads.codex }));
vi.mock('@/hooks/useClaudeSubscriptionUsage', () => ({ useClaudeSubscriptionUsage: reads.claude }));
vi.mock('@/hooks/useXaiSubscriptionUsage', () => ({ useXaiSubscriptionUsage: reads.xai }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: { percent?: number }) =>
      key === 'quotaCard.remainingPercent' ? `剩余 ${args?.percent}%` : key,
    i18n: { language: 'en' },
  }),
}));
import { UnifiedModelRail } from '@/components/new-chat/UnifiedModelRail';
import {
  codexWeeklyQuota,
  weeklyQuota,
  providerWeeklyQuotaSource,
} from '@/components/new-chat/useProviderWeeklyQuota';

const provider = (id: string, extra: Partial<ProviderView> = {}): ProviderView => ({
  id,
  name: id,
  source: 'builtin',
  auth: { method: 'oauth' },
  access: { kind: 'subscription', product: 'test' },
  connected: true,
  agents: [],
  routing: {},
  models: {},
  ...extra,
});
const snapshot = (used: number): MobileCodexRateLimitsResult => ({
  account: { email: null, accountId: null, planType: null },
  rateLimits: {
    primary: { usedPercent: 10, windowMinutes: 300 },
    secondary: { usedPercent: used, windowMinutes: 10080 },
  },
  rateLimitsByLimitId: null,
  rateLimitResetCredits: null,
  resetOffer: null,
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('provider weekly quota identity and windows', () => {
  it('selects only the weekly generic bucket, not the latest promotion or short window', () => {
    const data = snapshot(79);
    expect(codexWeeklyQuota(data, Date.now())?.usedPercent).toBe(79);
    data.rateLimitsByLimitId = {
      promo: { limitId: 'promo', secondary: { usedPercent: 0, windowMinutes: 10080 } },
      codex: data.rateLimits,
    };
    expect(codexWeeklyQuota(data, Date.now())?.usedPercent).toBe(79);
    delete data.rateLimitsByLimitId.codex;
    expect(codexWeeklyQuota(data, Date.now())).toBeNull();
    data.rateLimitsByLimitId = {};
    expect(codexWeeklyQuota(data, Date.now())).toBeNull();
    data.rateLimitsByLimitId = null;
    data.rateLimits.secondary!.windowMinutes = 1440;
    expect(codexWeeklyQuota(data, Date.now())).toBeNull();
    data.rateLimits.primary = { usedPercent: 32, windowMinutes: 10080 };
    expect(codexWeeklyQuota(data, Date.now())?.usedPercent).toBe(32);
  });
  it('does not turn missing, invalid or expired values into full quota', () => {
    for (const used of [null, undefined, NaN, Infinity, '20'])
      expect(weeklyQuota(used, null, 10000)).toBeNull();
    expect(weeklyQuota(0, 10, 10000)).toBeNull();
    expect(weeklyQuota(150, 11, 10000)?.usedPercent).toBe(100);
    expect(weeklyQuota(-10, 11, 10000)?.usedPercent).toBe(0);
  });
  it('scopes native account usage to eligible connections, never same-brand API duplicates', () => {
    expect(providerWeeklyQuotaSource(provider('openai'))).toBe('codex');
    expect(
      providerWeeklyQuotaSource(
        provider('account-b', { source: 'user', auth: { method: 'oauth', native: 'codex' } }),
      ),
    ).toBe('codex');
    expect(providerWeeklyQuotaSource(provider('anthropic'))).toBe('claude');
    expect(providerWeeklyQuotaSource(provider('xai'))).toBe('xai');
    for (const p of [
      provider('openai', { connected: false }),
      provider('openai', { suspended: true }),
      provider('openai', { auth: { method: 'apiKey' } }),
      provider('openai', { openAiAccount: { source: 'local', reconnectRequired: true } }),
      provider('custom-xai'),
      provider('custom-anthropic'),
    ])
      expect(providerWeeklyQuotaSource(p)).toBeNull();
  });
});

describe('provider rail weekly remaining bars', () => {
  it('keeps two OpenAI accounts separate, preserves selection and updates remaining including zero', () => {
    let usedB = 79;
    reads.codex.mockImplementation((enabled, id) => ({
      snapshot: enabled ? snapshot(id === 'openai' ? 32 : usedB) : null,
    }));
    reads.claude.mockReturnValue(null);
    reads.xai.mockReturnValue(null);
    const providers = [
      provider('openai'),
      provider('second', { source: 'user', auth: { method: 'oauth', native: 'codex' } }),
    ];
    const onSelect = vi.fn();
    const props = {
      items: providers.map((p) => ({ kind: 'provider' as const, providerId: p.id })),
      active: { kind: 'all' as const },
      providers,
      providerLabel: (id: string) => `OpenAI ${id}`,
      onSelect,
      localProviderUsage: true,
    };
    const { container, rerender } = render(<UnifiedModelRail {...props} />);
    expect(
      [...container.querySelectorAll('[data-weekly-remaining]')].map((el) =>
        el.getAttribute('data-weekly-remaining'),
      ),
    ).toEqual(['68', '21']);
    const second = screen.getByRole('button', { name: 'OpenAI second' });
    expect(second.getAttribute('aria-description')).toContain('剩余 21%');
    fireEvent.click(second);
    expect(onSelect).toHaveBeenCalledWith({ kind: 'provider', providerId: 'second' });
    usedB = 100;
    rerender(<UnifiedModelRail {...props} />);
    expect(second.querySelector('[data-weekly-remaining="0"] span')?.getAttribute('style')).toBe(
      'width: 0%;',
    );
    expect(reads.codex).toHaveBeenCalledWith(true, 'second');
  });
  it('uses Claude account weekly quota and hides expired xAI quota', () => {
    reads.codex.mockReturnValue({ snapshot: null });
    reads.claude.mockImplementation((enabled) =>
      enabled ? { fiveHour: { utilization: 95 }, sevenDay: { utilization: 40 } } : null,
    );
    let expired = false;
    reads.xai.mockImplementation((enabled) =>
      enabled
        ? {
            creditUsagePercent: 96,
            updatedAt: Date.now(),
            resetsAt: Date.now() / 1000 + (expired ? -1 : 100),
          }
        : null,
    );
    const providers = [provider('anthropic'), provider('xai')];
    const props = {
      items: providers.map((p) => ({ kind: 'provider' as const, providerId: p.id })),
      active: { kind: 'all' as const },
      providers,
      providerLabel: (id: string) => id,
      onSelect: () => {},
      localProviderUsage: true,
    };
    const { container, rerender } = render(<UnifiedModelRail {...props} />);
    expect(
      [...container.querySelectorAll('[data-weekly-remaining]')].map((el) =>
        el.getAttribute('data-weekly-remaining'),
      ),
    ).toEqual(['60', '4']);
    expired = true;
    rerender(<UnifiedModelRail {...props} />);
    expect(container.querySelectorAll('[data-weekly-remaining]')).toHaveLength(1);
  });
  it('does not read local quotas for remote directories', () => {
    render(
      <UnifiedModelRail
        items={[{ kind: 'provider', providerId: 'openai' }]}
        active={{ kind: 'all' }}
        providers={[provider('openai')]}
        providerLabel={(id) => id}
        onSelect={() => {}}
        localProviderUsage={false}
      />,
    );
    expect(reads.codex).not.toHaveBeenCalled();
    expect(reads.claude).not.toHaveBeenCalled();
    expect(reads.xai).not.toHaveBeenCalled();
  });
});
