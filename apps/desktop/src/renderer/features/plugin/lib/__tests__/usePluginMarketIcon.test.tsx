/**
 * Regression coverage for custom marketplace icon batching, viewport loading and cache bounds.
 * @vitest-environment jsdom
 */

import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PluginMarketItem,
  PluginMarketLocalIconRequest,
  PluginMarketLocalIconResult,
} from '../../../../../shared/pluginMarket';
import {
  __pluginMarketIconStoreStatsForTest,
  __resetPluginMarketIconStoreForTest,
  usePluginMarketIcon,
} from '../usePluginMarketIcon';

function testHex(value: string, length: number): string {
  const encoded = [...value]
    .map((character) => character.codePointAt(0)!.toString(16).padStart(2, '0'))
    .join('');
  return (encoded || 'a').repeat(Math.ceil(length / Math.max(encoded.length, 1))).slice(0, length);
}

function testCustomIconKey(source: string, projection: string, digest: string): string {
  return `2${testHex(source, 16)}${testHex(projection, 16)}${testHex(digest, 31)}`;
}

function customItem(
  id: string,
  key?: string,
  market = 'team-lib',
  source = market,
): PluginMarketItem {
  const iconKey = key ?? testCustomIconKey(source, 'snapshot', id);
  return {
    pluginId: `custom:${market}/${id}`,
    ghostId: id,
    name: id,
    description: null,
    author: null,
    scope: 'public',
    organizationId: null,
    defaultInstall: false,
    releaseId: `custom:${market}/${id}:1.0.0`,
    version: '1.0.0',
    publishedAt: '2026-08-06T00:00:00.000Z',
    icon: null,
    customIconKey: iconKey,
    installState: 'not-installed',
    enabled: null,
    sourceType: 'local-market',
    sourceMarketName: market,
  };
}

let localIcons: ReturnType<typeof vi.fn>;

function ConsumerForSourceSplit({ item }: { item: PluginMarketItem }) {
  const icon = usePluginMarketIcon(item, { deferUntilVisible: false });
  return <span>{icon.iconDataUrl ? 'loaded' : 'pending'}</span>;
}

beforeEach(() => {
  __resetPluginMarketIconStoreForTest();
  localIcons = vi.fn();
  (window as unknown as { electronAPI: { pluginMarket: { localIcons: typeof localIcons } } })
    .electronAPI = { pluginMarket: { localIcons } };
});

afterEach(() => {
  __resetPluginMarketIconStoreForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, 'IntersectionObserver');
  Reflect.deleteProperty(window, 'electronAPI');
});

