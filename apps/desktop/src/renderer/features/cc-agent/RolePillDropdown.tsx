/**
 * RolePillDropdown — worker pane header 的 role pill + popover dropdown。
 *
 * Trigger pill: ● {role} ({agent} · {model} · {effort}) ▾
 * Popover: WORKERS header + worker rows + Create new worker 行。
 */

import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  type ReactNode,
  type WheelEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronUp, Plus, X, EllipsisVertical } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppShortcutDisplay } from '@/hooks/useAppShortcut';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Tip } from '@/components/ui/tooltip';
import { VendorIcon, agentKindToVendor } from '@/components/sidebar/VendorIcon';
import type { WorkerInfo } from './hooks/useWorkers';
import { shouldShowWorkerLabel } from './workerLabel';
import { clearWorkerAttention, useWorkerAttentionSnapshot } from './lib/workerAttentionStore';

// Strip provider prefix: 'deepseek/deepseek-v4-pro' → 'deepseek-v4-pro'.
// 通用代理网关返回的 model id 经常带 'provider/model' 形式, UI 里只显末段更清爽.
function simplifyModelName(model: string): string {
  const slash = model.lastIndexOf('/');
  return slash >= 0 ? model.slice(slash + 1) : model;
}

// 各模型档位集合不同,信号条没有稳定含义。已知档才写词表里的短文案,
// 未知值不显示,也不再默默掉回 medium。
const WORKER_EFFORT_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function workerEffortLabel(t: (key: string) => string, effort: string | null): string | null {
  if (!effort || !WORKER_EFFORT_LEVELS.has(effort)) return null;
  return t(`effortLevels.${effort}`);
}

function WorkerModelLine({
  model,
  effort,
}: {
  model: string;
  effort: string | null;
}) {
  const { t } = useTranslation();
  const effortLabel = workerEffortLabel(t, effort);
  // 列表选中行是浅色 chip 底,不能套深色药丸上的 --surface-on-card,
  // 日间会糊成看不清。副行一律走次级字色。
  // 菜单有 overflow-x-hidden,整行 nowrap 会把后加的档位裁掉;
  // 模型名可截,档位词短、必须留在可见区。右侧给 archive / ERR 留空。
  return (
    <div className="mt-0.5 mr-7 ml-[26px] flex min-w-0 items-baseline gap-1.5 text-12 leading-snug text-[var(--text-secondary)]">
      <span className="min-w-0 truncate">{simplifyModelName(model)}</span>
      {effortLabel ? <span className="shrink-0">· {effortLabel}</span> : null}
    </div>
  );
}

// Worker avatar — 直接复用 sidebar VendorIcon (Claude Code / Codex CLI Agent
// 身份 glyph),跟侧边栏 Agent icon 视觉 100% 对齐:
//   - running: VendorIcon 内部自动 status-bar-accent + session-status-breathing
//   - error:   className override 染 error-flat 红 (twMerge 会让外层 text-* 覆盖
//              VendorIcon 内置的 sidebar-muted default) —— 错误的显式标记由 WorkerErrorBadge
//              (ERR 药丸) + tab 整体描红承担, 这里只图标染红, 不再叠红点
//              (红点在多数 app 里=下级有新消息, 与"出错"语义不符, 故 error 不用点)
//   - idle / done: 走 VendorIcon 默认 sidebar-muted 灰 (跟 sidebar idle 一致, 不 dim)
//   - showAttentionDot=true: 右上叠 6×6 绿 dot(完成未读,全端统一色表:绿=完成未读,
//     橙专职 running;跟 sidebar hasAttentionNotification 同款) —— done 未读用点是合适的
//     (点=有新结果可看); 只有 error 不该用点
function WorkerAvatar({
  agent,
  status,
  showAttentionDot = false,
  selected = false,
}: {
  agent: WorkerInfo['agent'];
  status: WorkerInfo['status'];
  showAttentionDot?: boolean;
  selected?: boolean;
}) {
  const vendor = agentKindToVendor(agent);
  const selectedIdleClassName =
    selected && status !== 'running' && status !== 'error'
      ? 'text-[var(--surface-on-card)]'
      : undefined;
  return (
    <span className="relative inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center">
      <VendorIcon
        vendor={vendor}
        size={vendor === 'cc' ? 14 : 13}
        running={status === 'running'}
        className={status === 'error' ? 'text-[var(--error-flat)]' : selectedIdleClassName}
      />
      {showAttentionDot && (
        <span
          className="absolute -top-[1px] -right-[1px] inline-block h-[6px] w-[6px] rounded-full"
          style={{
            backgroundColor: 'var(--card-status-done)',
            boxShadow: '0 0 0 1.5px var(--surface-elevated)',
          }}
          aria-label="unread"
        />
      )}
    </span>
  );
}

// WorkerErrorBadge — worker 处于终态 error 时的显式标记药丸(ERR)。刻意不用红点:
// 红点在多数 app 里=下级有新消息, 与"出错"语义不符。为醒目做成实心饱和红底 + 浅色字
// (bg=--error-fg 饱和红, text=--error-bg 近白/深红) —— 比"软红底+红字"更抢眼, 且两个
// 都是现成 error token、双主题对比度均已定义, 无需新增"恒定白字"token。位置/偏移由调用方
// 经 className 给(可内联, 也可作绝对定位角标叠在行右上)。
function WorkerErrorBadge({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      aria-label={t('orca.rolePill.errorBadgeAria')}
      className={cn(
        'pointer-events-none inline-flex items-center rounded-full bg-[var(--error-fg)] px-1.5 text-10 font-semibold uppercase leading-[1.5] tracking-[0.3px] text-[var(--error-bg)]',
        className,
      )}
    >
      {t('orca.rolePill.errorBadge')}
    </span>
  );
}

