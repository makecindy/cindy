/**
 * DiffView
 * ---------------------------------------------------------------------------
 * F-MSG-6: Edit tool diff rendering, GitHub-standard red/green full-row fill.
 *
 * Uses the `diff` package for real line-level diffing.
 * - Deleted lines: GitHub red foreground + light red background (full row)
 * - Added lines:   GitHub green foreground + light green background (full row)
 * - Unchanged lines: context
 * - Line numbers in Stone gray, JetBrains Mono
 *
 * Background tokens (--diff-del-bg / --diff-add-bg) are shared with
 * MarkdownDiffBlock and the TextLightbox hljs override so all three diff
 * surfaces look identical. Switched from grayscale → red/green on 2026-04-21.
 */

import { useMemo } from 'react';
import { diffLines } from 'diff';
import { cn } from '@/lib/utils';

interface DiffViewProps {
  oldString: string;
  newString: string;
  /**
   * 只在每个变化前后保留 N 行 context,中间未变化的部分用 "···" 分隔行折叠。
   * 类似 git diff -U{N}。不传 = 不折叠(展示全部 context),保留原行为给 Edit tool
   * 调用复用 — 它传的本来就是小范围 hunk,不需要折叠。
   * SkillhubDiffPanel 传整个文件内容时必须设置(常用 3),否则一改一行铺一整屏。
   */
  contextLines?: number;
}

interface DiffLine {
  type: 'del' | 'add' | 'ctx';
  text: string;
  lineNum: number;
}

interface SkipMarker {
  type: 'skip';
  /** 折叠的行数,用于 "··· skipped N lines ···" 提示 */
  count: number;
  /** 用作 React key 的稳定标识 */
  anchorIdx: number;
}

type RenderRow = DiffLine | SkipMarker;

/**
 * Real line-level diff using the `diff` package.
 */
function computeDiff(oldStr: string, newStr: string): DiffLine[] {
  const changes = diffLines(oldStr, newStr);
  const result: DiffLine[] = [];
  let lineNum = 1;

  for (const change of changes) {
    // diffLines includes trailing newline in value; split and filter empty trailing
    const lines = change.value.replace(/\n$/, '').split('\n');

    for (const line of lines) {
      if (change.added) {
        result.push({ type: 'add', text: line, lineNum });
      } else if (change.removed) {
        result.push({ type: 'del', text: line, lineNum });
      } else {
        result.push({ type: 'ctx', text: line, lineNum });
      }
      lineNum++;
    }
  }

  return result;
}

/**
 * 把超出 ±contextLines 范围的连续 ctx 行折叠成一个 SkipMarker。
 *
 * 算法:对每个 add/del 行,标记其前后 contextLines 行为"保留",
 * 其余 ctx 行折叠;连续被折叠区段汇总成一个 marker(显示行数提示)。
 */
function applyContextLimit(lines: DiffLine[], contextLines: number): RenderRow[] {
  if (lines.length === 0) return [];
  const keep = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type !== 'ctx') {
      const lo = Math.max(0, i - contextLines);
      const hi = Math.min(lines.length - 1, i + contextLines);
      for (let j = lo; j <= hi; j++) keep[j] = true;
    }
  }
  const result: RenderRow[] = [];
  let skipStart = -1;
  for (let i = 0; i < lines.length; i++) {
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

export function DiffView({ oldString, newString, contextLines }: DiffViewProps) {
  const rows = useMemo<RenderRow[]>(() => {
    const all = computeDiff(oldString, newString);
    return contextLines !== undefined ? applyContextLimit(all, contextLines) : all;
  }, [oldString, newString, contextLines]);

  // 算 gutter 宽度:取最大 lineNum,跳过 skip marker
  const maxLineNum = useMemo(() => {
    let max = 0;
    for (const r of rows) {
      if (r.type !== 'skip' && r.lineNum > max) max = r.lineNum;
    }
    return max;
  }, [rows]);
  const gutterWidth = String(maxLineNum).length || 1;

  // select-text:globals.css 全局禁用了文本选中(Electron 原生 app 风格),
  // diff 内容必须可读可复制,所以这里显式开。gutter / 符号列已通过 select-none
  // 排除,只有内容文本会被选中。
  //
  // diff-hscroll:横向滚动条常显(globals.css),否则长行只能靠 trackpad 盲滚。
  // pre 的 `w-max min-w-full`:行是 flex 容器,pre 宽度若锁在 100% 容器宽,
  // 长行内容会溢出到行的边界之外 —— 滚过去以后行背景(红/绿)在一屏宽处就断了。
  // 让 pre 取 max-content(至少铺满容器),行宽 = 最长行宽,底色跟着滚动区一起延伸。
  return (
    <div className="diff-hscroll select-text overflow-x-auto rounded-[12px] border border-[var(--msg-tool-card-border)]">
      <pre className="m-0 w-max min-w-full p-0 text-[length:calc(var(--app-code-font-size)_-_1px)] leading-[1.5] font-mono">
        {rows.map((row, i) => {
          if (row.type === 'skip') {
            // 折叠占位行 — 不带行号,只显示 "··· N lines unchanged ···"
            return (
              <div
                key={`skip-${row.anchorIdx}`}
                className="flex min-h-[20px] select-none text-[var(--diff-line-num)]"
              >
                <span
                  className="shrink-0 px-2 text-right"
                  style={{ minWidth: `${gutterWidth + 3}ch` }}
                />
                <span className="shrink-0 w-4 text-center">⋯</span>
                <span className="flex-1 whitespace-pre pr-3 italic">
                  {row.count} 行未变
                </span>
              </div>
            );
          }
          return (
            <div
              key={`${row.type}-${row.lineNum}-${i}`}
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
        })}
      </pre>
    </div>
  );
}
