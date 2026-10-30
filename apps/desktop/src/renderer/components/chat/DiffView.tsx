/**
 * DiffView
 * ---------------------------------------------------------------------------
 * F-MSG-6: Edit tool diff rendering, GitHub-standard red/green full-row fill.
 *
 * Diff analysis is shared with AgentActionRow and runs in a module Worker for
 * large payloads. This component only applies the existing context folding
 * rule and paints the returned rows. Large row sets use @tanstack/react-virtual
 * so the lightbox never mounts thousands of DOM nodes at once.
 */

import { CHAT_COMPACT_CODE_CLASS } from './chatChrome';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import {
  DIFF_MAIN_THREAD_MAX_CHARS,
  DIFF_VIRTUALIZE_THRESHOLD,
  getDiffDetailsSync,
  requestDiffDetails,
  type DiffDetails,
  type DiffLine,
} from '@/lib/agent-actions/diffStats';

interface DiffViewProps {
  oldString: string;
  newString: string;
  /** Pair analysis already produced by AgentActionRow, avoiding a second diff. */
  analysis?: DiffDetails;
  /**
   * 只在每个变化前后保留 N 行 context,中间未变化的部分用 "···" 分隔行折叠。
   * 类似 git diff -U{N}。不传 = 不折叠(展示全部 context),保留原行为给 Edit tool
   * 调用复用 — 它传的本来就是小范围 hunk,不需要折叠。
   * SkillhubDiffPanel 传整个文件内容时必须设置(常用 3),否则一改一行铺一整屏。
   */
  contextLines?: number;
}

interface SkipMarker {
  type: 'skip';
  /** 折叠的行数,用于 "··· skipped N lines ···" 提示 */
  count: number;
  /** 用作 React key 的稳定标识 */
  anchorIdx: number;
  truncated?: boolean;
}

type RenderRow = DiffLine | SkipMarker;

const DIFF_PRE_CLASS_NAME =
  cn('m-0 w-max min-w-full p-0', CHAT_COMPACT_CODE_CLASS);

/**
 * 把超出 ±contextLines 范围的连续 ctx 行折叠成一个 SkipMarker。
 *
 * 算法:对每个 add/del 行,标记其前后 contextLines 行为"保留",
 * 其余 ctx 行折叠;连续被折叠区段汇总成一个 marker(显示行数提示)。
 */
function applyContextLimit(lines: DiffLine[], contextLines: number): RenderRow[] {
  if (lines.length === 0) return [];
  const keep = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].type !== 'ctx') {
      const lo = Math.max(0, i - contextLines);
      const hi = Math.min(lines.length - 1, i + contextLines);
      for (let j = lo; j <= hi; j += 1) keep[j] = true;
    }
  }
  const result: RenderRow[] = [];
  let skipStart = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (keep[i]) {
      if (skipStart >= 0) {
        result.push({ type: 'skip', count: i - skipStart, anchorIdx: skipStart });
        skipStart = -1;
      }
      result.push(lines[i]);
    } else if (skipStart < 0) {
      skipStart = i;
    }
  }
  if (skipStart >= 0) {
    result.push({ type: 'skip', count: lines.length - skipStart, anchorIdx: skipStart });
  }
  return result;
}

function DiffLineRow({ row, gutterWidth }: { row: DiffLine; gutterWidth: number }) {
  return (
    <div
      className={cn(
        'flex min-h-[20px]',
        row.type === 'del' && 'bg-[var(--diff-del-bg)]',
        row.type === 'add' && 'bg-[var(--diff-add-bg)]',
      )}
    >
      {/* Gutter: line number + prefix */}
      <span
        className="shrink-0 select-none px-2 text-right text-[var(--diff-line-num)]"
        style={{ minWidth: `${gutterWidth + 3}ch` }}
      >
        {row.lineNum}
      </span>
      <span
        className={cn(
          'shrink-0 w-4 select-none text-center',
          row.type === 'del' && 'text-[var(--diff-del-fg)]',
          row.type === 'add' && 'text-[var(--diff-add-fg)]',
        )}
      >
        {row.type === 'del' ? '-' : row.type === 'add' ? '+' : ' '}
      </span>
      {/* Content */}
      <span
        className={cn(
          'flex-1 whitespace-pre pr-3',
          row.type === 'del' && 'text-[var(--diff-del-fg)]',
          row.type === 'add' && 'text-[var(--diff-add-fg)]',
        )}
      >
        {row.text}
      </span>
    </div>
  );
}

function SkipRow({
  row,
  gutterWidth,
  truncatedLabel,
}: {
  row: SkipMarker;
  gutterWidth: number;
  truncatedLabel: string;
}) {
  return (
    <div
      className="flex min-h-[20px] select-none text-[var(--diff-line-num)]"
      data-diff-skip-count={row.count}
    >
      <span className="shrink-0 px-2 text-right" style={{ minWidth: `${gutterWidth + 3}ch` }} />
      <span className="shrink-0 w-4 text-center">⋯</span>
      <span className="flex-1 whitespace-pre pr-3 italic">
        {row.truncated ? truncatedLabel : `${row.count} 行未变`}
      </span>
    </div>
  );
}