const WORKER_LIST_LAYOUT_KEY = 'orca-worker-list-layout-v1';
const HOVER_OPEN_DELAY_MS = 60;
const HOVER_CLOSE_DELAY_MS = 160;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
const WHEEL_LINE_HEIGHT_PX = 40;

function wheelDeltaYToPixels(event: WheelEvent<HTMLElement>, element: HTMLElement): number {
  switch (event.deltaMode) {
    case DOM_DELTA_LINE:
      return event.deltaY * WHEEL_LINE_HEIGHT_PX;
    case DOM_DELTA_PAGE:
      return event.deltaY * element.clientWidth;
    default:
      return event.deltaY;
  }
}

function ensureChildHorizontallyVisible(container: HTMLElement, child: HTMLElement): void {
  const containerRect = container.getBoundingClientRect();
  const childRect = child.getBoundingClientRect();
  if (childRect.left < containerRect.left) {
    container.scrollLeft -= containerRect.left - childRect.left;
  } else if (childRect.right > containerRect.right) {
    container.scrollLeft += childRect.right - containerRect.right;
  }
}

type WorkerListLayout = 'tabs' | 'dropdown';
type DropdownOpenMode = 'transient' | 'pinned' | null;

// Exported for direct unit testing of the default-layout fallback matrix.
export function readStoredWorkerListLayout(): WorkerListLayout {
  if (typeof window === 'undefined') return 'tabs';
  try {
    const stored = window.localStorage.getItem(WORKER_LIST_LAYOUT_KEY);
    if (stored === 'dropdown') return 'dropdown';
    return 'tabs';
  } catch {
    return 'tabs';
  }
}

function storeWorkerListLayout(layout: WorkerListLayout): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(WORKER_LIST_LAYOUT_KEY, layout);
  } catch {
    // UI preference only; keep the in-memory state if persistence is unavailable.
  }
}

function getWorkerArchiveDisplayName(worker: WorkerInfo): string {
  return shouldShowWorkerLabel(worker.role, worker.label)
    ? `${worker.role} #${worker.label}`
    : worker.role;
}

function useRequestArchiveWorker(onArchiveWorker: (workerId: string) => void) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();

  return useCallback(
    async (target: WorkerInfo) => {
      const displayName = getWorkerArchiveDisplayName(target);
      const ok = await confirm({
        title: t('newChat.collaboration.archiveWorkerConfirmTitleName', {
          name: displayName,
          defaultValue: 'Archive worker {{name}}?',
        }),
        description: t('newChat.collaboration.archiveWorkerConfirmDesc', {
          defaultValue:
            'This stops the worker SDK session and hides it from the sidebar. History is kept as archived. There is no restore action in the current UI; create a new worker if you archived it by mistake.',
        }),
        confirmText: t('newChat.collaboration.archiveWorkerConfirmConfirm', {
          defaultValue: 'Archive worker',
        }),
        cancelText: t('newChat.collaboration.archiveWorkerConfirmCancel', {
          defaultValue: 'Cancel',
        }),
      });
      if (ok) onArchiveWorker(target.workerId);
    },
    [confirm, onArchiveWorker, t],
  );
}

function clearTimerRef(ref: { current: number | null }): void {
  if (ref.current !== null) {
    window.clearTimeout(ref.current);
    ref.current = null;
  }
}

function WorkerSummary({
  worker,
  showAttentionDot,
  selected = false,
  compact = false,
}: {
  worker: WorkerInfo;
  showAttentionDot?: boolean;
  selected?: boolean;
  compact?: boolean;
}) {
  return (
    <>
      <div className={cn('flex items-center gap-2 leading-snug', compact ? 'text-11' : 'text-13')}>
        <WorkerAvatar
          agent={worker.agent}
          status={worker.status}
          showAttentionDot={showAttentionDot}
          selected={selected}
        />
        <span
          className={cn(
            'font-medium',
            selected ? 'text-[var(--surface-on-card)]' : 'text-[var(--text-primary)]',
          )}
        >
          {worker.role}
        </span>
        {shouldShowWorkerLabel(worker.role, worker.label) && !compact && (
          <>
            <span
              className={
                selected
                  ? 'text-[var(--surface-on-card)] opacity-60'
                  : 'text-[var(--text-tertiary)]'
              }
            >
              #
            </span>
            <span
              className={
                selected
                  ? 'text-[var(--surface-on-card)] opacity-80'
                  : 'text-[var(--text-secondary)]'
              }
            >
              {worker.label}
            </span>
          </>
        )}
      </div>
      {!compact && (
        <WorkerModelLine model={worker.model} effort={worker.effort} />
      )}
    </>
  );
}

export interface RolePillDropdownProps {
  worker: WorkerInfo | null;
  workers: WorkerInfo[];
  selectedWorkerId: string | null;
  activeWorkerCount: number;
  onSwitchFocus: (workerId: string) => void;
  onArchiveWorker: (workerId: string) => void;
  /** false 时,选中的 worker 不会仅因组件挂载/刷新而自动清 attention。 */
  clearAttentionWhenVisible?: boolean;
  className?: string;
}

export interface WorkerListToolbarProps extends RolePillDropdownProps {
  softLimit: number;
  hardLimit: number;
  onOpenCreate: () => void;
  trailingActions?: ReactNode;
  /** 硬上限时 + 按钮跳转协同设置的逃生口；分离侧栏窗口无法导航到设置路由，传 undefined 表示不接线。 */
  onOpenSettings?: () => void;
}

