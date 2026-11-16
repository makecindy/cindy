/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import type { PluginMarketItem, PluginMarketPage, PluginMarketQuery } from '../../../../shared/pluginMarket';
import type { InstalledGhost } from '../../../../shared/ghost';
import { emptyPluginBrowserCache, PluginCatalogBrowser } from '../PluginCatalogBrowser';
import { GhostPluginIcon } from '../GhostPluginIcon';

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
  // Exercise real virtual rows with a viewport; zero-size jsdom previously
  // rendered only the transient fallback and masked activation failures.
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.tagName === 'MAIN' ? 800 : 150; });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, this.tagName === 'MAIN' ? 0 : -(this.closest('main')?.scrollTop ?? 0), 800, this.offsetHeight);
  });
  vi.stubGlobal('IntersectionObserver', class {
    callback: () => void;
    constructor(callback: (entries: unknown[]) => void) { this.callback = () => callback([{ isIntersecting: true }]); }
    observe() { intersections.add(this.callback); }
    disconnect() { intersections.delete(this.callback); }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); intersections.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); readVisibleRange = undefined; });

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
function fixture(loadPage: (query: PluginMarketQuery) => Promise<PluginMarketPage>, renderItem = (item: PluginMarketItem) => <article>{item.name}</article>) {
  const cache = { current: emptyPluginBrowserCache() };
  const scroll = createRef<HTMLElement | null>();
  const view = (query = '', visible = true, scope: NonNullable<PluginMarketQuery['scope']> = 'all', revision = 'revision', installedGhosts?: InstalledGhost[], installedItems?: PluginMarketItem[], ownerKey = 'owner', reader = loadPage) => <main ref={scroll}><PluginCatalogBrowser cacheRef={cache}
    ownerKey={ownerKey} revision={revision} query={query} scope={scope} onScope={() => {}}
    visible={visible} showOrganization={false} scrollRef={scroll} loadPage={reader}
    installedGhosts={installedGhosts} installedItems={installedItems}
    renderItem={renderItem} /></main>;
  return { cache, view };
}

// Unit / user-feedback-1: the revised catalog rule excludes installed cards.
// Existing receipt coverage deliberately kept them, missing count/list parity
// when Main returns one remaining item but the refresh pins the installed one.
it('removes an installed card from warm market batches so visible cards match the count', async () => {
  let installed = false;
  const load = vi.fn(async () => ({ ...page(0, installed ? 1 : 2),
    items: installed ? [item(1)] : [item(0), item(1)] }));
  const { cache, view } = fixture(load);
  const mounted = render(view());
  await screen.findByText('Tool 0');
  installed = true;
  mounted.rerender(view('', true, 'all', 'installed', undefined, [{ ...item(0), installState: 'installed' }]));
  await act(async () => { await cache.current.refresh!({ force: true }); });
  expect(cache.current.counts?.all).toBe(1);
  expect(screen.getByText('Tool 1')).toBeTruthy();
  expect(screen.queryByText('Tool 0')).toBeNull();
  expect([...cache.current.pages.values()].flat().map(item => item.pluginId)).toEqual(['plugin-1']);
});

// Unit / user-feedback-1: a warm tab should keep its already decoded images.
// Request-count tests alone missed the visible tree being destroyed/recreated.
it('keeps warm catalog cards and decoded images mounted across tab visibility changes', async () => {
  const load = vi.fn(async () => page(0, 1));
  const { view } = fixture(load, item => <article>
    <GhostPluginIcon iconId={item.ghostId} iconName={item.name} iconDataUrl="https://icons.invalid/tool.png" />
    {item.name}
  </article>);
  const mounted = render(view());
  const card = await screen.findByText('Tool 0');
  const image = card.querySelector('img')!;
  expect(image).toBeTruthy();
  fireEvent.load(image);
  const reads = load.mock.calls.length;
  mounted.rerender(view('', false));
  mounted.rerender(view('', true));
  expect(load).toHaveBeenCalledTimes(reads);
  expect(screen.queryByText('ccAgent.common.loading')).toBeNull();
  expect(screen.getByText('Tool 0')).toBe(card);
  expect(screen.getByText('Tool 0').querySelector('img')).toBe(image);
});

