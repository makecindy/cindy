/**
 * Regression coverage for locale-sensitive market refreshes.
 * @vitest-environment jsdom
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { usePluginMarketLocaleRefresh } from '../usePluginMarketLocaleRefresh';

describe('usePluginMarketLocaleRefresh', () => {
  it('does not duplicate the initial market load', () => {
    const refreshMarket = vi.fn();
    const refreshDetail = vi.fn();

    renderHook(({ locale }) => usePluginMarketLocaleRefresh(locale, refreshMarket, refreshDetail), {
      initialProps: { locale: 'en' },
    });

    expect(refreshMarket).not.toHaveBeenCalled();
    expect(refreshDetail).not.toHaveBeenCalled();
  });

  it('refreshes the list and open detail when the locale changes', async () => {
    const refreshMarket = vi.fn();
    const refreshDetail = vi.fn();
    const { rerender } = renderHook(
      ({ locale }) => usePluginMarketLocaleRefresh(locale, refreshMarket, refreshDetail),
      { initialProps: { locale: 'en' } },
    );

    await act(async () => {
      rerender({ locale: 'zh-CN' });
      await Promise.resolve();
    });

    expect(refreshMarket).toHaveBeenCalledTimes(1);
    expect(refreshDetail).toHaveBeenCalledTimes(1);
  });

  it('swallows refresh failures from either market request', async () => {
    const refreshMarket = vi.fn().mockRejectedValue(new Error('market unavailable'));
    const refreshDetail = vi.fn().mockRejectedValue(new Error('detail unavailable'));
    const { rerender } = renderHook(
      ({ locale }) => usePluginMarketLocaleRefresh(locale, refreshMarket, refreshDetail),
      { initialProps: { locale: 'en' } },
    );

    await act(async () => {
      rerender({ locale: 'ja' });
    });

    await waitFor(() => {
      expect(refreshMarket).toHaveBeenCalledTimes(1);
      expect(refreshDetail).toHaveBeenCalledTimes(1);
    });
  });
});