// 菜单经 absolute 定位且未走 portal 渲染，会被最近的 overflow 非 visible 祖先裁剪。
// 找到该裁剪祖先元素（overflow 非 visible 的最近祖先）；找不到返回 null。
function findClippingContainer(el: HTMLElement): HTMLElement | null {
  let container: HTMLElement | null = el.parentElement;
  while (container) {
    const style = window.getComputedStyle(container);
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') break;
    container = container.parentElement;
  }
  return container;
}

// 找到裁剪祖先的视口边界（top/bottom/left/right），用于钳制菜单可用高度/宽度；
// 找不到裁剪祖先时返回 null，由调用方退回视口边界。
function findClippingBounds(
  el: HTMLElement,
): { top: number; bottom: number; left: number; right: number } | null {
  const container = findClippingContainer(el);
  if (!container) return null;
  const r = container.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
}

// 菜单经 top-full + mt-1 从锚点下方定位。按锚点相对最近裁剪祖先（而非 window.innerHeight）
// 计算可用高度——当 Worker 工具栏位于高度小于 viewport 的 overflow-hidden 侧栏容器中时，
// 仍能正确钳制菜单高度与展开方向，避免菜单伸出容器被裁掉、底部 Worker 行 / 布局切换项
// 无法滚动到达。当锚点下方空间不足（低于上方空间）时改为向上展开。maxHeight 严格钳制在
// 锚点一侧的真实可用空间内，不再设「固定内容高度保底」——可用空间小于 header + 布局切换项
// 所需高度时，由菜单外层 overflow-y-auto 兜底滚动（布局切换项仍可滚动到），避免
// Math.max(保底, 可用空间) 把菜单顶出裁剪边界、布局切换项反而不可点。
function useAnchorMenuMaxHeight(
  anchorRef: { current: HTMLElement | null },
  open: boolean,
): { maxHeight: number; placeAbove: boolean } | undefined {
  const [placement, setPlacement] = useState<
    { maxHeight: number; placeAbove: boolean } | undefined
  >(undefined);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // mt-1/mb-1 (4px) + 12px 安全边距。
      const gap = 4;
      const pad = 12;
      const clip = findClippingBounds(el);
      const topBound = clip ? clip.top : 0;
      const bottomBound = clip ? clip.bottom : window.innerHeight;
      const belowSpace = bottomBound - rect.bottom - gap - pad;
      const aboveSpace = rect.top - topBound - gap - pad;
      const placeAbove = aboveSpace > belowSpace;
      setPlacement({
        maxHeight: Math.max(0, placeAbove ? aboveSpace : belowSpace),
        placeAbove,
      });
    };
    update();
    window.addEventListener('resize', update);
    // 侧栏经拖拽分割线（pointermove）调整宽度时不会触发 window.resize；用 ResizeObserver
    // 监听裁剪祖先容器尺寸变化，菜单打开期间及时重算边界，避免菜单超出当前侧栏被裁掉。
    const clipContainer = anchorRef.current ? findClippingContainer(anchorRef.current) : null;
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' && clipContainer ? new ResizeObserver(update) : null;
    if (resizeObserver && clipContainer) resizeObserver.observe(clipContainer);
    return () => {
      window.removeEventListener('resize', update);
      resizeObserver?.disconnect();
    };
  }, [anchorRef, open]);
  return placement;
}

// 菜单宽度钳制：硬编码 w-[320px] 在窄侧栏（侧栏 shell overflow-hidden，最小宽 280px）
// 会被裁掉一截。按锚点相对最近裁剪祖先（overflow 非 visible 的容器）的同侧可用宽度
// 钳制菜单最大宽度，避免 worker 行与布局标签被裁切。找不到裁剪祖先时退回视口边界。
// align: 'left' 表示菜单左对齐锚点向右展开（dropdown popover），
//        'right' 表示菜单右对齐锚点向左展开（⋮ 菜单）。
function useAnchorMenuMaxWidth(
  anchorRef: { current: HTMLElement | null },
  open: boolean,
  align: 'left' | 'right',
): number | undefined {
  const [maxWidth, setMaxWidth] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      const anchor = el.getBoundingClientRect();
      const bounds = findClippingBounds(el) ?? { left: 0, right: window.innerWidth };
      const available = align === 'left' ? bounds.right - anchor.left : anchor.right - bounds.left;
      setMaxWidth(Math.max(0, available));
    };
    update();
    window.addEventListener('resize', update);
    // 侧栏经拖拽分割线（pointermove）调整宽度时不会触发 window.resize；用 ResizeObserver
    // 监听裁剪祖先容器尺寸变化，菜单打开期间及时重算边界，避免菜单超出当前侧栏被裁掉。
    const clipContainer = anchorRef.current ? findClippingContainer(anchorRef.current) : null;
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' && clipContainer ? new ResizeObserver(update) : null;
    if (resizeObserver && clipContainer) resizeObserver.observe(clipContainer);
    return () => {
      window.removeEventListener('resize', update);
      resizeObserver?.disconnect();
    };
  }, [anchorRef, open, align]);
  return maxWidth;
}

