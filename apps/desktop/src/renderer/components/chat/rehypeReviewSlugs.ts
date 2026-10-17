/**
 * rehypeReviewSlugs — 审查预览的跨片段标题锚点修正（**只在审查页启用**）。
 *
 * 背景（2026-09-21 修，Greptile P1）：审查预览为每个计划片段各建一个
 * `MarkdownRenderer`，而 `rehype-slug` 每次 transform 都会 `slugs.reset()` —— 于是
 * 「重复标题落在不同片段」时两段会生成**同一个 id**（非法 HTML；页内链接只能命中
 * 第一个），全篇渲染时本该是 `x` / `x-1` 的两个不同锚点退化成同一个。
 *
 * 做法：计划阶段（markdownBlockDiff）用同一套 GitHub slug 规则算出全篇标题 id，
 * 本插件逐片段把这些 id 落到位（覆盖 rehype-slug 的结果），并同时把所有页内链接
 * `href="#..."` 按全篇表重写 —— 跨片段链接因此也能落到正确标题。
 *
 * 不变量：
 *  - `headingIds` 数量与片段内标题数不一致时不覆盖（宁可用 rehype-slug 的局部结果，
 *    也不要把 id 错配到别的标题上）；链接重写仍然生效。
 *  - 只在审查页（MarkdownDiffPreview 传 options）挂载；普通聊天路径不带本插件。
 */

import { visit } from 'unist-util-visit';

interface HastNodeLike {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
}

export interface RehypeReviewSlugsOptions {
  /** 本片段内标题应落的 id（按标题顺序）；空数组表示本片段不需要覆盖。 */
  headingIds?: readonly string[];
  /** 页内链接重写表：slug（或已定稿 id）→ 全篇唯一 id。 */
  anchorIds?: Readonly<Record<string, string>>;
}

const HEADING_TAG_PATTERN = /^h[1-6]$/;

/** 片段的标题 id 覆盖 + 页内链接重写。 */
export default function rehypeReviewSlugs(options: RehypeReviewSlugsOptions = {}) {
  const headingIds = options.headingIds ?? [];
  const anchorIds = options.anchorIds ?? {};

  return (tree: unknown): void => {
    if (headingIds.length > 0) {
      const headings: HastNodeLike[] = [];
      visit(tree as never, 'element', (node: HastNodeLike) => {
        if (typeof node.tagName === 'string' && HEADING_TAG_PATTERN.test(node.tagName)) {
          headings.push(node);
        }
      });
      // 数量对不上就不覆盖：错配 id 比重复 id 更糟（会让链接指向错误标题）。
      if (headings.length === headingIds.length) {
        headings.forEach((heading, index) => {
          heading.properties = { ...heading.properties, id: headingIds[index] };
        });
      }
    }

    if (Object.keys(anchorIds).length === 0) return;
    visit(tree as never, 'element', (node: HastNodeLike) => {
      if (node.tagName !== 'a') return;
      const href = node.properties?.href;
      if (typeof href !== 'string' || !href.startsWith('#')) return;
      const fragment = href.slice(1);
      const mapped = anchorIds[fragment] ?? anchorIds[safeDecode(fragment)];
      if (mapped === undefined || mapped === fragment) return;
      node.properties = { ...node.properties, href: `#${mapped}` };
    });
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