// Unit regression: installation/focus refreshes discarded all loaded batches and
// the saved viewport. A two-page catalog is the smallest reproducing input.
it('keeps loaded cards and offset visible while refreshing installation or foreground metadata', async () => {
  const load = vi.fn(async (input: PluginMarketQuery) => page(Number(input.cursor ?? 0), 12));
  const { cache, view } = fixture(load);
  const mounted = render(view());
  await screen.findByText('Tool 0');
  act(() => intersections.forEach(callback => callback()));
  await waitFor(() => expect(cache.current.last).toBe(1));
  cache.current.grid.offset = 640;
  const pages = cache.current.pages;
  mounted.rerender(view('', true, 'all', 'installed-then-focused'));
  expect(cache.current.pages).toBe(pages);
  expect(cache.current.last).toBe(1);
  expect(cache.current.grid.offset).toBe(640);
  expect(screen.getByText('Tool 0')).toBeTruthy();
});

// Unit / review finding 2: the existing invalid-cursor case had only two pages.
// Nine batches and a return to page zero expose fixed-tail eviction; a failed
// background rebuild must also retain that visible page until a retry succeeds.
it('keeps the visible early batch resident through a failed and retried cursor rebuild', async () => {
  let changed = false;
  let rebuilding = false;
  let finish!: (value: PluginMarketPage) => void;
  let fail!: (error: Error) => void;
  const load = vi.fn(async (input: PluginMarketQuery) => {
    if (input.counts) return page(0, 90);
    if (changed && input.cursor && !input.cursor.startsWith('new:')) {
      rebuilding = true;
      throw new Error('[PLUGIN_LIST_CHANGED] catalog changed');
    }
    const offset = Number((input.cursor ?? '0').replace('new:', ''));
    const result = page(offset, 90);
    const next = { ...result, counts: null, nextCursor: result.nextCursor && changed ? `new:${result.nextCursor}` : result.nextCursor };
    if (rebuilding && !input.cursor) {
      rebuilding = false;
      return new Promise<PluginMarketPage>((resolve, reject) => { finish = resolve; fail = reject; });
    }
    return next;
  });
  const { cache, view } = fixture(load);
  render(view());
  await screen.findByText('Tool 0');
  for (let index = 1; index <= 8; index++) {
    await waitFor(() => expect(intersections.size).toBe(1));
    await act(async () => intersections.forEach(callback => callback()));
    await waitFor(() => expect(cache.current.last).toBe(index));
  }
  act(() => readVisibleRange?.(0, 3));
  await waitFor(() => expect(cache.current.pages.has(0)).toBe(true));
  changed = true;
  let refresh!: Promise<void>;
  await act(async () => { refresh = cache.current.refresh!({ force: true }); });
  expect(screen.getByText('Tool 0')).toBeTruthy();
  await act(async () => { fail(new Error('temporary rebuild failure')); await refresh; });
  expect(screen.getByText('Tool 0')).toBeTruthy();
  await act(async () => { refresh = cache.current.refresh!({ force: true }); });
  await act(async () => { finish({ ...page(0, 90), counts: null, nextCursor: 'new:10' }); await refresh; });
  expect(cache.current.pages.size).toBeLessThanOrEqual(6);
  expect(cache.current.pages.has(0)).toBe(true);
  expect(cache.current.last).toBe(8);
  expect(cache.current.hasNext).toBe(false);
  expect(screen.getByText('Tool 0')).toBeTruthy();
  expect(cache.current.cursors.get(1)).toBe('new:10');
});

