// @vitest-environment jsdom
/**
 * 一个供应商连接的订阅额度卡按「哪台电脑 + 哪个供应商」读(供应商组展开看每台的额度用)：
 *   - deviceId 为 null 读本机账号，不读任何远端镜像；
 *   - 指定电脑时经 device-link 读那台的镜像，按那台的供应商 id 读，不借用本机同名账号；
 *   - 不是订阅类连接(API key 等)两边都不读。
 */
import { act, cleanup, renderHook } from '@testing-library/react';
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
vi.mock('@/hooks/useAccountUsage', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/hooks/useAccountUsage')>(),
  useAccountUsage: () => null,
}));
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
    ...actual,
    selectRemoteCodexAccountUsage: actual.selectRemoteCodexAccountUsage,
    useRemoteCodexAccountUsage: (...args: Parameters<typeof actual.useRemoteCodexAccountUsage>) => {
      const [deviceId, providerId] = args;
      mocks.remoteCodex.push([deviceId, providerId]);
      return actual.useRemoteCodexAccountUsage(...args);
    },
    useRemoteXaiSubscriptionUsage: (deviceId: string | null, providerId?: string) => {
      mocks.remoteXai.push([deviceId, providerId]);
      return null;
    },
  };
});

import { useDeviceProviderSubscriptionCard } from '../useProviderSubscriptionCard';
import { resetRemoteDeviceUsageMirrorsForTest } from '@/hooks/useRemoteDeviceUsage';
import { useProviderUsageSnapshots, useProviderWeeklyQuota } from '../../new-chat/useProviderWeeklyQuota';
import { matchCodexBucketForModel } from '@cindy/maker-shared/codex-usage-buckets';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { installHiddenAnimationGate } from '@/lib/hiddenAnimationGate';

