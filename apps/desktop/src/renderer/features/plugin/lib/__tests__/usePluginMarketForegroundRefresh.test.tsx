/**
 * Regression coverage for foreground market refresh deduplication and outage throttling.
 * @vitest-environment jsdom
 */

import { act, fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usePluginMarketForegroundRefresh } from '../usePluginMarketForegroundRefresh';

function Harness({ refresh }: { refresh: () => void | Promise<void> }) {
  const lastRefreshAtRef = useRef(0);
  usePluginMarketForegroundRefresh(refresh, lastRefreshAtRef);
  return null;
}

async function flushForegroundEvent(target: Window | Document, event: Event): Promise<void> {
  await act(async () => {
    fireEvent(target, event);
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('usePluginMarketForegroundRefresh', () => {
  it('deduplicates paired focus and visibility events while a refresh is in flight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T00:00:00.000Z'));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    let finishRefresh: (() => void) | null = null;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    render(<Harness refresh={refresh} />);

    fireEvent.focus(window);
    fireEvent(document, new Event('visibilitychange'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishRefresh?.();
      await Promise.resolve();
    });
  });

  it('throttles repeated foreground events after a failed refresh', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T00:00:00.000Z'));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    const refresh = vi.fn().mockRejectedValue(new Error('market unavailable'));
    render(<Harness refresh={refresh} />);

    await flushForegroundEvent(window, new FocusEvent('focus'));
    await flushForegroundEvent(window, new FocusEvent('focus'));
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(29_999);
    await flushForegroundEvent(window, new FocusEvent('focus'));
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await flushForegroundEvent(window, new FocusEvent('focus'));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('does not refresh while the document is hidden', async () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    const refresh = vi.fn();
    render(<Harness refresh={refresh} />);

    await flushForegroundEvent(window, new FocusEvent('focus'));

    expect(refresh).not.toHaveBeenCalled();
  });
});
