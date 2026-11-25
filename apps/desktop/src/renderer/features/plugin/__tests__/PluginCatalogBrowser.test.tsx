/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRef, isValidElement } from 'react';
import type { PluginMarketItem, PluginMarketPage, PluginMarketQuery } from '../../../../shared/pluginMarket';
import type { InstalledGhost } from '../../../../shared/ghost';
import { emptyPluginBrowserCache, PluginCatalogBrowser } from '../PluginCatalogBrowser';
import { GhostPluginIcon } from '../GhostPluginIcon';
import type { PluginCatalogFilter } from '../lib/pluginMarketPresentation';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let readVisibleRange: ((first: number, last: number) => void) | undefined;
let renderedGrid: Parameters<typeof import('../PluginVirtualGrid').PluginVirtualGrid>[0] | undefined;
let restoredIndex: number | undefined;
vi.mock('../PluginVirtualGrid', async importOriginal => {
  const actual = await importOriginal<typeof import('../PluginVirtualGrid')>();
  return { ...actual, PluginVirtualGrid: (props: Parameters<typeof actual.PluginVirtualGrid>[0]) => {
    readVisibleRange = props.onRange;
    renderedGrid = props;
    if (props.cache?.restore?.index !== undefined) restoredIndex = props.cache.restore.index;
    return <actual.PluginVirtualGrid {...props} />;
  } };
});
const intersections = new Set<() => void>();
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); intersections.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); readVisibleRange = undefined; renderedGrid = undefined; restoredIndex = undefined; });

function item(index: number): PluginMarketItem {
  return { pluginId: `plugin-${index}`, ghostId: `tool-${index}`, name: `Tool ${index}`, description: null,
    author: null, scope: 'public', publisherKind: 'official', organizationId: null, defaultInstall: false, releaseId: `release-${index}`,
    version: '1.0.0', publishedAt: '2026-11-01T00:00:00Z', icon: null, installState: 'not-installed', enabled: null,
    sourceType: 'server', sourceMarketName: null };
}
function page(start: number, total = 120): PluginMarketPage {
  return { items: Array.from({ length: Math.min(10, total - start) }, (_, i) => item(start + i)),
    counts: start ? null : { all: total, public: total, organization: 0, personal: 0, custom: 0 },
    nextCursor: start + 10 < total ? String(start + 10) : null,
    customSourceNames: [], unavailableCustomSourceNames: [], unavailableReason: null };
}
function fixture(loadPage: (query: PluginMarketQuery) => Promise<PluginMarketPage>,
  renderItem: Parameters<typeof PluginCatalogBrowser>[0]['renderItem'] = item => <article>{item.name}</article>) {
  const cache = { current: emptyPluginBrowserCache() };
  const scroll = createRef<HTMLElement | null>();
  const view = (query = '', visible = true, scope: PluginCatalogFilter = 'all', revision = 'revision', installedGhosts?: InstalledGhost[], installedItems?: PluginMarketItem[], ownerKey = 'owner', reader = loadPage, online = true) => <main ref={scroll}><PluginCatalogBrowser cacheRef={cache}
    ownerKey={ownerKey} revision={revision} query={query} scope={scope} onScope={() => {}}
    visible={visible} showOrganization={false} scrollRef={scroll} loadPage={reader} online={online}
    installedGhosts={installedGhosts} installedItems={installedItems}
    renderItem={renderItem} /></main>;
  return { cache, view };
}

function openSourceMenu() {
  fireEvent.keyDown(screen.getByRole('combobox', { name: /^settings\.ghosts\.page\.filtersAria/ }), { key: 'ArrowDown' });
}

const sortLabel = 'settings.ghosts.page.marketSort.label';
const serverSorts = [
  { key: 'updated', label: '最近更新', metric: { kind: 'date', label: '更新时间' } },
  { key: 'trending', label: '最近热门', metric: { kind: 'count', label: '近 7 天热度' } },
  { key: 'downloads', label: '最多下载', metric: { kind: 'count', label: '下载次数' } },
] satisfies NonNullable<PluginMarketPage['sorts']>;
function sortedBy(input: PluginMarketQuery) {
  return input.sort ? { sort: input.sort === 'default' ? 'updated' : input.sort, sorts: serverSorts } : {};
}

// Unit: the echoed sort supplies each row's metric label and sortValue.
it.each(serverSorts)('uses the echoed $key option metric for visible rows', async ({ key, metric }) => {
  const sortValue = metric.kind === 'date' ? '2026-11-22T15:40:00Z' : 286849;
  const { view } = fixture(async input => ({
    ...page(0, 2),
    ...(input.counts ? {} : { sort: key, sorts: serverSorts, items: [item(0), item(1)].map(entry => ({ ...entry, sortValue })) }),
  }), (entry, rowMetric) => <article>{entry.name} · {rowMetric?.label} · {entry.sortValue}</article>);
  render(view());
  expect(await screen.findByText(`Tool 0 · ${metric.label} · ${sortValue}`)).toBeTruthy();
  expect(screen.getByText(`Tool 1 · ${metric.label} · ${sortValue}`)).toBeTruthy();
});

