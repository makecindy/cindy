import type { ComponentProps, ReactNode, RefObject, UIEventHandler } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { cn } from '@/lib/utils';
import { GhostPluginDetailView } from './GhostPluginDetailView';
import { RemotePluginReadOnlyDetail } from './RemotePluginReadOnlyDetail';
import { MarketPluginDetailView } from './MarketPluginDetailView';
import { PluginCatalogBrowser } from './PluginCatalogBrowser';
import { PluginVirtualGrid } from './PluginVirtualGrid';
import {
  CatalogTargetControls,
  InstalledCatalogHeader,
  PluginManagementLayout,
  PluginManagementPage,
} from './PluginManagementLayout';
import { PluginCatalogPanels } from './lib/PluginCatalogPanels';
import { PluginRecommendationSlots } from './lib/PluginRecommendationSlots';

type CatalogTab = 'installed' | 'market';
type Market = Omit<ComponentProps<typeof PluginCatalogBrowser>, 'query' | 'filterHost' | 'scrollRef' | 'onScope'> & {
  onScope: ComponentProps<typeof PluginCatalogBrowser>['onScope'];
  total: number | null;
};

export type PluginCatalogDetail =
  | { installed: ComponentProps<typeof GhostPluginDetailView> }
  | { market: ComponentProps<typeof MarketPluginDetailView> }
  | { readOnly: ComponentProps<typeof RemotePluginReadOnlyDetail> };

export interface PluginCatalogModel {
  embedded?: boolean;
  onSelectCatalogTab?: ComponentProps<typeof PluginManagementLayout>['onSelectTab'];
  query: string;
  onQueryChange(query: string): void;
  scrollRef: RefObject<HTMLElement | null>;
  onScroll: UIEventHandler<HTMLElement>;
  tabsRef: RefObject<HTMLDivElement | null>;
  filtersRef: RefObject<HTMLDivElement | null>;
  tab: CatalogTab;
  onSelectTab(tab: CatalogTab): void;
  target: ComponentProps<typeof CatalogTargetControls>;
  headerActions?: ReactNode;
  publication?: { open(): void; disabled?: boolean; indicator?: ReactNode };
  notice?: ReactNode;
  scopeNotice?: ReactNode;
  installedTotal: number;
  installedCount?: number;
  installedGrid?: Omit<ComponentProps<typeof PluginVirtualGrid>, 'scrollRef' | 'active'>;
  installedSentinel?: RefObject<HTMLDivElement | null>;
  installedNotice?: ReactNode;
  installedEmpty?: ReactNode;
  recommendations?: { loading: boolean; cards: ReactNode };
  market?: Market;
  wrapSections?(sections: ReactNode): ReactNode;
}

type PluginCatalogViewProps = {
  aside?: ReactNode;
  overlay?: ReactNode;
} & (
  | { catalog: PluginCatalogModel; detail?: never; notice?: never }
  | { catalog?: never; detail: PluginCatalogDetail; notice?: ReactNode }
);

export function PluginCatalogView({ catalog, detail, notice, aside, overlay }: PluginCatalogViewProps) {
  if (detail) {
    return (
      <div className="flex h-full min-h-0 w-full">
        <div className="flex min-w-0 flex-1 flex-col">
          {notice}
          <div className="min-h-0 flex-1">
            {'installed' in detail
              ? <GhostPluginDetailView {...detail.installed} />
              : 'market' in detail
                ? <MarketPluginDetailView key={detail.market.detail.pluginId} {...detail.market} />
                : <RemotePluginReadOnlyDetail {...detail.readOnly} />}
          </div>
        </div>
        {aside}
        {overlay}
      </div>
    );
  }

  return <PluginCatalogList catalog={catalog} aside={aside} overlay={overlay} />;
}

