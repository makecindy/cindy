/**
 * highlightSegments — 把 title 按命中字符下标切成高亮 / 非高亮 segments
 * ---------------------------------------------------------------------------
 * 配合 fuzzyMatch 的 indices 输出使用。纯展示函数,无副作用,可单测。
 *
 * 视觉:命中字符加粗 + 字色 #262626 (Light) / #f5f5f5 (Dark)——复用 sidebar
 * 标题色,避免 docs/design-rules/cindy-design-system.md 禁止的色彩 token。非命中字符沿用父级 text-foreground。
 *
 * 健壮性约定:
 *   - indices 必须严格升序、都在 [0, title.length) 内(由 fuzzyMatch 保证);
 *     遇到越界/乱序索引时 silently skip(不抛、不渲染异常字符)
 *   - indices 为空数组 → 直接返回原 title 字符串(零开销)
 *   - title 为空 → 返回空字符串
 *
 * 注:文件后缀 .tsx 因为返回 ReactNode(包含 <mark>);其他 cc-agent/lib/* 文件
 * 全是 .ts。本文件是 lib/ 下唯一的 .tsx,保留是因为 segments 渲染算"对 fuzzy
 * 输出的 React-side 适配",放在 lib/ 一起便于和 fuzzyMatch.ts 共用单测目录。
 */

import type { ReactNode } from 'react';

export interface HighlightSegmentsOptions {
  /**
   * 自定义高亮字符的 className,默认走 sidebar 标题色 + bold:
   * `'bg-transparent font-semibold text-[#262626] dark:text-[#f5f5f5]'`
   */
  highlightClassName?: string;
}

const DEFAULT_HIGHLIGHT_CLASS =
  'bg-transparent font-semibold text-[var(--msg-assistant-text)]';

/**
 * 把 title 切成混合数组,命中字符包在 `<mark>` 中,其它返回纯字符串。
 *
 * @param title    要渲染的源文本
 * @param indices  命中字符在 title 中的下标(严格升序;越界/乱序的会被 skip)
 * @param options  可选样式覆盖
 * @returns        ReactNode(可能是 string 或 (string | ReactElement)[])
 */
export function highlightSegments(
  title: string,
  indices: readonly number[],
  options?: HighlightSegmentsOptions,
): ReactNode {
  if (!title) return '';
  if (indices.length === 0) return title;

  const cls = options?.highlightClassName ?? DEFAULT_HIGHLIGHT_CLASS;
  // indices 是 UTF-16 code unit 下标；命中 emoji 等多单元字符时可能落在
  // surrogate pair 中间。把每个下标扩成完整码点区间再合并，保证切片
  // 永远落在码点边界，不会把一个字符拆成两个乱码 half-surrogate。
  const spans: Array<{ start: number; end: number }> = [];
  for (const i of indices) {
    // 防御:跳过越界 / 负数 index
    if (i < 0 || i >= title.length) continue;
    let start = i;
    let end = i + 1;
    // 落在低代理上时回退到高代理；落在高代理上时扩到低代理末尾。
    const code = title.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff) start -= 1;
    else if (code >= 0xd800 && code <= 0xdbff) end += 1;
    const prev = spans[spans.length - 1];
    if (prev && start <= prev.end) {
      prev.start = Math.min(prev.start, start);
      prev.end = Math.max(prev.end, end);
    } else {
      spans.push({ start, end });
    }
  }

  const out: ReactNode[] = [];
  let cursor = 0;
  for (let k = 0; k < spans.length; k += 1) {
    const span = spans[k]!;
    if (span.start > cursor) out.push(title.slice(cursor, span.start));
    out.push(
      <mark key={span.start} className={cls}>
        {title.slice(span.start, span.end)}
      </mark>,
    );
    cursor = span.end;
  }
  if (cursor < title.length) out.push(title.slice(cursor));
  return out;
}
