/**
 * RolePillDropdown — worker pane header 的 role pill + popover dropdown。
 *
 * Trigger pill: ● {role} ({agent} · {model} · {effort}) ▾
 * Popover: WORKERS header + worker rows + Create new worker 行。
 */

import { useState, useRef, useEffect, useLayoutEffect, useCallback, type ReactNode, type WheelEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Plus,
  ChevronRight,
  X,
  EllipsisVertical,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppShortcutDisplay } from '@/hooks/useAppShortcut';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Tip } from '@/components/ui/tooltip';
import { VendorIcon, agentKindToVendor } from '@/components/sidebar/VendorIcon';
import type { WorkerInfo } from './hooks/useWorkers';
import { shouldShowWorkerLabel } from './workerLabel';
import {
  clearWorkerAttention,
  useWorkerAttentionSnapshot,
} from './lib/workerAttentionStore';

// Strip provider prefix: 'deepseek/deepseek-v4-pro' → 'deepseek-v4-pro'.
// 通用代理网关返回的 model id 经常带 'provider/model' 形式, UI 里只显末段更清爽.
function simplifyModelName(model: string): string {
  const slash = model.lastIndexOf('/');
  return slash >= 0 ? model.slice(slash + 1) : model;
}

// Effort 文字 → 5-bar 视觉编码 (跟主 pill 的 Codex effort 表达对齐).
// minimal/low/medium/high/max 对应填 1/2/3/4/5 个柱.
const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'max'] as const;
function effortFillCount(effort: string | null): number {
  const idx = EFFORT_LEVELS.indexOf((effort ?? 'medium') as (typeof EFFORT_LEVELS)[number]);
  return idx >= 0 ? idx + 1 : 3;
}

function EffortBars({ effort }: { effort: string | null }) {
  const fill = effortFillCount(effort);
  return (
    <span
      className="inline-flex items-end"
      style={{ gap: 1.5, height: 8 }}
      aria-label={`effort ${effort ?? 'medium'}`}
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          style={{
            display: 'inline-block',
            width: 2,
            height: 4 + i,
            borderRadius: 1,
            backgroundColor: i < fill ? 'var(--text-secondary)' : 'var(--text-tertiary)',
            opacity: i < fill ? 1 : 0.35,
          }}
        />
      ))}
    </span>
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

function readStoredWorkerListLayout(): WorkerListLayout {
  if (typeof window === 'undefined') return 'dropdown';
  try {
    return window.localStorage.getItem(WORKER_LIST_LAYOUT_KEY) === 'tabs' ? 'tabs' : 'dropdown';
  } catch {
    return 'dropdown';
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
      <div
        className={cn(
          'flex items-center gap-2 leading-snug',
          compact ? 'text-11' : 'text-13',
        )}
      >
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
        <div className="mt-0.5 ml-[26px] flex items-center gap-1.5 text-11 leading-snug text-[var(--text-tertiary)]">
          <span>{simplifyModelName(worker.model)}</span>
          <EffortBars effort={worker.effort} />
        </div>
      )}
    </>
  );
}

export interface RolePillDropdownProps {
  worker: WorkerInfo | null;
  workers: WorkerInfo[];
  selectedWorkerId: string | null;
  activeWorkerCount: number;
  softLimit: number;
  hardLimit: number;
  onSwitchFocus: (workerId: string) => void;
  onOpenCreate: () => void;
  onOpenSettings: () => void;
  settingsEnabled?: boolean;
  onArchiveWorker: (workerId: string) => void;
  /** false 时,选中的 worker 不会仅因组件挂载/刷新而自动清 attention。 */
  clearAttentionWhenVisible?: boolean;
  className?: string;
}

export interface WorkerListToolbarProps extends RolePillDropdownProps {
  trailingActions?: ReactNode;
}