describe('usePluginMarketIcon', () => {
  it('merges same-frame consumers into one request and reuses the shared cache', async () => {
    const alpha = customItem('alpha');
    const beta = customItem('beta');
    localIcons.mockImplementation(async (requests: PluginMarketLocalIconRequest[]) =>
      requests.map(
        (request): PluginMarketLocalIconResult => ({
          ...request,
          status: 'loaded',
          dataUrl: `data:image/png;base64,${request.pluginId}`,
        }),
      ),
    );

    const first = renderHook(() => [
      usePluginMarketIcon(alpha, { deferUntilVisible: false }),
      usePluginMarketIcon(beta, { deferUntilVisible: false }),
    ]);
    await waitFor(() => expect(first.result.current.every((entry) => entry.iconDataUrl)).toBe(true));
    expect(localIcons).toHaveBeenCalledTimes(1);
    expect(localIcons.mock.calls[0]?.[0]).toEqual([
      { pluginId: alpha.pluginId, expectedIconKey: alpha.customIconKey },
      { pluginId: beta.pluginId, expectedIconKey: beta.customIconKey },
    ]);

    first.unmount();
    const cached = renderHook(() => usePluginMarketIcon(alpha, { deferUntilVisible: false }));
    expect(cached.result.current.iconDataUrl).toContain(alpha.pluginId);
    expect(localIcons).toHaveBeenCalledTimes(1);
  });

  it('falls back without IPC retries when a custom icon key is invalid', async () => {
    const item = customItem('invalid-key', '0'.repeat(64));
    const hook = renderHook(() => usePluginMarketIcon(item, { deferUntilVisible: false }));
    await act(async () => Promise.resolve());

    expect(hook.result.current.iconDataUrl).toBeUndefined();
    expect(localIcons).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('reloads cached bytes when Main publishes a new icon projection generation', async () => {
    const first = customItem('alpha', testCustomIconKey('team-source', 'projection-a', 'old'));
    const next = customItem('alpha', testCustomIconKey('team-source', 'projection-b', 'new'));
    localIcons
      .mockResolvedValueOnce([
        {
          pluginId: first.pluginId,
          expectedIconKey: first.customIconKey!,
          status: 'loaded',
          dataUrl: 'data:image/png;base64,OLD',
        },
      ])
      .mockResolvedValueOnce([
        {
          pluginId: next.pluginId,
          expectedIconKey: next.customIconKey!,
          status: 'loaded',
          dataUrl: 'data:image/png;base64,NEW',
        },
      ]);

    const hook = renderHook(
      ({ item }: { item: PluginMarketItem }) =>
        usePluginMarketIcon(item, { deferUntilVisible: false }),
      { initialProps: { item: first } },
    );
    await waitFor(() => expect(hook.result.current.iconDataUrl).toContain('OLD'));
    expect(localIcons).toHaveBeenCalledTimes(1);

    hook.rerender({ item: next });
    await waitFor(() => expect(hook.result.current.iconDataUrl).toContain('NEW'));
    expect(localIcons).toHaveBeenCalledTimes(2);
    expect(localIcons.mock.calls[1]?.[0]).toEqual([
      { pluginId: next.pluginId, expectedIconKey: next.customIconKey },
    ]);
    hook.unmount();
  });

  it('does not read a card icon until its container approaches the viewport', async () => {
    let callback: IntersectionObserverCallback | null = null;
    const observe = vi.fn();
    const disconnect = vi.fn();
    class TestIntersectionObserver {
      constructor(next: IntersectionObserverCallback) {
        callback = next;
      }
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
      takeRecords = vi.fn(() => []);
      readonly root = null;
      readonly rootMargin = '240px';
      readonly thresholds = [0];
    }
    globalThis.IntersectionObserver =
      TestIntersectionObserver as unknown as typeof IntersectionObserver;
    localIcons.mockImplementation(async (requests: PluginMarketLocalIconRequest[]) =>
      requests.map(
        (request): PluginMarketLocalIconResult => ({
          ...request,
          status: 'loaded',
          dataUrl: 'data:image/png;base64,AAAA',
        }),
      ),
    );

    const item = customItem('alpha');
    const hook = renderHook(() => usePluginMarketIcon(item, { deferUntilVisible: true }));
    const target = document.createElement('span');
    act(() => hook.result.current.containerRef(target));
    await waitFor(() => expect(observe).toHaveBeenCalledWith(target));
    expect(localIcons).not.toHaveBeenCalled();

    act(() => {
      callback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    await waitFor(() => expect(hook.result.current.iconDataUrl).toContain('AAAA'));
    expect(localIcons).toHaveBeenCalledTimes(1);
    hook.unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it('retries uncertain failures while visible and stops once bytes load', async () => {
    vi.useFakeTimers();
    const item = customItem('alpha');
    localIcons
      .mockResolvedValueOnce([
        {
          pluginId: item.pluginId,
          expectedIconKey: item.customIconKey!,
          status: 'retryable',
        },
      ])
      .mockResolvedValueOnce([
        {
          pluginId: item.pluginId,
          expectedIconKey: item.customIconKey!,
          status: 'loaded',
          dataUrl: 'data:image/png;base64,AAAA',
        },
      ]);

    const hook = renderHook(() => usePluginMarketIcon(item, { deferUntilVisible: false }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(localIcons).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(localIcons).toHaveBeenCalledTimes(2);
    expect(hook.result.current.iconDataUrl).toContain('AAAA');
  });

  it('serializes batches so one source discovery finishes before the next batch starts', async () => {
    const items = Array.from({ length: 17 }, (_, index) => customItem(`icon-${index}`));
    const pending: Array<{
      requests: PluginMarketLocalIconRequest[];
      resolve: (results: PluginMarketLocalIconResult[]) => void;
    }> = [];
    localIcons.mockImplementation(
      (requests: PluginMarketLocalIconRequest[]) =>
        new Promise<PluginMarketLocalIconResult[]>((resolve) => {
          pending.push({ requests, resolve });
        }),
    );

    function Consumer({ item }: { item: PluginMarketItem }) {
      const icon = usePluginMarketIcon(item, { deferUntilVisible: false });
      return <span data-testid="serialized-icon">{icon.iconDataUrl ? 'loaded' : 'pending'}</span>;
    }

    const view = render(
      <>
        {items.map((item) => (
          <Consumer key={item.pluginId} item={item} />
        ))}
      </>,
    );
    await waitFor(() => expect(localIcons).toHaveBeenCalledTimes(1));
    const firstBatch = pending[0]!;
    expect(firstBatch.requests).toHaveLength(8);

    await act(async () => {
      firstBatch.resolve(
        firstBatch.requests.map((request) => ({
          ...request,
          status: 'loaded',
          dataUrl: 'data:image/png;base64,AAAA',
        })),
      );
    });
    await waitFor(() => expect(localIcons).toHaveBeenCalledTimes(2));
    const secondBatch = pending[1]!;
    expect(secondBatch.requests).toHaveLength(8);

    await act(async () => {
      secondBatch.resolve(
        secondBatch.requests.map((request) => ({
          ...request,
          status: 'loaded',
          dataUrl: 'data:image/png;base64,AAAA',
        })),
      );
    });
    await waitFor(() => expect(localIcons).toHaveBeenCalledTimes(3));
    const thirdBatch = pending[2]!;
    expect(thirdBatch.requests).toHaveLength(1);

    await act(async () => {
      thirdBatch.resolve(
        thirdBatch.requests.map((request) => ({
          ...request,
          status: 'loaded',
          dataUrl: 'data:image/png;base64,AAAA',
        })),
      );
    });
    await waitFor(() =>
      expect(
        screen.getAllByTestId('serialized-icon').every((node) => node.textContent === 'loaded'),
      ).toBe(true),
    );
    view.unmount();
  });

  it('does not mix different marketplace sources in one IPC batch', async () => {
    const teamItems = Array.from({ length: 5 }, (_, index) => customItem(`team-${index}`));
    const otherItems = Array.from({ length: 4 }, (_, index) =>
      customItem(`other-${index}`, undefined, 'other-market'),
    );
    const pending: Array<{
      requests: PluginMarketLocalIconRequest[];
      resolve: (results: PluginMarketLocalIconResult[]) => void;
    }> = [];
    localIcons.mockImplementation(
      (requests: PluginMarketLocalIconRequest[]) =>
        new Promise<PluginMarketLocalIconResult[]>((resolve) =>
          pending.push({ requests, resolve }),
        ),
    );

    const view = render(
      <>
        {[...teamItems, ...otherItems].map((item) => (
          <span key={item.pluginId}>
            <ConsumerForSourceSplit item={item} />
          </span>
        ))}
      </>,
    );
    await waitFor(() => expect(localIcons).toHaveBeenCalledTimes(1));
    expect(
      pending[0]!.requests.every((request) => request.pluginId.startsWith('custom:team-lib/')),
    ).toBe(true);
    await act(async () =>
      pending[0]!.resolve(
        pending[0]!.requests.map((request) => ({
          ...request,
          status: 'loaded',
          dataUrl: 'data:image/png;base64,AAAA',
        })),
      ),
    );
    await waitFor(() => expect(localIcons).toHaveBeenCalledTimes(2));
    expect(
      pending[1]!.requests.every((request) => request.pluginId.startsWith('custom:other-market/')),
    ).toBe(true);
    await act(async () =>
      pending[1]!.resolve(
        pending[1]!.requests.map((request) => ({
          ...request,
          status: 'loaded',
          dataUrl: 'data:image/png;base64,AAAA',
        })),
      ),
    );
    view.unmount();
  });

  it('releases a hung IPC batch after its timeout and ignores late results', async () => {
    vi.useFakeTimers();
    const items = [
      ...Array.from({ length: 8 }, (_, index) => customItem(`timeout-${index}`)),
      customItem('healthy-after-timeout', undefined, 'other-market'),
    ];
    localIcons
      .mockImplementationOnce(
        () => new Promise<PluginMarketLocalIconResult[]>(() => undefined),
      )
      .mockImplementation(async (requests: PluginMarketLocalIconRequest[]) =>
        requests.map(
          (request): PluginMarketLocalIconResult => ({
            ...request,
            status: 'loaded',
            dataUrl: 'data:image/png;base64,AAAA',
          }),
        ),
      );

    function Consumer({ item }: { item: PluginMarketItem }) {
      const icon = usePluginMarketIcon(item, { deferUntilVisible: false });
      return <span data-testid="timeout-icon">{icon.iconDataUrl ? 'loaded' : 'pending'}</span>;
    }

    const view = render(
      <>
        {items.map((item) => (
          <Consumer key={item.pluginId} item={item} />
        ))}
      </>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(localIcons).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(localIcons.mock.calls.length).toBeGreaterThan(1);
    expect(
      localIcons.mock.calls.slice(1).some((call) =>
        (call[0] as PluginMarketLocalIconRequest[]).some(
          (request) => request.pluginId === items[8]!.pluginId,
        ),
      ),
    ).toBe(true);
    view.unmount();
  });

  it('does not exceed the global unsettled request cap', async () => {
    vi.useFakeTimers();
    localIcons.mockImplementation(
      () => new Promise<PluginMarketLocalIconResult[]>(() => undefined),
    );
    const first = renderHook(() =>
      usePluginMarketIcon(customItem('cap-a'), { deferUntilVisible: false }),
    );
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    const second = renderHook(() =>
      usePluginMarketIcon(customItem('cap-b', undefined, 'other-market'), {
        deferUntilVisible: false,
      }),
    );
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(__pluginMarketIconStoreStatsForTest().unsettledRequests).toBe(2);
    expect(localIcons).toHaveBeenCalledTimes(2);
    first.unmount();
    second.unmount();
  });

  it('keeps one transport slot per opaque source across projection generations', async () => {
    vi.useFakeTimers();
    localIcons.mockImplementation(
      () => new Promise<PluginMarketLocalIconResult[]>(() => undefined),
    );
    const first = renderHook(() =>
      usePluginMarketIcon(
        customItem('same-source-a', testCustomIconKey('source-a', 'projection-a', 'a')),
        { deferUntilVisible: false },
      ),
    );
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(10_000));

    const second = renderHook(() =>
      usePluginMarketIcon(
        customItem('same-source-b', testCustomIconKey('source-a', 'projection-b', 'b')),
        { deferUntilVisible: false },
      ),
    );
    await act(async () => Promise.resolve());

    expect(localIcons).toHaveBeenCalledTimes(1);
    expect(__pluginMarketIconStoreStatsForTest().unsettledRequests).toBe(1);
    first.unmount();
    second.unmount();
  });

  it('does not let a hung same-name source block a replacement source', async () => {
    vi.useFakeTimers();
    localIcons.mockImplementation(
      () => new Promise<PluginMarketLocalIconResult[]>(() => undefined),
    );
    const oldSource = renderHook(() =>
      usePluginMarketIcon(
        customItem('old-source', testCustomIconKey('source-old', 'projection-a', 'a')),
        { deferUntilVisible: false },
      ),
    );
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(10_000));

    const replacement = customItem(
      'replacement-source',
      testCustomIconKey('source-new', 'projection-b', 'b'),
    );
    const nextSource = renderHook(() =>
      usePluginMarketIcon(replacement, { deferUntilVisible: false }),
    );
    await act(async () => Promise.resolve());

    expect(localIcons).toHaveBeenCalledTimes(2);
    expect(localIcons.mock.calls[1]?.[0]).toEqual([
      {
        pluginId: replacement.pluginId,
        expectedIconKey: replacement.customIconKey,
      },
    ]);
    expect(__pluginMarketIconStoreStatsForTest().unsettledRequests).toBe(2);
    oldSource.unmount();
    nextSource.unmount();
  });

  it('does not let one hung marketplace consume both transport slots', async () => {
    vi.useFakeTimers();
    let resolveHealthy: ((results: PluginMarketLocalIconResult[]) => void) | undefined;
    localIcons
      .mockImplementationOnce(() => new Promise<PluginMarketLocalIconResult[]>(() => undefined))
      .mockImplementationOnce(
        () =>
          new Promise<PluginMarketLocalIconResult[]>((resolve) => {
            resolveHealthy = resolve;
          }),
      );
    const hung = renderHook(() =>
      usePluginMarketIcon(customItem('hung-a'), { deferUntilVisible: false }),
    );
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(localIcons).toHaveBeenCalledTimes(1);

    const healthyMarketItem = customItem('healthy-b', undefined, 'other-market');
    const healthy = renderHook(() =>
      usePluginMarketIcon(healthyMarketItem, { deferUntilVisible: false }),
    );
    await act(async () => Promise.resolve());

    expect(localIcons).toHaveBeenCalledTimes(2);
    expect(localIcons.mock.calls[1]?.[0]).toEqual([
      {
        pluginId: healthyMarketItem.pluginId,
        expectedIconKey: healthyMarketItem.customIconKey,
      },
    ]);
    expect(__pluginMarketIconStoreStatsForTest().unsettledRequests).toBe(2);

    await act(async () =>
      resolveHealthy?.([
        {
          pluginId: healthyMarketItem.pluginId,
          expectedIconKey: healthyMarketItem.customIconKey!,
          status: 'loaded',
          dataUrl: `data:image/png;base64,${healthyMarketItem.pluginId}`,
        },
      ]),
    );
    expect(healthy.result.current.iconDataUrl).toContain(healthyMarketItem.pluginId);
    expect(__pluginMarketIconStoreStatsForTest().unsettledRequests).toBe(1);
    expect(localIcons).toHaveBeenCalledTimes(2);

    hung.unmount();
    healthy.unmount();
  });

  it('wakes transport-blocked icons when a slot settles without consuming retry budget', async () => {
    vi.useFakeTimers();
    const pending: Array<{
      requests: PluginMarketLocalIconRequest[];
      resolve: (results: PluginMarketLocalIconResult[]) => void;
    }> = [];
    localIcons.mockImplementation(
      (requests: PluginMarketLocalIconRequest[]) =>
        new Promise<PluginMarketLocalIconResult[]>((resolve) => {
          pending.push({ requests, resolve });
        }),
    );

    const first = renderHook(() =>
      usePluginMarketIcon(customItem('blocked-a'), { deferUntilVisible: false }),
    );
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    const second = renderHook(() =>
      usePluginMarketIcon(customItem('blocked-b', undefined, 'other-market'), {
        deferUntilVisible: false,
      }),
    );
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    const thirdItem = customItem('blocked-c', undefined, 'third-market');
    const third = renderHook(() => usePluginMarketIcon(thirdItem, { deferUntilVisible: false }));
    await act(async () => Promise.resolve());

    expect(localIcons).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(localIcons).toHaveBeenCalledTimes(2);

    first.unmount();
    second.unmount();
    await act(async () => pending[0]!.resolve([]));
    expect(localIcons).toHaveBeenCalledTimes(3);
    const recovery = pending[2]!;
    expect(recovery.requests.some((request) => request.pluginId === thirdItem.pluginId)).toBe(true);
    await act(async () =>
      recovery.resolve(
        recovery.requests.map((request) => ({
          ...request,
          status: 'loaded',
          dataUrl: `data:image/png;base64,${request.pluginId}`,
        })),
      ),
    );
    expect(third.result.current.iconDataUrl).toContain(thirdItem.pluginId);

    third.unmount();
  });

  it('bounds unmounted record metadata and cancels pending retries', async () => {
    const items = Array.from({ length: 136 }, (_, index) => customItem(`record-${index}`));
    localIcons.mockImplementation(async (requests: PluginMarketLocalIconRequest[]) =>
      requests.map(
        (request): PluginMarketLocalIconResult => ({ ...request, status: 'missing' }),
      ),
    );

    function Consumer({ item }: { item: PluginMarketItem }) {
      usePluginMarketIcon(item, { deferUntilVisible: false });
      return null;
    }

    const view = render(
      <>
        {items.map((item) => (
          <Consumer key={item.pluginId} item={item} />
        ))}
      </>,
    );
    await waitFor(() => expect(localIcons).toHaveBeenCalledTimes(17));
    await act(async () => {
      await Promise.resolve();
    });
    view.unmount();
    expect(__pluginMarketIconStoreStatsForTest().records).toBeLessThanOrEqual(128);
    __resetPluginMarketIconStoreForTest();

    vi.useFakeTimers();
    const retryItem = customItem('retry-after-unmount');
    localIcons.mockReset();
    localIcons.mockResolvedValue([
      {
        pluginId: retryItem.pluginId,
        expectedIconKey: retryItem.customIconKey!,
        status: 'retryable',
      },
    ]);
    const hook = renderHook(() => usePluginMarketIcon(retryItem, { deferUntilVisible: false }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(localIcons).toHaveBeenCalledTimes(1);
    hook.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(localIcons).toHaveBeenCalledTimes(1);
  });

  it('evicts unmounted image data once the shared cache exceeds its byte budget', async () => {
    const items = Array.from({ length: 25 }, (_, index) => customItem(`icon-${index}`));
    const payload = `data:image/png;base64,${'A'.repeat(700_000)}`;
    localIcons.mockImplementation(async (requests: PluginMarketLocalIconRequest[]) =>
      requests.map(
        (request): PluginMarketLocalIconResult => ({
          ...request,
          status: 'loaded',
          dataUrl: payload,
        }),
      ),
    );

    function Consumer({ item }: { item: PluginMarketItem }) {
      const icon = usePluginMarketIcon(item, { deferUntilVisible: false });
      return <span data-testid="market-icon-state">{icon.iconDataUrl ? 'loaded' : 'pending'}</span>;
    }

    const view = render(
      <>
        {items.map((item) => (
          <Consumer key={item.pluginId} item={item} />
        ))}
      </>,
    );
    await waitFor(() =>
      expect(screen.getAllByTestId('market-icon-state').every((node) => node.textContent === 'loaded')).toBe(
        true,
      ),
    );
    expect(__pluginMarketIconStoreStatsForTest().loadedDataSize).toBeGreaterThan(16 * 1024 * 1024);

    view.unmount();
    expect(__pluginMarketIconStoreStatsForTest().loadedDataSize).toBeLessThanOrEqual(
      16 * 1024 * 1024,
    );
  });
});
