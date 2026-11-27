import { useState, type ComponentProps, type ReactNode, type RefObject, type UIEventHandler } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { PluginCatalogPublishButton } from './GhostPluginActions';
import { GhostPluginDetailView } from './GhostPluginDetailView';
import { RemotePluginReadOnlyDetail } from './RemotePluginReadOnlyDetail';
import { MarketPluginDetailView } from './MarketPluginDetailView';
import { PluginCatalogBrowser } from './PluginCatalogBrowser';
import { PluginVirtualGrid } from './PluginVirtualGrid';
import {
  CatalogTargetControls,
  CatalogHeading,
  CatalogHeadingTabs,
  CatalogSectionHeader,
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
  tab: CatalogTab;
  onSelectTab(tab: CatalogTab): void;
  target: ComponentProps<typeof CatalogTargetControls>;
  headerActions?: ReactNode;
  publication?: ComponentProps<typeof PluginCatalogPublishButton>;
  notice?: ReactNode;
  scopeNotice?: ReactNode;
  installedTotal: number;
  installedCount?: number;
  installedGrid?: Omit<ComponentProps<typeof PluginVirtualGrid>, 'scrollRef' | 'active'>;
  installedSentinel?: RefObject<HTMLDivElement | null>;
  installedNotice?: ReactNode;
  installedEmpty?: ReactNode;
  recommendations?: ComponentProps<typeof PluginRecommendationSlots>;
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
  const [searchScope, setSearchScope] = useState<Market['scope']>('all');
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

  return <PluginCatalogList catalog={catalog} aside={aside} overlay={overlay}
    searchScope={searchScope} onSearchScope={setSearchScope} />;
}

function PluginCatalogList({ catalog, aside, overlay, searchScope, onSearchScope }: {
  catalog: PluginCatalogModel;
  aside: ReactNode;
  overlay: ReactNode;
  searchScope: Market['scope'];
  onSearchScope: Market['onScope'];
}) {
  const { t } = useTranslation();
  const {
    embedded, onSelectCatalogTab, query, onQueryChange, scrollRef, onScroll, tabsRef,
    tab, onSelectTab, target, headerActions, publication, notice, scopeNotice, installedTotal, installedCount,
    installedGrid, installedSentinel, installedNotice, installedEmpty, recommendations, market, wrapSections,
  } = catalog;
  const searching = Boolean(query.trim());
  const showInstalled = !market || searching || tab === 'installed';
  const title = t(searching ? 'settings.ghosts.page.searchResults' : !market ? 'settings.ghosts.title'
    : tab === 'market' ? 'settings.ghosts.page.marketSection' : 'settings.ghosts.page.installedSection');
  const alignTabs = () => {
    const root = scrollRef.current;
    const tabs = tabsRef.current;
    if (!root || !tabs) return;
    const distance = tabs.getBoundingClientRect().top - root.getBoundingClientRect().top;
    if (distance < 0) root.scrollTop += distance;
  };

  const sections = (
    <>
      {!searching && tab === 'market' && market && recommendations ? (
        <section className="plugin-catalog-recommendations min-w-0">
          <PluginRecommendationSlots {...recommendations} />
        </section>
      ) : null}
      {scopeNotice}
      <PluginCatalogPanels scrollRef={scrollRef} query={query}>
        <section hidden={!showInstalled} className="plugin-motion-page-section mt-6 min-w-0">
          {searching || !market ? (
            <CatalogSectionHeader region="installed" title={t('settings.ghosts.page.installedSection')} count={installedCount} />
          ) : null}
          {installedNotice}
          {installedGrid ? <PluginVirtualGrid {...installedGrid} scrollRef={scrollRef} active={showInstalled} /> : null}
          {installedSentinel ? <div ref={installedSentinel} className="h-1" /> : null}
          {installedEmpty}
        </section>
        {market ? (
          <PluginCatalogBrowser
            {...market}
            scope={searching ? searchScope : market.scope}
            query={query}
            scrollRef={scrollRef}
            onScope={value => { (searching ? onSearchScope : market.onScope)(value); alignTabs(); }}
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
        if (!searching && value.trim()) onSearchScope('all');
        onQueryChange(value.slice(0, 100));
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
      }}
      onSelectTab={onSelectCatalogTab}
      headerActions={<>
        {publication ? <PluginCatalogPublishButton {...publication} /> : null}
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
          <PluginManagementPage className="plugin-catalog-frame">
            <CatalogHeading
              anchor={tabsRef}
              searching={searching}
              title={title}
              target={<CatalogTargetControls {...target} />}
              tabs={market ? (
                <CatalogHeadingTabs
                  value={tab}
                  installedCount={installedTotal}
                  marketCount={market.total}
                  onValueChange={value => {
                    if (value === 'market' && tab !== 'market') market.onScope('official');
                    onSelectTab(value);
                    alignTabs();
                  }}
                />
              ) : undefined}
            />
            {notice ? <div className="mt-6">{notice}</div> : null}
            {wrapSections ? wrapSections(sections) : sections}
          </PluginManagementPage>
        </main>
        {aside}
      </div>
      {overlay}
    </PluginManagementLayout>
  );
}