// Unit: sorting is capability-gated by the real page result; a search and
// subsequent sort change must start at page zero rather than reuse old cursors.
it('offers sort only after an echo and starts each sort or search at its first page', async () => {
  let legacy = true;
  const load = vi.fn(async (input: PluginMarketQuery) => ({
    ...page(0, 1),
    items: [{ ...item(0), name: input.sort === 'trending' ? 'Most used tool' : 'Default order tool' }],
    ...(legacy || input.counts ? {} : sortedBy(input)),
  }));
  const oldReader = fixture(load);
  const legacyView = render(oldReader.view());
  await screen.findByText('Default order tool');
  expect(screen.queryByRole('combobox', { name: sortLabel })).toBeNull();
  legacyView.unmount();
  legacy = false;
  load.mockClear();
  const { view } = fixture(load);
  const mounted = render(view());
  const sortTrigger = await screen.findByRole('combobox', { name: sortLabel });
  const sourceTrigger = screen.getByRole('combobox', { name: /^settings\.ghosts\.page\.filtersAria/ });
  expect(sourceTrigger.textContent).toMatch(/^settings\.ghosts\.page\.filterAll\d*$/);
  expect(sortTrigger.textContent).toBe(serverSorts[0].label);
  expect(load).toHaveBeenCalledWith(expect.objectContaining({ sort: 'default', cursor: null }));
  fireEvent.keyDown(sortTrigger, { key: 'ArrowDown' });
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(serverSorts.map(option => option.label));
  fireEvent.keyDown(screen.getByRole('option', { name: '最近热门' }), { key: 'Enter' });
  await screen.findByText('Most used tool');
  expect(load).toHaveBeenCalledWith(expect.objectContaining({ sort: 'trending', cursor: null }));
  await waitFor(() => expect(document.activeElement).toBe(sortTrigger));
  expect(sortTrigger.textContent).toBe('最近热门');
  mounted.rerender(view('Tool'));
  await waitFor(() => expect(load).toHaveBeenCalledWith(expect.objectContaining({ sort: 'trending', cursor: null, query: 'Tool' })));
});

// Unit: a future key can be removed between listing and selection. The echoed order,
// its updated options and its cursor must all take effect without a second first-page read.
it('adopts the server fallback and replaces its offered options without rerequesting it', async () => {
  const removed = { key: 'region_mix_2', label: '<b>地区</b>' };
  const added = { key: 'rank_next', label: '新选项' };
  const load = vi.fn(async (input: PluginMarketQuery): Promise<PluginMarketPage> => {
    const firstOrder = input.sort === 'default' || input.sort === 'updated';
    const result = page(input.cursor ? 10 : 0, 12);
    return input.counts ? result : {
      ...result,
      nextCursor: result.nextCursor ? (firstOrder ? 'old:10' : 'new:10') : null,
      sort: firstOrder ? 'updated' : 'downloads',
      sorts: firstOrder ? [...serverSorts, removed] : [{ ...serverSorts[2], metric: { kind: 'count', label: '综合热度' } }, added],
    };
  });
  const { cache, view } = fixture(load, (entry, metric) => <article>{entry.name} · {metric?.label}</article>);
  render(view());
  const trigger = await screen.findByRole('combobox', { name: sortLabel });
  expect(screen.getByText('Tool 0 · 更新时间')).toBeTruthy();
  act(() => intersections.forEach(callback => callback()));
  await waitFor(() => expect(cache.current.last).toBe(1));
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const option = screen.getByRole('option', { name: removed.label });
  expect(option.textContent).toBe(removed.label);
  expect(option.querySelector('b')).toBeNull();
  fireEvent.click(option);
  await waitFor(() => expect(trigger.textContent).toBe('最多下载'));
  expect(screen.getByText('Tool 0 · 综合热度')).toBeTruthy();
  expect(cache.current.last).toBe(0);
  expect(JSON.parse(cache.current.key).at(-1)).toBe(JSON.stringify(['all', 'downloads']));
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  expect(screen.getAllByRole('option').map(row => row.textContent)).toEqual(['最多下载', added.label]);
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
  act(() => intersections.forEach(callback => callback()));
  await waitFor(() => expect(cache.current.last).toBe(1));
  expect(load.mock.calls.filter(([input]) => !input.counts).map(([input]) => [input.sort, input.cursor]))
    .toEqual([['default', null], ['updated', 'old:10'], [removed.key, null], ['downloads', 'new:10']]);
});

it('keeps each plugin once when a sorted cursor returns a moved plugin again', async () => {
  const nextCursor = 'sorted-second-page';
  const load = vi.fn(async (input: PluginMarketQuery) => ({
    ...page(0, 2),
    items: input.cursor ? [{ ...item(0), name: 'Repeated tool' }, item(1)] : [item(0)],
    nextCursor: input.cursor ? null : nextCursor,
    ...sortedBy(input),
  }));
  const { view } = fixture(load);
  render(view());
  await screen.findByText('Tool 0');
  act(() => { for (const intersect of intersections) intersect(); });
  await screen.findByText('Tool 1');
  expect(screen.getAllByText('Tool 0')).toHaveLength(1);
  expect(screen.queryByText('Repeated tool')).toBeNull();
  expect(load.mock.calls.filter(([input]) => !input.counts).map(([input]) => [input.cursor, input.sort]))
    .toEqual([[null, 'default'], [nextCursor, 'updated']]);
});

it('refreshes a moved sorted item using the cursor returned by the refreshed first page', async () => {
  let moved = false;
  const load = vi.fn(async (input: PluginMarketQuery) => {
    const items = input.cursor === null ? (moved ? [item(2), item(0)] : [item(0), item(1)])
      : input.cursor === 'new:2' ? [item(1), item(3)] : moved ? [item(3)] : [item(2), item(3)];
    return { ...page(0, 4), items, ...sortedBy(input), nextCursor: input.cursor === null ? (moved ? 'new:2' : 'old:2') : null };
  });
  const { cache, view } = fixture(load);
  render(view());
  await screen.findByText('Tool 0');
  await act(async () => intersections.forEach(callback => callback()));
  await screen.findByText('Tool 3');
  moved = true;
  load.mockClear();
  await act(async () => { await cache.current.refresh!({ force: true }); });
  expect(load.mock.calls.filter(([input]) => !input.counts).map(([input]) => input.cursor)).toEqual([null, 'new:2']);
  expect([...cache.current.pages.values()].flat().map(item => item.pluginId)).toEqual(['plugin-2', 'plugin-0', 'plugin-1', 'plugin-3']);
  expect(screen.getByText('Tool 1')).toBeTruthy();
});

async function browseBatches(cache: ReturnType<typeof fixture>['cache'], last: number) {
  await screen.findByText('Tool 0');
  for (let index = 1; index <= last; index++) {
    fireEvent.scroll(screen.getByRole('main'), { target: { scrollTop: index * 750 } });
    await waitFor(() => expect(intersections.size).toBe(1));
    await act(async () => intersections.forEach(callback => callback()));
    await waitFor(() => expect(cache.current.last).toBe(index));
  }
}