function provider(id: string, auth: Record<string, unknown>): ProviderView {
  return { id, name: id, source: 'user', connected: true, auth } as unknown as ProviderView;
}
const claude = provider('anthropic-1a2b', { method: 'oauth', native: 'claude' });
const apiKey = provider('openrouter', { method: 'api-key' });
const codex = provider('openai', { method: 'oauth', native: 'codex' });
const invoke = vi.fn();
const liveQuota = (used = 42, providerId?: string) => ({
  providerId,
  account: { planType: 'pro' },
  rateLimits: { limitId: 'promo', secondary: { usedPercent: 1, windowMinutes: 10080 } },
  rateLimitsByLimitId: {
    codex: { secondary: { usedPercent: used, windowMinutes: 10080 } },
    'gpt-5.4': { limitId: 'gpt-5.4', limitName: 'GPT-5.4', secondary: { usedPercent: 7, windowMinutes: 10080 } },
  },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-27T00:00:00Z'));
  setDataOwnerGeneration('owner-a');
  resetRemoteDeviceUsageMirrorsForTest();
  invoke.mockReset().mockResolvedValue(liveQuota());
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.assign(window, { electronAPI: { deviceLink: { invoke, onRemotePush: () => () => {} } } });
  mocks.localClaude.length = 0;
  mocks.remoteClaude.length = 0;
  mocks.remoteCodex.length = 0;
  mocks.remoteXai.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const remaining = (card: ReturnType<typeof useDeviceProviderSubscriptionCard>) =>
  card?.windows.map((window) => [window.key, window.window.utilization]);

describe('useDeviceProviderSubscriptionCard', () => {
  // Unit regression: the real card hook used a day-old snapshot because remote reads
  // never reached app-server. Existing account routing mocks did not exercise IPC.
  it('reads live remote Codex quota and timestamps the generic account window', async () => {
    let finish!: (value: ReturnType<typeof liveQuota>) => void;
    invoke.mockImplementation((_device, channel) => channel === 'maker:usage:account'
      ? Promise.resolve({ secondary: { usedPercent: 99 }, webSnapshot: { source: 'openai-web', secondary: { usedPercent: 88 } } })
      : new Promise((resolve) => { finish = resolve; }));
    const startedAt = Date.now();
    const { result } = renderHook(() => ({
      card: useDeviceProviderSubscriptionCard(codex, 'mini'),
      rail: useProviderWeeklyQuota(codex, { deviceId: 'mini' }),
      models: useProviderUsageSnapshots(codex, { deviceId: 'mini' }, { web: true }),
    }));
    expect(invoke.mock.calls.filter(([, channel]) => channel === 'maker:usage:codex-rate-limits')).toEqual([
      ['mini', 'maker:usage:codex-rate-limits', ['openai']],
    ]);
    await act(async () => {});
    expect(result.current.models.codex?.web?.secondary?.usedPercent).toBe(88);
    expect(result.current.models.codex?.buckets).toBeNull();
    expect(result.current.card).toBeNull();
    await act(async () => { finish(liveQuota()); });
    expect(remaining(result.current.card)).toEqual([['secondary', 42]]);
    expect(result.current.card?.updatedAt).toBeGreaterThanOrEqual(startedAt);
    expect(result.current.rail?.usedPercent).toBe(42);
    expect(matchCodexBucketForModel(result.current.models.codex?.buckets, 'gpt-5.4')?.secondary?.usedPercent).toBe(7);
    expect(result.current.models.codex?.web?.secondary?.usedPercent).toBe(88);
  });

  it('shares one read per minute and stops when hidden, closed or unmounted', async () => {
    let nativeHidden!: (hidden: boolean) => void;
    window.electronAPI.onWindowHiddenChange = (callback) => {
      nativeHidden = callback;
      return () => {};
    };
    const disposeGate = installHiddenAnimationGate();
    const { result, rerender, unmount } = renderHook(({ open }) => ({
      card: useDeviceProviderSubscriptionCard(open ? codex : undefined, 'mini'),
      second: useDeviceProviderSubscriptionCard(open ? codex : undefined, 'mini'),
    }), { initialProps: { open: true } });
    await act(async () => {});
    invoke.mockResolvedValue(liveQuota(56));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(remaining(result.current.card)).toEqual([['secondary', 56]]);
    expect(result.current.card?.updatedAt).toBe(Date.now());
    await act(async () => { nativeHidden(true); });
    expect(document.visibilityState).toBe('visible');
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(invoke).toHaveBeenCalledTimes(2);
    await act(async () => { nativeHidden(false); });
    expect(invoke).toHaveBeenCalledTimes(3);
    act(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(invoke).toHaveBeenCalledTimes(3);
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(invoke).toHaveBeenCalledTimes(4);
    rerender({ open: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(result.current.card).toBeNull();
    await act(async () => { nativeHidden(true); });
    rerender({ open: true });
    await act(async () => {});
    expect(invoke).toHaveBeenCalledTimes(4);
    await act(async () => { nativeHidden(false); });
    expect(invoke).toHaveBeenCalledTimes(5);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(invoke).toHaveBeenCalledTimes(5);
    disposeGate();
  });

  it.each(['[CHANNEL_NOT_ALLOWED]', 'network unavailable'])('falls back to the old snapshot after %s without clearing it on failure', async (error) => {
    const updatedAt = Date.now() - 86_400_000;
    invoke.mockImplementation(async (_device, channel) => {
      if (channel === 'maker:usage:codex-rate-limits') throw new Error(error);
      return { secondary: { usedPercent: 26, windowMinutes: 10080 }, updatedAt };
    });
    const { result } = renderHook(() => useDeviceProviderSubscriptionCard(codex, 'mini'));
    await act(async () => {});
    expect(invoke).toHaveBeenLastCalledWith('mini', 'maker:usage:account', ['codex']);
    expect(remaining(result.current)).toEqual([['secondary', 26]]);
    expect(result.current?.updatedAt).toBe(updatedAt);
    invoke.mockRejectedValue(new Error('offline'));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(remaining(result.current)).toEqual([['secondary', 26]]);
    invoke.mockImplementation(async (_device, channel) => {
      if (channel === 'maker:usage:codex-rate-limits') throw new Error(error);
      return null; // The host cleared its account after logout, not a transport failure.
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(result.current).toBeNull();
  });

  it('rejects unscoped legacy replies for named accounts and keeps devices/accounts separate', async () => {
    const named = provider('openai-secondary', { method: 'oauth', native: 'codex' });
    invoke.mockImplementation(async (device, channel, [id]) => channel === 'maker:usage:account'
      ? { secondary: { usedPercent: 99, windowMinutes: 10080 } }
      : liveQuota(device === 'mini' ? 42 : 61, id === named.id ? undefined : id));
    const { result } = renderHook(() => ({
      first: useDeviceProviderSubscriptionCard(codex, 'mini'),
      other: useDeviceProviderSubscriptionCard(codex, 'other'),
      named: useDeviceProviderSubscriptionCard(named, 'mini'),
    }));
    await act(async () => {});
    expect(remaining(result.current.first)).toEqual([['secondary', 42]]);
    expect(remaining(result.current.other)).toEqual([['secondary', 61]]);
    expect(result.current.named).toBeNull();
    expect(invoke).toHaveBeenCalledWith('mini', 'maker:usage:codex-rate-limits', [named.id]);
    invoke.mockResolvedValue(liveQuota(18, named.id));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(remaining(result.current.named)).toEqual([['secondary', 18]]);
    expect(remaining(result.current.first)).toEqual([['secondary', 42]]);
  });

  it('drops old-owner results and never queries sharing devices', async () => {
    let finish!: (value: ReturnType<typeof liveQuota>) => void;
    invoke.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { result, rerender } = renderHook(({ device }) => useDeviceProviderSubscriptionCard(codex, device), {
      initialProps: { device: 'mini' },
    });
    const oldFinish = finish;
    setDataOwnerGeneration('owner-b');
    rerender({ device: 'mini' });
    await act(async () => { oldFinish(liveQuota(90)); });
    expect(result.current).toBeNull();
    await act(async () => { finish(liveQuota(15)); });
    expect(remaining(result.current)).toEqual([['secondary', 15]]);
    rerender({ device: 'share:example' });
    const count = invoke.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(invoke).toHaveBeenCalledTimes(count);
    expect(result.current).toBeNull();
  });
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
