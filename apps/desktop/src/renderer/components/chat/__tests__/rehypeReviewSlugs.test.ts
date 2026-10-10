import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSlug from 'rehype-slug';
import { visit } from 'unist-util-visit';

import rehypeReviewSlugs, { type RehypeReviewSlugsOptions } from '../rehypeReviewSlugs';

/** 走「rehypeSlug + 本插件」的真实顺序（与渲染链一致），返回最终树。 */
function render(source: string, options?: RehypeReviewSlugsOptions) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeSlug)
    .use(rehypeReviewSlugs, options ?? {});
  return processor.runSync(processor.parse(source)) as never;
}

function collect(tree: unknown, type: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  visit(tree as never, 'element', (node: { tagName?: string; properties?: Record<string, unknown> }) => {
    if (node.tagName === type) out.push(node.properties ?? {});
  });
  return out;
}

describe('rehypeReviewSlugs', () => {
  it('assigns the whole-document ids a segment should carry', () => {
    // 片段里只有第二个同名标题：全篇 id 是 `用法-1`，必须覆盖 rehype-slug 的局部 `用法`。
    const tree = render('## 用法\n', { headingIds: ['用法-1'] });
    expect(collect(tree, 'h2')[0].id).toBe('用法-1');
  });

  it('leaves ids alone when the count does not match the segment', () => {
    // 数量对不上就不覆盖：错配 id 比重复 id 更糟（链接会指到别人的标题）。
    const tree = render('## 用法\n\n## 其他\n', { headingIds: ['用法-1'] });
    const ids = collect(tree, 'h2').map((props) => props.id);
    expect(ids).toEqual(['用法', '其他']);
  });

  it('rewrites in-page links through the whole-document map', () => {
    const tree = render('见 [锚点](#用法) 与 [第二个](#用法-1)。\n', {
      anchorIds: { 用法: '用法', '用法-1': '用法-1' },
    });
    const hrefs = collect(tree, 'a').map((props) => props.href);
    // 第一条按表重写（同段 slug 在全篇里已被去重），第二条保持不变。
    expect(hrefs).toEqual(['#用法', '#用法-1']);
  });

  it('rewrites percent-encoded fragments and leaves unknown anchors untouched', () => {
    const tree = render('见 [编码](#%E7%94%A8%E6%B3%95) 与 [外部](#未收录)。\n', {
      anchorIds: { 用法: '用法-2' },
    });
    const hrefs = collect(tree, 'a').map((props) => decodeURIComponent(String(props.href)));
    expect(hrefs).toEqual(['#用法-2', '#未收录']);
  });

  it('does nothing without options (chat 路径行为零变化)', () => {
    const tree = render('## 用法\n\n## 用法\n');
    expect(collect(tree, 'h2').map((props) => props.id)).toEqual(['用法', '用法-1']);
  });
});