it.each(['legacy', 'custom', 'offline'] as const)('refreshes only six pages near the visible position when the catalog is %s', async mode => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(150);
  const scope = mode === 'custom' ? 'custom' : 'all';
  const load = vi.fn(async (input: PluginMarketQuery) => {
    const batch = page(Number(input.cursor ?? 0));
    if (input.counts) return batch;
    return mode === 'custom' ? {
      ...batch, items: batch.items.map(row => ({ ...row, sourceType: 'local-market' as const, sourceMarketName: 'Test source' })),
      customSourceNames: ['Test source'],
    } : { ...batch, ...(mode === 'offline' ? sortedBy(input) : {}) };
  });
  const { cache, view } = fixture(load);
  render(view('', true, scope, 'revision', undefined, undefined, 'owner', load, mode !== 'offline'));
  await browseBatches(cache, 9);
  expect(screen.queryByRole('combobox', { name: sortLabel })).toBeNull();
  expect(cache.current.pages.size).toBe(10);
  const earlier = cache.current.pages.get(0);
  act(() => readVisibleRange?.(90, 93));
  load.mockClear();
  await act(async () => { await cache.current.refresh!({ force: true }); });
  expect(load.mock.calls.filter(([input]) => !input.counts).map(([input]) => input.cursor))
    .toEqual(['40', '50', '60', '70', '80', '90']);
  expect(cache.current.pages.get(0)).toBe(earlier);
  expect(cache.current.pages.size).toBe(10);
});

// Unit / §8.4: the legacy six-page budget test did not exercise a server
// echo. Ten loaded batches must keep their sort and read only the near six.
it('refreshes only six nearby pages with a live sort echo', async () => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(150);
  const load = vi.fn(async (input: PluginMarketQuery) => ({
    ...page(Number(input.cursor ?? 0)), ...sortedBy(input),
  }));
  const { cache, view } = fixture(load);
  render(view());
  await browseBatches(cache, 9);
  act(() => readVisibleRange?.(90, 93));
  const earlier = cache.current.pages.get(0);
  load.mockClear();
  await act(async () => { await cache.current.refresh!({ force: true }); });
  const reads = load.mock.calls.map(([input]) => input).filter(input => !input.counts);
  expect(reads.map(input => input.cursor)).toEqual(['40', '50', '60', '70', '80', '90']);
  expect(reads.every(input => input.sort === 'updated')).toBe(true);
  expect(cache.current.pages.get(0)).toBe(earlier);
  expect(cache.current.metadata?.sort).toBe('updated');
});

it('publishes new logical offsets when a refreshed sorted page changes size', async () => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(150);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(150);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const row = this.closest<HTMLElement>('[data-index]');
    const top = this.tagName === 'MAIN' ? 0 : Number(row?.dataset.index ?? 0) * 150 - (this.closest('main')?.scrollTop ?? 0);
    return new DOMRect(0, top, 800, this.offsetHeight);
  });
  let filtered = false;
  const load = vi.fn(async (input: PluginMarketQuery) => {
    const start = Number(input.cursor ?? 0);
    const batch = page(start, 330);
    return { ...batch, ...sortedBy(input), items: filtered && start === 300 ? batch.items.slice(1) : batch.items };
  });
  const { cache, view } = fixture(load);
  render(view());
  await browseBatches(cache, 32);
  expect([...cache.current.pages.keys()]).toEqual(Array.from({ length: 30 }, (_, index) => index + 3));
  expect(renderedGrid?.count).toBe(330);
  const previous = new Map(cache.current.pages);
  filtered = true;
  await act(async () => { await cache.current.refresh!({ force: true }); });
  expect([...cache.current.pages.keys()]).toEqual([...previous.keys()]);
  for (const [index, batch] of previous) {
    if (index !== 30) expect(cache.current.pages.get(index)).toBe(batch);
  }
  expect(cache.current.sizes.get(0)?.all).toBe(10);
  expect(cache.current.sizes.get(30)?.all).toBe(9);
  expect(renderedGrid?.count).toBe(329);
  expect(restoredIndex).toBe(319);
  const shifted = renderedGrid?.renderItem(319);
  expect(isValidElement<{ item?: PluginMarketItem }>(shifted) && shifted.props.item?.pluginId).toBe('plugin-320');
});

it('reads an evicted page from the visible sorted list while bounded recovery is pending', async () => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(150);
  let rebuilding = false;
  let rejectOldCursor = true;
  let finish!: (result: PluginMarketPage) => void;
  let finishOldPage!: (result: PluginMarketPage) => void;
  const head = new Promise<PluginMarketPage>(resolve => { finish = resolve; });
  const oldPage = new Promise<PluginMarketPage>(resolve => { finishOldPage = resolve; });
  const fresh = (start: number) => {
    const result = page(start, 330);
    return { ...result, sort: 'updated', sorts: serverSorts, nextCursor: result.nextCursor ? `fresh:${result.nextCursor}` : null };
  };
  const load = vi.fn(async (input: PluginMarketQuery) => {
    if (rebuilding && !input.counts) {
      if (rejectOldCursor) {
        rejectOldCursor = false;
        throw new Error('[PLUGIN_LIST_CHANGED] invalid cursor');
      }
      if (input.cursor === null) return head;
      if (input.cursor === '20') return oldPage;
      if (input.cursor?.startsWith('fresh:')) return fresh(Number(input.cursor.slice(6)));
    }
    return { ...page(Number(input.cursor ?? 0), 330), ...sortedBy(input) };
  });
  const { cache, view } = fixture(load);
  render(view());
  await browseBatches(cache, 32);
  const oldCursors = cache.current.cursors;
  expect(cache.current.pages.has(1)).toBe(false);
  rebuilding = true;
  load.mockClear();
  let refresh!: Promise<void>;
  await act(async () => { refresh = cache.current.refresh!({ force: true }); });
  await waitFor(() => expect(load).toHaveBeenCalledWith(expect.objectContaining({ cursor: null, counts: false })));
  await act(async () => {
    fireEvent.scroll(screen.getByRole('main'), { target: { scrollTop: 1050 } });
    readVisibleRange?.(10, 13);
  });
  expect(cache.current.pages.has(1)).toBe(true);
  expect(cache.current.cursors).toBe(oldCursors);
  expect(load).toHaveBeenCalledWith(expect.objectContaining({ cursor: '10', counts: false }));
  await act(async () => {
    readVisibleRange?.(20, 23);
    fireEvent.scroll(screen.getByRole('main'), { target: { scrollTop: 24_000 } });
    readVisibleRange?.(320, 323);
  });
  expect(load).toHaveBeenCalledWith(expect.objectContaining({ cursor: '20', counts: false }));
  await act(async () => { finish(fresh(0)); await refresh; });
  expect(cache.current.cursors).not.toBe(oldCursors);
  expect(cache.current.last).toBe(5);
  expect(cache.current.hasNext).toBe(true);
  expect(cache.current.pages.get(2)?.[0]?.name).toBe('Tool 20');
  await act(async () => {
    finishOldPage({ ...page(20, 330), sort: 'updated', sorts: serverSorts, items: [{ ...item(20), name: 'Obsolete row' }] });
  });
  await waitFor(() => expect(cache.current.pages.get(2)?.[0]?.name).toBe('Tool 20'));
  expect(load).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'fresh:20', counts: false }));
});

