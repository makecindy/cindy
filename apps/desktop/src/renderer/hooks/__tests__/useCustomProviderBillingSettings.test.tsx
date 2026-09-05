// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const customProviderBillingGetFor = vi.fn();
let remotePushListener: ((push: { deviceId: string; channel: string }) => void) | undefined;
let presenceListener: ((snapshot: { deviceId: string; online: boolean }) => void) | undefined;
let statusListener: ((payload: { status: 'stopped' | 'connecting' | 'online' }) => void) | undefined;

vi.mock('@/lib/makerTransport', () => ({
  customProviderBillingGetFor: (...args: unknown[]) => customProviderBillingGetFor(...args),
}));

vi.mock('@/lib/customProviderBillingSettingsStore', () => ({
  getCustomProviderShowSdkCost: () => false,
  setCustomProviderShowSdkCost: vi.fn(),
  subscribeCustomProviderShowSdkCost: () => () => undefined,
}));

import {
  __resetCustomProviderBillingSettingsForTests,
  useCustomProviderBillingSettingsSnapshot,
} from '../useCustomProviderBillingSettings';

beforeEach(() => {
  __resetCustomProviderBillingSettingsForTests();
  customProviderBillingGetFor.mockReset();
  customProviderBillingGetFor.mockResolvedValue({
    showSdkCostForCustomProviders: true,
    isCustomized: true,
  });
  remotePushListener = undefined;
  presenceListener = undefined;
  statusListener = undefined;
  vi.stubGlobal('window', {
    electronAPI: {
      deviceLink: {
        onRemotePush: vi.fn((listener: typeof remotePushListener) => {
          remotePushListener = listener ?? undefined;
          return () => { remotePushListener = undefined; };
        }),
        onPresenceChanged: vi.fn((listener: typeof presenceListener) => {
          presenceListener = listener ?? undefined;
          return () => { presenceListener = undefined; };
        }),
        onStatusChanged: vi.fn((listener: typeof statusListener) => {
          statusListener = listener ?? undefined;
          return () => { statusListener = undefined; };
        }),
      },
    },
  });
});

afterEach(() => {
  __resetCustomProviderBillingSettingsForTests();
});

async function flushRequests(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useCustomProviderBillingSettingsSnapshot', () => {
  it('shares one remote read across rows for the same device', async () => {
    const first = renderHook(() => useCustomProviderBillingSettingsSnapshot('dev-1'));
    const second = renderHook(() => useCustomProviderBillingSettingsSnapshot('dev-1'));

    await flushRequests();

    expect(customProviderBillingGetFor).toHaveBeenCalledTimes(1);
    expect(first.result.current.showSdkCostForCustomProviders).toBe(true);
    expect(second.result.current.showSdkCostForCustomProviders).toBe(true);
  });

  it('does not read settings while cost metadata is disabled', async () => {
    renderHook(() => useCustomProviderBillingSettingsSnapshot('dev-1', false));
    await flushRequests();
    expect(customProviderBillingGetFor).not.toHaveBeenCalled();
  });

  it('coalesces push refreshes for all rows on a device', async () => {
    renderHook(() => useCustomProviderBillingSettingsSnapshot('dev-1'));
    renderHook(() => useCustomProviderBillingSettingsSnapshot('dev-1'));
    await flushRequests();

    await act(async () => {
      remotePushListener?.({
        deviceId: 'dev-1',
        channel: 'maker:custom-provider-billing:changed',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(customProviderBillingGetFor).toHaveBeenCalledTimes(2);
  });

  it('fails closed before refetching after the last subscriber remounts', async () => {
    const first = renderHook(() => useCustomProviderBillingSettingsSnapshot('dev-1'));
    await flushRequests();
    expect(first.result.current.showSdkCostForCustomProviders).toBe(true);
    first.unmount();

    let resolveFresh: ((value: { showSdkCostForCustomProviders: boolean; isCustomized: boolean }) => void) | undefined;
    customProviderBillingGetFor.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFresh = resolve;
    }));
    const reopened = renderHook(() => useCustomProviderBillingSettingsSnapshot('dev-1'));
    expect(reopened.result.current.showSdkCostForCustomProviders).toBe(false);

    await act(async () => {
      resolveFresh?.({ showSdkCostForCustomProviders: false, isCustomized: true });
      await Promise.resolve();
    });
    expect(reopened.result.current.showSdkCostForCustomProviders).toBe(false);
  });

  it('drops mounted snapshots immediately when the relay disconnects', async () => {
    const hook = renderHook(() => useCustomProviderBillingSettingsSnapshot('dev-1'));
    await flushRequests();
    expect(hook.result.current.showSdkCostForCustomProviders).toBe(true);

    act(() => statusListener?.({ status: 'connecting' }));
    expect(hook.result.current.showSdkCostForCustomProviders).toBe(false);
  });

  it('rejects a stale GET that finishes after presence invalidation', async () => {
    let resolveStale: ((value: { showSdkCostForCustomProviders: boolean; isCustomized: boolean }) => void) | undefined;
    customProviderBillingGetFor.mockImplementationOnce(() => new Promise((resolve) => {
      resolveStale = resolve;
    }));
    const hook = renderHook(() => useCustomProviderBillingSettingsSnapshot('dev-1'));
    expect(hook.result.current.showSdkCostForCustomProviders).toBe(false);

    act(() => presenceListener?.({ deviceId: 'dev-1', online: false }));
    await act(async () => {
      resolveStale?.({ showSdkCostForCustomProviders: true, isCustomized: true });
      await Promise.resolve();
    });
    expect(hook.result.current.showSdkCostForCustomProviders).toBe(false);
  });

  it('refetches mounted devices when the relay returns online', async () => {
    const hook = renderHook(() => useCustomProviderBillingSettingsSnapshot('dev-1'));
    await flushRequests();
    expect(hook.result.current.showSdkCostForCustomProviders).toBe(true);

    act(() => statusListener?.({ status: 'connecting' }));
    expect(hook.result.current.showSdkCostForCustomProviders).toBe(false);
    customProviderBillingGetFor.mockResolvedValueOnce({
      showSdkCostForCustomProviders: true,
      isCustomized: true,
    });
    await act(async () => {
      statusListener?.({ status: 'online' });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(customProviderBillingGetFor).toHaveBeenCalledTimes(2);
    expect(hook.result.current.showSdkCostForCustomProviders).toBe(true);
  });

  it('accepts a fresh GET after the device comes back online', async () => {
    const hook = renderHook(() => useCustomProviderBillingSettingsSnapshot('dev-1'));
    await flushRequests();
    act(() => presenceListener?.({ deviceId: 'dev-1', online: false }));
    expect(hook.result.current.showSdkCostForCustomProviders).toBe(false);

    customProviderBillingGetFor.mockResolvedValueOnce({
      showSdkCostForCustomProviders: true,
      isCustomized: true,
    });
    await act(async () => {
      presenceListener?.({ deviceId: 'dev-1', online: true });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hook.result.current.showSdkCostForCustomProviders).toBe(true);
  });
});