// Unit / PR review G1: a pending first refresh page must not keep reading a
// departed filter/search/tab. Existing cases only checked late publication,
// missing the real Main/Device Link requests between pages and cursor rebuilds.
it.each([
  ['resident', 'scope'], ['rebuild', 'scope'], ['rejected', 'scope'],
  ['resident', 'query'], ['resident', 'tab'], ['resident', 'unmount'],
] as const)('stops an obsolete %s refresh after changing %s', async (phase, transition) => {
  let refreshing = false, rebuilding = false, waiting = true;
  let finish!: (value: PluginMarketPage) => void;
  const load = vi.fn(async (input: PluginMarketQuery) => {
    if (!input.counts && refreshing && input.scope === 'all' && !input.query) {
      if (phase === 'rebuild' && !rebuilding) {
        rebuilding = true;
        throw new Error('[PLUGIN_LIST_CHANGED] catalog changed');
      }
      if (!input.cursor && waiting) {
        waiting = false;
        return new Promise<PluginMarketPage>((resolve, reject) => {
          finish = value => phase === 'rejected' ? reject(new Error('[PLUGIN_LIST_CHANGED] catalog changed')) : resolve(value);
        });
      }
    }
    return page(Number(input.cursor ?? 0), 20);
  });
  const { cache, view } = fixture(load);
  const mounted = render(view());
  await screen.findByText('Tool 0');
  await waitFor(() => expect(intersections.size).toBe(1));
  await act(async () => intersections.forEach(callback => callback()));
  await waitFor(() => expect(cache.current.last).toBe(1));
  refreshing = true;
  let refresh!: Promise<void>;
  await act(async () => { refresh = cache.current.refresh!({ force: true }); });
  expect(finish).toBeTypeOf('function');
  if (transition === 'scope') {
    mounted.rerender(view('', true, 'public'));
    // Returning to the same warm cache must not revive the departed refresh.
    mounted.rerender(view());
  } else if (transition === 'query') mounted.rerender(view('changed'));
  else if (transition === 'tab') mounted.rerender(view('', false));
  else mounted.unmount();
  const reads = load.mock.calls.filter(([input]) => !input.counts && input.scope === 'all').length;
  await act(async () => { finish(page(0, 20)); await refresh; });
  expect(load.mock.calls.filter(([input]) => !input.counts && input.scope === 'all')).toHaveLength(reads);
  if (transition !== 'unmount') expect(screen.getByText('Tool 0')).toBeTruthy();
});

it('shows first-page cards without waiting for the independent count', async () => {
  const load = vi.fn((input: PluginMarketQuery) => input.counts
    ? new Promise<PluginMarketPage>(() => {})
    : Promise.resolve({ ...page(0, 1), counts: null }));
  const { view } = fixture(load);
  render(view());
  expect(await screen.findByText('Tool 0')).toBeTruthy();
});

it('removes the installed receipt immediately without waiting for a market snapshot refresh', async () => {
  const load = vi.fn(async () => page(0, 1));
  const { view } = fixture(load, item => <article>{item.name}:{item.installState}</article>);
  const mounted = render(view('', true, 'all', 'revision', []));
  await screen.findByText('Tool 0:not-installed');
  const ghost: InstalledGhost = { manifest: { schemaVersion: 2, id: 'tool-0', name: 'Tool 0', version: '1.0.0', kind: 'chip', entry: 'main.js' },
    dir: '/fixture/tool-0', namespace: null, enabled: true, approval: { state: 'approved', revision: 'receipt-test' },
    publishingSource: { kind: 'public-market', pluginId: 'plugin-0' } };
  mounted.rerender(view('', true, 'all', 'revision', [ghost]));
  expect(screen.queryByText('Tool 0:installed')).toBeNull();
  expect(screen.queryByText('Tool 0:not-installed')).toBeNull();
  expect(load.mock.calls).toHaveLength(2); // No snapshot/query needed for the receipt.
});

// Unit: content equality must ignore short-lived delivery addresses. The prior
// tests did not count card renders across a background catalog refresh.
it('does not render unchanged cards or signed-url renewals and renders only a changed card', async () => {
  let name = 'Tool 1', signature = 'first';
  const renderItem = vi.fn((item: PluginMarketItem) => <article>{item.name}</article>);
  const load = vi.fn(async () => ({ ...page(0, 2), items: [
    { ...item(0), usageStatistics: { usageCount: '4', asOf: signature }, icon: { sha256: 'a'.repeat(64), mimeType: 'image/png', sizeBytes: 12,
      url: `https://icons.invalid/${signature}`, expiresAt: signature } },
    { ...item(1), name },
  ] }));
  const { cache, view } = fixture(load, renderItem);
  render(view());
  await screen.findByText('Tool 0');
  await waitFor(() => expect(cache.current.refresh).toBeDefined());
  const before = renderItem.mock.calls.length;
  signature = 'second';
  await act(async () => { await cache.current.refresh!({ force: true }); });
  expect(renderItem).toHaveBeenCalledTimes(before);
  // The normal merge refreshed cached transport metadata silently; an image
  // error must still deliver those URLs to the actual rendered image.
  await act(async () => { await cache.current.refresh!({ force: true, renewIcons: true }); });
  expect(renderItem).toHaveBeenCalledTimes(before + 1);
  name = 'Changed tool';
  await act(async () => { await cache.current.refresh!({ force: true }); });
  expect(screen.getByText('Changed tool')).toBeTruthy();
  expect(renderItem).toHaveBeenCalledTimes(before + 2);
});