it('offers explicit retry from the first page after a second cursor rejection', async () => {
  let firstReads = 0;
  const load = vi.fn(async (input: PluginMarketQuery) => {
    if (input.counts) return page(0, 12);
    if (!input.cursor) {
      firstReads++;
      return { ...page(0, 12), ...sortedBy(input), nextCursor: `chain-${firstReads}` };
    }
    if (firstReads === 1) throw new Error('[PLUGIN_LIST_CHANGED] invalid cursor');
    if (firstReads === 2) throw new Error('[INVALID_PARAMS] invalid cursor');
    return { ...page(10, 12), ...sortedBy(input) };
  });
  const { cache, view } = fixture(load);
  render(view());
  await screen.findByText('Tool 0');
  await act(async () => intersections.forEach(callback => callback()));
  const retry = await screen.findByRole('button', { name: 'commonUi.retry' });
  expect(screen.getByText('settings.ghosts.market.unavailable')).toBeTruthy();
  expect(screen.getByText('Tool 0')).toBeTruthy();
  await act(async () => {
    intersections.forEach(callback => callback());
    await cache.current.refresh!({ force: true });
  });
  expect(firstReads).toBe(2);
  expect(load.mock.calls.filter(([input]) => !input.counts).map(([input]) => input.cursor))
    .toEqual([null, 'chain-1', null, 'chain-2']);
  fireEvent.click(retry);
  await waitFor(() => expect(cache.current.last).toBe(1));
  expect(screen.queryByRole('button', { name: 'commonUi.retry' })).toBeNull();
  expect(load.mock.calls.filter(([input]) => !input.counts).map(([input]) => input.cursor))
    .toEqual([null, 'chain-1', null, 'chain-2', null, 'chain-3']);
});

it('shows both server totals before visiting a second public page', async () => {
  const load = vi.fn(async (input: PluginMarketQuery) => ({ ...page(0, 250),
    counts: input.counts ? { all: 250, public: 250, organization: 0, personal: 0, custom: 0, official: 210, community: 39 } : null,
  }));
  const { view } = fixture(load);
  const mounted = render(view('', true, 'official'));
  await screen.findByText('Tool 0');
  openSourceMenu();
  await waitFor(() => expect(screen.getByRole('option', { name: /publisherKind.community/ }).textContent).toMatch(/39$/));
  expect(screen.getByRole('option', { name: /publisherKind.official/ }).textContent).toMatch(/210$/);
  mounted.rerender(view('', true, 'community'));
  expect(screen.getByRole('option', { name: /publisherKind.community/ }).textContent).toMatch(/39$/);
  expect(load.mock.calls.some(([input]) => input.cursor)).toBe(false);
  expect(load.mock.calls.filter(([input]) => input.counts)).toHaveLength(1);
});

// Cold market entry: the first batch can contain no community plugin. Neither
// counts nor the first category switch may depend on scrolling the official list.
it('counts both publishers on first entry without a scroll and shares the rows between filters', async () => {
  const official = { ...item(0), publisherKind: 'official' as const };
  const community = { ...item(1), publisherKind: 'personal' as const };
  const unknown = { ...item(2), author: 'Cindy', publisherKind: null };
  const load = vi.fn(async (input: PluginMarketQuery) => ({
    ...page(0, 3), items: input.cursor ? [community] : [official, unknown],
    nextCursor: input.cursor ? null : 'second',
  }));
  const { view } = fixture(load);
  const mounted = render(view('', true, 'official'));
  await screen.findByText(official.name);
  openSourceMenu();
  await waitFor(() => expect(screen.getByRole('option', { name: /publisherKind.community/ }).textContent).toMatch(/1$/));
  expect(screen.queryByText(unknown.name)).toBeNull();
  expect(screen.getByRole('option', { name: /publisherKind.community/ }).textContent).toMatch(/1$/);
  expect(screen.getByRole('option', { name: /publisherKind.official/ }).textContent).toMatch(/1$/);
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
  const reads = load.mock.calls.length;
  mounted.rerender(view('', true, 'community'));
  expect(screen.getByText(community.name)).toBeTruthy();
  expect(screen.queryByText(official.name)).toBeNull();
  mounted.rerender(view('', true, 'official'));
  expect(screen.getByText(official.name)).toBeTruthy();
  expect(load.mock.calls.length).toBe(reads);
  expect(load.mock.calls.filter(([input]) => !input.counts).map(([input]) => input.scope)).toEqual(['public', 'public']);
});

