/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import type { PluginMarketItem, PluginMarketPage, PluginMarketQuery } from '../../../../shared/pluginMarket';
import { emptyPluginBrowserCache, PluginCatalogBrowser } from '../PluginCatalogBrowser';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let readVisibleRange: ((first: number, last: number) => void) | undefined;
vi.mock('../PluginVirtualGrid', async importOriginal => {
  const actual = await importOriginal<typeof import('../PluginVirtualGrid')>();
  return { ...actual, PluginVirtualGrid: (props: Parameters<typeof actual.PluginVirtualGrid>[0]) => {
    readVisibleRange = props.onRange;
    return <actual.PluginVirtualGrid {...props} />;
  } };
});
const intersections = new Set<() => void>();
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class {
    callback: () => void;
    constructor(callback: (entries: unknown[]) => void) { this.callback = () => callback([{ isIntersecting: true }]); }
    observe() { intersections.add(this.callback); }
    disconnect() { intersections.delete(this.callback); }
  });
});
afterEach(() => { cleanup(); intersections.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); readVisibleRange = undefined; });

function item(index: number): PluginMarketItem {
  return { pluginId: `plugin-${index}`, ghostId: `tool-${index}`, name: `Tool ${index}`, description: null,
    author: null, scope: 'public', organizationId: null, defaultInstall: false, releaseId: `release-${index}`,
    version: '1.0.0', publishedAt: '2026-11-01T00:00:00Z', icon: null, installState: 'not-installed', enabled: null,
    sourceType: 'server', sourceMarketName: null };
}
function page(start: number, total = 120): PluginMarketPage {
  return { items: Array.from({ length: Math.min(10, total - start) }, (_, i) => item(start + i)),
    counts: start ? null : { all: total, public: total, organization: 0, personal: 0, custom: 0 },
    nextCursor: start + 10 < total ? String(start + 10) : null,
    customSourceNames: [], unavailableCustomSourceNames: [], unavailableReason: null };
}
function fixture(loadPage: (query: PluginMarketQuery) => Promise<PluginMarketPage>) {
  const cache = { current: emptyPluginBrowserCache() };
  const scroll = createRef<HTMLElement | null>();
  const view = (query = '', visible = true, scope: NonNullable<PluginMarketQuery['scope']> = 'all') => <main ref={scroll}><PluginCatalogBrowser cacheRef={cache}
    ownerKey="owner" revision="revision" query={query} scope={scope} onScope={() => {}}
    visible={visible} showOrganization={false} scrollRef={scroll} loadPage={loadPage}
    renderItem={item => <article>{item.name}</article>} /></main>;
  return { cache, view };
}

// Unit: bounded browser reads, stale searches and retry behavior are new contracts;
// the existing navigation suite did not exercise cursor reads or memory eviction.
it('defers the hidden market read until visible and reuses its page on later tab switches', async () => {
  vi.useFakeTimers();
  const load = vi.fn(async () => page(0, 1));
  const { view } = fixture(load);
  const mounted = render(view('', false));
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  expect(load).not.toHaveBeenCalled();
  mounted.rerender(view('', true));
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  expect(screen.getByText('Tool 0')).toBeTruthy();
  mounted.rerender(view('', false));
  mounted.rerender(view('', true));
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  expect(load).toHaveBeenCalledTimes(1);
});

it('reuses search-wide counts across source filters and recounts for a new search', async () => {
  const load = vi.fn(async (query: PluginMarketQuery) => ({ ...page(0), counts: query.counts === false ? null : page(0).counts }));
  const { cache, view } = fixture(load);
  const mounted = render(view());
  await screen.findByText('Tool 0');
  mounted.rerender(view('', true, 'public'));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'public', counts: false }));
  expect(cache.current.counts?.all).toBe(120);
  mounted.rerender(view('new search', true, 'public'));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'new search', counts: true }));
});