function WorkerLayoutMenu({
  layout,
  onLayoutChange,
  workers,
  selectedWorkerId,
  activeWorkerCount,
  onSwitchFocus,
  onArchiveWorker,
  clearAttentionWhenVisible = true,
}: {
  layout: WorkerListLayout;
  onLayoutChange: (layout: WorkerListLayout) => void;
  workers: WorkerInfo[];
  selectedWorkerId: string | null;
  activeWorkerCount: number;
  onSwitchFocus: (workerId: string) => void;
  onArchiveWorker: (workerId: string) => void;
  clearAttentionWhenVisible?: boolean;
}) {
  const { t } = useTranslation();
  // 与 dropdown (RolePillDropdown) 对齐展开交互：hover 临时展开 (transient)、
  // 点击固定 (pinned)、移出后延迟关闭 —— 两种布局下 ⋮ 的操作体感一致。
  const [openMode, setOpenMode] = useState<DropdownOpenMode>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const hoverOpenTimerRef = useRef<number | null>(null);
  const hoverCloseTimerRef = useRef<number | null>(null);
  const attention = useWorkerAttentionSnapshot();
  const requestArchiveWorker = useRequestArchiveWorker(onArchiveWorker);
  const totalWorkerCount = workers.length;
  const activeCount = activeWorkerCount;
  const open = openMode !== null;
  const menuPlacement = useAnchorMenuMaxHeight(wrapperRef, open);
  const menuMaxWidth = useAnchorMenuMaxWidth(wrapperRef, open, 'right');

  const clearHoverTimers = useCallback(() => {
    clearTimerRef(hoverOpenTimerRef);
    clearTimerRef(hoverCloseTimerRef);
  }, []);

  const closeMenu = useCallback(() => {
    clearHoverTimers();
    setOpenMode(null);
  }, [clearHoverTimers]);

  const handleMouseEnter = useCallback(() => {
    if (openMode === 'pinned') return;
    clearTimerRef(hoverCloseTimerRef);
    if (openMode === 'transient' || hoverOpenTimerRef.current !== null) return;
    hoverOpenTimerRef.current = window.setTimeout(() => {
      hoverOpenTimerRef.current = null;
      setOpenMode('transient');
    }, HOVER_OPEN_DELAY_MS);
  }, [openMode]);

  const handleMouseLeave = useCallback(() => {
    if (openMode === 'pinned') return;
    clearTimerRef(hoverOpenTimerRef);
    if (openMode !== 'transient' || hoverCloseTimerRef.current !== null) return;
    hoverCloseTimerRef.current = window.setTimeout(() => {
      hoverCloseTimerRef.current = null;
      setOpenMode(null);
    }, HOVER_CLOSE_DELAY_MS);
  }, [openMode]);

  useEffect(() => {
    return () => clearHoverTimers();
  }, [clearHoverTimers]);

  useLayoutEffect(() => {
    if (!open || !clearAttentionWhenVisible) return;
    if (
      selectedWorkerId &&
      workers.find((item) => item.workerId === selectedWorkerId)?.status !== 'done'
    ) {
      clearWorkerAttention(selectedWorkerId);
    }
  }, [attention, clearAttentionWhenVisible, selectedWorkerId, workers, open]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        closeMenu();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [closeMenu, open]);

  const layoutRows: Array<{ value: WorkerListLayout; label: string }> = [
    { value: 'tabs', label: t('orca.rolePill.layoutTabs') },
    { value: 'dropdown', label: t('orca.rolePill.layoutDropdown') },
  ];

  return (
    <div
      ref={wrapperRef}
      className="relative shrink-0"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <Tip text={t('orca.rolePill.layoutMenuLabel')} side="bottom" delay={250} disabled={open}>
        <button
          type="button"
          aria-label={t('orca.rolePill.layoutMenuLabel')}
          className={cn(
            'inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground',
            'hover:bg-muted/70 hover:text-foreground',
            open && 'bg-[var(--surface-chip)] text-[var(--text-primary)]',
          )}
          onClick={() => {
            clearHoverTimers();
            setOpenMode((mode) => (mode === 'pinned' ? null : 'pinned'));
          }}
        >
          <EllipsisVertical size={13} />
        </button>
      </Tip>
      {open && (
        <div
          className={cn(
            'absolute right-0 z-50 flex w-[320px] flex-col overflow-y-auto overflow-x-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]',
            menuPlacement?.placeAbove ? 'bottom-full mb-1' : 'top-full mt-1',
          )}
          style={{
            boxShadow: 'var(--shadow-menu)',
            maxHeight: menuPlacement?.maxHeight,
            maxWidth: menuMaxWidth,
          }}
        >
          {/* Header: WORKERS + count */}
          {layout === 'tabs' && (
            <>
              <div className="flex shrink-0 select-none items-center justify-between px-4 pt-3 pb-2">
                <span className="text-10 font-medium uppercase tracking-[0.5px] text-[var(--text-tertiary)]">
                  {t('orca.rolePill.workersHeader')}
                </span>
                <span className="text-10 font-medium text-[var(--text-tertiary)]">
                  {t('orca.rolePill.workerCountSummary', {
                    count: totalWorkerCount,
                    totalCount: totalWorkerCount,
                    activeCount,
                  })}
                </span>
              </div>

              {/* Worker rows */}
              <div className="flex flex-col">
                {workers.map((w) => {
                  const isFocused = w.workerId === selectedWorkerId || w.focused;
                  const isError = w.status === 'error';
                  return (
                    <div key={w.workerId} className="group relative">
                      <button
                        type="button"
                        className={cn(
                          'flex w-full flex-col px-4 py-2 text-left transition-colors',
                          isError
                            ? 'bg-[var(--error-bg)] border-l-2 border-[var(--error-fg)] pl-[14px]'
                            : isFocused
                              ? 'bg-[var(--surface-chip)] border-l-2 border-[var(--status-bar-accent)] pl-[14px]'
                              : 'pl-4',
                        )}
                        onClick={() => {
                          onSwitchFocus(w.workerId);
                          closeMenu();
                        }}
                      >
                        <div className="flex items-center gap-2 text-13 leading-snug">
                          <WorkerAvatar
                            agent={w.agent}
                            status={w.status}
                            showAttentionDot={!isFocused && attention.has(w.workerId)}
                          />
                          <span className="font-medium text-[var(--text-primary)]">{w.role}</span>
                          {shouldShowWorkerLabel(w.role, w.label) && (
                            <>
                              <span className="text-[var(--text-tertiary)]">#</span>
                              <span className="text-[var(--text-secondary)]">{w.label}</span>
                            </>
                          )}
                        </div>
                        <WorkerModelLine model={w.model} effort={w.effort} />
                      </button>
                      {/* hover archive ✕ */}
                      <button
                        type="button"
                        className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-[22px] w-[22px] items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeMenu();
                          void requestArchiveWorker(w);
                        }}
                        aria-label={t('orca.rolePill.archiveWorkerAria', {
                          name: getWorkerArchiveDisplayName(w),
                        })}
                      >
                        <X size={13} />
                      </button>
                      {isError && (
                        <WorkerErrorBadge className="absolute right-2 top-1.5 z-10 shadow-[0_0_0_1.5px_var(--surface-elevated)]" />
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Separator */}
              <div className="mx-4 h-px shrink-0 bg-[var(--border-default)]" />
            </>
          )}

          {/* Layout options */}
          <div className="shrink-0 p-1">
            <div className="select-none px-2.5 py-1.5 text-10 font-medium leading-snug text-[var(--text-tertiary)]">
              {t('orca.rolePill.layoutMenuLabel')}
            </div>
            {layoutRows.map((row) => {
              const selected = row.value === layout;
              return (
                <button
                  key={row.value}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-12 leading-snug text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)]"
                  onClick={() => {
                    onLayoutChange(row.value);
                    closeMenu();
                  }}
                >
                  <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--text-primary)]">
                    {selected && <Check size={12} strokeWidth={2.4} />}
                  </span>
                  <span>{row.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function CreateWorkerTabButton({
  activeCount,
  softLimit,
  hardLimit,
  onOpenCreate,
  onOpenSettings,
}: {
  activeCount: number;
  softLimit: number;
  hardLimit: number;
  onOpenCreate: () => void;
  onOpenSettings?: () => void;
}) {
  const { t } = useTranslation();
  const shortcutKey = useAppShortcutDisplay('new-maker');
  const hardDisabled = activeCount >= hardLimit;
  // 硬上限时 + 按钮提供「跳转协同设置」逃生口；但分离侧栏窗口无法导航到设置路由
  // （onOpenSettings 未接线），此时退回旧的 disabled 行为，避免呈现一个点了没反应的按钮。
  const hardSettingsAction = hardDisabled && !!onOpenSettings;
  const hardBlocked = hardDisabled && !onOpenSettings;
  const softWarn = !hardDisabled && activeCount >= softLimit;
  const tooltip = hardSettingsAction
    ? t('orca.rolePill.hardLimitSettingsHint', { count: hardLimit })
    : hardBlocked
      ? t('orca.rolePill.hardLimitHint', { count: hardLimit })
      : softWarn
        ? t('orca.rolePill.softLimitHint', { count: softLimit })
        : shortcutKey
          ? `${t('orca.rolePill.createWorker')} (${shortcutKey})`
          : t('orca.rolePill.createWorker');

  return (
    <Tip text={tooltip} side="bottom" delay={250}>
      <button
        type="button"
        aria-label={
          hardSettingsAction
            ? t('orca.rolePill.settingsCollaboration')
            : t('orca.rolePill.createWorker')
        }
        aria-disabled={hardBlocked || undefined}
        className={cn(
          'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--border-default)]',
          'bg-[var(--surface-elevated)] text-[var(--text-secondary)] transition-colors',
          'hover:bg-[var(--surface-chip)] hover:text-[var(--text-primary)]',
          (softWarn || hardSettingsAction) && 'text-[var(--status-bar-accent)]',
          hardBlocked &&
            'cursor-not-allowed opacity-40 hover:bg-[var(--surface-elevated)] hover:text-[var(--text-secondary)]',
        )}
        onClick={() => {
          if (hardSettingsAction) {
            onOpenSettings?.();
            return;
          }
          if (hardBlocked) return;
          onOpenCreate();
        }}
      >
        <Plus size={13} />
      </button>
    </Tip>
  );
}

function WorkerTabsList({
  workers,
  selectedWorkerId,
  onSwitchFocus,
  onArchiveWorker,
  clearAttentionWhenVisible = true,
}: {
  workers: WorkerInfo[];
  selectedWorkerId: string | null;
  onSwitchFocus: (workerId: string) => void;
  onArchiveWorker: (workerId: string) => void;
  clearAttentionWhenVisible?: boolean;
}) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const focusedTabRef = useRef<HTMLButtonElement | null>(null);
  const [scrollState, setScrollState] = useState({ left: false, right: false });
  const attention = useWorkerAttentionSnapshot();
  const requestArchiveWorker = useRequestArchiveWorker(onArchiveWorker);
  const focusedWorkerId =
    selectedWorkerId ?? workers.find((worker) => worker.focused)?.workerId ?? null;

  useLayoutEffect(() => {
    if (!clearAttentionWhenVisible) return;
    if (
      selectedWorkerId &&
      workers.find((item) => item.workerId === selectedWorkerId)?.status !== 'done'
    ) {
      clearWorkerAttention(selectedWorkerId);
    }
  }, [attention, clearAttentionWhenVisible, selectedWorkerId, workers]);

  const updateScrollState = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const maxLeft = element.scrollWidth - element.clientWidth;
    setScrollState({
      left: element.scrollLeft > 1,
      right: maxLeft - element.scrollLeft > 1,
    });
  }, []);

  useEffect(() => {
    updateScrollState();
    const element = scrollRef.current;
    if (!element) return undefined;
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateScrollState) : null;
    resizeObserver?.observe(element);
    return () => resizeObserver?.disconnect();
  }, [updateScrollState, workers]);

  useEffect(() => {
    const container = scrollRef.current;
    const focusedTab = focusedTabRef.current;
    if (!container || !focusedTab) return;
    ensureChildHorizontallyVisible(container, focusedTab);
    updateScrollState();
  }, [focusedWorkerId, updateScrollState, workers.length]);

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    if (element.scrollWidth <= element.clientWidth) return;
    event.preventDefault();
    element.scrollLeft += wheelDeltaYToPixels(event, element);
    updateScrollState();
  };

  return (
    <div className="relative min-w-0 flex-1">
      <div
        ref={scrollRef}
        className="flex min-w-0 items-center gap-1 overflow-x-auto pr-3 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onScroll={updateScrollState}
        onWheel={handleWheel}
      >
        {workers.map((worker) => {
          const selected = worker.workerId === focusedWorkerId;
          const showAttentionDot = !selected && attention.has(worker.workerId);
          // error 终态整体描红: 选中态保留 accent 底 (标明当前 tab) 但换红边, 非选中态
          // 走软红底 + 红边 + 红字, 让出错 worker 的 tab 一眼可定位。
          const isError = worker.status === 'error';
          return (
            <Tip
              key={worker.workerId}
              side="bottom"
              delay={250}
              contentClassName="min-w-[220px] max-w-[260px] border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[var(--shadow-menu)]"
              text={
                <div className="py-0.5">
                  <WorkerSummary worker={worker} showAttentionDot={showAttentionDot} />
                </div>
              }
            >
              <div className="group relative inline-flex shrink-0">
                <button
                  type="button"
                  ref={selected ? focusedTabRef : undefined}
                  className={cn(
                    'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border py-0 pl-2 pr-6 text-11 leading-none transition-colors',
                    selected
                      ? isError
                        ? 'border-[var(--error-fg)] bg-[var(--accent-cta-bg)] text-[var(--accent-pure-cta-fg)]'
                        : 'border-[var(--accent-cta-bg)] bg-[var(--accent-cta-bg)] text-[var(--accent-pure-cta-fg)]'
                      : isError
                        ? 'border-[var(--error-border)] bg-[var(--error-bg)] text-[var(--error-fg-strong)] hover:bg-[var(--error-bg)]'
                        : 'border-[var(--border-default)] bg-[var(--surface-chip)] text-[var(--text-primary)] hover:bg-[var(--surface-hover)]',
                  )}
                  onClick={() => {
                    onSwitchFocus(worker.workerId);
                  }}
                >
                  <WorkerSummary
                    worker={worker}
                    showAttentionDot={showAttentionDot}
                    selected={selected}
                    compact
                  />
                  {/* ERR 徽章行内放在 pill 内部, 而非溢出角标 —— 平铺容器是 overflow-x-auto
                      (会连带裁剪垂直溢出), 角标朝上溢出会被切掉; 行内则始终在 pill 边界内。 */}
                  {isError && <WorkerErrorBadge className="ml-0.5" />}
                </button>
                <button
                  type="button"
                  className={cn(
                    'absolute right-[3px] top-1/2 inline-flex h-[18px] w-[18px] -translate-y-1/2 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100',
                    selected
                      ? 'text-[var(--surface-on-card)] hover:text-[var(--surface-on-card)]'
                      : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]',
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    void requestArchiveWorker(worker);
                  }}
                  aria-label={t('orca.rolePill.archiveWorkerAria', {
                    name: getWorkerArchiveDisplayName(worker),
                  })}
                >
                  <X size={12} />
                </button>
              </div>
            </Tip>
          );
        })}
      </div>
      {scrollState.left && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-5"
          style={{ background: 'linear-gradient(to right, hsl(var(--content-area)), transparent)' }}
        />
      )}
      {scrollState.right && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-7"
          style={{ background: 'linear-gradient(to right, transparent, hsl(var(--content-area)))' }}
        />
      )}
    </div>
  );
}

