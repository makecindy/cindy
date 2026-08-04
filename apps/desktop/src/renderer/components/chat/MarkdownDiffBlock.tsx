/**
 * MarkdownDiffBlock
 * ---------------------------------------------------------------------------
 * Renders a markdown ```diff fenced code block as a row-by-row diff view —
 * line numbers in a gutter, a dedicated `+` / `-` symbol column, and the
 * changed-line text in GitHub-standard red/green.
 *
 * Why not reuse `DiffView`?
 * `DiffView` takes (oldString, newString) and runs `diff.diffLines()` to
 * compute the change set. Here the fenced ```diff body is *already* a diff
 * — every line is pre-prefixed with `+`, `-`, or a space by whoever wrote
 * the markdown. The two components share the same visual skeleton (and the
 * same `--diff-*-fg/bg` tokens), but the input semantics are different
 * enough that wedging both into one component would just hide the seam.
 *
 * Visual contract is intentionally aligned with DiffView so the message
 * stream looks coherent regardless of which path produced the diff.
 */

import { useMemo } from 'react';
import { cn } from '@/lib/utils';

interface MarkdownDiffBlockProps {
  /** The raw text contents of a ```diff fenced code block. */
  raw: string;
}

interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  text: string;
  lineNum: number;
}

/**
 * Parse pre-prefixed diff text into typed rows.
 * `+++` / `---` / `@@` hunk headers stay as `ctx` so they render in the
 * default text color (no red/green bleed onto file headers).
 */
function parseDiffText(raw: string): DiffLine[] {
  // Trim leading/trailing blank lines so the block doesn't open or close on
  // an empty row — matches how fenced code blocks are usually authored.
  const lines = raw.replace(/^\n+|\n+$/g, '').split('\n');
  let lineNum = 1;
  return lines.map((line) => {
    let type: DiffLine['type'] = 'ctx';
    let text = line;
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      // diff hunk / file headers — keep raw, render as ctx (no color)
      type = 'ctx';
    } else if (line.startsWith('+')) {
      type = 'add';
      // Drop the leading '+' and the conventional single space after it.
      text = line.slice(1).replace(/^ /, '');
    } else if (line.startsWith('-')) {
      type = 'del';
      text = line.slice(1).replace(/^ /, '');
    }
    return { type, text, lineNum: lineNum++ };
  });
}

export function MarkdownDiffBlock({ raw }: MarkdownDiffBlockProps) {
  const lines = useMemo(() => parseDiffText(raw), [raw]);

  const maxLineNum = lines.length > 0 ? lines[lines.length - 1].lineNum : 0;
  const gutterWidth = String(maxLineNum).length;

  return (
    // diff-hscroll + pre 的 `w-max min-w-full` 与 DiffView 同一套横滚契约:
    // 滚动条常显 + 行宽取最长行,长行滚出去以后红/绿底色不断。
    <div
      className={cn(
        'diff-hscroll my-3 overflow-x-auto rounded-[12px]',
        'border border-[var(--msg-code-block-border)]',
        'bg-[var(--msg-code-block-bg)]',
      )}
    >
      <pre className="m-0 w-max min-w-full p-0 text-[length:calc(var(--app-code-font-size)_-_1px)] leading-[1.5] font-mono">
        {lines.map((line, i) => (
          <div
            key={`${line.type}-${line.lineNum}-${i}`}
            className={cn(
              'flex min-h-[20px]',
              line.type === 'del' && 'bg-[var(--diff-del-bg)]',
              line.type === 'add' && 'bg-[var(--diff-add-bg)]',
            )}
          >
            {/* Line-number gutter */}
            <span
              className="shrink-0 select-none px-2 text-right text-[var(--diff-line-num)]"
              style={{ minWidth: `${gutterWidth + 3}ch` }}
            >
              {line.lineNum}
            </span>
            {/* Symbol column (+ / - / space) */}
            <span
              className={cn(
                'shrink-0 w-4 select-none text-center',
                line.type === 'del' && 'text-[var(--diff-del-fg)]',
                line.type === 'add' && 'text-[var(--diff-add-fg)]',
              )}
            >
              {line.type === 'del' ? '-' : line.type === 'add' ? '+' : ' '}
            </span>
            {/* Content column */}
            <span
              className={cn(
                'flex-1 whitespace-pre pr-3',
                line.type === 'del' && 'text-[var(--diff-del-fg)]',
                line.type === 'add' && 'text-[var(--diff-add-fg)]',
              )}
            >
              {line.text}
            </span>
          </div>
        ))}
      </pre>
    </div>
  );
}