function PluginCatalogList({ catalog, aside, overlay }: {
  catalog: PluginCatalogModel;
  aside: ReactNode;
  overlay: ReactNode;
}) {
  const { t } = useTranslation();
  const {
    embedded, onSelectCatalogTab, query, onQueryChange, scrollRef, onScroll, tabsRef, filtersRef,
    tab, onSelectTab, target, headerActions, publication, notice, scopeNotice, installedTotal, installedCount,
    installedGrid, installedSentinel, installedNotice, installedEmpty, recommendations, market, wrapSections,
  } = catalog;
  const marketTotal = market?.total;
  const searching = Boolean(query.trim());
  const showInstalled = !market || searching || tab === 'installed';
  const alignTabs = () => {
    const root = scrollRef.current;
    const tabs = tabsRef.current;
    if (!root || !tabs) return;
    const distance = tabs.getBoundingClientRect().top - root.getBoundingClientRect().top;
    if (distance < 0) root.scrollTop += distance;
  };

  const sections = (
    <>
      {!searching && recommendations ? (
        <section className="mt-6 min-w-0">
          <h2 className="mb-4 text-20 font-medium text-[var(--text-primary)]">{t('settings.ghosts.page.todayRecommendations')}</h2>
          <PluginRecommendationSlots loading={recommendations.loading}>{recommendations.cards}</PluginRecommendationSlots>
        </section>
      ) : null}
      {!searching && market ? (
        <>
          <div ref={tabsRef} className="mt-6 h-0" />
          <div className="sticky top-0 z-raised flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-default)] app-wallpaper-surface bg-[var(--surface)] py-3">
            <SegmentedControl<CatalogTab>
              role="tablist"
              density="lg"
              optionClassName="plugin-management-tab min-w-[88px] px-4 text-13"
              value={tab}
              onValueChange={value => {
                if (value === 'market' && tab !== 'market') market.onScope('official');
                onSelectTab(value);
                alignTabs();
              }}
              aria-label={t('settings.ghosts.page.secondaryTabsAria')}
              options={[
                { value: 'installed', label: <>{t('settings.ghosts.page.installedSection')} <span className="ml-1.5 inline-block min-w-[3ch] text-right tabular-nums">{installedTotal}</span></> },
                { value: 'market', label: <>{t('settings.ghosts.page.marketSection')} <span className="ml-1.5 inline-block min-w-[3ch] text-right tabular-nums">{marketTotal ?? '\u00a0'}</span></> },
              ]}
            />
            <div ref={filtersRef} className="min-w-0" />
          </div>
        </>
      ) : null}
      {scopeNotice}
      <PluginCatalogPanels scrollRef={scrollRef} query={query}>
        <section hidden={!showInstalled} className="plugin-motion-page-section mt-6 min-w-0">
          <InstalledCatalogHeader title={t('settings.ghosts.page.installedSection')} count={installedCount} />
          {installedNotice}
          {installedGrid ? <PluginVirtualGrid {...installedGrid} scrollRef={scrollRef} active={showInstalled} /> : null}
          {installedSentinel ? <div ref={installedSentinel} className="h-1" /> : null}
          {installedEmpty}
        </section>
        {market ? (
          <PluginCatalogBrowser
            {...market}
            query={query}
            filterHost={filtersRef}
            scrollRef={scrollRef}
            onScope={value => { market.onScope(value); alignTabs(); }}
          />
        ) : null}
      </PluginCatalogPanels>
    </>
  );

  return (
    <PluginManagementLayout
      activeTab="plugins"
      embedded={embedded}
      query={query}
      onQueryChange={value => {
        onQueryChange(value.slice(0, 100));
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
      }}
      onSelectTab={onSelectCatalogTab}
      headerActions={<>
        {publication ? (
          <Button variant="secondary" size="lg" disabled={publication.disabled} onClick={publication.open}>
            {t('settings.ghosts.contribution.myPlugins')}
            {publication.indicator}
          </Button>
        ) : null}
        {headerActions}
      </>}
    >
      <div className="flex min-h-0 flex-1">
        <main
          ref={scrollRef}
          onScroll={onScroll}
          className={cn(
            'app-wallpaper-surface min-h-0 w-full min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]',
            embedded ? 'bg-transparent' : 'bg-[var(--surface)]',
          )}
        >
          <PluginManagementPage>
            {notice}
            <header className="plugin-motion-page-header pb-2" data-catalog-region="heading">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h1 className="text-28 font-medium leading-tight text-[var(--text-primary)]">
                  {t('settings.ghosts.title')}
                </h1>
                <CatalogTargetControls {...target} />
              </div>
              <p className="mt-2 max-w-2xl text-14 leading-[1.714] text-[var(--text-secondary)]">
                {t('settings.ghosts.description')}
              </p>
            </header>
            {wrapSections ? wrapSections(sections) : sections}
          </PluginManagementPage>
        </main>
        {aside}
      </div>
      {overlay}
    </PluginManagementLayout>
  );
}