// The old ten-row read hid an entire publisher on first entry. A realistic
// catalog honors the requested limit; switching should use the same page and grid.
it('shows the first public batch and both exact counts before the first publisher switch', async () => {
  const rows = Array.from({ length: 24 }, (_, i) => ({
    ...item(i), publisherKind: i < 15 ? 'official' as const : i < 23 ? 'personal' as const : null,
  }));
  const load = vi.fn(async (input: PluginMarketQuery) => {
    const start = Number(input.cursor ?? 0);
    const items = rows.slice(start, start + (input.limit ?? 10));
    return { ...page(0, rows.length), items, nextCursor: start + items.length < rows.length ? String(start + items.length) : null,
      counts: input.counts ? page(0, rows.length).counts : null };
  });
  const { cache, view } = fixture(load);
  const mounted = render(view('', true, 'official'));
  await screen.findByText(rows[0]!.name);
  openSourceMenu();
  expect(screen.getByRole('option', { name: /publisherKind.official/ }).textContent).toMatch(/15$/);
  expect(screen.getByRole('option', { name: /publisherKind.community/ }).textContent).toMatch(/8$/);
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
  const grid = cache.current.grid;
  mounted.rerender(view('', true, 'community'));
  expect(screen.getByText(rows[15]!.name)).toBeTruthy();
  expect(cache.current.grid).toBe(grid);
  expect(load.mock.calls.filter(([input]) => !input.counts)).toHaveLength(1);
});

it('keeps installed cards in warm market batches and source counts', async () => {
  const load = vi.fn(async () => page(0, 2));
  const { cache, view } = fixture(load, item => <article>{item.name}:{item.installState}</article>);
  const mounted = render(view());
  const row = await screen.findByText('Tool 0:not-installed');
  await waitFor(() => expect(cache.current.counts).toMatchObject({ all: 2, public: 2 }));
  const grid = cache.current.grid;
  mounted.rerender(view('', true, 'all', 'revision', undefined, [{ ...item(0), installState: 'installed' }]));
  expect(screen.getByText('Tool 0:installed')).toBe(row);
  expect(screen.getByText('Tool 1:not-installed')).toBeTruthy();
  expect(cache.current.grid).toBe(grid);
  expect(cache.current.counts).toMatchObject({ all: 2, public: 2 });
  expect([...cache.current.pages.values()].flat().map(item => item.pluginId)).toEqual(['plugin-0', 'plugin-1']);
  expect(load.mock.calls).toHaveLength(2);
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
  // Cards can commit before the continuation observer subscribes. Trigger the
  // same viewport event only after the real subscription is ready (#10917 CI).
  await waitFor(() => expect(intersections.size).toBe(1));
  await act(async () => intersections.forEach(callback => callback()));
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
  expect(cache.current.pages.size).toBe(9);
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
    mounted.rerender(view('', true, 'official'));
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

// Unit / Codex C2 (approved convergence): joining a pre-change flight does
// not cover an install/source invalidation. Previous cancellation tests changed
// the cache key; here three revisions share one live cache and a pending read.
it.each(['resolved', 'rejected', 'list-changed', 'latest-failed', 'departed'] as const)(
  'coalesces revisions received during a catalog refresh: %s', async outcome => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    let phase: 'initial' | 'old' | 'latest' = 'initial';
    let finishOld!: (value: PluginMarketPage) => void, failOld!: (error: Error) => void;
    let finishLatest!: (value: PluginMarketPage) => void, failLatest!: (error: Error) => void;
    const old = new Promise<PluginMarketPage>((resolve, reject) => { finishOld = resolve; failOld = reject; });
    const latest = new Promise<PluginMarketPage>((resolve, reject) => { finishLatest = resolve; failLatest = reject; });
    const load = vi.fn(async (input: PluginMarketQuery) => input.counts ? page(0, 2)
      : phase === 'initial' ? page(0, 1) : phase === 'old' ? old : latest);
    const { cache, view } = fixture(load);
    const mounted = render(view());
    await screen.findByText('Tool 0');
    phase = 'old';
    let reading!: Promise<void>;
    await act(async () => { reading = cache.current.refresh!({ force: true }); });
    const reads = () => load.mock.calls.filter(([input]) => !input.counts).length;
    const before = reads();
    phase = 'latest';
    for (const revision of ['uninstall-1', 'source-2', 'uninstall-3']) mounted.rerender(view('', true, 'all', revision));
    expect(reads()).toBe(before);
    if (outcome === 'departed') mounted.rerender(view('', false, 'all', 'uninstall-3'));
    await act(async () => {
      if (outcome === 'rejected' || outcome === 'list-changed') failOld(new Error(outcome === 'list-changed'
        ? '[PLUGIN_LIST_CHANGED] old cursor invalidated' : 'old request failed'));
      else finishOld({ ...page(0, 1), items: [{ ...item(0), name: 'Obsolete response' }] });
    });
    expect(cache.current.refreshedRevision).not.toBe('uninstall-3');
    expect(screen.queryByText('Obsolete response')).toBeNull();
    if (outcome === 'departed') {
      expect(reads()).toBe(before);
      await reading;
      return;
    }
    expect(reads()).toBe(before + 1);
    await act(async () => {
      if (outcome === 'latest-failed') failLatest(new Error('latest request failed'));
      else finishLatest(page(0, 2));
      await reading;
    });
    expect(reads()).toBe(before + 1); // Failure must not turn coalescing into retries.
    expect(screen.getByText('Tool 0')).toBeTruthy();
    if (outcome === 'latest-failed') expect(cache.current.refreshedRevision).not.toBe('uninstall-3');
    else { expect(screen.getByText('Tool 1')).toBeTruthy(); expect(cache.current.refreshedRevision).toBe('uninstall-3'); }
  });

// Unit / Greptile 4582423581: a new scroll page is not proof that the other
// resident batches cover an invalidation. Existing revision tests had no
// simultaneous scroll read, so a page timestamp could consume the follow-up.
it('refreshes resident batches after invalidation even when a scroll page finishes first', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
  let phase: 'initial' | 'old-refresh' | 'latest' = 'initial';
  let finish!: (value: PluginMarketPage) => void;
  const old = new Promise<PluginMarketPage>(resolve => { finish = resolve; });
  const freshPage = (offset: number): PluginMarketPage => ({ ...page(offset, 31),
    items: [item(99), ...Array.from({ length: 30 }, (_, index) => item(index))].slice(offset, offset + 10) });
  const load = vi.fn(async (input: PluginMarketQuery) => {
    if (input.counts) return page(0, 31);
    const offset = Number(input.cursor ?? 0);
    if (phase === 'old-refresh' && offset === 0) return old;
    return phase === 'latest' ? freshPage(offset) : page(offset, 31);
  });
  const { cache, view } = fixture(load);
  const mounted = render(view());
  await screen.findByText('Tool 0');
  await waitFor(() => expect(intersections.size).toBe(1));
  await act(async () => intersections.forEach(callback => callback()));
  await waitFor(() => expect(cache.current.last).toBe(1));
  phase = 'old-refresh';
  let refreshing!: Promise<void>;
  await act(async () => { refreshing = cache.current.refresh!({ force: true }); });
  for (const revision of ['uninstall-1', 'sources-2', 'uninstall-3']) mounted.rerender(view('', true, 'all', revision));
  phase = 'latest'; clock.mockReturnValue(20_000);
  await act(async () => intersections.forEach(callback => callback()));
  await waitFor(() => expect(cache.current.pages.has(2)).toBe(true));
  await act(async () => { finish(page(0, 31)); await refreshing; });
  await waitFor(() => expect(cache.current.pages.get(0)?.some(row => row.pluginId === 'plugin-99')).toBe(true));
  expect(cache.current.pages.get(1)?.map(row => row.pluginId)).toEqual(freshPage(10).items.map(row => row.pluginId));
  expect(load.mock.calls.filter(([input]) => !input.counts && !input.cursor)).toHaveLength(3);
  expect(screen.getByText('Tool 99')).toBeTruthy();
});