it('reads only the first page, advances at the sentinel and retains at most six batches', async () => {
  const load = vi.fn(async (query: PluginMarketQuery) => ({ ...page(Number(query.cursor ?? 0), 100_000),
    ...(query.counts === false ? { counts: null } : {}) }));
  const { cache, view } = fixture(load);
  render(view());
  await screen.findByText('Tool 0');
  expect(load).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 10, cursor: null }));
  expect(cache.current.counts?.all).toBe(100_000);
  expect(screen.getAllByRole('article').length).toBeLessThanOrEqual(6);
  for (let index = 1; index <= 7; index++) {
    act(() => intersections.forEach(callback => { callback(); callback(); }));
    await waitFor(() => expect(cache.current.last).toBe(index));
  }
  expect(load).toHaveBeenCalledTimes(8);
  expect(cache.current.pages.size).toBe(6);
  expect(cache.current.pages.has(0)).toBe(false);
  expect(cache.current.counts?.all).toBe(100_000);
  act(() => readVisibleRange?.(0, 3));
  await waitFor(() => expect(cache.current.pages.has(0)).toBe(true));
  expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: null, counts: false }));
  expect(cache.current.counts?.all).toBe(100_000);
});

it('renders short filtered pages contiguously after an empty page with a continuation', async () => {
  const load = vi.fn(async (query: PluginMarketQuery) => query.cursor === null
    ? { ...page(0), items: [], nextCursor: '10' }
    : { ...page(10, 12), nextCursor: null });
  const { cache, view } = fixture(load);
  render(view());
  await waitFor(() => expect(cache.current.metadata).not.toBeNull());
  act(() => intersections.forEach(callback => callback()));
  await screen.findByText('Tool 10');
  expect(screen.getByText('Tool 11')).toBeTruthy();
  expect(screen.getAllByRole('article')).toHaveLength(2);
  expect(screen.queryByText('Tool 0')).toBeNull();
});

it('coalesces queued search changes instead of running obsolete catalog counts in parallel', async () => {
  vi.useFakeTimers();
  const responses = new Map<string, (page: PluginMarketPage) => void>();
  const load = vi.fn((query: PluginMarketQuery) => new Promise<PluginMarketPage>(resolve => responses.set(query.query ?? '', resolve)));
  const { view } = fixture(load);
  const mounted = render(view('old'));
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(responses.has('old')).toBe(true);
  mounted.rerender(view('intermediate'));
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(load).toHaveBeenCalledTimes(1);
  mounted.rerender(view('new'));
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => { responses.get('old')!({ ...page(0, 1), items: [{ ...item(0), name: 'Old result' }] }); });
  expect(responses.has('intermediate')).toBe(false);
  expect(responses.has('new')).toBe(true);
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => { responses.get('new')!({ ...page(0, 1), items: [{ ...item(1), name: 'New result' }] }); });
  expect(screen.queryByText('Old result')).toBeNull();
  expect(screen.getByText('New result')).toBeTruthy();
  expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'new', excludeInstalled: true }));
});

it('reads the current query when returning to it while its obsolete request is still pending', async () => {
  vi.useFakeTimers();
  const responses: Array<(page: PluginMarketPage) => void> = [];
  const load = vi.fn(() => new Promise<PluginMarketPage>(resolve => responses.push(resolve)));
  const { cache, view } = fixture(load);
  const mounted = render(view('same'));
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  mounted.rerender(view('other'));
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  mounted.rerender(view('same'));
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => { responses[0](page(0, 1)); });
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => { responses[1](page(0, 1)); });
  expect(cache.current.counts?.all).toBe(1);
  expect(screen.getByText('Tool 0')).toBeTruthy();
});

it('retries a failed page and reuses the same query after a detail return', async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(page(0, 1));
  const { cache, view } = fixture(load);
  const mounted = render(view());
  fireEvent.click(await screen.findByRole('button', { name: 'commonUi.retry' }));
  await screen.findByText('Tool 0');
  mounted.unmount();
  render(view());
  await screen.findByText('Tool 0');
  expect(cache.current.counts?.all).toBe(1);
  expect(load).toHaveBeenCalledTimes(2);
});
