// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';
import type { ClaudeSubscriptionUsageSnapshot } from '../../shared/claudeSubscriptionUsage';
import type { XaiSubscriptionUsageSnapshot } from '../../shared/xaiSubscriptionUsage';
import type { RateLimitSnapshot } from '@/hooks/useAccountUsage';

const reads = vi.hoisted(() => ({
  codex: vi.fn(),
  web: vi.fn(),
  claude: vi.fn(),
  xai: vi.fn(),
  accounts: {} as Record<string, MobileCodexRateLimitsResult>,
  webSnapshot: null as RateLimitSnapshot | null,
  claudeSnapshot: null as ClaudeSubscriptionUsageSnapshot | null,
  xaiSnapshot: null as XaiSubscriptionUsageSnapshot | null,
}));
vi.mock('@/hooks/useCodexRateLimits', () => ({ useCodexRateLimits: reads.codex }));
vi.mock('@/hooks/useAccountUsage', () => ({ useAccountUsage: reads.web }));
vi.mock('@/hooks/useClaudeSubscriptionUsage', () => ({ useClaudeSubscriptionUsage: reads.claude }));
vi.mock('@/hooks/useXaiSubscriptionUsage', () => ({ useXaiSubscriptionUsage: reads.xai }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: { percent?: number }) =>
      ({
        'todaySpend.unit.day': '天',
        'todaySpend.unit.hour': '小时',
        'todaySpend.unit.minute': '分钟',
        'todaySpend.unit.second': '秒',
        'quotaCard.resetPending': '重置中…',
        'quotaCard.remainingPercent': `剩余 ${args?.percent}%`,
      })[key] ?? key,
  }),
}));
import {
  ModelSourceDetails,
  ModelSourceUsageProvider,
} from '@/components/new-chat/ModelSourceDetails';

