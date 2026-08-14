/**
 * PlanViewerCard
 * ---------------------------------------------------------------------------
 * FP-5: Card that shows the Agent's plan while the user decides whether to
 * approve or revise it. Four display states driven from the outside:
 *
 *   expanded   — full height; Header + double-column body (Outline | Content)
 *   half       — fixed ~280px; same body layout, smaller viewport
 *   minimized  — collapsed 44px bar; title + "+" to restore
 *   edit       — full height; single-column Markdown source (JetBrains Mono)
 *
 * All four come from the same card frame (1px Board border, 12px radius,
 * 914px wide) so state transitions are a matter of swapping the body.
 *
 *   8uwcT / Nmmx1 (expanded), L2Fjs / YVYJZ (half),
 *   f74q2 / Dmac1 (minimized), MkFae / CB8j8 (edit)
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Maximize2, Minimize2, Minus, Pencil, Plus, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import type { PendingPlanReview, PlanViewerState } from '@/lib/makerChatStore';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PlanViewerCardProps {
  pending: PendingPlanReview;
  viewerState: PlanViewerState;
  /**
   * Session cwd — forwarded to MarkdownRenderer so any local-path links the
   * plan happens to contain (e.g. `apps/desktop/src/...`) resolve correctly.
   */
  workingDir: string;
  /**
   * FP-5: the non-minimized state the user was in before minimizing. The "+"
   * restore button uses this as its target instead of hard-coding 'expanded',
   * so a user who was in half/edit gets back to where they were.
   */
  lastExpandedState: 'expanded' | 'half' | 'edit';
  onStateChange: (next: PlanViewerState) => void;
  /**
   * 取消本次审阅(次级动作,收在工具条 X / Esc,不与批准同级):关闭卡片,
   * 结束本轮计划循环(下一条消息回常规模式)。未提供时不渲染 X(兼容旧调用方)。
   */
  onCancel?: () => void;
  /**
   * FP-edit: called on every textarea keystroke in edit mode. The hook layer
   * is responsible for: (1) updating the in-memory pending plan synchronously
   * so Approve sees the latest content; (2) debouncing the disk write through
   * the cc-agent:plan-file-write IPC. The fourth callback argument surfaces
   * any write failure so this card can show an inline "Save failed" hint.
   */
  onPlanContentChange?: (
    requestId: string,
    planFilePath: string,
    content: string,
    onWriteError?: (message: string) => void,
  ) => void;
}

// ---------------------------------------------------------------------------
// Outline entry — extracted from rendered DOM (rehype-slug assigns ids).
// ---------------------------------------------------------------------------

interface OutlineEntry {
  id: string;
  label: string;
  level: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PlanViewerCard({
  pending,
  viewerState,
  workingDir,
  onCancel,
  lastExpandedState,
  onStateChange,
  onPlanContentChange,
}: PlanViewerCardProps) {
  const { t } = useTranslation();
  // FP-edit: most recent disk-save error, displayed inline in edit mode.
  // Cleared whenever the user types again (assume the next keystroke retries).
  const [saveError, setSaveError] = useState<string | null>(null);
  // FP-edit: textarea ref to keep the caret position stable across rerenders
  // — pending.plan is the source of truth so the textarea is fully controlled.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Content column ref — we scan its DOM for h1-h3 to build the outline,
  // since rehype-slug (used inside MarkdownRenderer) is the only thing that
  // actually knows the canonical heading ids.
  const contentRef = useRef<HTMLDivElement>(null);
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  // Reset the inline save-error banner when leaving edit mode so it doesn't
  // resurface stale messages on the next entry.
  useEffect(() => {
    if (viewerState !== 'edit') setSaveError(null);
  }, [viewerState]);
  // Rebuild outline whenever the plan markdown changes or the content column
  // re-mounts (entering/leaving edit mode unmounts it). Wait one frame so
  // react-markdown has finished committing the headings before we read ids.
  useEffect(() => {
    if (viewerState === 'edit') return;
    const handle = window.requestAnimationFrame(() => {
      const root = contentRef.current;
      if (!root) return;
      const headings = root.querySelectorAll<HTMLElement>('h1, h2, h3');
      const next: OutlineEntry[] = [];
      headings.forEach((el) => {
        const id = el.id;
        const label = (el.textContent ?? '').trim();
        if (!id || !label) return;
        const level = Number(el.tagName.slice(1)) || 2;
        next.push({ id, label, level });
      });
      setOutline((prev) => {
        if (
          prev.length === next.length &&
          prev.every((p, i) => p.id === next[i].id && p.label === next[i].label)
        ) {
          return prev;
        }
        return next;
      });
    });
    return () => window.cancelAnimationFrame(handle);
  }, [pending.plan, viewerState]);
  // Minor #5: outline items are click-to-highlight only (no scroll-spy in v1).
  // Nothing is highlighted on first render; clicking an entry both scrolls and
  // marks that entry active.
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);

