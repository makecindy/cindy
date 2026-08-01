/**
 * Regression coverage for locale-sensitive market refreshes.
 * @vitest-environment jsdom
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { usePluginMarketLocaleRefresh } from '../usePluginMarketLocaleRefresh';

describe('usePluginMarketLocaleRefresh', () => {
  it('waits for the initial main-locale sync before correcting the market load', async () => {
    let finishSync: (() => void) | undefined;
    const syncLocale = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSync = resolve;
        }),
    );
    const refreshMarket = vi.fn();
    const refreshDetail = vi.fn();

    renderHook(
      ({ locale }) =>
        usePluginMarketLocaleRefresh(locale, syncLocale, refreshMarket, refreshDetail),
      {
        initialProps: { locale: 'en' },
      },
    );

    await waitFor(() => {
      expect(syncLocale).toHaveBeenCalledWith('en');
    });
    expect(refreshMarket).not.toHaveBeenCalled();
    expect(refreshDetail).not.toHaveBeenCalled();

    await act(async () => {
      finishSync?.();
    });

    await waitFor(() => {
      expect(refreshMarket).toHaveBeenCalledTimes(1);
      expect(refreshDetail).toHaveBeenCalledTimes(1);
    });
  });

  it('waits for main to accept a changed locale before refreshing market data', async () => {
    const syncLocale = vi.fn().mockResolvedValue(undefined);
    const refreshMarket = vi.fn();
    const refreshDetail = vi.fn();
    const { rerender } = renderHook(
      ({ locale }) =>
        usePluginMarketLocaleRefresh(locale, syncLocale, refreshMarket, refreshDetail),
      { initialProps: { locale: 'en' } },
    );

    await waitFor(() => {
      expect(refreshMarket).toHaveBeenCalledTimes(1);
      expect(refreshDetail).toHaveBeenCalledTimes(1);
    });
    syncLocale.mockClear();
    refreshMarket.mockClear();
    refreshDetail.mockClear();

    await act(async () => {
      rerender({ locale: 'zh-CN' });
    });

    await waitFor(() => {
      expect(syncLocale).toHaveBeenCalledWith('zh-CN');
      expect(refreshMarket).toHaveBeenCalledTimes(1);
      expect(refreshDetail).toHaveBeenCalledTimes(1);
    });
    expect(syncLocale.mock.invocationCallOrder[0]).toBeLessThan(
      refreshMarket.mock.invocationCallOrder[0],
    );
    expect(syncLocale.mock.invocationCallOrder[0]).toBeLessThan(
      refreshDetail.mock.invocationCallOrder[0],
    );
  });

  it('swallows refresh failures from either market request', async () => {
    const syncLocale = vi.fn().mockResolvedValue(undefined);
    const refreshMarket = vi.fn().mockRejectedValue(new Error('market unavailable'));
    const refreshDetail = vi.fn().mockRejectedValue(new Error('detail unavailable'));
    const { rerender } = renderHook(
      ({ locale }) =>
        usePluginMarketLocaleRefresh(locale, syncLocale, refreshMarket, refreshDetail),
      { initialProps: { locale: 'en' } },
    );

    await waitFor(() => {
      expect(refreshMarket).toHaveBeenCalledTimes(1);
      expect(refreshDetail).toHaveBeenCalledTimes(1);
    });
    refreshMarket.mockClear();
    refreshDetail.mockClear();

    await act(async () => {
      rerender({ locale: 'ja' });
    });

    await waitFor(() => {
      expect(refreshMarket).toHaveBeenCalledTimes(1);
      expect(refreshDetail).toHaveBeenCalledTimes(1);
    });
  });
});
