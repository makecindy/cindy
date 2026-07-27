// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTranslation } from 'react-i18next';

import enCommon from '../i18n/locales/en/common.json';
import koCommon from '../i18n/locales/ko/common.json';
import type { ClaudeSubscriptionUsageSnapshot } from '../hooks/useClaudeSubscriptionUsage';

const mocks = vi.hoisted(() => ({
  useClaudeSubscriptionUsage: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: vi.fn(),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ text, children }: { text: React.ReactNode; children: React.ReactElement }) => (
    <>
      {children}
      <div data-testid="usage-tooltip">{text}</div>
    </>
  ),
}));

vi.mock('@/hooks/useApiKey', () => ({
  useApiKey: () => ({ hasSavedKey: false, isReconciling: false }),
}));
vi.mock('@/hooks/useClaudeOAuthConnected', () => ({
  useClaudeOAuthConnected: () => true,
}));
vi.mock('@/hooks/useClaudeSessionRoute', () => ({
  useClaudeSessionRoute: () => null,
}));
vi.mock('@/hooks/useSessionSpend', () => ({
  useSessionSpend: () => null,
}));
vi.mock('@/hooks/useSessionEstimatedValue', () => ({
  useSessionEstimatedValue: () => null,
}));
vi.mock('@/hooks/useSessionTokens', () => ({
  useSessionTokens: () => null,
}));
vi.mock('@/components/chat/ChatDisplaySnapshotContext', () => ({
  useChatDisplaySnapshot: () => null,
}));
vi.mock('@/hooks/useAccountUsage', () => ({
  requestCodexAccountRefresh: vi.fn(),
  useAccountUsage: () => null,
}));
vi.mock('@/hooks/useClaudeAccountUsage', () => ({
  useClaudeAccountUsage: () => null,
}));
vi.mock('@/hooks/useClaudeSubscriptionUsage', () => ({
  requestClaudeSubscriptionRefresh: vi.fn(),
  useClaudeSubscriptionUsage: mocks.useClaudeSubscriptionUsage,
}));
vi.mock('@/hooks/useCodexRuntimeRoute', () => ({
  useCodexRuntimeRoute: () => ({ authInjection: null }),
}));
vi.mock('@/hooks/useXaiRateLimit', () => ({
  useXaiRateLimit: () => null,
}));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    getSnapshot: () => ({ messages: [] }),
    subscribe: () => () => {},
  },
}));
vi.mock('../components/status/quotaResetRollup', () => ({
  RESET_PENDING_MAX_MS: 10 * 60_000,
  computeCountdownTickDelayMs: () => 60_000,
  useQuotaResetRollup: (
    slot: { remainingPercent: number } | null,
  ) => slot ? { percent: slot.remainingPercent, celebrating: false } : null,
}));
vi.mock('../components/status/QuotaResetConfetti', () => ({
  QuotaResetConfetti: () => null,
}));

import { TodaySpendChip } from '../components/status/TodaySpendChip';

type LocaleCatalog = Record<string, unknown>;

function readCatalogValue(catalog: LocaleCatalog, key: string): string {
  const value = key.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, catalog);
  if (typeof value !== 'string') throw new Error(`Missing test translation: ${key}`);
  return value;
}

function makeTranslator(catalog: LocaleCatalog) {
  return (key: string, values?: Record<string, unknown>): string =>
    readCatalogValue(catalog, key).replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
      String(values?.[name] ?? ''),
    );
}

// 选择 UTC / Asia-Shanghai 下都不会跨天的时刻,让 resetAt 稳定走“当天只显时分”分支。
const NOW_MS = Date.parse('2026-07-25T08:00:00.000Z');
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const RESET_AT_SECONDS = Math.floor((NOW_MS + FIVE_HOURS_MS) / 1000);

function usageSnapshot(): ClaudeSubscriptionUsageSnapshot {
  return {
    subscriptionType: 'pro',
    fiveHour: { utilization: 5, resetsAt: RESET_AT_SECONDS },
    sevenDay: { utilization: 25, resetsAt: RESET_AT_SECONDS },
    scoped: [{
      modelDisplayName: 'Fable',
      utilization: 25,
      resetsAt: RESET_AT_SECONDS,
    }],
  };
}

function renderClaudeUsage(catalog: LocaleCatalog) {
  vi.mocked(useTranslation).mockReturnValue({
    t: makeTranslator(catalog),
  } as never);
  mocks.useClaudeSubscriptionUsage.mockReturnValue(usageSnapshot());
  render(
    <TodaySpendChip
      vendorKey="cc"
      providerId="anthropic"
      modelId="claude-fable"
    />,
  );
}

describe('TodaySpendChip Claude subscription presentation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('keeps stable chip identities and renders complete reset details in the tooltip', () => {
    renderClaudeUsage(enCommon);

    expect(screen.getByText('5h 95% left')).toBeTruthy();
    expect(screen.getByText('Fable weekly 75% left')).toBeTruthy();

    const resetAt = new Date(RESET_AT_SECONDS * 1000).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
    const tooltipText = screen.getByTestId('usage-tooltip').textContent;
    expect(tooltipText).toContain(
      `Weekly 75% left (25% used) · resets in 5h (${resetAt})`,
    );
    expect(tooltipText).toContain(
      `Fable weekly 75% left (25% used) · resets in 5h (${resetAt})`,
    );
  });

  it('keeps a space before the Korean reset-time parenthesis', () => {
    renderClaudeUsage(koCommon);

    const resetAt = new Date(RESET_AT_SECONDS * 1000).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
    expect(screen.getByTestId('usage-tooltip').textContent).toContain(
      `재설정 (${resetAt})`,
    );
  });
});