  // ── Minimized: bar + "+" ───────────────────────────────────────────────
  if (viewerState === 'minimized') {
    return (
      <div
        className={cn(
          'w-full max-w-[914px] rounded-[12px] border',
          'border-[var(--plan-card-border)] bg-[var(--plan-card-bg)]',
          // Right padding tuned so the "+" icon's right edge lines up with
          // the ↵ / pencil icons in PlanActionCard below. Action card uses
          // px-[16px] with no extra inner padding around its 16px icons → icon
          // right edge sits 16px from the card edge. Here the "+" lives inside
          // a 28×28 button (icon centered → 6px inner offset), so a 10px outer
          // pr puts the icon's right edge at 10+6 = 16px. Same math applies to
          // the expanded toolbar header below.
          'flex h-[44px] items-center justify-between pl-[20px] pr-[10px]',
        )}
      >
        <span className="text-14 font-semibold text-[var(--plan-min-title)]">
          {t('newChat.planReview.title')}
        </span>
        <div className="flex items-center gap-[4px]">
          <button
            type="button"
            onClick={() => onStateChange(lastExpandedState)}
            aria-label={t('newChat.planReview.restoreAria')}
            className={cn(
              'flex h-[28px] w-[28px] items-center justify-center rounded-[6px]',
              'transition-colors hover:bg-[var(--plan-toolbar-btn-hover-bg)]',
            )}
          >
            <Plus size={16} className="text-[var(--plan-min-icon)]" />
          </button>
          {onCancel && (
            <ToolbarButton
              icon={X}
              label={`${t('newChat.planReview.cancel')} (Esc)`}
              onClick={onCancel}
            />
          )}
        </div>
      </div>
    );
  }

  // ── Expanded / Half / Edit all share the header card frame ────────────
  const isEdit = viewerState === 'edit';
  const hint = isEdit
    ? t('newChat.planReview.hintEditMode')
    : t('newChat.planReview.hintSelect');

  // Sizing (FP-5):
  //   half        — fixed 280px so the chat messages above stay visible
  //   expanded/edit — occupies the available vertical band above the Action
  //                   Card. Reserved ~260px covers Action Card (90px) +
  //                   WorkDir row + vertical gaps + body top padding so the
  //                   card stops just under the toolbar.
  const cardHeightClass = viewerState === 'half'
    ? 'h-[280px]'
    : 'h-[calc(100vh-260px)] min-h-[320px]';

  const handleScrollToAnchor = (id: string) => {
    // Scope the lookup to this card's content column so multiple plan
    // viewers (or other rehype-slug consumers in the page) can't collide.
    const root = contentRef.current;
    const target = root?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    setActiveAnchor(id);
  };

