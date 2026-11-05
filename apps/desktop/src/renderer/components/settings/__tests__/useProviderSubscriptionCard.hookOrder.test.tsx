// @vitest-environment jsdom

/**
 * Regression for the conditional-hook crash in useDeviceProviderSubscriptionCard.
 * This file deliberately leaves useProviderAccountUsage unmocked so React counts
 * its hooks; a supported -> unsupported flip must not change the hook order.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import type { ProviderView } from '@cindy/model-providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@/hooks/useClaudeSubscriptionUsage', () => ({ useClaudeSubscriptionUsage: () => null }));
vi.mock('@/hooks/useCodexRateLimits', () => ({ useCodexRateLimits: () => ({ snapshot: null }) }));
vi.mock('@/hooks/useAccountUsage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useAccountUsage')>()),
  useAccountUsage: () => null,
}));
vi.mock('@/hooks/useXaiSubscriptionUsage', () => ({
  useXaiSubscriptionUsage: () => null,
  requestXaiSubscriptionRefresh: vi.fn(),
}));
vi.mock('@/hooks/useRemoteClaudeSubscriptionUsage', () => ({
  useRemoteClaudeSubscriptionUsage: () => null,
}));
vi.mock('@/hooks/useRemoteDeviceUsage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useRemoteDeviceUsage')>()),
  useRemoteCodexAccountUsage: () => null,
  useRemoteXaiSubscriptionUsage: () => null,
}));

import { useDeviceProviderSubscriptionCard } from '../useProviderSubscriptionCard';

const invoke = vi.fn();

const opencodeProvider = (connected: boolean): ProviderView =>
  ({
    id: 'opencode-go',
    name: 'OpenCode Go',
    source: 'user',
    connected,
    auth: { method: 'api-key' },
    routing: {
      codex: { upstream: 'https://opencode.ai/zen/go/v1', authStrategy: 'api-key-header' },
    },
    opencodeGoUsageAgents: ['codex'],
  }) as unknown as ProviderView;

beforeEach(() => {
  invoke.mockReset().mockResolvedValue({
    usage: {
      rolling: { percent: 10, status: 'ok', resetsAt: null },
      weekly: { percent: 45, status: 'ok', resetsAt: null },
      monthly: { percent: 65, status: 'ok', resetsAt: null },
    },
  });
  Object.assign(window, {
    electronAPI: {
      deviceLink: { invoke, onRemotePush: () => () => {} },
      maker: { fetchProviderAccountUsage: vi.fn(), onProvidersChanged: () => () => {} },
    },
  });
});

afterEach(() => cleanup());

describe('useDeviceProviderSubscriptionCard hook order', () => {
  it('keeps hook order stable when OpenCode Go support flips after a provider change', async () => {
    const { rerender } = renderHook(
      ({ provider }: { provider: ProviderView }) =>
        useDeviceProviderSubscriptionCard(provider, 'mini'),
      { initialProps: { provider: opencodeProvider(true) } },
    );
    await act(async () => {});

    expect(() => rerender({ provider: opencodeProvider(false) })).not.toThrow();
    await act(async () => {});
  });
});