export function WorkerListToolbar({
  worker,
  workers,
  selectedWorkerId,
  activeWorkerCount,
  softLimit,
  hardLimit,
  onSwitchFocus,
  onOpenCreate,
  onOpenSettings,
  onArchiveWorker,
  trailingActions,
  clearAttentionWhenVisible = true,
  className,
}: WorkerListToolbarProps) {
  const { t } = useTranslation();
  const [layout, setLayout] = useState<WorkerListLayout>(readStoredWorkerListLayout);
  const activeCount = activeWorkerCount;

  const handleLayoutChange = useCallback((nextLayout: WorkerListLayout) => {
    setLayout(nextLayout);
    storeWorkerListLayout(nextLayout);
  }, []);

  if (!worker) {
    return (
      <div className={cn('flex min-w-0 flex-1 items-center gap-1', className)}>
        <span className="min-w-0 flex-1 select-none truncate text-11 font-medium text-muted-foreground">
          {t('orca.rolePill.worker')}
        </span>
        <CreateWorkerTabButton
          activeCount={activeCount}
          softLimit={softLimit}
          hardLimit={hardLimit}
          onOpenCreate={onOpenCreate}
          onOpenSettings={onOpenSettings}
        />
        <WorkerLayoutMenu
          layout={layout}
          onLayoutChange={handleLayoutChange}
          workers={workers}
          selectedWorkerId={selectedWorkerId}
          activeWorkerCount={activeWorkerCount}
          onSwitchFocus={onSwitchFocus}
          onArchiveWorker={onArchiveWorker}
          clearAttentionWhenVisible={clearAttentionWhenVisible}
        />
        {trailingActions}
      </div>
    );
  }

  return (
    <div className={cn('flex min-w-0 flex-1 items-center gap-1.5', className)}>
      {layout === 'tabs' ? (
        <>
          <CreateWorkerTabButton
            activeCount={activeCount}
            softLimit={softLimit}
            hardLimit={hardLimit}
            onOpenCreate={onOpenCreate}
            onOpenSettings={onOpenSettings}
          />
          <WorkerTabsList
            workers={workers}
            selectedWorkerId={selectedWorkerId}
            onSwitchFocus={onSwitchFocus}
            onArchiveWorker={onArchiveWorker}
            clearAttentionWhenVisible={clearAttentionWhenVisible}
          />
        </>
      ) : (
        <>
          <CreateWorkerTabButton
            activeCount={activeCount}
            softLimit={softLimit}
            hardLimit={hardLimit}
            onOpenCreate={onOpenCreate}
            onOpenSettings={onOpenSettings}
          />
          <div className="min-w-0 flex-1">
            <RolePillDropdown
              worker={worker}
              workers={workers}
              selectedWorkerId={selectedWorkerId}
              activeWorkerCount={activeWorkerCount}
              onSwitchFocus={onSwitchFocus}
              onArchiveWorker={onArchiveWorker}
              clearAttentionWhenVisible={clearAttentionWhenVisible}
            />
          </div>
        </>
      )}
      <WorkerLayoutMenu
        layout={layout}
        onLayoutChange={handleLayoutChange}
        workers={workers}
        selectedWorkerId={selectedWorkerId}
        activeWorkerCount={activeWorkerCount}
        onSwitchFocus={onSwitchFocus}
        onArchiveWorker={onArchiveWorker}
        clearAttentionWhenVisible={clearAttentionWhenVisible}
      />
      {trailingActions}
    </div>
  );
}