function renderRow(row: RenderRow, gutterWidth: number, truncatedLabel: string) {
  return row.type === 'skip' ? (
    <SkipRow row={row} gutterWidth={gutterWidth} truncatedLabel={truncatedLabel} />
  ) : (
    <DiffLineRow row={row} gutterWidth={gutterWidth} />
  );
}

export function DiffView({ oldString, newString, analysis, contextLines }: DiffViewProps) {
  const { t } = useTranslation();
  const parentRef = useRef<HTMLDivElement | null>(null);
  const syncAnalysis = useMemo(() => {
    if (analysis) return analysis;
    // Keep the existing synchronous first paint for small edits. Large edits
    // intentionally return no value here and are resolved by the Worker below.
    if (oldString.length + newString.length > DIFF_MAIN_THREAD_MAX_CHARS) return null;
    return getDiffDetailsSync(oldString, newString);
  }, [analysis, oldString, newString]);
  const [resolvedAnalysis, setResolvedAnalysis] = useState<DiffDetails | null>(syncAnalysis);

  useEffect(() => {
    let active = true;
    if (analysis) {
      setResolvedAnalysis(analysis);
      return () => {
        active = false;
      };
    }
    setResolvedAnalysis(syncAnalysis);
    void requestDiffDetails(oldString, newString).then((details) => {
      if (active) setResolvedAnalysis(details);
    });
    return () => {
      active = false;
    };
  }, [analysis, newString, oldString, syncAnalysis]);

  const rows = useMemo<RenderRow[]>(() => {
    const all = resolvedAnalysis?.rows ?? [];
    const rendered = contextLines !== undefined ? applyContextLimit(all, contextLines) : all;
    if (!resolvedAnalysis?.truncated && !resolvedAnalysis?.rowsTruncated) return rendered;
    const omitted = Math.max(1, resolvedAnalysis.omittedRows ?? 1);
    return [
      ...rendered,
      {
        type: 'skip',
        count: omitted,
        anchorIdx: all.length,
        truncated: true,
      },
    ];
  }, [contextLines, resolvedAnalysis]);
  // 算 gutter 宽度:取最大 lineNum,跳过 skip marker
  const maxLineNum = useMemo(() => {
    let max = 0;
    for (const row of rows) {
      if (row.type !== 'skip' && row.lineNum > max) max = row.lineNum;
    }
    return max;
  }, [rows]);
  const gutterWidth = String(maxLineNum).length || 1;
  const minWidthCh = useMemo(() => {
    let longest = 0;
    for (const row of rows) {
      if (row.type !== 'skip' && row.text.length > longest) longest = row.text.length;
    }
    // Virtual rows are absolutely positioned and therefore do not contribute
    // to the pre's intrinsic width; reserve the longest row explicitly so
    // horizontal scrolling and full-row backgrounds remain intact.
    return Math.max(1, longest + gutterWidth + 7);
  }, [gutterWidth, rows]);
  const virtualized = rows.length > DIFF_VIRTUALIZE_THRESHOLD;
  const truncatedLabel = t('chat.lightbox.diffPreviewTruncated');
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 20,
    overscan: 24,
    getItemKey: (index) => {
      const row = rows[index];
      return row.type === 'skip' ? `skip-${row.anchorIdx}` : `${row.type}-${row.lineNum}-${index}`;
    },
  });

  if (!resolvedAnalysis) {
    return (
      <div className="diff-hscroll overflow-x-auto rounded-xl border border-[var(--msg-tool-card-border)]">
        <div className="px-3 py-3 text-13 text-[var(--msg-tool-card-chevron)]">
          {t('chat.lightbox.diffPreviewLoading')}
        </div>
      </div>
    );
  }

  // select-text:globals.css 全局禁用了文本选中(Electron 原生 app 风格),
  // diff 内容必须可读可复制,所以这里显式开。gutter / 符号列已通过 select-none
  // 排除,只有内容文本会被选中。
  //
  // diff-hscroll:横向滚动条常显(globals.css),否则长行只能靠 trackpad 盲滚。
  // pre 的 `w-max min-w-full`:行是 flex 容器,pre 宽度若锁在 100% 容器宽,
  // 长行内容会溢出到行的边界之外 —— 滚过去以后行背景(红/绿)在一屏宽处就断了。
  if (virtualized) {
    return (
      <div
        ref={parentRef}
        data-diff-virtualized="true"
        className="diff-hscroll select-text overflow-x-auto overflow-y-auto max-h-[60vh] rounded-xl border border-[var(--msg-tool-card-border)]"
      >
        <pre
          className={cn('relative', DIFF_PRE_CLASS_NAME)}
          style={{ height: virtualizer.getTotalSize(), minWidth: `${minWidthCh}ch` }}
        >
          {virtualizer.getVirtualItems().map((item) => (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full overflow-visible"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {renderRow(rows[item.index], gutterWidth, truncatedLabel)}
            </div>
          ))}
        </pre>
      </div>
    );
  }

  return (
    <div className="diff-hscroll select-text overflow-x-auto rounded-xl border border-[var(--msg-tool-card-border)]">
      <pre className={DIFF_PRE_CLASS_NAME}>
        {rows.map((row, index) => (
          <div
            key={
              row.type === 'skip' ? `skip-${row.anchorIdx}` : `${row.type}-${row.lineNum}-${index}`
            }
          >
            {renderRow(row, gutterWidth, truncatedLabel)}
          </div>
        ))}
      </pre>
    </div>
  );
}
