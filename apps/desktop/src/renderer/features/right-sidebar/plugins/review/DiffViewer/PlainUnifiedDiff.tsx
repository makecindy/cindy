import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ExternalLink, Minus, Plus, Undo2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import type { DiffLine, FileDiff } from '@/lib/gitReview.types';
import { Tip } from '@/components/ui/tooltip';
import {
  buildDiffRows,
  buildHunkRows,
  estimateDiffRowsMinWidthCh,
  shouldVirtualizeDiffRows,
  type DiffRenderRow,
  type HunkActionAnchor,
  type DiffViewMode,
  type SplitDiffCell,
} from './diffRows';
import { useDiffHighlights } from './useDiffHighlights';
import { highlightLineKey } from './highlight';
import { collectInlineDiffRanges, renderInlineDiffHtml, type InlineDiffRange } from './inlineDiff';
import { ImageDiffPreview, isPreviewableImageDiff } from './ImageDiffPreview';

export { buildHunkRows };
export type { DiffViewMode };

interface HunkAction {
  label: string;
  disabled: boolean;
  disabledTooltip?: string;
  icon: 'plus' | 'minus' | 'revert';
  isPending: (hunkIndex: number) => boolean;
  onClick: (hunkIndex: number) => void;
}

const HUNK_ACTION_REVEAL_CLASS = 'invisible opacity-0 transition-opacity group-hover/file:visible group-hover/file:opacity-100 group-focus-within/file:visible group-focus-within/file:opacity-100';

export function hunkActionRevealClass(forceVisible: boolean): string {
  return forceVisible ? 'visible opacity-100 transition-opacity' : HUNK_ACTION_REVEAL_CLASS;
}

function hunkActionIcon(icon: HunkAction['icon']) {
  if (icon === 'plus') return <Plus size={11} />;
  if (icon === 'minus') return <Minus size={11} />;
  return <Undo2 size={11} />;
}

function lineClass(type: DiffLine['type']): string {
  if (type === 'add') return 'bg-[var(--diff-add-bg)] text-[var(--diff-add-fg)]';
  if (type === 'delete') return 'bg-[var(--diff-del-bg)] text-[var(--diff-del-fg)]';
  return 'text-[var(--text-primary)]';
}

function prefix(type: DiffLine['type']): string {
  if (type === 'add') return '+';
  if (type === 'delete') return '-';
  return ' ';
}

function HunkSeparator({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[20px] w-full select-none items-center bg-[var(--surface)] font-mono text-11 leading-5 text-[var(--text-tertiary)]">
      <span className="w-[3.5rem] shrink-0 border-r border-[var(--border-default)] px-2 text-right text-[var(--diff-line-num)]" />
      <span className="w-[3.5rem] shrink-0 border-r border-[var(--border-default)] px-2 text-right text-[var(--diff-line-num)]" />
      <span className="w-5 shrink-0 text-center">⋯</span>
      <span className="pr-4">{t('rightSidebar.review.unmodifiedLines', { count })}</span>
    </div>
  );
}

function HunkActionPill({
  anchor,
  hunkAction,
  hunkActions,
}: {
  anchor?: HunkActionAnchor;
  hunkAction?: HunkAction;
  hunkActions?: HunkAction[];
}) {
  if (!anchor) return null;
  const hunk = anchor.hunk;
  const actions = hunkActions ?? (hunkAction ? [hunkAction] : []);
  if (hunk.selectableLines.length === 0 || actions.length === 0) return null;

  const hasPendingAction = actions.some((action) => action.isPending(hunk.index));
  return (
    <span
      data-review-hunk-action-anchor="true"
      className="pointer-events-none absolute bottom-[3px] left-0 right-0 z-20 flex justify-end"
    >
      <span
        data-review-action-reveal="hunk"
        className={cn(
          'pointer-events-auto sticky right-2 flex shrink-0 items-center gap-1 rounded-full border border-[var(--border-default)] bg-[color-mix(in_srgb,var(--surface-elevated)_90%,transparent)] p-1 text-[var(--text-primary)] shadow-[var(--shadow-menu)] backdrop-blur-sm',
          hunkActionRevealClass(hasPendingAction),
        )}
      >
        {actions.map((action) => {
          const pending = action.isPending(hunk.index);
          const button = (
            <button
              key={action.label}
              type="button"
              aria-label={action.label}
              disabled={action.disabled || pending}
              onClick={() => action.onClick(hunk.index)}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-10 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? <Spinner size={11} /> : hunkActionIcon(action.icon)}
              <span className="sr-only">{action.label}</span>
            </button>
          );
          return (
            <Tip key={action.label} text={action.disabled && action.disabledTooltip ? action.disabledTooltip : action.label}>
              <span className="inline-flex shrink-0">{button}</span>
            </Tip>
          );
        })}
      </span>
    </span>
  );
}