export function RolePillDropdown({
  worker,
  workers,
  selectedWorkerId,
  activeWorkerCount,
  onSwitchFocus,
  onArchiveWorker,
  clearAttentionWhenVisible = true,
  className,
}: RolePillDropdownProps) {
  const { t } = useTranslation();
  const [openMode, setOpenMode] = useState<DropdownOpenMode>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const hoverOpenTimerRef = useRef<number | null>(null);
  const hoverCloseTimerRef = useRef<number | null>(null);
  const attention = useWorkerAttentionSnapshot();
  const requestArchiveWorker = useRequestArchiveWorker(onArchiveWorker);
  const open = openMode !== null;
  const menuPlacement = useAnchorMenuMaxHeight(triggerRef, open);
  const menuMaxWidth = useAnchorMenuMaxWidth(triggerRef, open, 'left');

  useLayoutEffect(() => {
    if (!clearAttentionWhenVisible) return;
    if (
      selectedWorkerId &&
      workers.find((item) => item.workerId === selectedWorkerId)?.status !== 'done'
    ) {
      clearWorkerAttention(selectedWorkerId);
    }
  }, [attention, clearAttentionWhenVisible, selectedWorkerId, workers]);

  const clearHoverTimers = useCallback(() => {
    clearTimerRef(hoverOpenTimerRef);
    clearTimerRef(hoverCloseTimerRef);
  }, []);

  const closeDropdown = useCallback(() => {
    clearHoverTimers();
    setOpenMode(null);
  }, [clearHoverTimers]);

  const handleMouseEnter = useCallback(() => {
    if (openMode === 'pinned') return;
    clearTimerRef(hoverCloseTimerRef);
    if (openMode === 'transient' || hoverOpenTimerRef.current !== null) return;
    hoverOpenTimerRef.current = window.setTimeout(() => {
      hoverOpenTimerRef.current = null;
      setOpenMode('transient');
    }, HOVER_OPEN_DELAY_MS);
  }, [openMode]);

  const handleMouseLeave = useCallback(() => {
    if (openMode === 'pinned') return;
    clearTimerRef(hoverOpenTimerRef);
    if (openMode !== 'transient' || hoverCloseTimerRef.current !== null) return;
    hoverCloseTimerRef.current = window.setTimeout(() => {
      hoverCloseTimerRef.current = null;
      setOpenMode(null);
    }, HOVER_CLOSE_DELAY_MS);
  }, [openMode]);

  useEffect(() => {
    return () => clearHoverTimers();
  }, [clearHoverTimers]);

  // click outside → close
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        closeDropdown();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDropdown();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [closeDropdown, open]);

  if (!worker) {
    return (
      <span className={cn('text-11 font-medium text-muted-foreground', className)}>
        {t('orca.rolePill.worker')}
      </span>
    );
  }

  const totalWorkerCount = workers.length;
  const activeCount = activeWorkerCount;
  // dropdown 折叠态 trigger 只显 focused worker。若其它(折叠后看不见的)worker 处于
  // error, 折叠入口必须也能看出来 —— 否则违反可见性原则(展开才发现问题太迟)。这里
  // 聚合出"存在非当前显示的出错 worker", 在 trigger 右上叠一个 error 角标(static,
  // 聚合未读语义, 同侧栏聚合入口)。当前 worker 自己出错已由药丸整体描红表达, 故这里
  // 排除当前 worker, 只提示"还有你没看到的错误"。
  const hasHiddenWorkerError = workers.some(
    (w) => w.status === 'error' && w.workerId !== worker.workerId,
  );

  return (
    <div className="relative" onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
      {/* ── Trigger: 单 chip [avatar 含 status + role + caret].
            model / effort 不在这里展示 — focused worker 的 model 在输入框那边自然
            可见, dropdown 列表里 worker rows 第二行还展示简化 model + 档位文字
            供切换时对比, 这里只用 role 标识 "当前活跃的 worker". ── */}
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border py-[3px] px-2.5',
          'text-11 leading-none',
          // focused worker 出错时 trigger 也描红(dropdown 布局下它是常驻可见的当前 worker)
          worker.status === 'error'
            ? 'border-[var(--error-border)] bg-[var(--error-bg)] hover:bg-[var(--error-bg)]'
            : cn(
                'border-[var(--border-default)]',
                open ? 'bg-[var(--surface-chip)]' : 'bg-[var(--surface-elevated)]',
                'hover:bg-[var(--surface-chip)]',
              ),
          'transition-colors',
          className,
        )}
        onClick={() => {
          clearHoverTimers();
          setOpenMode((mode) => (mode === 'pinned' ? null : 'pinned'));
        }}
      >
        <WorkerAvatar agent={worker.agent} status={worker.status} />
        <span className="font-medium text-[var(--text-primary)]">{worker.role}</span>
        {/* 折叠入口错误徽章(内联, 而非溢出角标 —— trigger 处在会裁剪的容器里, 角标会被切)。
            两种情形都显: (1) 当前 focused worker 自己出错; (2) 有"当前没显示出来的"出错
            worker(折叠只显 focused, 描红盖不到隐藏的出错 worker)—— 满足可见性原则。 */}
        {(worker.status === 'error' || hasHiddenWorkerError) && (
          <WorkerErrorBadge className="ml-0.5" />
        )}
        {open ? (
          <ChevronUp size={11} className="text-[var(--text-tertiary)]" />
        ) : (
          <ChevronDown size={11} className="text-[var(--text-tertiary)]" />
        )}
      </button>

      {/* ── Popover ── */}
      {open && (
        <div
          ref={popoverRef}
          className={cn(
            'absolute left-0 z-50 flex w-[320px] flex-col overflow-y-auto overflow-x-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]',
            menuPlacement?.placeAbove ? 'bottom-full mb-1' : 'top-full mt-1',
          )}
          style={{
            boxShadow: 'var(--shadow-menu)',
            maxHeight: menuPlacement?.maxHeight,
            maxWidth: menuMaxWidth,
          }}
        >
          {/* Header: WORKERS + count */}
          <div className="flex shrink-0 select-none items-center justify-between px-4 pt-3 pb-2">
            <span className="text-10 font-medium uppercase tracking-[0.5px] text-[var(--text-tertiary)]">
              {t('orca.rolePill.workersHeader')}
            </span>
            <span className="text-10 font-medium text-[var(--text-tertiary)]">
              {t('orca.rolePill.workerCountSummary', {
                // count 驱动 i18next 复数选择 (en: _one/_other; zh/ja/ko: _other),
                // totalCount/activeCount 仍用于插值。
                count: totalWorkerCount,
                totalCount: totalWorkerCount,
                activeCount,
              })}
            </span>
          </div>

          {/* Worker rows */}
          <div className="flex flex-col">
            {workers.map((w) => {
              const isFocused = w.workerId === selectedWorkerId || w.focused;
              // error 行整体描红(优先于 focused 高亮), 软红底 + 红左边, 与 tabs 布局一致。
              const isError = w.status === 'error';
              return (
                <div key={w.workerId} className="group relative">
                  <button
                    type="button"
                    className={cn(
                      'flex w-full flex-col px-4 py-2 text-left transition-colors',
                      isError
                        ? 'bg-[var(--error-bg)] border-l-2 border-[var(--error-fg)] pl-[14px]'
                        : isFocused
                          ? 'bg-[var(--surface-chip)] border-l-2 border-[var(--status-bar-accent)] pl-[14px]'
                          : 'pl-4',
                    )}
                    onClick={() => {
                      onSwitchFocus(w.workerId);
                      closeDropdown();
                    }}
                  >
                    {/* 主行: avatar (含 status icon + 可选 attention dot) + role + optional internal label. */}
                    <div className="flex items-center gap-2 text-13 leading-snug">
                      <WorkerAvatar
                        agent={w.agent}
                        status={w.status}
                        showAttentionDot={!isFocused && attention.has(w.workerId)}
                      />
                      <span className="font-medium text-[var(--text-primary)]">{w.role}</span>
                      {shouldShowWorkerLabel(w.role, w.label) && (
                        <>
                          <span className="text-[var(--text-tertiary)]">#</span>
                          <span className="text-[var(--text-secondary)]">{w.label}</span>
                        </>
                      )}
                    </div>
                    {/* 副行: 简化 model 名 (去 provider 前缀) + 档位文字.
                        各模型档位集合不同,不用信号条假装同一把尺子. */}
                    <WorkerModelLine model={w.model} effort={w.effort} />
                  </button>
                  {/* hover archive ✕ */}
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-[22px] w-[22px] items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeDropdown();
                      void requestArchiveWorker(w);
                    }}
                    aria-label={t('orca.rolePill.archiveWorkerAria', {
                      name: getWorkerArchiveDisplayName(w),
                    })}
                  >
                    <X size={13} />
                  </button>
                  {/* 出错行的显式 ERR 徽章(角标叠右上); 行整体已描红, 徽章给出明确标记 */}
                  {isError && (
                    <WorkerErrorBadge className="absolute right-2 top-1.5 z-10 shadow-[0_0_0_1.5px_var(--surface-elevated)]" />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