// Unit / Codex 4582498653: metadata is absent during a cold read, so refreshing
// only warm pages loses its invalidation. Both resolve and reject must let one
// current-revision read replace that obsolete first request.
it.each(['resolved', 'rejected'] as const)('rechecks an invalidated first batch once after it is %s', async outcome => {
  let finish!: (value: PluginMarketPage) => void, fail!: (error: Error) => void;
  const first = new Promise<PluginMarketPage>((resolve, reject) => { finish = resolve; fail = reject; });
  let initial = true;
  const load = vi.fn(async (input: PluginMarketQuery) => {
    if (input.counts) return page(0, 2);
    if (initial) { initial = false; return first; }
    return page(0, 2);
  });
  const { cache, view } = fixture(load);
  const mounted = render(view());
  await waitFor(() => expect(load.mock.calls.filter(([input]) => !input.counts)).toHaveLength(1));
  for (const revision of ['installed-1', 'source-2', 'uninstalled-3']) mounted.rerender(view('', true, 'all', revision));
  expect(load.mock.calls.filter(([input]) => !input.counts)).toHaveLength(1);
  await act(async () => { if (outcome === 'resolved') finish(page(0, 1)); else fail(new Error('obsolete first read failed')); });
  expect(await screen.findByText('Tool 1')).toBeTruthy();
  expect(load.mock.calls.filter(([input]) => !input.counts)).toHaveLength(2);
  expect(cache.current.pages.get(0)?.map(row => row.pluginId)).toEqual(['plugin-0', 'plugin-1']);
});

// Unit / Codex 4582498662: Main returns successful custom items together with
// per-source failures. Snapshot tests did not exercise the independent paging
// writer; it must preserve only failed sources, update metadata, then recover.
it('merges successful custom page results while retaining only failed sources', async () => {
  const official = item(0);
  const custom = (index: number, source: string, name: string) => ({ ...item(index), sourceType: 'local-market' as const, sourceMarketName: source, name });
  let response: PluginMarketPage = { ...page(0, 4), counts: null,
    items: [official, custom(1, 'working', 'Working old'), custom(2, 'removed', 'Removed source'), custom(3, 'failed', 'Failed source')],
    customSourceNames: ['working', 'removed', 'failed'] };
  const load = vi.fn(async () => response);
  const { cache, view } = fixture(load);
  render(view());
  const officialCard = await screen.findByText('Tool 0');
  response = { ...response, items: [custom(1, 'working', 'Working updated'), custom(4, 'new-source', 'Added source')],
    unavailableReason: 'official unavailable', customSourceNames: ['working', 'failed', 'new-source'], unavailableCustomSourceNames: ['failed'] };
  await act(async () => { await cache.current.refresh!({ force: true }); });
  expect(screen.getByText('Working updated')).toBeTruthy();
  expect(screen.getByText('Added source')).toBeTruthy();
  expect(screen.getByText('Failed source')).toBeTruthy();
  expect(screen.queryByText('Removed source')).toBeNull();
  expect(screen.getByText('Tool 0')).toBe(officialCard);
  expect(cache.current.metadata?.customSourceNames).toEqual(response.customSourceNames);
  expect(cache.current.metadata?.unavailableReason).toBe('official unavailable');
  response = { ...page(0, 1), counts: null, items: [{ ...official, name: 'Recovered official' }] };
  await act(async () => { await cache.current.refresh!({ force: true }); });
  expect(screen.getByText('Recovered official')).toBeTruthy();
  expect(screen.queryByText('Failed source')).toBeNull();
  expect(cache.current.metadata?.customSourceNames).toEqual([]);
});

it('shows first-page cards without waiting for the independent count', async () => {
  const load = vi.fn((input: PluginMarketQuery) => input.counts
    ? new Promise<PluginMarketPage>(() => {})
    : Promise.resolve({ ...page(0, 1), counts: null }));
  const { view } = fixture(load);
  render(view());
  expect(await screen.findByText('Tool 0')).toBeTruthy();
});