it('keeps visible batches while rebuilding an invalid continuation in the background', async () => {
  let changed = false;
  let release: ((page: PluginMarketPage) => void) | undefined;
  const load = vi.fn(async (input: PluginMarketQuery) => {
    if (input.counts) return page(0, 12);
    if (input.cursor === '10' && !changed) { changed = true; throw new Error('[PLUGIN_LIST_CHANGED] changed'); }
    if (changed && !input.cursor) return new Promise<PluginMarketPage>(resolve => { release = resolve; });
    return page(Number(input.cursor ?? 0), 12);
  });
  const { cache, view } = fixture(load);
  render(view());
  await screen.findByText('Tool 0');
  act(() => intersections.forEach(callback => callback()));
  await waitFor(() => expect(release).toBeDefined());
  expect(screen.getByText('Tool 0')).toBeTruthy();
  await act(async () => { release!(page(0, 12)); });
  await waitFor(() => expect(cache.current.last).toBe(1));
  expect(cache.current.pages.size).toBe(2);
  expect(cache.current.error).toBeNull();
});

it('updates source group headings together with refreshed custom cards', async () => {
  let middleSource = 'Source A';
  const load = vi.fn(async () => ({ ...page(0, 3),
    customSourceNames: ['Source A', 'Source B', 'Source C'],
    items: [item(0), item(1), item(2)].map((item, index) => ({ ...item,
      sourceType: 'git-market' as const, sourceMarketName: index === 2 ? 'Source B' : index === 1 ? middleSource : 'Source A' })),
  }));
  const { cache, view } = fixture(load);
  render(view('', true, 'custom'));
  await screen.findByRole('heading', { name: 'Source B' });
  expect(screen.queryByRole('heading', { name: 'Source C' })).toBeNull();
  middleSource = 'Source C';
  await act(async () => { await cache.current.refresh!({ force: true }); });
  expect(screen.getByRole('heading', { name: 'Source C' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Source B' })).toBeTruthy();
});

it.each(['unknown', 'failed'])('throttles %s counts across tab and scope switches', async state => {
  const load = vi.fn(async (input: PluginMarketQuery) => {
    if (state === 'failed' && input.counts) throw new Error('count unavailable');
    return { ...page(0, 1), counts: null };
  });
  const { view } = fixture(load);
  const mounted = render(view());
  await screen.findByText('Tool 0');
  mounted.rerender(view('', false));
  mounted.rerender(view('', true));
  mounted.rerender(view('', true, 'public'));
  await screen.findByText('Tool 0');
  expect(load.mock.calls.filter(([input]) => input.counts === true)).toHaveLength(1);
});

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
  expect(load).toHaveBeenCalledTimes(2); // Items and independent counts; no reread on return.
});

// Unit regression: ordinary browsing showed installed plugins because only search
// requested exclusion. Existing paging tests returned only uninstalled fixtures.
// Two installed states and one source conflict exercise visible results and counts.
it.each(['', 'Tool'])('excludes installed plugins and updates from the market for query "%s", retaining conflicts', async query => {
  vi.useFakeTimers();
  const installed = [
    { ...item(0), installState: 'installed' as const },
    { ...item(1), installState: 'update-available' as const },
  ];
  const available = [item(2), { ...item(3), installState: 'conflict' as const }];
  const load = vi.fn(async (input: PluginMarketQuery) => {
    const items = input.excludeInstalled ? available : [...installed, ...available];
    return { ...page(0, 4), items, nextCursor: null,
      counts: { all: items.length, public: items.length, organization: 0, personal: 0, custom: 0 } };
  });
  const { cache, view } = fixture(load);
  render(view(query));
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  expect(screen.queryByText('Tool 0')).toBeNull();
  expect(screen.queryByText('Tool 1')).toBeNull();
  expect(screen.getByText('Tool 2')).toBeTruthy();
  expect(screen.getByText('Tool 3')).toBeTruthy();
  expect(cache.current.counts).toMatchObject({ all: 2, public: 2 });
  expect(load).toHaveBeenCalledTimes(2);
});

it('reuses search-wide counts across source filters and recounts for a new search', async () => {
  const load = vi.fn(async (query: PluginMarketQuery) => ({ ...page(0), counts: query.counts === false ? null : page(0).counts }));
  const { cache, view } = fixture(load);
  const mounted = render(view());
  await screen.findByText('Tool 0');
  mounted.rerender(view('', true, 'public'));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'public', counts: false }));
  expect(cache.current.counts?.all).toBe(120);
  mounted.rerender(view('new search', true, 'public'));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(5));
  expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'new search', counts: true }));
});