  return (
    <div
      className={cn(
        'flex w-full max-w-[914px] flex-col overflow-hidden rounded-[12px] border',
        'border-[var(--plan-card-border)] bg-[var(--plan-card-bg)]',
        cardHeightClass,
      )}
    >
      {/* Header */}
      <div
        className={cn(
          // Right padding matches the minimized state above so toolbar icons
          // and the "+" share a vertical right baseline with PlanActionCard.
          'flex h-[44px] shrink-0 items-center justify-between border-b pl-[20px] pr-[10px]',
          'border-[var(--plan-header-divider)]',
        )}
      >
        <div className="flex items-center gap-[12px]">
          <span className="text-14 font-semibold text-[var(--plan-header-title)]">
            {t('newChat.planReview.title')}
          </span>
          <span className="text-12 font-normal text-[var(--plan-header-hint)]">
            {hint}
          </span>
        </div>
        {/* Toolbar: Edit / Minimize / Maximize */}
        <div className="flex items-center gap-[4px]">
          <ToolbarButton
            icon={Pencil}
            label={isEdit ? t('newChat.planReview.toolbar.exitEdit') : t('newChat.planReview.toolbar.edit')}
            active={isEdit}
            onClick={() => onStateChange(isEdit ? 'expanded' : 'edit')}
          />
          <ToolbarButton
            icon={Minus}
            label={t('newChat.planReview.toolbar.minimize')}
            onClick={() => onStateChange('minimized')}
          />
          <ToolbarButton
            // Icon tracks the target action: from half → expand (grow, Maximize2),
            // from expanded → collapse to half (shrink inward, Minimize2). Keeps
            // the glyph direction consistent with the label.
            icon={viewerState === 'half' ? Maximize2 : Minimize2}
            label={
              viewerState === 'half'
                ? t('newChat.planReview.toolbar.expand')
                : t('newChat.planReview.toolbar.collapseHalf')
            }
            onClick={() =>
              onStateChange(viewerState === 'half' ? 'expanded' : 'half')
            }
          />
          {/* 取消本次审阅 —— 次级动作收在工具条(与批准/反馈不同级), Esc 同效。 */}
          {onCancel && (
            <ToolbarButton
              icon={X}
              label={`${t('newChat.planReview.cancel')} (Esc)`}
              onClick={onCancel}
            />
          )}
        </div>
      </div>

      {/* Body */}
      {isEdit ? (
        <div
          className={cn(
            'flex flex-1 flex-col overflow-hidden',
            'bg-[var(--plan-content-bg)]',
          )}
        >
          {/* FP-edit: editable Markdown source. Controlled by pending.plan so
              the store stays the single source of truth — every keystroke
              flows through onPlanContentChange (sync store + debounced write). */}
          <textarea
            ref={textareaRef}
            value={pending.plan}
            onChange={(e) => {
              const next = e.target.value;
              if (saveError) setSaveError(null);
              onPlanContentChange?.(
                pending.requestId,
                pending.planFilePath,
                next,
                (msg) => setSaveError(msg),
              );
            }}
            spellCheck={false}
            wrap="soft"
            className={cn(
              'flex-1 resize-none overflow-y-auto px-[28px] py-[20px]',
              'whitespace-pre-wrap break-words bg-transparent outline-none',
              'font-mono text-13 leading-[1.7]',
              'text-[var(--plan-edit-body)] caret-[var(--plan-edit-body)]',
            )}
            aria-label={t('newChat.planReview.toolbar.edit')}
          />
          {saveError && (
            <div
              className={cn(
                'shrink-0 border-t px-[28px] py-[8px] text-12',
                'border-[var(--plan-header-divider)]',
                'bg-[var(--plan-content-bg)] text-red-500',
              )}
              role="status"
            >
              {t('newChat.planReview.saveFailed', { message: saveError })}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-1 overflow-hidden">
          {/* Outline Column — 180px */}
          <div
            className={cn(
              'flex w-[180px] shrink-0 flex-col gap-[2px] overflow-y-auto border-r px-[12px] py-[16px]',
              'bg-[var(--plan-outline-bg)] border-[var(--plan-outline-border)]',
            )}
          >
            <div className="pb-[4px]">
              <span className="text-12 font-semibold text-[var(--plan-outline-label)]">
                {t('newChat.planReview.outlineLabel')}
              </span>
            </div>
            {outline.length === 0 ? (
              <span className="px-[8px] py-[6px] text-12 text-[var(--plan-outline-item-text)]">
                {t('newChat.planReview.outlineEmpty')}
              </span>
            ) : (
              outline.map((entry) => {
                const isActive = activeAnchor === entry.id;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => handleScrollToAnchor(entry.id)}
                    className={cn(
                      'flex items-center rounded-[6px] px-[8px] py-[6px] text-left',
                      'text-12',
                      'transition-colors hover:bg-[var(--plan-outline-active-bg)]',
                      // v1: no scroll-spy. Items are neutral by default and
                      // become active only after the user clicks them.
                      isActive
                        ? 'bg-[var(--plan-outline-active-bg)] text-[var(--plan-outline-active-text)] font-medium'
                        : 'text-[var(--plan-outline-item-text)]',
                      entry.level >= 3 && 'pl-[16px]',
                    )}
                  >
                    <span className="truncate">{entry.label}</span>
                  </button>
                );
              })
            )}
          </div>

          {/* Content Column — fills remaining space */}
          <div
            ref={contentRef}
            className={cn(
              'flex-1 overflow-y-auto px-[28px] py-[20px]',
              'bg-[var(--plan-content-bg)]',
            )}
          >
            <MarkdownRenderer
              workingDir={workingDir}
              content={pending.plan}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ToolbarButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <Tip text={label}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className={cn(
          'flex h-[28px] w-[28px] items-center justify-center rounded-[6px]',
          'transition-colors hover:bg-[var(--plan-toolbar-btn-hover-bg)]',
          active && 'bg-[var(--plan-toolbar-btn-hover-bg)]',
        )}
      >
        <Icon size={14} className="text-[var(--plan-toolbar-btn-icon)]" />
      </button>
    </Tip>
  );
}

