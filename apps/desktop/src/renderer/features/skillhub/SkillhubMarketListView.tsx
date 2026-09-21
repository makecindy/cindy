import { buildMarketSkillRoute } from './lib/detailRoutes';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, ChevronDown, ArrowLeft } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/lib/toast';
import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { SegmentedControl } from '@/components/ui/segmented-control';
import {
  useCategoryList,
  useMarketList,
  type CategoryFilter,
  type MarketSkill,
  type SortBy,
  type Visibility,
} from './hooks/useMarketList';
import { refresh as refreshSkillhub } from './hooks/useSkillhub';
import { MarketManagementDialogs, useMarketManagement } from './hooks/useMarketManagement';
import { MarketListError } from './components/MarketListError';
import { MarketCard } from './components/MarketCard';
import { InstallTargetPicker } from './components/InstallTargetPicker';
import { marketCardPrimaryAction } from './lib/marketDetailViewModel';
import { groupMineByOwner } from './lib/mineGrouping';
import { useAuth } from '@/contexts/AuthContext';
import { CATEGORY_ALL } from '../../../shared/skillhubCategory';
import { useSkillhubIdentityPolicy } from './hooks/useSkillhubIdentityPolicy';
import { useMarketSkillUpdate } from './hooks/useMarketSkillUpdate';

// Must match the global native scrollbar width in styles/globals.css.
const MARKET_SCROLLBAR_GUTTER_PX = 12;

const SORT_OPTIONS: Array<{ value: SortBy; labelKey: string }> = [
  { value: 'trending', labelKey: 'skillhub.market.sortTrending' },
  { value: 'downloads', labelKey: 'skillhub.market.sortDownloads' },
  { value: 'updated_at', labelKey: 'skillhub.market.sortLatest' },
  { value: 'created_at', labelKey: 'skillhub.market.sortCreated' },
];

export function SkillhubMarketListView() {
  return <SkillhubMarketListViewInner />;
}