it('reads only the first page, advances at the sentinel and retains at most six batches', async () => {
  // Compact viewport: one visible row plus the grid's two overscan rows.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(150);
  const load = vi.fn(async (query: PluginMarketQuery) => ({ ...page(Number(query.cursor ?? 0), 100_000),
    ...(query.counts === false ? { counts: null } : {}) }));
  const { cache, view } = fixture(load);
  render(view());
  await screen.findByText('Tool 0');
  expect(load).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenCalledWith(expect.objectContaining({ limit: 10, cursor: null, counts: false }));
  expect(cache.current.counts?.all).toBe(100_000);
  expect(screen.getAllByRole('article').length).toBeLessThanOrEqual(6);
  for (let index = 1; index <= 7; index++) {
    // Move the real viewport with each batch; a visible first page must not be evicted.
    fireEvent.scroll(screen.getByRole('main'), { target: { scrollTop: index * 750 } });
    act(() => intersections.forEach(callback => { callback(); callback(); }));
    await waitFor(() => expect(cache.current.last).toBe(index));
  }
  expect(load).toHaveBeenCalledTimes(9);
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

it('coalesces queued item searches while counts run independently', async () => {
  vi.useFakeTimers();
  const responses = new Map<string, (page: PluginMarketPage) => void>();
  const load = vi.fn((query: PluginMarketQuery) => query.counts ? Promise.resolve(page(0, 1))
    : new Promise<PluginMarketPage>(resolve => responses.set(query.query ?? '', resolve)));
  const itemReads = () => load.mock.calls.filter(([input]) => input.counts === false);
  const { view } = fixture(load);
  const mounted = render(view('old'));
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(responses.has('old')).toBe(true);
  mounted.rerender(view('intermediate'));
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(itemReads()).toHaveLength(1);
  mounted.rerender(view('new'));
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(itemReads()).toHaveLength(1);
  await act(async () => { responses.get('old')!({ ...page(0, 1), items: [{ ...item(0), name: 'Old result' }] }); });
  expect(responses.has('intermediate')).toBe(false);
  expect(responses.has('new')).toBe(true);
  expect(itemReads()).toHaveLength(2);
  await act(async () => { responses.get('new')!({ ...page(0, 1), items: [{ ...item(1), name: 'New result' }] }); });
  expect(screen.queryByText('Old result')).toBeNull();
  expect(screen.getByText('New result')).toBeTruthy();
  expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'new', excludeInstalled: true }));
});

it('reads the current query when returning to it while its obsolete request is still pending', async () => {
  vi.useFakeTimers();
  const responses: Array<(page: PluginMarketPage) => void> = [];
  const load = vi.fn((query: PluginMarketQuery) => query.counts ? Promise.resolve(page(0, 1))
    : new Promise<PluginMarketPage>(resolve => responses.push(resolve)));
  const itemReads = () => load.mock.calls.filter(([input]) => input.counts === false);
  const { cache, view } = fixture(load);
  const mounted = render(view('same'));
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  mounted.rerender(view('other'));
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  mounted.rerender(view('same'));
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(itemReads()).toHaveLength(1);
  await act(async () => { responses[0](page(0, 1)); });
  expect(itemReads()).toHaveLength(2);
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
  expect(load).toHaveBeenCalledTimes(3);
});

