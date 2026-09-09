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
import { getMarketSelected, setMarketSelected } from './hooks/useMarketSelection';
import { MarketCard } from './components/MarketCard';
import { InstallTargetPicker } from './components/InstallTargetPicker';
import { SkillhubMarketPreviewPanel } from './SkillhubMarketPreviewPanel';
import { marketCardPrimaryAction } from './lib/marketDetailViewModel';
import { groupMineByOwner } from './lib/mineGrouping';
import { nextMarketPreviewName } from './lib/marketPreviewSelection';
import { syncMarketPreviewSelection } from './lib/marketPreviewSync';
import { useAuth } from '@/contexts/AuthContext';
import { CATEGORY_ALL } from '../../../shared/skillhubCategory';
import { useSkillhubIdentityPolicy } from './hooks/useSkillhubIdentityPolicy';

const FILTER_CHIP_STYLE = { height: '32px', padding: '0 12px', fontSize: '12px' };
// Must match the global native scrollbar width in styles/globals.css.
const MARKET_SCROLLBAR_GUTTER_PX = 12;

const SORT_OPTIONS: Array<{ value: SortBy; labelKey: string }> = [
  { value: 'trending', labelKey: 'skillhub.market.sortTrending' },
  { value: 'downloads', labelKey: 'skillhub.market.sortDownloads' },
  { value: 'updated_at', labelKey: 'skillhub.market.sortLatest' },
  { value: 'created_at', labelKey: 'skillhub.market.sortCreated' },
];