function UnifiedLineRow({
  line,
  html,
  inlineRanges,
  noNewlineLabel,
  wordWrap,
}: {
  line: DiffLine;
  html?: string;
  inlineRanges?: readonly InlineDiffRange[];
  noNewlineLabel: string;
  wordWrap: boolean;
}) {
  return (
    <div className={cn('flex min-h-[20px] w-full font-mono text-11 leading-5', lineClass(line.type))}>
      <span className="w-[3.5rem] shrink-0 select-none border-r border-[var(--border-default)] px-2 text-right text-[var(--diff-line-num)]">
        {line.oldLineNumber ?? ''}
      </span>
      <span className="w-[3.5rem] shrink-0 select-none border-r border-[var(--border-default)] px-2 text-right text-[var(--diff-line-num)]">
        {line.newLineNumber ?? ''}
      </span>
      <span className="w-5 shrink-0 select-none text-center">{prefix(line.type)}</span>
      <CodeContent line={line} html={html} inlineRanges={inlineRanges} noNewlineLabel={noNewlineLabel} wordWrap={wordWrap} />
    </div>
  );
}

function SplitLineRow({
  hunkIndex,
  left,
  right,
  highlights,
  inlineDiffs,
  noNewlineLabel,
  wordWrap,
}: {
  hunkIndex: number;
  left: SplitDiffCell | null;
  right: SplitDiffCell | null;
  highlights: ReadonlyMap<string, string>;
  inlineDiffs: ReadonlyMap<string, readonly InlineDiffRange[]>;
  noNewlineLabel: string;
  wordWrap: boolean;
}) {
  return (
    <div className="grid min-h-[20px] w-full grid-cols-2 font-mono text-11 leading-5">
      <SplitCell
        cell={left}
        side="left"
        html={left ? highlights.get(highlightLineKey(hunkIndex, left.originalLineIndex)) : undefined}
        inlineRanges={left ? inlineDiffs.get(highlightLineKey(hunkIndex, left.originalLineIndex)) : undefined}
        noNewlineLabel={noNewlineLabel}
        wordWrap={wordWrap}
      />
      <SplitCell
        cell={right}
        side="right"
        html={right ? highlights.get(highlightLineKey(hunkIndex, right.originalLineIndex)) : undefined}
        inlineRanges={right ? inlineDiffs.get(highlightLineKey(hunkIndex, right.originalLineIndex)) : undefined}
        noNewlineLabel={noNewlineLabel}
        wordWrap={wordWrap}
      />
    </div>
  );
}

function SplitCell({
  cell,
  side,
  html,
  inlineRanges,
  noNewlineLabel,
  wordWrap,
}: {
  cell: SplitDiffCell | null;
  side: 'left' | 'right';
  html?: string;
  inlineRanges?: readonly InlineDiffRange[];
  noNewlineLabel: string;
  wordWrap: boolean;
}) {
  const line = cell?.line ?? null;
  const isEmpty = !line;
  const className = isEmpty
    ? 'bg-[var(--surface)] text-[var(--text-tertiary)]'
    : lineClass(line.type);
  return (
    <div className={cn('flex min-w-0 overflow-hidden border-r border-[var(--border-default)]', className)}>
      <span className="w-[3.5rem] shrink-0 select-none border-r border-[var(--border-default)] px-2 text-right text-[var(--diff-line-num)]">
        {line ? side === 'left' ? line.oldLineNumber ?? '' : line.newLineNumber ?? '' : ''}
      </span>
      <span className="w-5 shrink-0 select-none text-center">{line ? prefix(line.type) : ''}</span>
      {line ? (
        <span
          data-review-split-cell-scroll="true"
          className={cn('min-w-0 flex-1', wordWrap ? 'overflow-visible' : 'scrollbar-hide overflow-x-auto overflow-y-hidden')}
        >
          <CodeContent
            line={line}
            html={html}
            inlineRanges={inlineRanges}
            noNewlineLabel={noNewlineLabel}
            compact
            splitScrollable
            wordWrap={wordWrap}
          />
        </span>
      ) : (
        <span className="min-w-0 flex-1 whitespace-pre pr-3" />
      )}
    </div>
  );
}