// Unit / round-5: switching a source discarded the only warm cache. Hold the
// first unseen source response, then return through warm sources without reads
// or card renders; the visible DOM must stay usable throughout the wait.
it('keeps cards while a source loads and reuses unchanged warm source cards', async () => {
  let finish!: (value: PluginMarketPage) => void;
  const load = vi.fn((input: PluginMarketQuery) => input.scope === 'public'
    ? new Promise<PluginMarketPage>(resolve => { finish = resolve; }) : Promise.resolve(page(0, 2)));
  const rendered = vi.fn((row: PluginMarketItem) => <article>{row.name}</article>);
  const { cache, view } = fixture(load, rendered);
  const mounted = render(view());
  const original = await screen.findByText('Tool 0');
  await act(async () => {});
  vi.useFakeTimers();
  mounted.rerender(view('', true, 'public'));
  expect(screen.queryByText('Tool 0')).toBe(original);
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(screen.getByText('Tool 0')).toBe(original);
  expect(screen.getByText('ccAgent.common.loading')).toBeTruthy();
  await act(async () => { finish(page(0, 2)); });
  expect(screen.getByText('Tool 0')).toBe(original);
  expect(screen.queryByText('ccAgent.common.loading')).toBeNull();
  const reads = load.mock.calls.length, renders = rendered.mock.calls.length;
  for (const scope of ['all', 'public', 'all', 'public'] as const) {
    mounted.rerender(view('', true, scope));
    expect(screen.getByText('Tool 0')).toBe(original);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  }
  expect(load).toHaveBeenCalledTimes(reads);
  expect(rendered).toHaveBeenCalledTimes(renders);
  expect(cache.current.pages.size).toBe(1);
});

// Unit / round-5: retained variants must be bounded and must never publish
// another owner's cards. Exercise real switching rather than a map helper.
it('evicts the least recently used source after four keys and isolates a new owner', async () => {
  const load = vi.fn(async (input: PluginMarketQuery) => page(Number(input.cursor ?? 0), 1));
  const { cache, view } = fixture(load);
  const mounted = render(view()); await screen.findByText('Tool 0');
  await act(async () => {});
  vi.useFakeTimers();
  for (const scope of ['public', 'organization', 'custom', 'all'] as const) {
    mounted.rerender(view('', true, scope));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByText('Tool 0')).toBeTruthy();
    expect(cache.current.variants!.size).toBeLessThanOrEqual(4);
  }
  const beforeWarm = load.mock.calls.length;
  mounted.rerender(view('', true, 'public')); await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(load).toHaveBeenCalledTimes(beforeWarm);
  mounted.rerender(view('Tool', true, 'all'));
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(load.mock.calls.some(([input]) => input.query === 'Tool')).toBe(true);
  const beforeEvicted = load.mock.calls.length;
  mounted.rerender(view('', true, 'organization'));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(load.mock.calls.length).toBeGreaterThan(beforeEvicted);
  mounted.rerender(view('', true, 'all', 'revision', undefined, undefined, 'another-owner', () => new Promise<PluginMarketPage>(() => {})));
  expect(screen.queryByText('Tool 0')).toBeNull();
});

// Unit / round-5: a source may change while its shared count is in flight.
// A failed first read must retain usable cards, and resolving that same count
// must populate the active filter rather than suppress it for thirty seconds.
it('keeps usable cards on a failed source and shares its pending count across sources', async () => {
  let counts!: (value: PluginMarketPage) => void;
  const load = vi.fn((input: PluginMarketQuery) => input.counts
    ? new Promise<PluginMarketPage>(resolve => { counts = resolve; })
    : input.scope === 'public' ? Promise.reject(new Error('temporary source failure'))
      : Promise.resolve({ ...page(0, 1), counts: null }));
  const { cache, view } = fixture(load);
  const mounted = render(view()); const original = await screen.findByText('Tool 0');
  await waitFor(() => expect(counts).toBeDefined());
  vi.useFakeTimers(); mounted.rerender(view('', true, 'public'));
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(screen.getByText('Tool 0')).toBe(original);
  expect(screen.getByRole('button', { name: 'commonUi.retry' })).toBeTruthy();
  expect(screen.queryByText('ccAgent.common.loading')).toBeNull();
  await act(async () => { counts(page(0, 1)); });
  expect(cache.current.counts?.all).toBe(1);
  expect(load.mock.calls.filter(([input]) => input.counts)).toHaveLength(1);
});
