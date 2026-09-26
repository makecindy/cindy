import { Button } from '@/components/ui/button';
/**
 * SkillhubHomeView — 技能(SkillHub)首页,/skillhub/local index。
 *
 * 重构(2026-06):SkillHub 不再用"左侧树导航 + 右侧内容"。左侧 app 侧栏还给
 * 项目/对话列表;技能整页在右侧主区,无常驻导航树,改为下钻(下一步)+ 回退:
 * 公开、可选的组织目录和本地技能在同一行切换；“更多”进入完整 Market。
 */

import { buildMarketSkillRoute, withSkillDetailReturn } from './lib/detailRoutes';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams, type Location } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { skillhubCatalogKey } from '../../../shared/skillhubCatalog';
import { CATEGORY_ALL } from '../../../shared/skillhubCategory';
import {
  Bot,
  ChevronRight,
  Package,
  SquareTerminal,
  Upload,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { toast } from '@/lib/toast';
import { useAuth } from '@/contexts/AuthContext';
import {
  PLUGIN_MANAGEMENT_CARD_GRID_CLASS,
  PluginManagementLayout,
  PluginManagementPage,
} from '@/features/plugin/PluginManagementLayout';
import { buildLocalSkillRoute, findLocalSkillByPath } from './lib/localRoutes';
import {
  builtInSkillDescriptionKey,
  prioritizeCindyBuiltInSkills,
} from './lib/builtInSkillPresentation';
import { refresh as refreshSkillhub, useSkillhub } from './hooks/useSkillhub';
import {
  MARKET_PAGE_SIZE,
  useCategoryList,
  useMarketList,
  type MarketSkill,
} from './hooks/useMarketList';
import { basename, deriveProjectWorkingDir } from './lib/pathDerivations';
import { projectHash } from './lib/projectHash';
import {
  homeMarketQuery,
  isHomeMarketResponseCurrent,
  visibleHomeCatalogTabs,
  type HomeMarketFilter,
} from './lib/homeMarketFilter';
import { deriveSkillSource } from './lib/skillSource';
import { InstallTargetPicker, type InstallTargetSkill } from './components/InstallTargetPicker';
import { SkillCategoryFilterBar } from './components/SkillCategoryFilterBar';
import { MarketListError } from './components/MarketListError';
import { HomeMarketCard } from './components/HomeMarketCard';
import { SkillIcon } from './components/SkillIcon';
import { SkillPublishUpdateHint } from './SkillPublishUpdateHint';
import { OfficialSkillBadge } from './components/OfficialSkillBadge';
import { useSkillhubHomeNavigation } from './hooks/useSkillhubHomeNavigation';
import { useMarketSkillUpdate } from './hooks/useMarketSkillUpdate';

const KIND_ICON: Record<string, LucideIcon> = {
  skill: Package,
  command: SquareTerminal,
  agent: Bot,
};

function includesSkillQuery(values: ReadonlyArray<string | undefined>, query: string): boolean {
  if (!query) return true;
  return values.some((value) => value?.toLocaleLowerCase().includes(query));
}

export function SkillhubHomeView({
  embedded = false,
  active = true,
  navigationLocation,
  onSelectCatalogTab,
}: {
  embedded?: boolean;
  active?: boolean;
  navigationLocation?: Location;
  onSelectCatalogTab?: (tab: 'plugins' | 'skills') => void;
} = {}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [initialSearch] = useSearchParams();
  const { skills, projects, bootstrapped, syncResults } = useSkillhub();
  const { catalogTab, query, setCatalogTab, setQuery } = useSkillhubHomeNavigation(navigationLocation);
  const normalizedQuery = query.trim().toLocaleLowerCase();

  // 未登录也请求公开 Skill 目录；登录身份只扩大服务端可见范围。
  const { user } = useAuth();
  const marketUpdate = useMarketSkillUpdate();
  const showOrganization = user?.membershipKind === 'org';
  const marketFilter: HomeMarketFilter = catalogTab === 'organization' ? 'organization' : 'public';
  const marketRequest = useMemo(() => homeMarketQuery(marketFilter), [marketFilter]);

  // 主 Skill Tab 直接分页展示当前云端目录；“更多”仍进入带完整筛选能力的 Market。
  const {
    items: marketItems,
    loading: marketLoading,
    loadingMore: marketLoadingMore,
    error: marketError,
    reload: reloadMarket,
    hasMore: marketHasMore,
    resolvedScope,
    resolvedMine,
    categoryFilter,
    setSearchQuery,
    setSortBy,
    setCatalogScope,
    setCategoryFilter,
    setVisibility,
    loadMore: loadMoreMarket,
  } = useMarketList('all', {
    enabled: active && catalogTab !== 'local',
    initialScope: 'market',
    initialSort: 'trending',
    initialSearchQuery: initialSearch.get('q') ?? '',
    initialCategoryFilter: initialSearch.get('category') ?? CATEGORY_ALL,
  });
  const categoryScope = marketRequest.scope === 'team' ? 'team' : 'market';
  const { categories } = useCategoryList(categoryScope);
  const previousMarketRequest = useRef(marketRequest);
  useEffect(() => {
    setCatalogScope(marketRequest.scope);
    setVisibility(marketRequest.visibility);
    setSortBy(marketRequest.sort);
    if (previousMarketRequest.current !== marketRequest) setCategoryFilter(CATEGORY_ALL);
    previousMarketRequest.current = marketRequest;
  }, [marketRequest, setCatalogScope, setCategoryFilter, setSortBy, setVisibility]);
  useEffect(() => {
    setSearchQuery(query);
  }, [query, setSearchQuery]);
  useEffect(() => {
    if (!showOrganization && catalogTab === 'organization') setCatalogTab('public');
  }, [catalogTab, showOrganization]);
  const marketResponseCurrent = isHomeMarketResponseCurrent(marketRequest, {
    scope: resolvedScope,
    mine: resolvedMine,
  });
  const catalogItems = useMemo(
    () =>
      (marketResponseCurrent ? marketItems : [])
        .filter((skill) =>
          includesSkillQuery(
            [skill.displayName, skill.name, skill.description, skill.authorName, skill.publisherName],
            normalizedQuery,
          ),
        ),
    [marketFilter, marketItems, marketResponseCurrent, normalizedQuery],
  );

  // 本地技能:global 一组 + 每个 project 一组(displayName 取自 store.projects,兜底 basename)。
  const globalSkills = useMemo(
    () =>
      prioritizeCindyBuiltInSkills(
        skills.filter(
          (skill) => {
            const descriptionKey = builtInSkillDescriptionKey(skill);
            const displayDescription = descriptionKey ? t(descriptionKey) : skill.description;
            return (
              skill.scope === 'global' &&
              includesSkillQuery(
                [skill.name, displayDescription, skill.description, skill.kind, skill.engine],
                normalizedQuery,
              )
            );
          },
        ),
      ),
    [normalizedQuery, skills, t],
  );
  const projectGroups = useMemo(() => {
    const byRoot = new Map<string, SkillhubSkill[]>();
    for (const s of skills) {
      if (s.scope !== 'project' || !s.projectRoot) continue;
      const arr = byRoot.get(s.projectRoot);
      if (arr) arr.push(s);
      else byRoot.set(s.projectRoot, [s]);
    }
    const nameByRoot = new Map(projects.map((p) => [p.projectRoot, p.displayName]));
    return [...byRoot.entries()]
      .map(([root, list]) => {
        const label = nameByRoot.get(root) ?? basename(root);
        return {
          root,
          label,
          skills: list.filter((skill) => {
            const descriptionKey = builtInSkillDescriptionKey(skill);
            const displayDescription = descriptionKey ? t(descriptionKey) : skill.description;
            return includesSkillQuery(
              [skill.name, displayDescription, skill.description, skill.kind, skill.engine, label],
              normalizedQuery,
            );
          }),
        };
      })
      .filter((group) => group.skills.length > 0);
  }, [normalizedQuery, skills, projects, t]);
  const visibleLocalCount = useMemo(
    () =>
      globalSkills.length + projectGroups.reduce((count, group) => count + group.skills.length, 0),
    [globalSkills.length, projectGroups],
  );
  const hasSearchResults = catalogTab === 'local'
    ? visibleLocalCount > 0
    : catalogItems.length > 0;

  // 本地导入：main 选择并检查文件 → 安装位置选择器 → 凭授权导入
  const [importGrantToken, setImportGrantToken] = useState<string | null>(null);
  const [importTarget, setImportTarget] = useState<InstallTargetSkill | null>(null);
  const [importPickerOpen, setImportPickerOpen] = useState(false);
  const [importBusy, setImportBusy] = useState(false);

  const returnTo = `/skillhub/local?${new URLSearchParams({ tab: catalogTab, q: query, category: categoryFilter })}`;
  const openLocal = (local: SkillhubSkill) => {
    const route = withSkillDetailReturn(buildLocalSkillRoute(local), returnTo);
    navigate(route, { state: { from: '/skillhub/local', resetHistory: true, skillhubHome: { catalogTab, query } } });
  };
  const openMarket = () => navigate('/skillhub/market');
  const openCatalogSkill = (skill: MarketSkill) => navigate(buildMarketSkillRoute(skill, returnTo));
  const homeCatalogTabs = visibleHomeCatalogTabs(showOrganization);

  const handleImportSkill = useCallback(async () => {
    if (importBusy) return;
    setImportBusy(true);
    try {
      const picked = await window.electronAPI.skillhub.pickLocal();
      if (!picked.success) {
        toast.error(picked.message || t('skillhub.home.importFailed'));
        return;
      }
      if (picked.canceled) return;

      setImportGrantToken(picked.grantToken);
      setImportTarget({
        name: picked.name,
        versionLabel: picked.version,
        description: picked.description,
      });
      setImportPickerOpen(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('skillhub.home.importFailed'));
    } finally {
      setImportBusy(false);
    }
  }, [importBusy, t]);

  const closeImportPicker = useCallback(() => {
    setImportPickerOpen(false);
    setImportGrantToken(null);
    setImportTarget(null);
  }, []);

  return (
    <PluginManagementLayout
      activeTab="skills"
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder={t('skillhub.home.search')}
      clearSearchLabel={t('skillhub.home.clearSearch')}
      embedded={embedded}
      onSelectTab={onSelectCatalogTab}
      headerActions={(
        <Button
          variant="secondary"
          size="lg"
          loading={importBusy}
          type="button"
          onClick={() => void handleImportSkill()}
          disabled={importBusy}
          aria-label={t('skillhub.home.importAria')}
          className="plugin-management-action-trigger shrink-0 shadow-[var(--plugin-card-shadow)]"
        >
          <Upload size={14} strokeWidth={1.8} aria-hidden="true" />
          <span className="plugin-management-action-label">{t('skillhub.home.import')}</span>
        </Button>
      )}
    >
      <div
        className={cn(
          'relative h-full min-h-0 w-full overflow-hidden',
          embedded ? 'bg-transparent' : 'bg-[var(--surface)]',
        )}
      >
        <main className="h-full overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable_both-edges]">
          <PluginManagementPage className="gap-8">
            <header className="plugin-motion-page-header flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 pt-1">
                <h1 className="text-28 font-medium leading-tight text-[var(--text-primary)]">
                  {t('skillhub.home.title')}
                </h1>
                <p className="mt-2 max-w-2xl text-14 leading-6 text-[var(--text-secondary)]">
                  {t('skillhub.home.description')}
                </p>
              </div>
              <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1" style={WINDOW_NO_DRAG_STYLE}>
                <SegmentedControl
                  role="radiogroup"
                  aria-label={t('skillhub.home.catalogFiltersAria')}
                  height={32}
                  optionHeight={28}
                  optionClassName="px-3.5 text-12"
                  value={catalogTab}
                  onValueChange={(tab) => {
                    setCatalogTab(tab);
                  }}
                  options={homeCatalogTabs.map((tab) => ({
                    value: tab,
                    label:
                      tab === 'local'
                        ? t('skillhub.home.local')
                        : t(`skillhub.home.catalogFilter.${tab}`),
                  }))}
                />
                <button
                    type="button"
                    onClick={openMarket}
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1 rounded-full px-3.5 py-2 text-12 text-[var(--text-secondary)]',
                      'transition-colors duration-150 hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)]',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                    )}
                  >
                    {t('skillhub.home.catalogMore')}
                    <ChevronRight size={13} strokeWidth={1.8} aria-hidden="true" />
                </button>
              </div>
            </header>

            {/* ① 当前云端目录摘要 */}
            {catalogTab !== 'local' && (!normalizedQuery || catalogItems.length > 0 || marketLoading || marketError) ? (
              <section className="plugin-motion-page-section min-w-0">
                {categories.length > 0 ? (
                  <SkillCategoryFilterBar
                    categories={categories}
                    selectedCategory={categoryFilter}
                    allLabel={t('skillhub.market.categoryAll')}
                    ariaLabel={t('skillhub.home.categoryFiltersAria')}
                    scrollLeftLabel={t('skillhub.home.scrollCategoriesLeft')}
                    scrollRightLabel={t('skillhub.home.scrollCategoriesRight')}
                    scrollStartLabel={t('skillhub.home.categoryScrollAtStart')}
                    scrollEndLabel={t('skillhub.home.categoryScrollAtEnd')}
                    onSelectCategory={setCategoryFilter}
                    className="mb-4"
                  />
                ) : null}

                <MarketListError error={marketError} loading={marketLoading} onRetry={reloadMarket} />
                {(marketLoading || !marketResponseCurrent) && catalogItems.length === 0 ? (
                  // 占位骨架:与真实卡片同栅格、同行数、同高度,内容到位后原地替换不跳动。
                  <div className={PLUGIN_MANAGEMENT_CARD_GRID_CLASS} aria-hidden>
                    {Array.from({ length: MARKET_PAGE_SIZE }).map((_, i) => (
                      <div
                        key={i}
                        className="flex min-h-[100px] flex-col gap-2 rounded-[12px] border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] p-3 shadow-[var(--plugin-card-shadow)]"
                      >
                        <div className="flex items-center gap-2">
                          <div className="size-9 shrink-0 animate-pulse rounded-xl bg-[var(--cmd-palette-item-hover)] opacity-60" />
                          <div className="h-3.5 w-2/3 animate-pulse rounded bg-[var(--cmd-palette-item-hover)] opacity-60" />
                        </div>
                        <div className="h-3 w-full animate-pulse rounded bg-[var(--cmd-palette-item-hover)] opacity-40" />
                        <div className="h-3 w-4/5 animate-pulse rounded bg-[var(--cmd-palette-item-hover)] opacity-40" />
                        <div className="mt-auto h-3 w-1/3 animate-pulse rounded bg-[var(--cmd-palette-item-hover)] opacity-40" />
                      </div>
                    ))}
                  </div>
                ) : marketError && catalogItems.length === 0 ? null : catalogItems.length === 0 ? (
                  <div className="rounded-[12px] border-[0.5px] border-[var(--border-default)] px-4 py-5 text-13 leading-5 text-[var(--text-secondary)]">
                    {t('skillhub.home.catalogEmpty')}
                  </div>
                ) : (
                  <div className={cn('plugin-motion-stagger', PLUGIN_MANAGEMENT_CARD_GRID_CLASS)}>
                    {catalogItems.map((s) => (
                      <HomeMarketCard
                        key={skillhubCatalogKey(s.name, s.catalogScope)}
                        skill={s}
                        onClick={openCatalogSkill}
                        onUpdate={user ? marketUpdate.update : undefined}
                        updating={marketUpdate.updatingNames.has(s.name)}
                      />
                    ))}
                    {marketResponseCurrent && marketHasMore ? (
                      <div className="col-span-full flex justify-center pt-1">
                        <Button
                          variant="secondary"
                          size="lg"
                          loading={marketLoadingMore}
                          type="button"
                          disabled={marketLoadingMore}
                          onClick={() => void loadMoreMarket()}
                        >
                          {t('skillhub.home.loadMore')}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                )}
              </section>
            ) : null}

            {/* ② 本地技能 */}
            {catalogTab === 'local' && (!normalizedQuery || visibleLocalCount > 0) ? (
              <section className="plugin-motion-page-section min-w-0">
                {visibleLocalCount === 0 ? (
                  <div className="rounded-[12px] border-[0.5px] border-[var(--border-default)] px-4 py-5 text-13 leading-5 text-[var(--text-secondary)]">
                    {bootstrapped ? t('skillhub.home.localEmpty') : t('skillhub.welcome.scanning')}
                  </div>
                ) : (
                  <div className="flex flex-col gap-6">
                    {globalSkills.length > 0 && (
                      <LocalGroup
                        skills={globalSkills}
                        syncResults={syncResults}
                        active={active}
                        onOpen={openLocal}
                      />
                    )}
                    {projectGroups.map((g) => (
                      <LocalGroup
                        key={g.root}
                        label={g.label}
                        skills={g.skills}
                        syncResults={syncResults}
                        active={active}
                        onOpen={openLocal}
                      />
                    ))}
                  </div>
                )}
              </section>
            ) : null}

            {normalizedQuery && (catalogTab === 'local' || !marketLoading) && !hasSearchResults ? (
              <div className="plugin-motion-page-section rounded-[12px] border-[0.5px] border-[var(--border-default)] px-4 py-8 text-center text-13 leading-5 text-[var(--text-secondary)]">
                {t('skillhub.home.noSearchResults')}
              </div>
            ) : null}
          </PluginManagementPage>
        </main>

        <InstallTargetPicker
          open={active && importPickerOpen}
          skill={importTarget}
          onClose={closeImportPicker}
          titleKey="skillhub.home.importPickerTitle"
          subtitleKey="skillhub.home.importPickerSubtitle"
          successToastKey="skillhub.home.importSuccess"
          failedToastKey="skillhub.home.importFailed"
          runAction={async ({ installPath, force }) => {
            if (!importGrantToken) {
              return {
                success: false,
                errorCode: 'INVALID_FILE',
                message: t('skillhub.home.importFailed'),
              };
            }
            return window.electronAPI.skillhub.importLocal({
              grantToken: importGrantToken,
              installPath,
              force,
            });
          }}
          onInstallComplete={(result) => {
            closeImportPicker();
            if (!result?.name) return;
            void refreshSkillhub().then((scannedSkills) => {
              const imported = result.absolutePath
                ? findLocalSkillByPath(scannedSkills, result.absolutePath)
                : undefined;
              if (imported) {
                navigate(buildLocalSkillRoute(imported), {
                  state: { from: '/skillhub/local', resetHistory: true, skillhubHome: { catalogTab, query } },
                });
                return;
              }
              const projectRoot = result.absolutePath
                ? deriveProjectWorkingDir(result.absolutePath)
                : null;
              const fallback = {
                id: '',
                absolutePath: result.absolutePath ?? '',
                engine: 'claude-code' as const,
                kind: 'skill' as const,
                scope: projectRoot ? ('project' as const) : ('global' as const),
                projectHash: projectRoot ? projectHash(projectRoot) : undefined,
                name: result.name,
              };
              navigate(buildLocalSkillRoute(fallback), {
                state: { from: '/skillhub/local', resetHistory: true, skillhubHome: { catalogTab, query } },
              });
            });
          }}
        />
      </div>
    </PluginManagementLayout>
  );
}

function LocalGroup({
  label,
  skills,
  syncResults,
  active,
  onOpen,
}: {
  label?: string;
  skills: SkillhubSkill[];
  active: boolean;
  /** server 归属结果(含 isMine),用于历史遗留 registry(origin 缺失)的来源推断 */
  syncResults: Map<string, SkillhubSyncResult>;
  onOpen: (s: SkillhubSkill) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      {label ? <span className="px-1 text-13 font-medium text-[var(--text-secondary)]">{label}</span> : null}
      <div className={cn('plugin-motion-stagger', PLUGIN_MANAGEMENT_CARD_GRID_CLASS)}>
        {skills.map((s) => {
          const Icon = KIND_ICON[s.kind] ?? Package;
          const descriptionKey = builtInSkillDescriptionKey(s);
          const displayDescription = descriptionKey ? t(descriptionKey) : s.description;
          // 来源:'skillhub' = 从市场安装的副本(填充徽标);'local' = 自己开发/发布、
          // 没走 SkillHub 安装的本地副本(弱化文字,不与 SkillHub 抢视觉)。
          // origin 缺失的历史 registry 靠 server isMine 兜底判定(见 deriveSkillSource)。
          const sync = syncResults.get(skillhubCatalogKey(s.registrySkillName ?? s.name, s.registryEntry?.catalogScope));
          const isMine = sync?.exists === true ? sync.isMine : null;
          const source = deriveSkillSource(
            s.registryEntry?.origin,
            s.registryEntry !== null,
            isMine,
          );
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onOpen(s)}
              className={cn(
                'group flex w-full items-start gap-3 rounded-[12px] border-[0.5px] border-[var(--border-default)] px-3 py-2.5 text-left',
                'bg-[var(--surface-elevated)] shadow-[var(--plugin-card-shadow)]',
                'transition-[background-color,border-color,transform] duration-150 ease-out',
                'hover:-translate-y-0.5 hover:border-[var(--text-tertiary)]',
                'active:translate-y-0 active:scale-[0.992]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
              )}
            >
              {s.kind === 'skill' ? (
                <SkillIcon />
              ) : (
                <span className="flex size-9 shrink-0 items-center justify-center rounded-[22%] border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[var(--plugin-card-shadow)]">
                  <Icon size={17} strokeWidth={1.75} />
                </span>
              )}
              <span className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-13 font-medium text-[var(--text-primary)]">
                    {s.name}
                  </span>
                  {s.builtIn ? (
                    <OfficialSkillBadge />
                  ) : (
                    <span className="shrink-0 text-10 text-[var(--text-tertiary)]">
                      {source === 'skillhub'
                        ? t('skillhub.home.sourceSkillhub')
                        : t('skillhub.home.sourceLocal')}
                    </span>
                  )}
                </span>
                {displayDescription && (
                  <span className="line-clamp-1 text-12 leading-4 text-[var(--text-secondary)]">
                    {displayDescription}
                  </span>
                )}
                <SkillPublishUpdateHint skill={s} knownCreator={active && sync?.exists === true && sync.isCreator === true} />
              </span>
              <span className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-lg border border-transparent text-[var(--text-secondary)] transition-[background-color,color,transform] group-hover:translate-x-0.5 group-hover:bg-[var(--surface-chip)] group-hover:text-[var(--text-primary)] group-active:translate-x-0 group-active:scale-95">
                <ChevronRight size={15} strokeWidth={1.8} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