function CodeContent({
  line,
  html,
  inlineRanges,
  noNewlineLabel,
  compact = false,
  splitScrollable = false,
  wordWrap,
}: {
  line: DiffLine;
  html?: string;
  inlineRanges?: readonly InlineDiffRange[];
  noNewlineLabel: string;
  compact?: boolean;
  splitScrollable?: boolean;
  wordWrap: boolean;
}) {
  const inlineHtml = inlineRanges && inlineRanges.length > 0 && line.type !== 'context'
    ? renderInlineDiffHtml({
      content: line.content,
      html,
      ranges: inlineRanges,
      side: line.type === 'add' ? 'add' : 'delete',
    })
    : null;

  return (
    <span className={cn(
      splitScrollable && !wordWrap ? 'inline-block min-w-max whitespace-pre' : 'min-w-0',
      wordWrap ? 'flex-1 whitespace-pre-wrap break-words' : !splitScrollable && 'whitespace-pre',
      compact ? 'pr-3' : 'pr-4',
    )}>
      {inlineHtml ? (
        <span dangerouslySetInnerHTML={{ __html: inlineHtml }} />
      ) : html ? (
        <span dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        line.content
      )}
      {line.noTrailingNewLine && (
        <span className="ml-2 select-none text-[var(--text-tertiary)]">{noNewlineLabel}</span>
      )}
    </span>
  );
}

function renderRow({
  row,
  hunkAction,
  hunkActions,
  highlights,
  inlineDiffs,
  noNewlineLabel,
  wordWrap,
}: {
  row: DiffRenderRow;
  hunkAction?: HunkAction;
  hunkActions?: HunkAction[];
  highlights: ReadonlyMap<string, string>;
  inlineDiffs: ReadonlyMap<string, readonly InlineDiffRange[]>;
  noNewlineLabel: string;
  wordWrap: boolean;
}) {
  if (row.type === 'separator') return <HunkSeparator count={row.count} />;
  if (row.type === 'line') {
    return (
      <div className="relative overflow-visible">
        <UnifiedLineRow
          line={row.line}
          html={highlights.get(highlightLineKey(row.hunk.index, row.originalLineIndex))}
          inlineRanges={inlineDiffs.get(highlightLineKey(row.hunk.index, row.originalLineIndex))}
          noNewlineLabel={noNewlineLabel}
          wordWrap={wordWrap}
        />
        <HunkActionPill anchor={row.hunkActionAnchor} hunkAction={hunkAction} hunkActions={hunkActions} />
      </div>
    );
  }
  return (
    <div className="relative overflow-visible">
      <SplitLineRow
        hunkIndex={row.hunk.index}
        left={row.left}
        right={row.right}
        highlights={highlights}
        inlineDiffs={inlineDiffs}
        noNewlineLabel={noNewlineLabel}
        wordWrap={wordWrap}
      />
      <HunkActionPill anchor={row.hunkActionAnchor} hunkAction={hunkAction} hunkActions={hunkActions} />
    </div>
  );
}