it('updates an installed or uninstalled row in place before the market snapshot refresh', async () => {
  const load = vi.fn(async () => page(0, 1));
  const { view } = fixture(load, item => <article>{item.name}:{item.installState}</article>);
  const mounted = render(view('', true, 'all', 'revision', []));
  const row = await screen.findByText('Tool 0:not-installed');
  const ghost: InstalledGhost = { manifest: { schemaVersion: 2, id: 'tool-0', name: 'Tool 0', version: '1.0.0', kind: 'chip', entry: 'main.js' },
    dir: '/fixture/tool-0', namespace: null, enabled: true, approval: { state: 'approved', revision: 'receipt-test' },
    publishingSource: { kind: 'public-market', pluginId: 'plugin-0' } };
  mounted.rerender(view('', true, 'all', 'revision', [ghost]));
  expect(screen.getByText('Tool 0:installed')).toBe(row);
  const staleSnapshot = [{ ...item(0), installState: 'installed' as const }];
  mounted.rerender(view('', true, 'all', 'revision', [ghost], staleSnapshot));
  mounted.rerender(view('', true, 'all', 'revision', [], staleSnapshot));
  expect(screen.getByText('Tool 0:not-installed')).toBe(row);
  expect(load.mock.calls).toHaveLength(2);
});

// Unit: content equality must ignore short-lived delivery addresses. The prior
// tests did not count card renders across a background catalog refresh.
it('does not render unchanged cards or signed-url renewals and renders only a changed card', async () => {
  let name = 'Tool 1', signature = 'first';
  const renderItem = vi.fn((item: PluginMarketItem) => <article>{item.name}</article>);
  const load = vi.fn(async () => ({ ...page(0, 2), items: [
    { ...item(0), usageStatistics: { usageCount: '4', asOf: signature }, icon: { sha256: 'a'.repeat(64), mimeType: 'image/png', sizeBytes: 12,
      url: `https://icons.invalid/${signature}`, expiresAt: '2099-01-01T00:00:00.000Z' } },
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
  expect(cache.current.pages.get(0)?.[0].icon?.url).toBe('https://icons.invalid/first');
  // Explicit recovery replaces the address even before the old signature expires.
  cache.current.countsAt = 0;
  const requestsBeforeRenewal = load.mock.calls.length;
  await act(async () => { await cache.current.refresh!({ force: true, renewIcons: true }); });
  expect(load.mock.calls.length - requestsBeforeRenewal).toBe(1);
  expect(cache.current.pages.get(0)?.[0].icon?.url).toBe('https://icons.invalid/second');
  expect(renderItem).toHaveBeenCalledTimes(before + 1);
  name = 'Changed tool';
  await act(async () => { await cache.current.refresh!({ force: true }); });
  expect(screen.getByText('Changed tool')).toBeTruthy();
  expect(renderItem).toHaveBeenCalledTimes(before + 2);
});

// Unit / Codex 4584198389: sequential renewal coverage missed a failed image
// joining an ordinary in-flight refresh. Exercise the actual image component:
// cache transport may change silently, but explicit renewal must restore src.
it('publishes renewed image props when renewal joins an in-flight catalog refresh', async () => {
  const value = (url: string): PluginMarketPage => ({ ...page(0, 1), items: [{ ...item(0),
    icon: { sha256: 'a'.repeat(64), mimeType: 'image/png', sizeBytes: 12, url, expiresAt: '2030-01-01T00:00:00Z' } }] });
  let hold = false;
  let finish!: (value: PluginMarketPage) => void;
  const load = vi.fn(async (input: PluginMarketQuery) => !input.counts && hold
    ? new Promise<PluginMarketPage>(resolve => { finish = resolve; }) : value('https://icons.invalid/old'));
  const { cache, view } = fixture(load, item => <article>{item.name}
    <GhostPluginIcon iconId={item.ghostId} iconName={item.name} iconDataUrl={item.icon?.url} />
  </article>);
  render(view());
  const card = await screen.findByText('Tool 0');
  const image = card.querySelector('img')!;
  expect(image.getAttribute('src')).toBe('https://icons.invalid/old');
  fireEvent.error(image);
  expect(card.querySelector('img')).toBeNull();
  hold = true;
  let ordinary!: Promise<void>;
  act(() => { ordinary = cache.current.refresh!({ force: true }); });
  await waitFor(() => expect(finish).toBeDefined());
  const renewal = cache.current.refresh!({ force: true, renewIcons: true });
  await act(async () => { finish(value('https://icons.invalid/new')); await Promise.all([ordinary, renewal]); });
  expect(cache.current.pages.get(0)?.[0].icon?.url).toBe('https://icons.invalid/new');
  expect(card.querySelector('img')?.getAttribute('src')).toBe('https://icons.invalid/new');
  expect(load.mock.calls.filter(([input]) => !input.counts)).toHaveLength(2);
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
  await waitFor(() => expect(intersections.size).toBe(1));
  await act(async () => intersections.forEach(callback => callback()));
  await waitFor(() => expect(release).toBeDefined());
  expect(screen.getByText('Tool 0')).toBeTruthy();
  await act(async () => { release!(page(0, 12)); });
  await waitFor(() => expect(cache.current.last).toBe(1));
  expect(cache.current.pages.size).toBe(2);
  expect(cache.current.error).toBeNull();
});

// Unit / Greptile 4582948698: both old official cursors can carry customOffset
// zero. During an official outage Main returns the same custom fallback twice;
// the per-page partial merge previously appended it to both resident batches.
it('keeps fallback custom plugins unique across resident batches during an outage refresh', async () => {
  let unavailable = false;
  const custom = [20, 21].map(index => ({ ...item(index), name: `Custom ${index}`,
    sourceType: 'local-market' as const, sourceMarketName: 'Working source' }));
  const load = vi.fn(async (input: PluginMarketQuery) => input.counts ? page(0, 22) : unavailable
    ? { ...page(0, 2), items: custom, counts: null, unavailableReason: 'official unavailable', customSourceNames: ['Working source'] }
    : { ...page(Number(input.cursor ?? 0), 22), counts: null, customSourceNames: ['Working source'] });
  const { cache, view } = fixture(load);
  render(view());
  const firstCard = await screen.findByText('Tool 0');
  await waitFor(() => expect(intersections.size).toBe(1));
  await act(async () => intersections.forEach(callback => callback()));
  await waitFor(() => expect(cache.current.last).toBe(1));
  unavailable = true;
  await act(async () => { await cache.current.refresh!({ force: true }); });
  const items = [...cache.current.pages.values()].flat();
  expect(items.filter(row => row.pluginId === 'plugin-20')).toHaveLength(1);
  expect(items.filter(row => row.pluginId === 'plugin-21')).toHaveLength(1);
  expect(items).toHaveLength(22);
  expect([...cache.current.sizes.values()].reduce((sum, size) => sum + size.all, 0)).toBe(22);
  expect(items.filter(row => row.sourceType === 'server')).toHaveLength(20);
  expect(screen.getByText('Tool 0')).toBe(firstCard);
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
  mounted.rerender(view('', true, 'official'));
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

it.each(['', 'Tool'])('excludes installed plugins only during search for query "%s", retaining conflicts', async query => {
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
  const mounted = render(view(query));
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  expect(Boolean(screen.queryByText('Tool 0'))).toBe(!query);
  expect(Boolean(screen.queryByText('Tool 1'))).toBe(!query);
  expect(screen.getByText('Tool 2')).toBeTruthy();
  expect(screen.getByText('Tool 3')).toBeTruthy();
  const expectedCount = query ? 2 : 4;
  expect(cache.current.counts).toMatchObject({ all: expectedCount, public: expectedCount });
  expect(load).toHaveBeenCalledTimes(2);
  expect(load.mock.calls.every(([input]) => input.excludeInstalled === Boolean(query))).toBe(true);
  if (!query) {
    const browseCache = cache.current;
    mounted.rerender(view('Tool'));
    expect(screen.getByText('Tool 2')).toBeTruthy();
    expect(screen.queryByText('Tool 0')).toBeNull();
    expect(screen.queryByText('Tool 1')).toBeNull();
    expect(browseCache.pages.get(0)).toHaveLength(4);
  }
});

it('reuses search-wide counts across source filters and recounts for a new search', async () => {
  const load = vi.fn(async (query: PluginMarketQuery) => ({ ...page(0), counts: query.counts === false ? null : page(0).counts }));
  const { cache, view } = fixture(load);
  const mounted = render(view());
  await screen.findByText('Tool 0');
  mounted.rerender(view('', true, 'official'));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'public', counts: false }));
  expect(cache.current.counts?.all).toBe(120);
  mounted.rerender(view('new search', true, 'official'));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(5));
  expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'new search', counts: true }));
});