function SkillhubMarketListViewInner() {
  const { t } = useTranslation();
  const { user, isInitializing } = useAuth();
  const identityPolicy = useSkillhubIdentityPolicy(user);
  const { update, updatingNames, isUpdating } = useMarketSkillUpdate();
  const location = useLocation();
  const navigate = useNavigate();
  const initialSearch = new URLSearchParams(location.search);
  const marketState = location.state as { freshEntry?: boolean; initialVisibility?: Visibility } | null;
  const initialVisibility = initialSearch.get('visibility') === 'mine' ? 'mine' : marketState?.initialVisibility === 'all' ||
    marketState?.initialVisibility === 'mine'
    ? marketState.initialVisibility
    : undefined;
  const {
    items,
    loading,
    loadingMore,
    error,
    hasMore,
    searchQuery,
    sortBy,
    categoryFilter,
    visibility,
    setSearchQuery,
    setSortBy,
    setCategoryFilter,
    setVisibility,
    loadMore,
    reload,
  } = useMarketList(initialVisibility, {
    initialScope: 'market',
    initialSort: SORT_OPTIONS.find((option) => option.value === initialSearch.get('sort'))?.value,
    initialSearchQuery: initialSearch.get('q') ?? '',
    initialCategoryFilter: initialSearch.get('category') ?? CATEGORY_ALL,
  });
  const { categories } = useCategoryList();

  // 「我的发布」按归属(个人 / 各团队)分组渲染;空组不显示(groupMineByOwner 只对有 item 的 owner 建组)。
  const isMineView = visibility === 'mine';
  const mineGroups = isMineView ? groupMineByOwner(items) : [];

  const selectedCategoryName = categoryFilter === CATEGORY_ALL
    ? t('skillhub.market.categoryAll')
    : categories.find((c) => c.slug === categoryFilter)?.name ?? t('skillhub.market.categoryAll');
  const marketScrollRef = useRef<HTMLDivElement | null>(null);
  const [marketHasVerticalOverflow, setMarketHasVerticalOverflow] = useState(false);

  useEffect(() => {
    if (!isInitializing && !user && visibility === 'mine') setVisibility('all');
  }, [isInitializing, setVisibility, user, visibility]);

  // Infinite scroll sentinel
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) void loadMore(); },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  useLayoutEffect(() => {
    const el = marketScrollRef.current;
    if (!el) return undefined;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const next = el.scrollHeight > el.clientHeight + 1;
      setMarketHasVerticalOverflow((prev) => (prev === next ? prev : next));
    };
    const scheduleMeasure = () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };

    measure();
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleMeasure);
    resizeObserver?.observe(el);
    if (el.firstElementChild) resizeObserver?.observe(el.firstElementChild);
    window.addEventListener('resize', scheduleMeasure);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
    };
  }, [error, hasMore, items.length, loading, loadingMore, visibility]);

  // Picker 状态 — Clone 按钮触发
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSkill, setPickerSkill] = useState<MarketSkill | null>(null);

  // 订阅 install progress 事件：done 时 refresh 本地 scan + toast
  useEffect(() => {
    const unsubscribe = window.electronAPI.skillhub.onInstallProgress((event) => {
      if (event.phase === 'done') {
        void refreshSkillhub();
      } else if (event.phase === 'failed') {
        // Direct updates report their own result; avoid a second toast from the broadcast.
        if (event.errorCode !== 'CANCELLED' && !isUpdating(event.name)) {
          toast.error(t('skillhub.market.installFailedToast', {
            name: event.name,
            message: event.message ?? event.errorCode ?? t('skillhub.market.installError'),
          }));
        }
      }
    });
    return unsubscribe;
  }, [isUpdating, t]);

  const sortLabel = useMemo(() => {
    return t(SORT_OPTIONS.find((option) => option.value === sortBy)?.labelKey ?? 'skillhub.market.sortLatest');
  }, [sortBy, t]);

  const returnTo = `/skillhub/market?${new URLSearchParams({ q: searchQuery, sort: sortBy, category: categoryFilter, visibility })}`;
  const handleCardClick = (skill: MarketSkill) => navigate(buildMarketSkillRoute(skill, returnTo));

  const handleClone = (skill: MarketSkill) => {
    setPickerSkill(skill);
    setPickerOpen(true);
  };
  const management = useMarketManagement({
    active: isMineView,
    reload,
    onClone: handleClone,
  });

  const renderCard = (skill: MarketSkill) => (
    <MarketCard
      key={skill.name}
      skill={skill}
      primaryAction={user
        ? (() => {
            const action = marketCardPrimaryAction({
              isMine: skill.isMine,
              listVisibility: visibility,
              cardState: skill.cardState,
            });
            return action === 'manage' && !identityPolicy.canWrite ? 'clone' : action;
          })()
        : 'none'}
      allowPrivateVisibilityLabel={visibility === 'mine'}
      onClone={handleClone}
      onUpdate={user ? update : undefined}
      updating={updatingNames.has(skill.name)}
      onManageAction={management.handleManageAction}
      onClick={handleCardClick}
    />
  );

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-[hsl(var(--content-area))]">
      {/* market-toolbar — h56, padding 0 24
          mac 上本页不渲染通用 ContentHeader,工具栏行承担窗口拖拽,行内交互
          元素各自 no-drag(windowDrag.tsx 约定) */}
      <div
        className="flex items-center justify-between bg-[hsl(var(--content-area))]"
        style={{
          height: '56px',
          padding: '0 24px',
          gap: '12px',
          ...WINDOW_DRAG_STYLE,
        }}
      >
        {/* back-to-home — 技能首页(/skillhub/local)。原"返回本地"在已移除的侧栏里,
            这里在工具栏补一个返回入口。 */}
        <button
          type="button"
          onClick={() => navigate('/skillhub/local')}
          aria-label={t('skillhub.sidebar.backToLocal')}
          title={t('skillhub.sidebar.backToLocal')}
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-[var(--msg-assistant-text)] transition-colors hover:bg-sidebar-item-hover"
          style={WINDOW_NO_DRAG_STYLE}
        >
          <ArrowLeft size={18} />
        </button>

        {/* search-input — 200x36 */}
        <div
          className="flex shrink-0 items-center rounded-full border border-[var(--chat-input-border)] bg-[var(--chat-input-bg)]"
          style={{ width: '200px', height: '36px', padding: '0 12px', gap: '8px', ...WINDOW_NO_DRAG_STYLE }}
        >
          <Search size={14} className="shrink-0 text-[var(--chat-input-placeholder)]" />
          <input
            type="text"
            placeholder={t('skillhub.market.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="min-w-0 flex-1 border-0 bg-transparent text-[var(--settings-input-text)] outline-none placeholder:text-[var(--settings-input-placeholder)]"
            style={{ fontSize: '13px' }}
          />
        </div>

        {/* toolbar-right — gap 8 */}
        <div className="flex items-center" style={{ gap: '8px', ...WINDOW_NO_DRAG_STYLE }}>
          {/* sort-dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center rounded-full border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]"
                style={{ height: '32px', padding: '0 12px', gap: '6px' }}
              >
                <span className="text-[var(--msg-assistant-text)]" style={{ fontSize: '12px' }}>
                  {sortLabel}
                </span>
                <ChevronDown size={12} className="text-[var(--settings-theme-icon)]" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={4}
              className="w-32 overflow-hidden rounded-xl border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-1 shadow-[var(--shadow-menu)]"
            >
              {SORT_OPTIONS.map((option) => (
                <DropdownMenuItem
                  key={option.value}
                  onSelect={() => setSortBy(option.value)}
                  className="h-8 rounded-md px-3 text-sm text-[var(--msg-assistant-text)] focus:bg-[var(--cmd-palette-item-hover)]"
                >
                  {t(option.labelKey)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* category-dropdown — 单选,默认「全部」;broker /categories 未接通时(空列表)自动隐藏 */}
          {categories.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="flex items-center rounded-full border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]"
                  style={{ height: '32px', padding: '0 12px', gap: '6px' }}
                >
                  <span className="text-[var(--msg-assistant-text)]" style={{ fontSize: '12px' }}>
                    {t('skillhub.market.categoryLabel', { name: selectedCategoryName })}
                  </span>
                  <ChevronDown size={12} className="text-[var(--settings-theme-icon)]" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                sideOffset={4}
                className="w-44 overflow-hidden rounded-xl border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-1 shadow-[var(--shadow-menu)]"
                style={{ maxWidth: '200px' }}
              >
                <DropdownMenuItem
                  onSelect={() => setCategoryFilter(CATEGORY_ALL)}
                  className="flex h-8 items-center justify-between gap-2 rounded-md px-3 text-sm text-[var(--msg-assistant-text)] focus:bg-[var(--cmd-palette-item-hover)]"
                >
                  <span className="truncate">{t('skillhub.market.categoryAll')}</span>
                </DropdownMenuItem>
                {categories.map((category) => (
                  <DropdownMenuItem
                    key={category.slug}
                    onSelect={() => setCategoryFilter(category.slug as CategoryFilter)}
                    className="flex h-8 items-center justify-between gap-2 rounded-md px-3 text-sm text-[var(--msg-assistant-text)] focus:bg-[var(--cmd-palette-item-hover)]"
                  >
                    <span className="truncate">{category.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          <SegmentedControl
            role="radiogroup"
            aria-label={t('skillhub.market.chipAll')}
            height={32}
            optionHeight={28}
            optionClassName="px-3 text-12"
            value={visibility}
            onValueChange={setVisibility}
            options={[
              { value: 'all', label: t('skillhub.market.chipAll') },
              ...(user
                ? [{ value: 'mine' as const, label: t('skillhub.market.chipMine') }]
                : []),
            ]}
          />
        </div>
      </div>

      {/* market-grid */}
      <div className="relative flex-1 overflow-hidden">
        <div
          ref={marketScrollRef}
          className="h-full overflow-y-auto overflow-x-hidden"
          style={marketHasVerticalOverflow
            ? {
              width: `calc(100% + ${MARKET_SCROLLBAR_GUTTER_PX}px)`,
              marginLeft: `-${MARKET_SCROLLBAR_GUTTER_PX}px`,
            }
            : { width: '100%' }}
        >
          <MarketListError error={error} loading={loading} onRetry={reload} />
          {loading && items.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-[var(--cmd-palette-item-meta)]">{t('skillhub.market.loading')}</p>
            </div>
          ) : error && items.length === 0 ? null : items.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-[var(--cmd-palette-item-meta)]">{t('skillhub.market.noResults')}</p>
            </div>
          ) : (
            <div
              style={marketHasVerticalOverflow
                ? { padding: '16px 12px 24px 36px' }
                : { padding: '16px 24px 24px 24px' }}
            >
              {isMineView ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  {mineGroups.map((group) => (
                    <div key={group.key} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      <div className="flex items-center gap-2" style={{ padding: '2px 2px 0' }}>
                        <span className="font-medium text-[var(--msg-assistant-text)]" style={{ fontSize: '13px' }}>
                          {group.isPersonal ? t('skillhub.market.ownerGroupPersonal') : group.label}
                        </span>
                        <span
                          className="inline-flex items-center justify-center rounded-full bg-[var(--chat-input-chip-bg)] text-[var(--settings-section-desc)]"
                          style={{ height: '18px', padding: '0 7px', fontSize: '11px' }}
                        >
                          {group.skills.length}
                        </span>
                      </div>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                          columnGap: '16px',
                          rowGap: '16px',
                        }}
                      >
                        {group.skills.map(renderCard)}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                    columnGap: '16px',
                    rowGap: '16px',
                  }}
                >
                  {items.map(renderCard)}
                </div>
              )}
              {hasMore && (
                <div ref={sentinelRef} className="flex justify-center py-4">
                  {loadingMore && (
                    <span className="text-sm text-[var(--cmd-palette-item-meta)]">
                      {t('skillhub.market.loading')}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* InstallTargetPicker */}
      <InstallTargetPicker
        open={pickerOpen}
        skill={pickerSkill}
        onClose={() => setPickerOpen(false)}
        onInstallComplete={() => {
          void refreshSkillhub();
          setPickerOpen(false);
        }}
      />
      <MarketManagementDialogs controller={management} />
    </div>
  );
}