export function PlainUnifiedDiff({
  diff,
  hunkAction,
  hunkActions,
  viewMode = 'unified',
  wordWrap = false,
  wordDiff = true,
  loadImagePreview,
  onImagePreviewLoad,
  onOpenFile,
}: {
  diff: FileDiff;
  hunkAction?: HunkAction;
  hunkActions?: HunkAction[];
  viewMode?: DiffViewMode;
  wordWrap?: boolean;
  wordDiff?: boolean;
  loadImagePreview?: (diff: FileDiff) => Promise<import('@/lib/gitReview.types').ReviewImagePreviewData>;
  onImagePreviewLoad?: () => void;
  onOpenFile?: (diff: FileDiff) => void;
}) {
  const { t } = useTranslation();
  const parentRef = useRef<HTMLDivElement | null>(null);
  const rows = useMemo(
    () => diff.kind === 'text' && diff.hunks.length > 0 ? buildDiffRows(diff.hunks, viewMode) : [],
    [diff.hunks, diff.kind, viewMode],
  );
  const highlights = useDiffHighlights(diff, rows);
  const inlineDiffs = useMemo(
    () => wordDiff && diff.kind === 'text' && diff.hunks.length > 0
      ? collectInlineDiffRanges(diff.hunks)
      : new Map<string, InlineDiffRange[]>(),
    [diff.hunks, diff.kind, wordDiff],
  );
  const virtualized = shouldVirtualizeDiffRows(rows.length);
  const useHorizontalMinWidth = !wordWrap && viewMode === 'unified';
  const minWidthCh = useMemo(
    () => useHorizontalMinWidth ? estimateDiffRowsMinWidthCh(rows, viewMode) : null,
    [rows, useHorizontalMinWidth, viewMode],
  );
  const noNewlineLabel = t('rightSidebar.review.noNewlineAtEof');
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 20,
    overscan: 24,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  useEffect(() => {
    if (parentRef.current) parentRef.current.scrollLeft = 0;
  }, [viewMode, wordWrap]);

  if (diff.kind !== 'text' && loadImagePreview && isPreviewableImageDiff(diff)) {
    return (
      <ImageDiffPreview
        diff={diff}
        loadImagePreview={loadImagePreview}
        onImageLoad={onImagePreviewLoad}
      />
    );
  }

  if (diff.kind !== 'text') {
    const status = t(`rightSidebar.review.status.${diff.kind}`, { defaultValue: diff.kind });
    const notice = diff.kind === 'unrenderable'
      ? diff.error ?? t('rightSidebar.review.kindNotice.unrenderable')
      : t(`rightSidebar.review.kindNotice.${diff.kind}`, { defaultValue: status });
    return (
      <div className="flex min-w-0 items-center gap-2 rounded-[8px] border border-[var(--border-default)] bg-[var(--surface)] px-3 py-2 text-12 text-[var(--text-secondary)]">
        <span className="min-w-0 flex-1">
          <span className="font-medium text-[var(--text-primary)]">{status}</span>
          <span className="ml-2">{notice}</span>
        </span>
        {diff.kind === 'too-large' && onOpenFile && (
          <button
            type="button"
            onClick={() => onOpenFile(diff)}
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[6px] border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2 text-11 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
          >
            <ExternalLink size={12} />
            <span>{t('rightSidebar.review.openFile')}</span>
          </button>
        )}
      </div>
    );
  }
  if (diff.hunks.length === 0) {
    return (
      <div className="rounded-[8px] border border-[var(--border-default)] bg-[var(--surface)] px-3 py-2 text-12 text-[var(--text-tertiary)]">
        {t('rightSidebar.review.noRenderableDiff')}
      </div>
    );
  }

  if (virtualized) {
    return (
      <div
        ref={parentRef}
        data-virtualized-diff="true"
        className={cn(
          'max-h-[70vh] max-w-full min-w-0 select-text rounded-[8px] border border-[var(--border-default)] bg-[var(--surface-elevated)]',
          wordWrap || viewMode === 'split' ? 'overflow-y-auto overflow-x-hidden' : 'overflow-auto',
        )}
      >
        <div
          className="relative min-w-full"
          style={{ height: virtualizer.getTotalSize(), minWidth: minWidthCh ? `${minWidthCh}ch` : undefined }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full overflow-visible"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {renderRow({ row, hunkAction, hunkActions, highlights, inlineDiffs, noNewlineLabel, wordWrap })}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={parentRef}
      className={cn(
        'max-w-full min-w-0 select-text rounded-[8px] border border-[var(--border-default)] bg-[var(--surface-elevated)]',
        wordWrap || viewMode === 'split' ? 'overflow-x-hidden' : 'overflow-x-auto',
      )}
    >
      <div
        className={cn('min-w-full', useHorizontalMinWidth && 'w-max')}
        style={{ minWidth: minWidthCh ? `${minWidthCh}ch` : undefined }}
      >
        {rows.map((row) => (
          <div key={`${diff.id}-${row.key}`} className="overflow-visible">
            {renderRow({ row, hunkAction, hunkActions, highlights, inlineDiffs, noNewlineLabel, wordWrap })}
          </div>
        ))}
      </div>
    </div>
  );
}
