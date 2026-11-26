/**
 * Regression coverage for the market Plugin detail view's explicit same-ID
 * replacement action and its data-preservation explanation.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ANTIGRAVITY_MARK_PATH } from '@cindy/maker-shared/branding';

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string, options?: { value?: string }) => options?.value !== undefined ? `${options.value} ${key}` : key, i18n: { language: 'en' } }),
}));
// The public share action reads the current account; these detail/install cases
// keep it signed out without loading the application's account lifecycle.
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: false, dataOwnerId: null, dataOwnerGeneration: 0 }),
}));

import { MarketPluginDetailView } from '../MarketPluginDetailView';
import type { GhostManifest } from '../../../../shared/ghost';
import type { PluginMarketDetail, PluginMarketItem, PluginMarketPage, PluginMarketQuery } from '../../../../shared/pluginMarket';
import { relatedPluginCatalogCache, removeUnavailableRelatedPlugin, type PluginRelatedCatalog } from '../PluginMoreDetails';
import { marketDetailCacheFor, marketItemSummary } from '../lib/marketDetailCache';
import { PLUGIN_CATALOG_REFRESH_MS } from '../lib/pluginBrowserCache';
import {
  __resetPluginInstallProgressForTest,
  beginPluginInstallProgress,
  failPluginInstallProgress,
  succeedPluginInstallProgress,
} from '../lib/pluginInstallProgress';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';

const manifest: GhostManifest = {
  schemaVersion: 2,
  id: 'google-calendar',
  name: 'Google Calendar',
  version: '1.3.11',
  kind: 'chip',
  entry: 'main.js',
  notify: true,
};

const detail: PluginMarketDetail = {
  pluginId: 'release-google-calendar',
  ghostId: 'google-calendar',
  name: 'Google Calendar',
  description: 'Connect Google Calendar',
  author: 'Cindy',
  scope: 'public',
  organizationId: null,
  defaultInstall: false,
  releaseId: 'release-1',
  version: '1.3.11',
  publishedAt: '2026-07-25T00:00:00.000Z',
  icon: null,
  installState: 'not-installed',
  enabled: null,
  sourceType: 'server',
  sourceMarketName: null,
  manifest,
};

const renderDetail = (overrides: Partial<PluginMarketDetail> = {}) =>
  render(
    <MarketPluginDetailView
      detail={{ ...detail, ...overrides }}
      busy={false}
      onBack={vi.fn()}
      onInstall={vi.fn()}
      onIconLoadError={vi.fn()}
    />,
  );

function relatedItem(id: string, overrides: Partial<PluginMarketItem> = {}): PluginMarketItem {
  return { ...marketItemSummary(detail), pluginId: id, ghostId: id, name: id, publisherKind: 'official', ...overrides };
}

function relatedPage(items: PluginMarketItem[], nextCursor: string | null = null): PluginMarketPage {
  return { items, nextCursor, counts: null, unavailableReason: null,
    customSourceNames: [], unavailableCustomSourceNames: [] };
}

function relatedCatalog(loadPage: PluginRelatedCatalog['loadPage']): PluginRelatedCatalog {
  return { cache: {}, ownerKey: 'related-owner', catalogKey: 'en', local: true, loadPage };
}

function detailWithRelated(item: PluginMarketDetail, catalog: PluginRelatedCatalog, onOpenRelated = vi.fn()) {
  return <MarketPluginDetailView key={item.pluginId} detail={item} relatedCatalog={catalog} busy={false}
    onOpenRelated={onOpenRelated} onBack={vi.fn()} onIconLoadError={vi.fn()} />;
}

// Unit / round2 §4: the real detail entry protects the recommendation contract.
// A mixed page, a cursor beyond 100 rows, and one failed visit cover selection,
// persistence and read boundaries that install/README tests do not exercise.
describe('More plugins', () => {
  const title = 'settings.ghosts.detail.morePlugins';
  const hint = 'settings.ghosts.detail.morePluginsHint';
  const cardNames = () => within(screen.getByRole('region', { name: title }))
    .getAllByRole('button', { name: name => name !== hint })
    .map(card => card.getAttribute('aria-label'));

  // The real section uses Tip for both transient previews and click-to-hold.
  it('shows the random-selection explanation after pointer hover and keyboard focus', async () => {
    render(detailWithRelated(detail, relatedCatalog(async () => relatedPage([relatedItem('Another plugin')]))));
    const trigger = await screen.findByRole('button', { name: hint });
    vi.useFakeTimers();
    try {
      fireEvent.pointerMove(trigger, { pointerType: 'mouse' });
      act(() => vi.advanceTimersByTime(500));
      expect(screen.getByRole('tooltip').textContent).toBe(hint);
      fireEvent.pointerLeave(trigger, { pointerType: 'mouse' });
      expect(screen.queryByRole('tooltip')).toBeNull();

      fireEvent.keyDown(document.body, { key: 'Tab' });
      act(() => trigger.focus());
      expect(screen.getByRole('tooltip').textContent).toBe(hint);
      fireEvent.keyDown(trigger, { key: 'Escape' });
      expect(screen.queryByRole('tooltip')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds the explanation after a click until toggled, escaped, scrolled, or dismissed outside', async () => {
    render(detailWithRelated(detail, relatedCatalog(async () => relatedPage([relatedItem('Another plugin')]))));
    const trigger = await screen.findByRole('button', { name: hint });
    const click = () => {
      fireEvent.pointerDown(trigger, { pointerType: 'mouse' });
      fireEvent.pointerUp(trigger, { pointerType: 'mouse' });
      fireEvent.click(trigger);
    };
    click();
    fireEvent.pointerLeave(trigger, { pointerType: 'mouse' });
    expect(screen.getByRole('tooltip').textContent).toBe(hint);
    click();
    expect(screen.queryByRole('tooltip')).toBeNull();

    await act(async () => { click(); });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();

    click();
    fireEvent.scroll(document);
    expect(screen.queryByRole('tooltip')).toBeNull();

    vi.useFakeTimers();
    try {
      click();
      act(() => vi.advanceTimersByTime(0));
      fireEvent.pointerDown(document.body, { pointerType: 'mouse' });
      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('mixes visible sources, keeps the draw on return, and replaces only the installed slot', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const current = { ...detail, publisherKind: 'personal' as const };
      const community = relatedItem('Community plugin', { publisherKind: 'personal' });
      const official = relatedItem('Official plugin');
      const team = relatedItem('Team plugin', { scope: 'organization', organizationId: 'team' });
      const reserve = relatedItem('Reserve plugin');
      const loadPage = vi.fn(async () => relatedPage([
        marketItemSummary(current), relatedItem('Already installed', { installState: 'installed' }),
        relatedItem('Custom source', { sourceType: 'git-market' }), relatedItem('Private listing', { scope: 'personal' }),
        community, official, team, reserve,
      ]));
      const catalog = { ...relatedCatalog(loadPage), cache: relatedPluginCatalogCache('owner-a') };
      const open = vi.fn();
      const { rerender } = render(detailWithRelated(current, catalog, open));
      await screen.findByRole('region', { name: title });
      expect(cardNames()).toEqual([community.name, official.name, team.name]);
      const first = screen.getByRole('button', { name: community.name });
      expect(within(first).getByText('settings.ghosts.market.publisherKind.community')).toBeTruthy();
      expect(within(screen.getByRole('button', { name: team.name })).getByText('settings.ghosts.page.origin.organization')).toBeTruthy();
      fireEvent.click(first);
      expect(open).toHaveBeenCalledWith(community);

      random.mockReturnValue(0.99);
      rerender(detailWithRelated({ ...community, manifest }, catalog));
      await screen.findByRole('region', { name: title });
      expect(cardNames()).not.toContain(community.name);
      rerender(detailWithRelated(current, { ...catalog, catalogKey: 'zh-CN', cache: relatedPluginCatalogCache('owner-a') }));
      await screen.findByRole('region', { name: title });
      expect(cardNames()).toEqual([community.name, official.name, team.name]);

      const afterInstall: PluginMarketItem = { ...official, installState: 'installed' };
      rerender(detailWithRelated(current, { ...catalog, liveItems: [afterInstall] }));
      await waitFor(() => expect(cardNames()).toEqual([community.name, reserve.name, team.name]));
      await act(async () => { removeUnavailableRelatedPlugin(catalog.cache, reserve.pluginId); });
      rerender(detailWithRelated(current, { ...catalog, liveItems: [afterInstall] }));
      await waitFor(() => expect(cardNames()).toEqual([community.name, team.name]));
      expect(loadPage).toHaveBeenCalledTimes(1);
      rerender(detailWithRelated(current, { ...catalog, cache: relatedPluginCatalogCache('owner-b') }));
      await screen.findByRole('region', { name: title });
      expect(loadPage).toHaveBeenCalledTimes(2);
    } finally {
      random.mockRestore();
    }
  });

  // Unit: the remembered directory may still call a plugin installed after the current roster has removed it.
  it('samples an uninstalled candidate from the cached directory on the next detail', async () => {
    const removed = relatedItem('formerly-installed', { name: 'Formerly installed', installState: 'installed' });
    const reserve = relatedItem('reserve', { name: 'Reserve' });
    const loadPage = vi.fn(async () => relatedPage([removed, reserve]));
    const catalog = relatedCatalog(loadPage);
    const onOpen = vi.fn();
    const { rerender } = render(detailWithRelated(detail, {
      ...catalog, installedGhosts: [{ manifest: { id: removed.ghostId } }],
    }, onOpen));
    await screen.findByRole('region', { name: title });
    expect(cardNames()).toEqual([reserve.name]);

    rerender(detailWithRelated({ ...reserve, manifest }, { ...catalog, installedGhosts: [] }, onOpen));
    const candidate = await screen.findByRole('button', { name: removed.name });
    fireEvent.click(candidate);
    expect(onOpen).toHaveBeenCalledWith({ ...removed, installState: 'not-installed' });
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  it('excludes the public simulator migration when its legacy identity is installed', async () => {
    const simulator = relatedItem('cindy-simulator', { name: 'Migrated simulator' });
    const organizationCopy = relatedItem('organization-simulator', {
      ghostId: simulator.ghostId, name: 'Team simulator', namespace: 'team',
      scope: 'organization', organizationId: 'team',
    });
    const catalog = relatedCatalog(async () => relatedPage([simulator, organizationCopy, relatedItem('Reserve')]));
    render(detailWithRelated(detail, {
      ...catalog, installedGhosts: [{ manifest: { id: 'baguette-simulator' } }],
    }));
    await screen.findByRole('region', { name: title });
    expect(cardNames()).toEqual(expect.arrayContaining(['Team simulator', 'Reserve']));
    expect(cardNames()).not.toContain(simulator.name);
  });

  it('reads through the last cursor before sampling, including a plugin after the first 100', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.9999);
    try {
      const beyondFirstPage = relatedItem('Plugin on page two', { publisherKind: 'personal' });
      const loadPage = vi.fn(async (query: PluginMarketQuery) => query.cursor
        ? relatedPage([beyondFirstPage])
        : relatedPage(Array.from({ length: 100 }, (_, index) => relatedItem(`First page ${index}`)), 'page-2'));
      render(detailWithRelated(detail, relatedCatalog(loadPage)));
      await screen.findByRole('region', { name: title });
      expect(cardNames()).toEqual([beyondFirstPage.name, 'First page 99', 'First page 98']);
      expect(loadPage.mock.calls).toEqual([
        [{ scope: 'all', limit: 100, counts: false, cursor: null }],
        [{ scope: 'all', limit: 100, counts: false, cursor: 'page-2' }],
      ]);
    } finally {
      random.mockRestore();
    }
  });

  it('caps the related directory at five pages', async () => {
    const loadPage = vi.fn(async ({ cursor }: PluginMarketQuery) => {
      const page = Number(cursor ?? '0') + 1;
      return relatedPage([relatedItem(`Plugin ${page}`)], page < 7 ? String(page) : null);
    });
    render(detailWithRelated(detail, relatedCatalog(loadPage)));
    await screen.findByRole('region', { name: title });
    expect(loadPage).toHaveBeenCalledTimes(5);
  });

  it('stops chasing pages when the last detail leaves and resumes the saved cursor', async () => {
    let finishFirst!: (page: PluginMarketPage) => void;
    const loadPage = vi.fn(({ cursor }: PluginMarketQuery) => cursor
      ? Promise.resolve(relatedPage([relatedItem('Second page')]))
      : new Promise<PluginMarketPage>(resolve => { finishFirst = resolve; }));
    const catalog = relatedCatalog(loadPage);
    const view = render(detailWithRelated(detail, catalog));
    expect(loadPage).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => { finishFirst(relatedPage([relatedItem('First page')], 'next')); });
    expect(loadPage).toHaveBeenCalledTimes(1);
    render(detailWithRelated(detail, catalog));
    await screen.findByRole('region', { name: title });
    expect(loadPage.mock.calls.map(([query]) => query.cursor)).toEqual([null, 'next']);
  });

  it('waits until the detail becomes visible before requesting the first page', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const loadPage = vi.fn(async () => relatedPage([relatedItem('Available plugin')]));
    try {
      render(detailWithRelated(detail, relatedCatalog(loadPage)));
      expect(loadPage).not.toHaveBeenCalled();
      visibility.mockReturnValue('visible');
      fireEvent(document, new Event('visibilitychange'));
      await screen.findByRole('region', { name: title });
      expect(loadPage).toHaveBeenCalledTimes(1);
    } finally {
      visibility.mockRestore();
    }
  });

  it('keeps all three recommendation slots when the directory is refreshed after expiry', async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const candidates = ['A', 'B', 'C', 'D', 'E'].map(relatedId => relatedItem(relatedId));
    const loadPage = vi.fn(async (_query: PluginMarketQuery) => relatedPage(candidates));
    const catalog = relatedCatalog(loadPage);
    try {
      const visit = async () => {
        const view = render(detailWithRelated(detail, catalog));
        await screen.findByRole('region', { name: title });
        const names = cardNames();
        view.unmount();
        return names;
      };
      const first = await visit();
      expect(first).toEqual(['A', 'B', 'C']);
      now += PLUGIN_CATALOG_REFRESH_MS - 1;
      expect(await visit()).toEqual(first);
      expect(loadPage).toHaveBeenCalledTimes(1);
      now++;
      random.mockReturnValue(0.99);
      const refreshed = await visit();
      expect(loadPage).toHaveBeenCalledTimes(2);
      expect(refreshed).toEqual(first);
      now += PLUGIN_CATALOG_REFRESH_MS;
      loadPage.mockImplementation(async ({ cursor }) => relatedPage(candidates.slice(3), String(Number(cursor) + 1)));
      expect(await visit()).toEqual(first);
      expect(loadPage).toHaveBeenCalledTimes(7);
      removeUnavailableRelatedPlugin(catalog.cache, 'B');
      expect(await visit()).toEqual(['A', 'E', 'C']);
      expect(loadPage).toHaveBeenCalledTimes(7);
    } finally {
      clock.mockRestore();
      random.mockRestore();
    }
  });

  it('keeps a failed load invisible until the next visit, then shows the one available plugin', async () => {
    const survivor = relatedItem('Only available plugin');
    const loadPage = vi.fn(async () => relatedPage([survivor]));
    loadPage.mockRejectedValueOnce(new Error('Directory unavailable'));
    const catalog = relatedCatalog(loadPage);
    const view = render(detailWithRelated(detail, catalog));
    await act(async () => {});
    expect(screen.queryByRole('region', { name: title })).toBeNull();
    view.rerender(detailWithRelated(detail, { ...catalog, online: false }));
    view.rerender(detailWithRelated(detail, { ...catalog, online: true }));
    expect(loadPage).toHaveBeenCalledTimes(1);
    view.unmount();
    render(detailWithRelated(detail, catalog));
    await screen.findByRole('region', { name: title });
    expect(cardNames()).toEqual([survivor.name]);
    expect(loadPage).toHaveBeenCalledTimes(2);
  });
});

describe('MarketPluginDetailView', () => {
  // Unit / #12735: the real catalog detail receives an official legacy ID with
  // no artwork. Previously the displayed icon was generic. A community item
  // of the same name must still show its own icon rather than the official mark.
  it.each([['official', true], ['personal', false]] as const)(
    'uses the legacy Antigravity mark only for the official detail (%s)',
    (publisherKind, expected) => {
      const { container } = renderDetail({ ghostId: 'engine', name: 'Antigravity', publisherKind });
      expect(Boolean(container.querySelector(`path[d="${ANTIGRAVITY_MARK_PATH}"]`))).toBe(expected);
    },
  );

  // Unit / §7: a verified manifest with a pending README must fit the real
  // detail body immediately. Existing collapsed-README cases use height zero.
  it('fits the detail immediately and keeps the disclosure stable when README arrives', () => {
    const viewport = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
      return this.tagName === 'MAIN' ? 800 : 0;
    });
    let measurements = 0;
    const getRect = HTMLElement.prototype.getBoundingClientRect;
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (!this.hasAttribute('data-plugin-detail-end')) return getRect.call(this);
      measurements++;
      return DOMRect.fromRect({ height: 480 });
    });
    const props = { busy: false, onBack: vi.fn(), onInstall: vi.fn(), onIconLoadError: vi.fn() };
    const declared = { ...detail, manifest: { ...manifest, readme: { en: 'README.md' } } };
    try {
      const { container, rerender } = render(<MarketPluginDetailView {...props} detail={marketItemSummary(detail)} />);
      const facts = screen.getByText('settings.ghosts.detail.infoTitle').closest('details')!;
      expect(facts.open).toBe(false);
      expect(screen.getByRole('button', { name: 'settings.ghosts.market.install' })).toHaveProperty('disabled', true);
      rerender(<MarketPluginDetailView {...props} detail={declared} />);
      const article = container.querySelector('article')!;
      expect(article.classList.contains('invisible')).toBe(false);
      expect(screen.getByRole('heading', { name: detail.name })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'settings.ghosts.market.install' })).toHaveProperty('disabled', false);
      expect(facts.open).toBe(true);
      const fittedMeasurements = measurements;

      rerender(<MarketPluginDetailView {...props} detail={{ ...declared,
        readme: { path: 'README.md', markdown: 'A visual guide', images: {} } }} />);
      expect(measurements).toBe(fittedMeasurements);
      expect(facts.open).toBe(true);
      const expand = screen.getByRole('button', { name: 'settings.ghosts.detail.descriptionExpand' });
      expect(expand.getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryByText('A visual guide')).toBeNull();
      fireEvent.click(expand);
      expect(screen.getByText('A visual guide')).toBeTruthy();
    } finally {
      viewport.mockRestore();
      geometry.mockRestore();
    }
  });

  it('keeps recommendations when a transient refresh leaves the verified manifest available', async () => {
    render(<MarketPluginDetailView detail={detail} busy={false} error="Refresh failed"
      relatedCatalog={relatedCatalog(async () => relatedPage([relatedItem('A plugin')]))}
      onOpenRelated={vi.fn()} onBack={vi.fn()} onIconLoadError={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'A plugin' })).toBeTruthy();
  });

  it('keeps the README collapsed when its body arrives after the manifest', () => {
    const props = { busy: false, onBack: vi.fn(), onIconLoadError: vi.fn() };
    const declared = { ...detail, manifest: { ...manifest, readme: { en: 'README.md' } } };
    const { rerender } = render(<MarketPluginDetailView {...props} detail={declared} />);
    const record = within(screen.getByRole('region', { name: 'settings.ghosts.detail.recordTitle' }));
    expect(record.getByText('settings.ghosts.detail.infoTitle').closest('details')?.open).toBe(false);
    rerender(<MarketPluginDetailView {...props} detail={{ ...declared,
      readme: { path: 'README.md', markdown: 'README body', images: {} } }} />);
    expect(screen.queryByText('README body')).toBeNull();
    expect(screen.getByRole('button', { name: 'settings.ghosts.detail.descriptionExpand' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps a standalone README behind the disclosure while the description stays in full', () => {
    const props = { busy: false, onBack: vi.fn(), onIconLoadError: vi.fn() };
    const { rerender } = render(<MarketPluginDetailView {...props} detail={marketItemSummary(detail)} />);
    expect(screen.queryByText('README body')).toBeNull();
    const record = within(screen.getByRole('region', { name: 'settings.ghosts.detail.recordTitle' }));
    const permission = record.getByText('settings.ghosts.detail.permissionsTitle').closest('summary')!;
    fireEvent.click(permission);
    fireEvent.click(permission);
    expect(permission.closest('details')?.open).toBe(false);
    rerender(<MarketPluginDetailView {...props} detail={{ ...detail,
      readme: { path: 'README.md', markdown: 'README body', images: {} } }} />);
    expect(screen.queryByText('README body')).toBeNull();
    const description = screen.getByText(detail.description!);
    expect(description.classList.contains('line-clamp-2')).toBe(false);
    const expand = screen.getByRole('button', { name: 'settings.ghosts.detail.descriptionExpand' });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(expand);
    expect(screen.getByText('README body')).toBeTruthy();
    expect(description.classList.contains('line-clamp-2')).toBe(false);
    expect(permission.closest('details')?.open).toBe(false);
    expect(record.getByText('settings.ghosts.detail.infoTitle').closest('details')?.open).toBe(false);
  });

  // Unit / user-feedback-1: actual rendered markup is compiled with the same
  // Tailwind dependency, then measured via computed style. The old loading test
  // only checked identity/buttons and missed a reserved height after completion.
  it.each([0, 4, 7])('leaves no README placeholder and keeps facts closed with %i tools at height zero', async count => {
    const { container } = renderDetail({ readme: null, manifest: { ...manifest,
      tools: Array.from({ length: count }, (_, index) => ({ name: `tool-${index}`, description: 'A tool' })) } });
    const { css } = await postcss([tailwindcss({ content: [{ raw: container.innerHTML, extension: 'html' }],
      corePlugins: { preflight: false } })]).process('@tailwind utilities;', { from: undefined });
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    try {
      const record = within(screen.getByRole('region', { name: 'settings.ghosts.detail.recordTitle' }));
      const permissions = record.getByText('settings.ghosts.detail.permissionsTitle').closest('details')!;
      expect(permissions.open).toBe(false);
      expect(screen.queryByText('settings.ghosts.detail.readmeTitle')).toBeNull();
      expect(permissions.previousElementSibling).toBeNull();
      expect(Number.parseFloat(getComputedStyle(permissions).minHeight) || 0).toBe(0);
      const details = record.getByText('settings.ghosts.detail.infoTitle').closest('details')!;
      expect(details.open).toBe(false);
      if (count > 0) {
        const tools = record.getByText('settings.ghosts.detail.toolsTitle').closest('details')!;
        expect(tools).toBe(details);
      }
    } finally { style.remove(); }
  });

  // Unit / unified loading design: real cache reads must stay bounded and cannot
  // carry a manifest into a new owner/language partition. No prior cache cases.
  it('evicts the least recently used detail at 50 entries and clears on scope changes', async () => {
    const cache = marketDetailCacheFor('cache-owner-A/en');
    for (let index = 0; index < 50; index++) {
      await cache.load(String(index), async () => ({ ...detail, pluginId: String(index) }));
    }
    cache.peek('0');
    await cache.load('50', async () => ({ ...detail, pluginId: '50' }));
    expect(cache.peek('0')).toBeTruthy();
    expect(cache.peek('1')).toBeUndefined();
    expect(marketDetailCacheFor('cache-owner-A/zh-CN').peek('0')).toBeUndefined();
    expect(marketDetailCacheFor('cache-owner-B/zh-CN').peek('0')).toBeUndefined();
  });
  // Unit / PR review G2: README images have no digest in the renderer mapping.
  // Existing icon-renewal tests miss a plugin without an icon whose signed
  // README URL changes after expiry. Both opening and background reads must
  // deliver that renewed address to the existing README component.
  it.each(['open', 'background', 'prefetch'] as const)('renews signed README images on a stale %s read', async mode => {
    const cache = marketDetailCacheFor(`readme-renewal-${mode}`);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    try {
      const readme = { path: 'README.md', markdown: '![Guide](guide.png)', images: { 'guide.png': 'https://images.invalid/guide.png?signature=expired' } };
      await cache.load(detail.pluginId, async () => ({ ...detail, readme }));
      clock.mockReturnValue(41_000);
      const renewed = { ...readme, images: { 'guide.png': 'https://images.invalid/guide.png?signature=renewed' } };
      const result = await cache.load(detail.pluginId, async () => ({ ...detail, readme: renewed }), mode);
      expect(result.readme?.images['guide.png']).toBe(renewed.images['guide.png']);
      expect(cache.peek(detail.pluginId)?.readme).toBe(result.readme);
      const unchanged = await cache.load(detail.pluginId, async () => ({ ...detail, readme: { ...renewed } }), 'background');
      expect(unchanged).toBe(result);
    } finally { clock.mockRestore(); }
  });
  // Unit / plugin-page-ux-fix: only a pending IPC with a catalog summary exposes
  // the old whole-page wait; existing cases all pass a complete manifest.
  it('delays loading feedback, keeps identity nodes, and never presents unknown permissions as empty', () => {
    vi.useFakeTimers();
    try {
      const item = { ...detail, manifest: undefined };
      const props = { busy: false, onBack: vi.fn(), onInstall: vi.fn(), onIconLoadError: vi.fn() };
      const { rerender } = render(<MarketPluginDetailView {...props} detail={item} />);
      const heading = screen.getByRole('heading', { level: 1, name: detail.name });
      expect(screen.getByRole('button', { name: 'settings.ghosts.market.install' })).toHaveProperty('disabled', true);
      expect(screen.queryByText('settings.ghosts.market.noPermissions')).toBeNull();
      act(() => { vi.advanceTimersByTime(299); });
      expect(screen.queryByRole('button', { name: 'settings.ghosts.remote.detailLoading' })).toBeNull();
      act(() => { vi.advanceTimersByTime(1); });
      expect(screen.getByRole('button', { name: 'settings.ghosts.remote.detailLoading' })).toHaveProperty('disabled', true);
      rerender(<MarketPluginDetailView {...props} detail={detail} />);
      expect(screen.getByRole('heading', { level: 1, name: detail.name })).toBe(heading);
      expect(screen.getByRole('button', { name: 'settings.ghosts.market.install' })).toHaveProperty('disabled', false);
    } finally { vi.useRealTimers(); }
  });
  it('shows download and weekly use counts in the uninstalled plugin hero', () => {
    const { container } = renderDetail({
      publisherKind: 'official',
      downloadStatistics: { requestCount: '0' },
      usageStatistics: { usageCount: '8932', usageCountLast7Days: '12', asOf: '2026-10-13T00:00:00Z' },
    });
    const header = container.querySelector('header');
    const banner = header?.querySelector<HTMLElement>('[data-v5-detail-header]')!;
    expect(within(banner).getByRole('button', { name: 'settings.ghosts.market.install' })).toBeTruthy();
    expect(within(banner).queryByRole('switch')).toBeNull();
    expect(header?.textContent).toContain('v1.3.11');
    expect(within(header!).getByRole('group', { name: '0 settings.ghosts.usage.downloadsValue' })).toBeTruthy();
    expect(within(header!).getByRole('group', { name: 'settings.ghosts.detail.heroWeeklyUsage 12' })).toBeTruthy();
    expect(container.textContent).not.toContain('settings.ghosts.usage.title');
    const source = 'settings.ghosts.detail.publicInstall';
    const publisher = 'settings.ghosts.market.publisherDescription.official';
    expect(within(header!).queryByText(source)).toBeNull();
    expect(within(header!).queryByText(publisher)).toBeNull();
    expect(within(header!).getByText('settings.ghosts.market.publisherKind.official')).toBeTruthy();
    const details = screen.getByText('settings.ghosts.detail.infoTitle');
    fireEvent.click(details);
    expect(within(details.closest('details')!).getByText(source)).toBeTruthy();
    expect(within(details.closest('details')!).getByText(publisher)).toBeTruthy();
  });

  // Unit: the real facts grid shows the listed package size next to its version.
  it('shows the listed package size after version when the plugin is not installed', () => {
    renderDetail({ sizeBytes: 1_258_291 });
    const facts = screen.getByText('settings.ghosts.detail.infoTitle').closest('details')!;
    const version = within(facts).getByText('settings.ghosts.detail.infoVersion').parentElement!;
    const size = within(facts).getByText('settings.ghosts.detail.infoPackageSize').parentElement!;
    expect(version.nextElementSibling).toBe(size);
    expect(within(size).getByText('1.2 MB')).toBeTruthy();
  });

  it('puts recent changes below the description and tools inside details', () => {
    renderDetail({ manifest: { ...manifest, releaseNotes: 'Changes in 1.3.11', tools: [{ name: 'calendar', description: 'Read events' }] } });
    const updates = screen.getByRole('heading', { name: /settings.ghosts.detail.recentUpdates/ }).closest('section')!;
    const record = within(screen.getByRole('region', { name: 'settings.ghosts.detail.recordTitle' }));
    const facts = record.getByText('settings.ghosts.detail.infoTitle').closest('details')!;
    expect(facts.open).toBe(false);
    expect(record.getByText('settings.ghosts.detail.toolCount').closest('details')).toBe(facts);
    expect(screen.getByText('Connect Google Calendar').compareDocumentPosition(updates) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(updates.compareDocumentPosition(facts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(updates).getByText('Changes in 1.3.11')).toBeTruthy();
    expect(updates.querySelector('.plugin-recent-updates-timeline')).toBeNull();
    expect(within(updates).queryByRole('button', { name: /olderUpdates/i })).toBeNull();
  });

  // Unit: a long sole update plus an earlier release must still stay compact,
  // and the latest available notes keep their own date/version.
  it('caps the latest notes at four lines and keeps older notes closed even as the only block', () => {
    const latestNotes = Array.from({ length: 14 }, (_, i) => `Update detail ${i + 1}`).join('\n');
    renderDetail({ updates: [
      { version: '1.2.0', publishedAt: '2026-07-10T12:00:00Z', releaseNotes: latestNotes },
      { version: '1.1.0', publishedAt: '2026-07-02T12:00:00Z', releaseNotes: 'Earlier changes' },
    ] });
    const section = screen.getByRole('region', { name: 'settings.ghosts.detail.recentUpdates' });
    const notes = section.querySelector('p')!;
    expect(within(section).getByText('v1.2.0')).toBeTruthy();
    expect(within(section).getByText('Jul 10').getAttribute('datetime')).toBe('2026-07-10T12:00:00Z');
    expect(notes.textContent).toBe(latestNotes);
    expect(notes.classList.contains('line-clamp-4')).toBe(true);
    expect(within(section).queryByText('Earlier changes')).toBeNull();
    const older = within(section).getByRole('button', { name: 'settings.ghosts.detail.olderUpdates 1' });
    const list = document.getElementById(older.getAttribute('aria-controls')!);
    expect(list).toHaveProperty('hidden', true);
    expect(older.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(older);
    expect(list).toHaveProperty('hidden', false);
    expect(older.getAttribute('aria-expanded')).toBe('true');
    expect(within(section).getByText('Earlier changes').classList.contains('line-clamp-4')).toBe(true);
    expect(notes.classList.contains('line-clamp-4')).toBe(true);
    fireEvent.click(within(section).getByRole('button', { name: 'settings.ghosts.detail.collapseOlderUpdates' }));
    expect(within(section).queryByText('Earlier changes')).toBeNull();
  });

  // Unit / round2 §4.2: history keeps each note's own disclosure and limit.
  it('expands a single historical release while leaving the other four-line caps intact', () => {
    const getRect = HTMLElement.prototype.getBoundingClientRect;
    const getStyle = window.getComputedStyle;
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.tagName === 'P' && this.textContent?.startsWith('Long historical note')) {
        return DOMRect.fromRect({ width: 400, height: 180 });
      }
      return getRect.call(this);
    });
    const styles = vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
      const style = getStyle(element, pseudo);
      if (element.tagName === 'P' && element.textContent?.startsWith('Long historical note')) style.lineHeight = '20px';
      return style;
    });
    try {
      renderDetail({ updates: [
        { version: '1.2.0', publishedAt: '2026-07-10T12:00:00Z', releaseNotes: 'Latest note' },
        { version: '1.1.0', publishedAt: '2026-07-02T12:00:00Z', releaseNotes: 'Long historical note A' },
        { version: '1.0.0', publishedAt: '2026-06-27T12:00:00Z', releaseNotes: 'Long historical note B' },
      ] });
      const updates = within(screen.getByRole('region', { name: 'settings.ghosts.detail.recentUpdates' }));
      fireEvent.click(updates.getByRole('button', { name: 'settings.ghosts.detail.olderUpdates 2' }));
      const first = updates.getByText('Long historical note A');
      const second = updates.getByText('Long historical note B');
      expect(first.classList.contains('line-clamp-4')).toBe(true);
      fireEvent.click(within(first.closest('li')!).getByRole('button', { name: 'settings.ghosts.detail.descriptionExpand' }));
      expect(first.classList.contains('line-clamp-4')).toBe(false);
      expect(second.classList.contains('line-clamp-4')).toBe(true);
      expect(updates.getByText('Latest note').classList.contains('line-clamp-4')).toBe(true);
      fireEvent.click(within(first.closest('li')!).getByRole('button', { name: 'settings.ghosts.detail.descriptionCollapse' }));
      expect(first.classList.contains('line-clamp-4')).toBe(true);
    } finally {
      geometry.mockRestore();
      styles.mockRestore();
    }
  });

  it('leaves out the update block with neither history nor manifest notes', () => {
    renderDetail({ updates: [] });
    expect(screen.queryByRole('heading', { name: /recentUpdates/ })).toBeNull();
  });

  it('shows the marketing description outside the conflict state', () => {
    renderDetail();
    const description = screen.getByText('Connect Google Calendar');
    expect(description.id).toBe('');
    expect(
      screen
        .getByRole('button', { name: /settings\.ghosts\.market\.install/ })
        .getAttribute('aria-describedby'),
    ).toBeNull();
  });

  it('presents server catalog permissions before the package is downloaded', () => {
    renderDetail();
    expect(screen.getByText('settings.ghosts.perm.grantsTitle')).toBeTruthy();
    expect(screen.queryByText('settings.ghosts.installConsent.customMarketSourceNotice')).toBeNull();
    expect(screen.queryByText('settings.ghosts.market.communityDisclaimer')).toBeNull();
  });

  it('uses the source line under the detail header for the community disclaimer', () => {
    renderDetail({ publisherKind: 'personal' });
    const action = screen.getByRole('button', { name: 'settings.ghosts.market.install' });
    const notice = screen.getByText('settings.ghosts.market.communityDisclaimer');
    expect(action.getAttribute('aria-describedby')).toBe(notice.id);
    expect(screen.getByText('Connect Google Calendar').compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(notice.parentElement).toBe(action.closest('header'));
    expect(screen.queryByText('settings.ghosts.market.publisherDescription.community')).toBeNull();
  });

  it('keeps the custom marketplace source notice visible below the description', () => {
    renderDetail({ sourceType: 'git-market', sourceMarketName: 'Example marketplace' });
    const notice = screen.getByText('settings.ghosts.installConsent.customMarketSourceNotice');
    expect(notice.closest('details')).toBeNull();
    expect(screen.getByText('Connect Google Calendar').compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('offers an explicit same-id replacement and binds its explanation to the action', () => {
    renderDetail({ installState: 'conflict' });

    const reason = screen.getByText('settings.ghosts.market.replaceDescription');
    expect(reason.id).toBeTruthy();
    // 替换提示不能遮掉插件本身的用途。
    expect(screen.getByText('Connect Google Calendar')).toBeTruthy();

    const action = screen.getByRole('button', {
      name: /settings\.ghosts\.market\.replace$/,
    }) as HTMLButtonElement;
    expect(action.disabled).toBe(false);
    expect(action.getAttribute('aria-describedby')).toBe(reason.id);
  });

  // Renderer unit: a long manifest keeps the first five display rows and all
  // network destinations readable before a first install.
  it('merges network targets and expands the remaining install permissions in place', () => {
    renderDetail({ manifest: { ...manifest, network: { hosts: ['api.example.com', 'files.example.com'] },
      tools: Array.from({ length: 7 }, (_, index) => ({ name: `action-${index}`, description: 'Example action' })) } });
    const record = within(screen.getByRole('region', { name: 'settings.ghosts.detail.recordTitle' }));
    const row = record.getByText('settings.ghosts.detail.permissionsTitle').closest('details')!;
    expect(row.open).toBe(false);
    fireEvent.click(row.querySelector('summary')!);
    expect(row.open).toBe(true);
    expect(row.querySelectorAll('li')).toHaveLength(5);
    expect(screen.getByText('api.example.com, files.example.com')).toBeTruthy();
    const more = within(row).getByRole('button', { name: 'settings.ghosts.detail.remainingPermissions' });
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(row.querySelectorAll('li').length).toBeGreaterThan(5);
    expect(screen.getByRole('heading', { name: 'settings.ghosts.market.securityTitle' }).closest('details')).toBe(row);
    fireEvent.click(more);
    expect(row.querySelectorAll('li')).toHaveLength(5);
  });

  it('falls back to the ghostId when a plugin has no description', () => {
    renderDetail({ description: null });
    expect(screen.getByText('google-calendar', { selector: 'header p' })).toBeTruthy();
  });

  it('hides the install action when the host does not provide one', () => {
    render(
      <MarketPluginDetailView
        detail={detail}
        busy={false}
        onBack={vi.fn()}
        onIconLoadError={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /settings\.ghosts\.market\.install/ })).toBeNull();
  });

  // 测试价值
  // - 生产入口与可观察结果：市场详情页的安装按钮位置；本机插件页显示本窗口发起的首装进度，
  //   完成写「已安装」，失败写「安装失败」并给出「重试」；远程设备页不显示本机进度。
  // - Bug／规则依据：verified-downloads.md「下载进度与界面」插件市场首装此前只有按钮转圈。
  // - 现有覆盖缺口：页面导航用例只走完整流程，不覆盖远程页不接本机进度这一分支。
  // - 最小失败输入：首装进行中、完成、失败（带原因，PR #11305 评审：单项失败原因不能只留在提示里）
  //   三种状态 × showInstallProgress 开 / 关。
  // - tier：unit（jsdom，直接驱动窗口级进度）。
  it.each([
    { name: 'shows a first install in progress', showInstallProgress: true, step: 'running', ring: 'downloadProgress.phase.preparing', button: null },
    { name: 'says Installed when a first install lands', showInstallProgress: true, step: 'done', ring: 'settings.ghosts.market.installed', button: null },
    { name: 'keeps the reason and offers a retry when it fails', showInstallProgress: true, step: 'failed', ring: 'Download timed out', button: 'commonUi.retry' },
    { name: 'leaves a remote computer\'s view untouched', showInstallProgress: false, step: 'running', ring: null, button: 'settings.ghosts.market.install' },
  ] as const)('$name', ({ showInstallProgress, step, ring, button }) => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      pluginMarket: { onInstallProgress: () => () => undefined },
    };
    act(() => {
      beginPluginInstallProgress(detail.pluginId, 'install');
      if (step === 'done') succeedPluginInstallProgress(detail.pluginId);
      // The same translated words the failure toast showed; the detail page has room to keep them.
      if (step === 'failed') failPluginInstallProgress(detail.pluginId, 'Download timed out');
    });
    try {
      render(
        <MarketPluginDetailView
          detail={detail}
          busy={false}
          showInstallProgress={showInstallProgress}
          onBack={vi.fn()}
          onInstall={vi.fn()}
          onIconLoadError={vi.fn()}
        />,
      );
      expect(screen.queryByRole('progressbar', { name: detail.name })?.textContent ?? null).toBe(ring);
      // The ring takes the button's place while running and when done; a failure brings back a retry.
      expect(screen.queryByRole('button', { name: 'settings.ghosts.market.install' }) !== null)
        .toBe(button === 'settings.ghosts.market.install');
      expect(screen.queryByRole('button', { name: 'commonUi.retry' }) !== null).toBe(button === 'commonUi.retry');
    } finally {
      act(() => __resetPluginInstallProgressForTest());
    }
  });

  it('replaces the install action with a spinner while busy', () => {
    render(
      <MarketPluginDetailView
        detail={detail}
        busy
        onBack={vi.fn()}
        onInstall={vi.fn()}
        onIconLoadError={vi.fn()}
      />,
    );

    const action = screen.getByRole('button', {
      name: /settings\.ghosts\.market\.install/,
    });
    expect(action.getAttribute('aria-busy')).toBe('true');
    expect(action.querySelector('.animate-spinner')).toBeTruthy();
    // Preserve the label width and accessible name while only the spinner is visible.
    expect(action.firstElementChild?.classList.contains('opacity-0')).toBe(true);
    expect(action.firstElementChild?.textContent).toContain('settings.ghosts.market.install');
    expect(action.lastElementChild?.getAttribute('aria-hidden')).toBe('true');
    expect(action.hasAttribute('disabled')).toBe(true);
  });
});
