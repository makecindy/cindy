// @vitest-environment jsdom
/**
 * 一个供应商连接的订阅额度卡按「哪台电脑 + 哪个供应商」读(供应商组展开看每台的额度用)：
 *   - deviceId 为 null 读本机账号，不读任何远端镜像；
 *   - 指定电脑时经 device-link 读那台的镜像，按那台的供应商 id 读，不借用本机同名账号；
 *   - 不是订阅类连接(API key 等)两边都不读。
 */
import { cleanup, renderHook } from '@testing-library/react';
import type { ProviderView } from '@cindy/model-providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const mocks = vi.hoisted(() => ({
  localClaude: [] as Array<[boolean, string]>,
  remoteClaude: [] as Array<[string | null, string | undefined]>,
  remoteCodex: [] as Array<[string | null, string | undefined]>,
  remoteXai: [] as Array<[string | null, string | undefined]>,
}));

const snapshot = (fiveHour: number) => ({
  fiveHour: { utilization: fiveHour, resetsAt: null },
  sevenDay: { utilization: 26, resetsAt: null },
  updatedAt: 1,
});

vi.mock('@/hooks/useClaudeSubscriptionUsage', () => ({
  useClaudeSubscriptionUsage: (enabled: boolean, providerId: string) => {
    mocks.localClaude.push([enabled, providerId]);
    return enabled ? snapshot(10) : null;
  },
}));
vi.mock('@/hooks/useCodexRateLimits', () => ({ useCodexRateLimits: () => ({ snapshot: null }) }));
vi.mock('@/hooks/useAccountUsage', () => ({ useAccountUsage: () => null }));
vi.mock('@/hooks/useXaiSubscriptionUsage', () => ({
  useXaiSubscriptionUsage: () => null,
  requestXaiSubscriptionRefresh: vi.fn(),
}));
vi.mock('@/hooks/useRemoteClaudeSubscriptionUsage', () => ({
  useRemoteClaudeSubscriptionUsage: (deviceId: string | null, providerId?: string) => {
    mocks.remoteClaude.push([deviceId, providerId]);
    return deviceId ? snapshot(13) : null;
  },
}));
vi.mock('@/hooks/useRemoteDeviceUsage', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useRemoteDeviceUsage')>('@/hooks/useRemoteDeviceUsage');
  return {
    selectRemoteCodexAccountUsage: actual.selectRemoteCodexAccountUsage,
    useRemoteCodexAccountUsage: (deviceId: string | null, providerId?: string) => {
      mocks.remoteCodex.push([deviceId, providerId]);
      return null;
    },
    useRemoteXaiSubscriptionUsage: (deviceId: string | null, providerId?: string) => {
      mocks.remoteXai.push([deviceId, providerId]);
      return null;
    },
  };
});

import { useDeviceProviderSubscriptionCard } from '../useProviderSubscriptionCard';

function provider(id: string, auth: Record<string, unknown>): ProviderView {
  return { id, name: id, source: 'user', connected: true, auth } as unknown as ProviderView;
}
const claude = provider('anthropic-1a2b', { method: 'oauth', native: 'claude' });
const apiKey = provider('openrouter', { method: 'api-key' });

beforeEach(() => {
  mocks.localClaude.length = 0;
  mocks.remoteClaude.length = 0;
  mocks.remoteCodex.length = 0;
  mocks.remoteXai.length = 0;
});
afterEach(() => cleanup());

const remaining = (card: ReturnType<typeof useDeviceProviderSubscriptionCard>) =>
  card?.windows.map((window) => [window.key, window.window.utilization]);

describe('useDeviceProviderSubscriptionCard', () => {
  it('reads this computer’s account when no device is given', () => {
    const { result } = renderHook(() => useDeviceProviderSubscriptionCard(claude, null));
    expect(remaining(result.current)).toEqual([['five-hour', 10], ['seven-day', 26]]);
    expect(mocks.localClaude.at(-1)).toEqual([true, 'anthropic-1a2b']);
    expect(mocks.remoteClaude.every(([deviceId]) => deviceId === null)).toBe(true);
  });

  it('reads the other computer’s account by its own provider id, never this computer’s', () => {
    const { result } = renderHook(() => useDeviceProviderSubscriptionCard(claude, 'mini'));
    expect(remaining(result.current)).toEqual([['five-hour', 13], ['seven-day', 26]]);
    expect(mocks.remoteClaude.at(-1)).toEqual(['mini', 'anthropic-1a2b']);
    expect(mocks.localClaude.every(([enabled]) => !enabled)).toBe(true);
    expect(mocks.remoteCodex.every(([deviceId]) => deviceId === null)).toBe(true);
    expect(mocks.remoteXai.every(([deviceId]) => deviceId === null)).toBe(true);
  });

  it('reads nothing for a connection without a subscription quota', () => {
    const { result } = renderHook(() => useDeviceProviderSubscriptionCard(apiKey, 'mini'));
    expect(result.current).toBeNull();
    expect(mocks.remoteClaude.every(([deviceId]) => deviceId === null)).toBe(true);
    expect(mocks.localClaude.every(([enabled]) => !enabled)).toBe(true);
  });
});