/** 圆角 pill 过滤 chip；样式跟 toolbar 上的 visibility chip 完全一致。 */
function FilterChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex shrink-0 items-center justify-center rounded-full transition-colors ${
        active
          ? 'bg-[var(--chat-input-chip-bg)] font-medium text-[var(--msg-assistant-text)]'
          : 'border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] font-normal text-[var(--settings-section-desc)]'
      }`}
      style={FILTER_CHIP_STYLE}
    >
      <span className="whitespace-nowrap leading-none">{label}</span>
    </button>
  );
}

export function SkillhubMarketListView() {
  return <SkillhubMarketListViewInner />;
}

function SkillhubMarketListViewInner() {
  const { t } = useTranslation();
  const { user, isInitializing } = useAuth();
  const identityPolicy = useSkillhubIdentityPolicy(user);
  const location = useLocation();
  const navigate = useNavigate();
  const marketState = location.state as { freshEntry?: boolean; initialVisibility?: Visibility } | null;
  const initialVisibility = marketState?.initialVisibility === 'all' ||
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
  } = useMarketList(initialVisibility, { initialScope: 'market' });
  const { categories } = useCategoryList();

  // 「我的发布」按归属(个人 / 各团队)分组渲染;空组不显示(groupMineByOwner 只对有 item 的 owner 建组)。
  const isMineView = visibility === 'mine';
  const mineGroups = isMineView ? groupMineByOwner(items) : [];

  const selectedCategoryName = categoryFilter === CATEGORY_ALL
    ? t('skillhub.market.categoryAll')
    : categories.find((c) => c.slug === categoryFilter)?.name ?? t('skillhub.market.categoryAll');
  const marketScrollRef = useRef<HTMLDivElement | null>(null);
  const [marketHasVerticalOverflow, setMarketHasVerticalOverflow] = useState(false);

  // freshEntry = true(顶部 Market 按钮显式点击)→ 清空 selection,回到状态 A
  // 不带这个标记(detail goBack → navigate(fromRoute='/skillhub/market'))→
  // 保留上次的 module-level selection,sidebar panel + 卡片选中态都自然恢复。
  const isFreshEntry = marketState?.freshEntry === true;

  // 当前选中的 Market skill —— 初始值取自模块级 store(detail goBack 回来的场景),
  // freshEntry 时强制 null。
  const [selectedName, setSelectedName] = useState<string | null>(() =>
    isFreshEntry ? null : getMarketSelected()?.name ?? null,
  );
  const [previewSkill, setPreviewSkill] = useState<MarketSkill | null>(null);

  useEffect(() => {
    if (!isInitializing && !user && visibility === 'mine') setVisibility('all');
  }, [isInitializing, setVisibility, user, visibility]);

  useEffect(() => {
    if (isFreshEntry) {
      setPreviewSkill(null);
      setMarketSelected(null);
    }
    // 仅 mount 时跑一次:freshEntry 是入口时刻的一次性信号。
  }, []);

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

  useEffect(() => {
    if (!previewSkill && !selectedName) return;
    const next = syncMarketPreviewSelection({ previewSkill, selectedName }, items);
    if (next.previewSkill === previewSkill && next.selectedName === selectedName) return;
    setPreviewSkill(next.previewSkill);
    setSelectedName(next.selectedName);
    setMarketSelected(next.previewSkill);
  }, [items, previewSkill, selectedName]);

  // Picker 状态 — Clone 按钮触发
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSkill, setPickerSkill] = useState<MarketSkill | null>(null);

  // 订阅 install progress 事件：done 时 refresh 本地 scan + toast
  useEffect(() => {
    const unsubscribe = window.electronAPI.skillhub.onInstallProgress((event) => {
      if (event.phase === 'done') {
        void refreshSkillhub();
      } else if (event.phase === 'failed') {
        if (event.errorCode !== 'CANCELLED') {
          toast.error(t('skillhub.market.installFailedToast', {
            name: event.name,
            message: event.message ?? event.errorCode ?? t('skillhub.market.installError'),
          }));
        }
      }
    });
    return unsubscribe;
  }, [t]);

  const sortLabel = useMemo(() => {
    return t(SORT_OPTIONS.find((option) => option.value === sortBy)?.labelKey ?? 'skillhub.market.sortLatest');
  }, [sortBy, t]);

  const handleCardClick = (skill: MarketSkill) => {
    const newName = nextMarketPreviewName(previewSkill?.name ?? null, skill.name);
    setSelectedName(newName);
    setMarketSelected(newName ? skill : null);
    setPreviewSkill(newName ? skill : null);
  };

  const handlePreviewClose = () => {
    setSelectedName(null);
    setMarketSelected(null);
    setPreviewSkill(null);
  };

  const handleClone = (skill: MarketSkill) => {
    setPickerSkill(skill);
    setPickerOpen(true);
  };
  const management = useMarketManagement({
    active: isMineView,
    reload,
    onClone: handleClone,
    onDeleted: (skill) => {
      if (previewSkill?.name !== skill.name && selectedName !== skill.name) return;
      setPreviewSkill(null);
      setSelectedName(null);
      setMarketSelected(null);
    },
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
      onManageAction={management.handleManageAction}
      onClick={handleCardClick}
      selected={skill.name === selectedName}
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
          ...(previewSkill ? WINDOW_NO_DRAG_STYLE : WINDOW_DRAG_STYLE),
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

          <FilterChip
            active={visibility === 'all'}
            label={t('skillhub.market.chipAll')}
            onClick={() => setVisibility('all')}
          />
          {user ? (
            <FilterChip
              active={visibility === 'mine'}
              label={t('skillhub.market.chipMine')}
              onClick={() => setVisibility('mine')}
            />
          ) : null}
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
          {error ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-[var(--error-fg)]">{t('skillhub.market.loadFailed', { error })}</p>
            </div>
          ) : loading && items.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-[var(--cmd-palette-item-meta)]">{t('skillhub.market.loading')}</p>
            </div>
          ) : items.length === 0 ? (
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
      <SkillhubMarketPreviewPanel
        open={previewSkill !== null}
        skill={previewSkill}
        onClose={handlePreviewClose}
        primaryAction={previewSkill && user
          ? (() => {
              const action = marketCardPrimaryAction({
                isMine: previewSkill.isMine,
                listVisibility: visibility,
                cardState: previewSkill.cardState,
              });
              return action === 'manage' && !identityPolicy.canWrite ? 'clone' : action;
            })()
          : 'none'}
        onClone={handleClone}
        onManageAction={management.handleManageAction}
      />
      <MarketManagementDialogs controller={management} />
    </div>
  );
}
