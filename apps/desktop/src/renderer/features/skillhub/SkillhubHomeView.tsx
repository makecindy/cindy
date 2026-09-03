/**
 * SkillhubHomeView — 技能(SkillHub)首页,/skillhub/local index。
 *
 * 重构(2026-06):SkillHub 不再用"左侧树导航 + 右侧内容"。左侧 app 侧栏还给
 * 项目/对话列表;技能整页在右侧主区,无常驻导航树,改为下钻(下一步)+ 回退:
 * 公开、可选的组织目录和本地技能在同一行切换；“更多”进入完整 Market。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { skillhubCatalogKey } from '../../../shared/skillhubCatalog';
import { CATEGORY_ALL } from '../../../shared/skillhubCategory';
import {
  Bot,
  ChevronRight,
  Download,
  Package,
  SquareTerminal,
  Upload,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useAuth } from '@/contexts/AuthContext';
import {
  PLUGIN_MANAGEMENT_CARD_GRID_CLASS,
  PluginManagementLayout,
  PluginManagementPage,
} from '@/features/plugin/PluginManagementLayout';
import { buildLocalSkillRoute, findLocalSkillByPath } from './lib/localRoutes';
import { refresh as refreshSkillhub, useSkillhub } from './hooks/useSkillhub';
import {
  MARKET_PAGE_SIZE,
  useCategoryList,
  useMarketList,
  type MarketSkill,
} from './hooks/useMarketList';
import { MarketManagementDialogs, useMarketManagement } from './hooks/useMarketManagement';
import { basename, deriveProjectWorkingDir } from './lib/pathDerivations';
import { projectHash } from './lib/projectHash';
import { marketCardPrimaryAction } from './lib/marketDetailViewModel';
import {
  homeMarketQuery,
  isHomeMarketResponseCurrent,
  visibleHomeCatalogTabs,
  type HomeCatalogTab,
  type HomeMarketFilter,
} from './lib/homeMarketFilter';
import { deriveSkillSource } from './lib/skillSource';
import { skillPublisherLabel } from './lib/publisherLabel';
import { InstallTargetPicker, type InstallTargetSkill } from './components/InstallTargetPicker';
import { SkillCategoryFilterBar } from './components/SkillCategoryFilterBar';
import { SkillIcon } from './components/SkillIcon';
import { SkillTagList } from './components/SkillTagList';
import { SkillhubMarketPreviewPanel } from './SkillhubMarketPreviewPanel';
import { useSkillhubIdentityPolicy } from './hooks/useSkillhubIdentityPolicy';

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
  onSelectCatalogTab,
}: {
  embedded?: boolean;
  onSelectCatalogTab?: (tab: 'plugins' | 'skills') => void;
} = {}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { skills, projects, bootstrapped, syncResults } = useSkillhub();
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLocaleLowerCase();

  // 未登录也请求公开 Skill 目录；登录身份只扩大服务端可见范围。
  const { user } = useAuth();
  const identityPolicy = useSkillhubIdentityPolicy(user);
  const showOrganization = user?.membershipKind === 'org';
  const [catalogTab, setCatalogTab] = useState<HomeCatalogTab>('public');
  const marketFilter: HomeMarketFilter = catalogTab === 'organization' ? 'organization' : 'public';
  const marketRequest = useMemo(() => homeMarketQuery(marketFilter), [marketFilter]);

  // 主 Skill Tab 直接分页展示当前云端目录；“更多”仍进入带完整筛选能力的 Market。
  const {
    items: marketItems,
    loading: marketLoading,
    loadingMore: marketLoadingMore,
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
    reload: reloadMarket,
  } = useMarketList('all', {
    enabled: catalogTab !== 'local',
    initialScope: 'market',
    initialSort: 'trending',
  });
  const categoryScope = marketRequest.scope === 'team' ? 'team' : 'market';
  const { categories } = useCategoryList(categoryScope);
  useEffect(() => {
    setCatalogScope(marketRequest.scope);
    setVisibility(marketRequest.visibility);
    setSortBy(marketRequest.sort);
    setCategoryFilter(CATEGORY_ALL);
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
      skills.filter(
        (skill) =>
          skill.scope === 'global' &&
          includesSkillQuery(
            [skill.name, skill.description, skill.kind, skill.engine],
            normalizedQuery,
          ),
      ),
    [normalizedQuery, skills],
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
          skills: list.filter((skill) =>
            includesSkillQuery(
              [skill.name, skill.description, skill.kind, skill.engine, label],
              normalizedQuery,
            ),
          ),
        };
      })
      .filter((group) => group.skills.length > 0);
  }, [normalizedQuery, skills, projects]);
  const visibleLocalCount = useMemo(
    () =>
      globalSkills.length + projectGroups.reduce((count, group) => count + group.skills.length, 0),
    [globalSkills.length, projectGroups],
  );
  const hasSearchResults = catalogTab === 'local'
    ? visibleLocalCount > 0
    : catalogItems.length > 0;

  // 推荐技能的预览浮层 + 安装选择器(复用 Market 那套):点推荐卡 = 下一步直接
  // 进入该技能的预览;关闭 = 回退到首页。
  const [previewSkill, setPreviewSkill] = useState<MarketSkill | null>(null);
  const [pickerSkill, setPickerSkill] = useState<MarketSkill | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // 本地导入：main 选择并检查文件 → 安装位置选择器 → 凭授权导入
  const [importGrantToken, setImportGrantToken] = useState<string | null>(null);
  const [importTarget, setImportTarget] = useState<InstallTargetSkill | null>(null);
  const [importPickerOpen, setImportPickerOpen] = useState(false);
  const [importBusy, setImportBusy] = useState(false);

  const openLocal = (s: SkillhubSkill) => {
    // 从首页进入 = 一次全新入口:清掉旧的技能历史栈(resetHistory),并把回退落点
    // 设为首页(from)。这样详情页「返回」回到首页这一步,而不是会话内残留的上一个技能。
    // 详情→详情的链式跳转不带 resetHistory,链路仍能逐级回退。
    navigate(buildLocalSkillRoute(s), {
      state: { from: '/skillhub/local', resetHistory: true },
    });
  };
  const openMarket = () => navigate('/skillhub/market');
  const openCatalogSkill = (skill: MarketSkill) => setPreviewSkill(skill);
  const handleClone = (skill: MarketSkill) => {
    setPickerSkill(skill);
    setPickerOpen(true);
  };
  const management = useMarketManagement({
    active: false,
    reload: reloadMarket,
    onClone: handleClone,
    onDeleted: (skill) => {
      if (previewSkill?.name === skill.name) setPreviewSkill(null);
    },
  });
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
        <button
          type="button"
          onClick={() => void handleImportSkill()}
          disabled={importBusy}
          className={cn(
            'plugin-management-action-trigger inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-[var(--border-default)]',
            'bg-[var(--surface-elevated)] px-3.5 text-12 font-medium text-[var(--text-primary)] shadow-[var(--plugin-card-shadow)]',
            'transition-[background-color,border-color,transform] duration-150 ease-out',
            'hover:border-[var(--text-tertiary)] hover:bg-[var(--surface-hover-soft)] active:scale-[0.98]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
          aria-label={t('skillhub.home.importAria')}
        >
          <Upload size={14} strokeWidth={1.8} aria-hidden="true" />
          <span className="plugin-management-action-label">{t('skillhub.home.import')}</span>
        </button>
      )}
    >
      <main
        className={cn(
          'relative h-full w-full overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable_both-edges]',
          embedded ? 'bg-transparent' : 'bg-[var(--surface)]',
        )}
      >
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
            <div
              className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1"
              role="group"
              aria-label={t('skillhub.home.catalogFiltersAria')}
            >
                {homeCatalogTabs.map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    aria-pressed={catalogTab === tab}
                    onClick={() => {
                      setPreviewSkill(null);
                      setCatalogTab(tab);
                    }}
                    className={cn(
                      'shrink-0 select-none rounded-full px-3.5 py-2 text-12 transition-colors duration-150',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                      catalogTab === tab
                        ? 'bg-[var(--surface-chip)] font-medium text-[var(--text-primary)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)]',
                    )}
                  >
                    {tab === 'local'
                      ? t('skillhub.home.local')
                      : t(`skillhub.home.catalogFilter.${tab}`)}
                  </button>
                ))}
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
          {catalogTab !== 'local' && (!normalizedQuery || catalogItems.length > 0 || marketLoading) ? (
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
              ) : catalogItems.length === 0 ? (
                <div className="rounded-[12px] border-[0.5px] border-[var(--border-default)] px-4 py-5 text-13 leading-5 text-[var(--text-secondary)]">
                  {t('skillhub.home.catalogEmpty')}
                </div>
              ) : (
                <div className={cn('plugin-motion-stagger', PLUGIN_MANAGEMENT_CARD_GRID_CLASS)}>
                  {catalogItems.map((s) => (
                    <button
                      key={s.name}
                      type="button"
                      onClick={() => openCatalogSkill(s)}
                      className={cn(
                        'group flex min-h-[100px] flex-col gap-1.5 rounded-[12px] border-[0.5px] border-[var(--border-default)]',
                        'bg-[var(--surface-elevated)] p-3 text-left shadow-[var(--plugin-card-shadow)]',
                        'transition-[background-color,border-color,transform] duration-150 ease-out',
                        'hover:-translate-y-0.5 hover:border-[var(--text-tertiary)]',
                        'active:translate-y-0 active:scale-[0.992]',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <SkillIcon url={s.icon} />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--msg-assistant-text)]">
                          {s.displayName || s.name}
                        </span>
                        <SkillTagList tags={s.tags} maxVisible={1} className="shrink-0" />
                        {s.installedLocally && (
                          <span className="shrink-0 rounded-full bg-[var(--chat-input-chip-bg)] px-1.5 py-0.5 text-10 text-[var(--cmd-palette-item-meta)]">
                            {t('skillhub.home.installed')}
                          </span>
                        )}
                      </div>
                      {s.description && (
                        <p className="line-clamp-2 text-xs text-[var(--cmd-palette-item-meta)]">
                          {s.description}
                        </p>
                      )}
                      <div className="flex items-center gap-2 text-11 text-[var(--cmd-palette-item-meta)]">
                        <span className="min-w-0 truncate">{skillPublisherLabel(s)}</span>
                        <span className="inline-flex shrink-0 items-center gap-0.5">
                          <Download size={11} />
                          {s.downloads}
                        </span>
                      </div>
                    </button>
                  ))}
                  {marketResponseCurrent && marketHasMore ? (
                    <div className="col-span-full flex justify-center pt-1">
                      <button
                        type="button"
                        disabled={marketLoadingMore}
                        onClick={() => void loadMoreMarket()}
                        className={cn(
                          'inline-flex min-h-9 items-center justify-center rounded-full border border-[var(--border-default)]',
                          'bg-[var(--surface-elevated)] px-5 text-12 font-medium text-[var(--text-secondary)]',
                          'transition-colors duration-150 hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                          'disabled:cursor-wait disabled:opacity-60',
                        )}
                      >
                        {marketLoadingMore
                          ? t('skillhub.home.loadingMore')
                          : t('skillhub.home.loadMore')}
                      </button>
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
                      onOpen={openLocal}
                    />
                  )}
                  {projectGroups.map((g) => (
                    <LocalGroup
                      key={g.root}
                      label={g.label}
                      skills={g.skills}
                      syncResults={syncResults}
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

        {/* 推荐技能预览浮层(下一步)+ 安装选择器 —— 复用 Market 同款。
          点推荐卡 = 打开预览;关闭 = 回退到首页。 */}
        <SkillhubMarketPreviewPanel
          open={previewSkill !== null}
          skill={previewSkill}
          onClose={() => setPreviewSkill(null)}
          primaryAction={
            previewSkill && user
              ? (() => {
                  const action = marketCardPrimaryAction({
                    isMine: previewSkill.isMine,
                    listVisibility: 'all',
                    cardState: previewSkill.cardState,
                  });
                  return action === 'manage' && !identityPolicy.canWrite ? 'clone' : action;
                })()
              : 'none'
          }
          onClone={handleClone}
          onManageAction={management.handleManageAction}
        />
        <MarketManagementDialogs controller={management} />
        <InstallTargetPicker
          open={pickerOpen}
          skill={pickerSkill}
          onClose={() => setPickerOpen(false)}
          onInstallComplete={() => {
            void refreshSkillhub();
            setPickerOpen(false);
            // 安装后关掉预览浮层:否则它仍持有 stale previewSkill、CTA 继续显示「安装/克隆」,
            // 可被重复点安装(PR #246 review)。
            setPreviewSkill(null);
          }}
        />
        <InstallTargetPicker
          open={importPickerOpen}
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
                  state: { from: '/skillhub/local', resetHistory: true },
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
                state: { from: '/skillhub/local', resetHistory: true },
              });
            });
          }}
        />
      </main>
    </PluginManagementLayout>
  );
}

function LocalGroup({
  label,
  skills,
  syncResults,
  onOpen,
}: {
  label?: string;
  skills: SkillhubSkill[];
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
          // 来源:'skillhub' = 从市场安装的副本(填充徽标);'local' = 自己开发/发布、
          // 没走 SkillHub 安装的本地副本(弱化文字,不与 SkillHub 抢视觉)。
          // origin 缺失的历史 registry 靠 server isMine 兜底判定(见 deriveSkillSource)。
          const sync = syncResults.get(skillhubCatalogKey(s.name, s.registryEntry?.catalogScope));
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
                  <span className="shrink-0 text-10 text-[var(--text-tertiary)]">
                    {source === 'skillhub'
                      ? t('skillhub.home.sourceSkillhub')
                      : t('skillhub.home.sourceLocal')}
                  </span>
                </span>
                {s.description && (
                  <span className="line-clamp-1 text-12 leading-4 text-[var(--text-secondary)]">
                    {s.description}
                  </span>
                )}
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
