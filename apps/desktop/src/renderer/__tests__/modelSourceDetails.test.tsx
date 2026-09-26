// @vitest-environment jsdom
import React from 'react';
import en from '../i18n/locales/en/common.json';
import zhCN from '../i18n/locales/zh-CN/common.json';
import zhTW from '../i18n/locales/zh-TW/common.json';
import ja from '../i18n/locales/ja/common.json';
import ko from '../i18n/locales/ko/common.json';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';
import type { ClaudeSubscriptionUsageSnapshot } from '../../shared/claudeSubscriptionUsage';
import type { XaiSubscriptionUsageSnapshot } from '../../shared/xaiSubscriptionUsage';
import type { RateLimitSnapshot } from '@/hooks/useAccountUsage';

const reads = vi.hoisted(() => ({
  pendingLabel: '',
  codex: vi.fn(),
  web: vi.fn(),
  claude: vi.fn(),
  xai: vi.fn(),
  accounts: {} as Record<string, MobileCodexRateLimitsResult>,
  webSnapshot: null as RateLimitSnapshot | null,
  claudeSnapshot: null as ClaudeSubscriptionUsageSnapshot | null,
  xaiSnapshot: null as XaiSubscriptionUsageSnapshot | null,
  remoteCodex: vi.fn(),
  remoteClaude: vi.fn(),
  remoteXai: vi.fn(),
}));
vi.mock('@/hooks/useCodexRateLimits', () => ({ useCodexRateLimits: reads.codex }));
vi.mock('@/hooks/useAccountUsage', async (importActual) => ({
  ...(await importActual<typeof import('@/hooks/useAccountUsage')>()),
  useAccountUsage: reads.web,
}));
vi.mock('@/hooks/useRemoteDeviceUsage', () => ({
  useRemoteCodexAccountUsage: reads.remoteCodex,
  useRemoteXaiSubscriptionUsage: reads.remoteXai,
}));
vi.mock('@/hooks/useRemoteClaudeSubscriptionUsage', () => ({
  useRemoteClaudeSubscriptionUsage: reads.remoteClaude,
}));
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
        'quotaCard.resetPending': reads.pendingLabel,
        'quotaCard.remainingPercent': `剩余 ${args?.percent}%`,
      })[key] ?? key,
  }),
}));
import {
  ModelSourceDetails,
  ModelSourceUsageProvider,
} from '@/components/new-chat/ModelSourceDetails';

const quotaText = (text: string) => (_: string, node: Element | null) =>
  node?.textContent === text &&
  !Array.from(node.children).some((child) => child.textContent === text);