function WorkerLayoutMenu({
  layout,
  onLayoutChange,
}: {
  layout: WorkerListLayout;
  onLayoutChange: (layout: WorkerListLayout) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const rows: Array<{ value: WorkerListLayout; label: string }> = [
    { value: 'tabs', label: t('orca.rolePill.layoutTabs') },
    { value: 'dropdown', label: t('orca.rolePill.layoutDropdown') },
  ];

  return (
    <div ref={wrapperRef} className="relative shrink-0">
      <Tip text={t('orca.rolePill.layoutMenuLabel')} side="bottom" delay={250}>
        <button
          type="button"
          aria-label={t('orca.rolePill.layoutMenuLabel')}
          className={cn(
            'inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground',
            'hover:bg-muted/70 hover:text-foreground',
            open && 'bg-[var(--surface-chip)] text-[var(--text-primary)]',
          )}
          onClick={() => setOpen((value) => !value)}
        >
          <EllipsisVertical size={13} />
        </button>
      </Tip>
      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-1 w-[190px] rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-1"
          style={{ boxShadow: 'var(--shadow-menu)' }}
        >
          <div className="select-none px-2.5 py-1.5 text-10 font-medium leading-snug text-[var(--text-tertiary)]">
            {t('orca.rolePill.layoutMenuLabel')}
          </div>
          {rows.map((row) => {
            const selected = row.value === layout;
            return (
              <button
                key={row.value}
                type="button"
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-12 leading-snug text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)]"
                onClick={() => {
                  onLayoutChange(row.value);
                  setOpen(false);
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
      )}
    </div>
  );
}

function CreateWorkerTabButton({
  activeCount,
  softLimit,
  hardLimit,
  onOpenCreate,
}: {
  activeCount: number;
  softLimit: number;
  hardLimit: number;
  onOpenCreate: () => void;
}) {
  const { t } = useTranslation();
  const hardDisabled = activeCount >= hardLimit;
  const softWarn = !hardDisabled && activeCount >= softLimit;
  const tooltip = hardDisabled
    ? t('orca.rolePill.hardLimitHint', { count: hardLimit })
    : softWarn
      ? t('orca.rolePill.softLimitHint', { count: softLimit })
      : t('orca.rolePill.createWorker');

  return (
    <Tip text={tooltip} side="bottom" delay={250}>
      <button
        type="button"
        aria-label={t('orca.rolePill.createWorker')}
        aria-disabled={hardDisabled}
        className={cn(
          'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--border-default)]',
          'bg-[var(--surface-elevated)] text-[var(--text-secondary)] transition-colors',
          'hover:bg-[var(--surface-chip)] hover:text-[var(--text-primary)]',
          softWarn && 'text-[var(--status-bar-accent)]',
          hardDisabled &&
            'cursor-not-allowed opacity-40 hover:bg-[var(--surface-elevated)] hover:text-[var(--text-secondary)]',
        )}
        onClick={() => {
          if (hardDisabled) return;
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
  const focusedWorkerId = selectedWorkerId ?? workers.find((worker) => worker.focused)?.workerId ?? null;

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
  settingsEnabled = true,
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
        />
        <WorkerLayoutMenu layout={layout} onLayoutChange={handleLayoutChange} />
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
        <div className="min-w-0 flex-1">
          <RolePillDropdown
            worker={worker}
            workers={workers}
            selectedWorkerId={selectedWorkerId}
            activeWorkerCount={activeWorkerCount}
            softLimit={softLimit}
            hardLimit={hardLimit}
            onSwitchFocus={onSwitchFocus}
            onOpenCreate={onOpenCreate}
            onOpenSettings={onOpenSettings}
            settingsEnabled={settingsEnabled}
            onArchiveWorker={onArchiveWorker}
            clearAttentionWhenVisible={clearAttentionWhenVisible}
          />
        </div>
      )}
      <WorkerLayoutMenu layout={layout} onLayoutChange={handleLayoutChange} />
      {trailingActions}
    </div>
  );
}

export function RolePillDropdown({
  worker,
  workers,
  selectedWorkerId,
  activeWorkerCount,
  softLimit,
  hardLimit,
  onSwitchFocus,
  onOpenCreate,
  onOpenSettings,
  settingsEnabled = true,
  onArchiveWorker,
  clearAttentionWhenVisible = true,
  className,
}: RolePillDropdownProps) {
  const { t } = useTranslation();
  // new-maker 快捷键显示跟随 registry 生效值 (用户改绑后热更新)。
  const shortcutKey = useAppShortcutDisplay('new-maker');
  const [openMode, setOpenMode] = useState<DropdownOpenMode>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const hoverOpenTimerRef = useRef<number | null>(null);
  const hoverCloseTimerRef = useRef<number | null>(null);
  const attention = useWorkerAttentionSnapshot();
  const requestArchiveWorker = useRequestArchiveWorker(onArchiveWorker);
  const open = openMode !== null;

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
            可见, dropdown 列表里 worker rows 第二行还展示简化 model + effort bars
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
          className="absolute left-0 top-full z-50 mt-1 w-[320px] rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]"
          style={{ boxShadow: 'var(--shadow-menu)' }}
        >
          {/* Header: WORKERS + count */}
          <div className="flex select-none items-center justify-between px-4 pt-3 pb-2">
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
                    {/* 副行: 简化 model 名 (去 provider 前缀) + effort bars.
                        Claude / Codex 都显 (两种 agent 都有 reasoning effort 概念). */}
                    <div className="mt-0.5 ml-[26px] flex items-center gap-1.5 text-11 leading-snug text-[var(--text-tertiary)]">
                      <span>{simplifyModelName(w.model)}</span>
                      <EffortBars effort={w.effort} />
                    </div>
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

          {/* Separator */}
          <div className="mx-4 h-px bg-[var(--border-default)]" />

          {/* ── Create new worker row (3 上限态) ── */}
          {activeCount >= hardLimit ? (
            /* hard disabled */
            <div className="px-4 py-2.5 rounded-b-xl">
              <div className="flex items-center gap-2 opacity-40">
                <span className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-[var(--surface-elevated)]">
                  <Plus size={13} />
                </span>
                <span className="text-13 leading-snug text-[var(--text-primary)]">
                  {t('orca.rolePill.createWorker')}
                </span>
              </div>
              <div className="mt-1 text-11 leading-snug text-[var(--text-tertiary)]">
                {t('orca.rolePill.hardLimitHint', { count: hardLimit })}
              </div>
              {settingsEnabled && (
                <button
                  type="button"
                  className="mt-1.5 inline-flex items-center gap-1 text-11 leading-snug text-[var(--text-primary)] underline hover:opacity-80"
                  onClick={() => onOpenSettings()}
                >
                  {t('orca.rolePill.settingsCollaboration')}
                  <ChevronRight size={10} />
                </button>
              )}
            </div>
          ) : activeCount >= softLimit ? (
            /* soft warn */
            <div className="px-4 py-2.5 rounded-b-xl">
              <button
                type="button"
                className="flex w-full items-center gap-2 text-left"
                onClick={() => {
                  onOpenCreate();
                  closeDropdown();
                }}
              >
                <span className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-[var(--surface-chip)]">
                  <Plus size={13} className="text-[var(--status-bar-accent)]" />
                </span>
                <span className="text-13 leading-snug text-[var(--status-bar-accent)]">
                  {t('orca.rolePill.createWorker')}
                </span>
                {/* 不用 font-mono: 代码字体缺 ⌘ 等修饰键字形, 见 KeyboardShortcutsSection。
                    用户删除绑定时 shortcutKey 为空串, 不渲染空占位。 */}
                {shortcutKey && (
                  <kbd className="ml-auto text-10 text-[var(--status-bar-accent)]">
                    {shortcutKey}
                  </kbd>
                )}
              </button>
              <div className="mt-1 px-[30px] text-11 leading-snug text-[var(--text-tertiary)]">
                {t('orca.rolePill.softLimitHint', { count: softLimit })}
              </div>
              {settingsEnabled && (
                <div className="px-[30px]">
                  <button
                    type="button"
                    className="mt-1 inline-flex items-center gap-1 text-11 leading-snug text-[var(--status-bar-accent)] underline hover:opacity-80"
                    onClick={() => onOpenSettings()}
                  >
                    {t('orca.rolePill.settingsCollaboration')}
                    <ChevronRight size={10} />
                  </button>
                </div>
              )}
            </div>
          ) : (
            /* normal */
            <button
              type="button"
              className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-13 leading-snug text-[var(--text-secondary)] hover:bg-[var(--surface-chip)] rounded-b-xl transition-colors"
              onClick={() => {
                onOpenCreate();
                closeDropdown();
              }}
            >
              <span className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-[var(--surface-chip)]">
                <Plus size={13} className="text-[var(--text-secondary)]" />
              </span>
              {t('orca.rolePill.createWorker')}
              {shortcutKey && (
                <kbd className="ml-auto text-10 text-[var(--text-tertiary)]">
                  {shortcutKey}
                </kbd>
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