it('advances at the sentinel and retains up to thirty visible batches', async () => {
  // Compact viewport: one visible row plus the grid's two overscan rows.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(150);
  const load = vi.fn(async (query: PluginMarketQuery) => {
    const start = Number(query.cursor ?? 0);
    const result = page(start, 100_000);
    return { ...result, ...sortedBy(query),
      items: start === 70 ? [item(0), ...result.items.slice(1)] : result.items,
      ...(query.counts === false ? { counts: null } : {}) };
  });
  const { cache, view } = fixture(load);
  render(view());
  await screen.findByText('Tool 0');
  expect(load).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenCalledWith(expect.objectContaining({ limit: 10, cursor: null, counts: false }));
  expect(cache.current.counts?.all).toBe(100_000);
  expect(screen.getAllByRole('article').length).toBeLessThanOrEqual(6);
  for (let index = 1; index <= 31; index++) {
    // Move the real viewport with each batch; a visible first page must not be evicted.
    fireEvent.scroll(screen.getByRole('main'), { target: { scrollTop: index * 750 } });
    act(() => intersections.forEach(callback => { callback(); callback(); }));
    await waitFor(() => expect(cache.current.last).toBe(index));
    if (index === 7) {
      expect(cache.current.pages.has(0)).toBe(true);
      expect(cache.current.pages.get(7)?.some(item => item.pluginId === 'plugin-0')).toBe(false);
      act(() => readVisibleRange?.(0, 3));
      expect(load).toHaveBeenCalledTimes(9);
    }
  }
  expect(load).toHaveBeenCalledTimes(33);
  expect(cache.current.pages.size).toBe(30);
  expect(cache.current.pages.has(0)).toBe(false);
  expect(cache.current.pages.get(7)?.some(item => item.pluginId === 'plugin-0')).toBe(false);
  expect(cache.current.sizes.get(7)?.all).toBe(9);
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
  // Metadata is published before React commits the continuation observer.
  // Deliver the viewport event only after that real subscription is installed.
  await waitFor(() => expect(intersections.size).toBeGreaterThan(0));
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
  mounted.rerender(view('', true, 'official'));
  expect(screen.queryByText('Tool 0')).toBe(original);
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(screen.getByText('Tool 0')).toBe(original);
  expect(screen.getByText('ccAgent.common.loading')).toBeTruthy();
  await act(async () => { finish(page(0, 2)); });
  expect(screen.getByText('Tool 0')).toBe(original);
  expect(screen.queryByText('ccAgent.common.loading')).toBeNull();
  const reads = load.mock.calls.length, renders = rendered.mock.calls.length;
  for (const scope of ['all', 'official', 'all', 'official'] as const) {
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
  for (const scope of ['official', 'organization', 'custom', 'all'] as const) {
    mounted.rerender(view('', true, scope));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByText('Tool 0')).toBeTruthy();
    expect(cache.current.variants!.size).toBeLessThanOrEqual(4);
  }
  const beforeWarm = load.mock.calls.length;
  mounted.rerender(view('', true, 'official')); await act(async () => { await vi.advanceTimersByTimeAsync(0); });
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
  vi.useFakeTimers(); mounted.rerender(view('', true, 'official'));
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(screen.getByText('Tool 0')).toBe(original);
  expect(screen.getByRole('button', { name: 'commonUi.retry' })).toBeTruthy();
  expect(screen.queryByText('ccAgent.common.loading')).toBeNull();
  await act(async () => { counts(page(0, 1)); });
  expect(cache.current.counts?.all).toBe(1);
  expect(load.mock.calls.filter(([input]) => input.counts)).toHaveLength(1);
});