const now = Date.UTC(2026, 8, 12);
const local = { deviceId: null };
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
  reads.pendingLabel = zhCN.quotaCard.resetPending;
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
  reads.remoteCodex.mockReturnValue(null);
  reads.remoteClaude.mockReturnValue(null);
  reads.remoteXai.mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('model source second line', () => {
  it('shares one reader per account across duplicate model and favorite rows', () => {
    const { container } = render(
      <ModelSourceUsageProvider
        providers={[provider('account-a'), provider('account-b')]}
        scope={local}
      >
        {details()}
        {details()}
        {details('account-b')}
      </ModelSourceUsageProvider>,
    );
    expect(screen.getAllByText(quotaText('2小时 78%'))).toHaveLength(2);
    expect(screen.getByText(quotaText('2小时 12%'))).toBeTruthy();
    expect(screen.getAllByText(quotaText('5天 42%'))).toHaveLength(3);
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
  it.each([70, 71, 89, 90, 98])('warns only on the percentage at %s percent used', (used) => {
    reads.accounts['account-a'] = snapshot(used);
    render(
      <ModelSourceUsageProvider providers={[provider('account-a')]} scope={local}>
        {details()}
      </ModelSourceUsageProvider>,
    );
    const percentage = screen.getByText(`${100 - used}%`);
    expect(percentage.className).toBe(
      used >= 90 ? 'text-[var(--quota-bar-crit)]' : used > 70 ? 'text-[var(--quota-bar-warn)]' : '',
    );
    expect(percentage.parentElement?.className).toBe('');
    expect(percentage.parentElement?.textContent).toBe(`2小时 ${100 - used}%`);
  });
  it('shows only the source when the directory may not show account usage', () => {
    render(
      <ModelSourceUsageProvider providers={[provider('account-a')]} scope={null}>
        {details()}
      </ModelSourceUsageProvider>,
    );
    expect(screen.getByText('account-a')).toBeTruthy();
    expect(reads.codex).not.toHaveBeenCalled();
    expect(reads.web).not.toHaveBeenCalled();
    expect(reads.remoteCodex).not.toHaveBeenCalled();
  });
  it('reads a remote directory from the device mirror, never this desktop', () => {
    const bucket = (limitId: string, used: number, limitName?: string) => ({
      limitId,
      limitName,
      planType: 'plus',
      primary: { usedPercent: used, windowMinutes: 300, resetsAt: now / 1000 + 7200 },
    });
    reads.remoteCodex.mockImplementation((deviceId: string | null, id: string) =>
      deviceId === 'device-1' && id === 'account-a'
        ? {
            ...bucket('codex_other', 5),
            webSnapshot: {
              source: 'openai-web',
              primary: { usedPercent: 61, resetsAt: now / 1000 + 3600 },
            },
            appServerBuckets: {
              codex: bucket('codex', 40),
              spark: bucket('spark', 90, 'GPT-5.3-Codex-Spark'),
            },
          }
        : null,
    );
    reads.remoteClaude.mockImplementation((deviceId: string | null) =>
      deviceId ? { subscriptionType: 'pro', fiveHour: { utilization: 25 } } : null,
    );
    render(
      <ModelSourceUsageProvider
        providers={[provider('account-a'), provider('claude', 'claude')]}
        scope={{ deviceId: 'device-1' }}
      >
        {details()}
        {details('account-a', 'gpt-5.3-codex-spark')}
        {details('account-a', 'chatgpt/gpt-5.6')}
        {details('claude', 'claude-opus-5')}
      </ModelSourceUsageProvider>,
    );
    expect(screen.getByText(quotaText('2小时 60%'))).toBeTruthy();
    expect(screen.getByText(quotaText('2小时 10%'))).toBeTruthy();
    expect(screen.getByText(quotaText('1小时 39%'))).toBeTruthy();
    expect(screen.getByText('claude · Pro')).toBeTruthy();
    expect(screen.getAllByText('account-a · Plus')).toHaveLength(2);
    expect(reads.remoteCodex).toHaveBeenCalledWith('device-1', 'account-a');
    expect(reads.codex.mock.calls.some(([enabled]) => enabled)).toBe(false);
    expect(reads.web.mock.calls.some(([, vendor]) => vendor === 'codex')).toBe(false);
    expect(reads.claude.mock.calls.some(([enabled]) => enabled)).toBe(false);
    expect(reads.xai.mock.calls.some(([enabled]) => enabled)).toBe(false);
  });
  it('does not borrow a native subscription for API or reconnect-required connections', () => {
    const api = { ...provider('account-a'), auth: { method: 'apiKey' as const } };
    const reconnect = {
      ...provider('account-b', 'claude'),
      subscriptionAccount: { source: 'oauth' as const, reconnectRequired: true },
    };
    render(
      <ModelSourceUsageProvider providers={[api, reconnect]} scope={local}>
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
      <ModelSourceUsageProvider providers={[provider('account-a')]} scope={local}>
        {details()}
      </ModelSourceUsageProvider>,
    );
    expect(screen.getByText(quotaText('2小时 78%'))).toBeTruthy();
    expect(screen.queryByText(quotaText('2小时 1%'))).toBeNull();
  });
  it('never falls back to Codex CLI quota for a ChatGPT bridge model', () => {
    const { rerender } = render(
      <ModelSourceUsageProvider providers={[provider('account-a')]} scope={local}>
        {details('account-a', 'chatgpt/gpt-5.6')}
      </ModelSourceUsageProvider>,
    );
    expect(screen.queryByText(quotaText('2小时 78%'))).toBeNull();
    expect(screen.getByText('account-a')).toBeTruthy();
    expect(screen.queryByText('account-a · Pro')).toBeNull();
    reads.webSnapshot = { primary: { usedPercent: 61, resetsAt: now / 1000 + 3600 } };
    rerender(
      <ModelSourceUsageProvider providers={[provider('account-a')]} scope={local}>
        {details('account-a', 'chatgpt/gpt-5.6')}
      </ModelSourceUsageProvider>,
    );
    expect(screen.getByText(quotaText('1小时 39%'))).toBeTruthy();
    expect(screen.queryByText('account-a · Pro')).toBeNull();
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
      <ModelSourceUsageProvider providers={[provider('claude', 'claude')]} scope={local}>
        {details('claude', 'claude-opus-5')}
      </ModelSourceUsageProvider>,
    );
    expect(screen.getByText('claude · Max')).toBeTruthy();
    expect(screen.getByText(quotaText('— 100%'))).toBeTruthy();
    expect(screen.getByText(quotaText('2天 20%'))).toBeTruthy();
    expect(screen.queryByText(quotaText('1天 50%'))).toBeNull();
  });
  it('shows current xAI weekly quota and hides stale values', () => {
    reads.xaiSnapshot = {
      planLabel: 'SuperGrok',
      creditUsagePercent: 36,
      resetsAt: now / 1000 + 86400,
      updatedAt: now,
    };
    const view = () => (
      <ModelSourceUsageProvider providers={[provider('xai', 'xai')]} scope={local}>
        {details('xai', 'grok-4')}
      </ModelSourceUsageProvider>
    );
    const { rerender } = render(view());
    expect(screen.getByText('xai · SuperGrok')).toBeTruthy();
    expect(screen.getByText(quotaText('1天 64%'))).toBeTruthy();
    reads.xaiSnapshot = { ...reads.xaiSnapshot, updatedAt: now - 10 * 86400000 };
    rerender(view());
    expect(screen.queryByText(quotaText('1天 64%'))).toBeNull();
  });

  it.each([en, zhCN, zhTW, ja, ko])(
    'constrains two localized pending windows and retains the full title',
    (locale) => {
      reads.pendingLabel = locale.quotaCard.resetPending;
      reads.accounts['account-a']!.rateLimits.primary!.resetsAt = now / 1000;
      reads.accounts['account-a']!.rateLimits.secondary!.resetsAt = now / 1000;
      const { container } = render(
        <ModelSourceUsageProvider providers={[provider('account-a')]} scope={local}>
          {details()}
        </ModelSourceUsageProvider>,
      );
      const line = container.querySelector('[data-model-source-details]')!;
      expect(screen.getAllByText(reads.pendingLabel)).toHaveLength(2);
      expect(line.getAttribute('title')).toBe(
        `account-a · Pro · ${reads.pendingLabel} · ${reads.pendingLabel}`,
      );
      const quota = line.lastElementChild!;
      expect(quota.className).toContain('max-w-[70%]');
      expect(quota.className).toContain('min-w-0');
      expect(quota.className).toContain('truncate');
      expect(quota.className).not.toContain('shrink-0');
    },
  );

  it('replaces an expired period with reset pending, never inferred full quota', () => {
    reads.accounts['account-a']!.rateLimits.primary!.resetsAt = now / 1000 + 1;
    render(
      <ModelSourceUsageProvider providers={[provider('account-a')]} scope={local}>
        {details()}
      </ModelSourceUsageProvider>,
    );
    expect(screen.getByText(quotaText('1秒 78%'))).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText(reads.pendingLabel)).toBeTruthy();
    expect(screen.queryByText(/100%/)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(10 * 60 * 1000);
    });
    expect(screen.queryByText(reads.pendingLabel)).toBeNull();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText('78%')).toBeNull();
  });
});