const now = Date.UTC(2026, 8, 12);
const provider = (id: string, native: 'codex' | 'claude' | 'xai' = 'codex'): ProviderView => ({
  id,
  name: id,
  source: 'user',
  auth: { method: 'oauth', native },
  connected: true,
  agents: [],
  routing: {},
  models: {},
  access: { kind: 'subscription', product: 'test' },
});
function snapshot(used: number): MobileCodexRateLimitsResult {
  return {
    account: { email: null, accountId: null, planType: 'pro' },
    rateLimits: {
      primary: { usedPercent: used, windowMinutes: 300, resetsAt: now / 1000 + 7200 },
      secondary: { usedPercent: 58, windowMinutes: 10080, resetsAt: now / 1000 + 5 * 86400 },
    },
    rateLimitsByLimitId: null,
    rateLimitResetCredits: null,
    resetOffer: null,
  };
}
function details(id = 'account-a', modelId = 'gpt-5.6') {
  return <ModelSourceDetails providerId={id} label={id} modelId={modelId} />;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  reads.accounts = { 'account-a': snapshot(22), 'account-b': snapshot(88) };
  reads.webSnapshot = null;
  reads.claudeSnapshot = null;
  reads.xaiSnapshot = null;
  reads.codex.mockImplementation((enabled: boolean, id: string) => ({
    snapshot: enabled ? (reads.accounts[id] ?? null) : null,
  }));
  reads.web.mockImplementation((_session, vendor) =>
    vendor === 'codex' ? reads.webSnapshot : null,
  );
  reads.claude.mockImplementation((enabled: boolean) => (enabled ? reads.claudeSnapshot : null));
  reads.xai.mockImplementation((enabled: boolean) => (enabled ? reads.xaiSnapshot : null));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('model source second line', () => {
  it('shares one reader per account across duplicate model and favorite rows', () => {
    const { container } = render(
      <ModelSourceUsageProvider providers={[provider('account-a'), provider('account-b')]} enabled>
        {details()}
        {details()}
        {details('account-b')}
      </ModelSourceUsageProvider>,
    );
    expect(screen.getAllByText('2小时 78%')).toHaveLength(2);
    expect(screen.getByText('2小时 12%')).toBeTruthy();
    expect(screen.getAllByText('5天 42%')).toHaveLength(3);
    expect(
      reads.codex.mock.calls.filter(([enabled, id]) => enabled && id === 'account-a'),
    ).toHaveLength(1);
    expect(container.querySelector('svg, [role="progressbar"]')).toBeNull();
    expect(container.textContent).not.toMatch(/5 小时|本周|剩余/);
    for (const line of container.querySelectorAll('[data-model-source-details]')) {
      expect(line.className).toContain('whitespace-nowrap');
      expect(line.querySelector('span')?.className).toContain('truncate');
    }
  });
  it('shows the source without reading local quota for a remote directory', () => {
    render(
      <ModelSourceUsageProvider providers={[provider('account-a')]} enabled={false}>
        {details()}
      </ModelSourceUsageProvider>,
    );
    expect(screen.getByText('account-a')).toBeTruthy();
    expect(reads.codex).not.toHaveBeenCalled();
    expect(reads.web).not.toHaveBeenCalled();
    expect(reads.claude).not.toHaveBeenCalled();
    expect(reads.xai).not.toHaveBeenCalled();
  });
  it('does not borrow a native subscription for API or reconnect-required connections', () => {
    const api = { ...provider('account-a'), auth: { method: 'apiKey' as const } };
    const reconnect = {
      ...provider('account-b', 'claude'),
      subscriptionAccount: { source: 'oauth' as const, reconnectRequired: true },
    };
    render(
      <ModelSourceUsageProvider providers={[api, reconnect]} enabled>
        {details()}
        {details('account-b')}
      </ModelSourceUsageProvider>,
    );
    expect(reads.codex).not.toHaveBeenCalled();
    expect(reads.claude).not.toHaveBeenCalled();
  });
  it('uses the generic Codex bucket for the matching model, not the latest promotional bucket', () => {
    const data = reads.accounts['account-a']!;
    data.rateLimitsByLimitId = {
      codex: data.rateLimits,
      promo: {
        limitId: 'promo',
        primary: { usedPercent: 99, windowMinutes: 300, resetsAt: now / 1000 + 7200 },
      },
    };
    data.rateLimits = data.rateLimitsByLimitId.promo!;
    render(
      <ModelSourceUsageProvider providers={[provider('account-a')]} enabled>
        {details()}
      </ModelSourceUsageProvider>,
    );
    expect(screen.getByText('2小时 78%')).toBeTruthy();
    expect(screen.queryByText('2小时 1%')).toBeNull();
  });
  it('never falls back to Codex CLI quota for a ChatGPT bridge model', () => {
    const { rerender } = render(
      <ModelSourceUsageProvider providers={[provider('account-a')]} enabled>
        {details('account-a', 'chatgpt/gpt-5.6')}
      </ModelSourceUsageProvider>,
    );
    expect(screen.queryByText('2小时 78%')).toBeNull();
    reads.webSnapshot = { primary: { usedPercent: 61, resetsAt: now / 1000 + 3600 } };
    rerender(
      <ModelSourceUsageProvider providers={[provider('account-a')]} enabled>
        {details('account-a', 'chatgpt/gpt-5.6')}
      </ModelSourceUsageProvider>,
    );
    expect(screen.getByText('1小时 39%')).toBeTruthy();
  });
  it('uses Claude model-scoped weekly quota and keeps unknown reset times honest', () => {
    reads.claudeSnapshot = {
      subscriptionType: 'max',
      fiveHour: { utilization: 0 },
      sevenDay: { utilization: 50, resetsAt: now / 1000 + 86400 },
      scoped: [
        {
          modelDisplayName: 'Opus',
          modelId: 'claude-opus-5',
          utilization: 80,
          resetsAt: now / 1000 + 2 * 86400,
        },
      ],
    };
    render(
      <ModelSourceUsageProvider providers={[provider('claude', 'claude')]} enabled>
        {details('claude', 'claude-opus-5')}
      </ModelSourceUsageProvider>,
    );
    expect(screen.getByText('claude · Max')).toBeTruthy();
    expect(screen.getByText('— 100%')).toBeTruthy();
    expect(screen.getByText('2天 20%')).toBeTruthy();
    expect(screen.queryByText('1天 50%')).toBeNull();
  });
  it('shows current xAI weekly quota and hides stale values', () => {
    reads.xaiSnapshot = {
      planLabel: 'SuperGrok',
      creditUsagePercent: 36,
      resetsAt: now / 1000 + 86400,
      updatedAt: now,
    };
    const view = () => (
      <ModelSourceUsageProvider providers={[provider('xai', 'xai')]} enabled>
        {details('xai', 'grok-4')}
      </ModelSourceUsageProvider>
    );
    const { rerender } = render(view());
    expect(screen.getByText('xai · SuperGrok')).toBeTruthy();
    expect(screen.getByText('1天 64%')).toBeTruthy();
    reads.xaiSnapshot = { ...reads.xaiSnapshot, updatedAt: now - 10 * 86400000 };
    rerender(view());
    expect(screen.queryByText('1天 64%')).toBeNull();
  });

  it('replaces an expired period with reset pending, never inferred full quota', () => {
    reads.accounts['account-a']!.rateLimits.primary!.resetsAt = now / 1000 + 1;
    render(
      <ModelSourceUsageProvider providers={[provider('account-a')]} enabled>
        {details()}
      </ModelSourceUsageProvider>,
    );
    expect(screen.getByText('1秒 78%')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('重置中…')).toBeTruthy();
    expect(screen.queryByText(/100%/)).toBeNull();
  });
});
