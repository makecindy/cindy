/**
 * 流式分片解析时的标题 id（DESIGN.md §14.4「Stream pacing」）。
 *
 * 不变量：流式期间每个 Markdown 标题的 id，等于终版整篇解析时 rehype-slug 给它的 id
 * （包括重复标题的 -1/-2 后缀），文内锚点与目录链接在流式期间不指错。
 *
 * 分片各自解析时，rehype-slug 只能看到本分片的标题，去重计数会错。这里不从源码猜
 * 哪些行是标题（引用、列表、公式块、Setext 等都会让猜测失准），而是：
 *
 * 1. 分片解析链里用 `rehypeMarkHeadingSlugText` 代替 rehype-slug，放在同一位置，
 *    把 rehype-slug 本会读取的标题文本记到 `data-slug-text` 上，不写 id；
 * 2. 渲染提交后，`assignStreamingHeadingIds` 按文档顺序收集这些标题，交给同一个
 *    rehype-slug 统一分配 id。
 *
 * 标题集合与文本都来自真实解析结果，计数顺序就是文档顺序，与整篇解析一致。
 */
import type { Element, ElementContent, Root, RootContent } from 'hast';
import rehypeSlug from 'rehype-slug';

export const HEADING_SLUG_TEXT_ATTR = 'data-slug-text';

const HEADING_TAG = /^h[1-6]$/;

type HastNode = Root | RootContent | ElementContent;

/** 与 rehype-slug 使用的 hast-util-to-string 相同：所有后代文本节点按树序拼接。 */
function headingText(node: HastNode): string {
  if ('children' in node) return node.children.map(descendantText).join('');
  return 'value' in node ? String(node.value) : '';
}

function descendantText(node: HastNode): string {
  if (node.type === 'text') return node.value;
  return 'children' in node ? node.children.map(descendantText).join('') : '';
}

function markHeadings(node: HastNode): void {
  if (node.type === 'element' && HEADING_TAG.test(node.tagName) && !node.properties.id) {
    // rehype-slug 跳过已带 id 的标题，它们也不占去重计数。
    node.properties.dataSlugText = headingText(node);
  }
  if ('children' in node) for (const child of node.children) markHeadings(child);
}

/** 流式分片里替代 rehype-slug：只记录标题文本，id 由 assignStreamingHeadingIds 统一分配。 */
export function rehypeMarkHeadingSlugText() {
  return (tree: Root) => {
    markHeadings(tree);
  };
}

const runRehypeSlug = (rehypeSlug as unknown as () => (tree: Root) => void)();

/**
 * 按文档顺序给 container 内流式分片的标题分配 id。每次提交后调用；只改变化了的 id，
 * 稳定分片里的标题 id 不会因为后面出现新标题而改变。
 */
export function assignStreamingHeadingIds(container: HTMLElement): void {
  const headings = container.querySelectorAll<HTMLElement>(`[${HEADING_SLUG_TEXT_ATTR}]`);
  if (headings.length === 0) return;
  const tree: Root = {
    type: 'root',
    children: Array.from(headings, (heading): Element => ({
      type: 'element',
      tagName: 'h1',
      properties: {},
      children: [{ type: 'text', value: heading.getAttribute(HEADING_SLUG_TEXT_ATTR) ?? '' }],
    })),
  };
  runRehypeSlug(tree);
  tree.children.forEach((node, index) => {
    const id = String((node as Element).properties.id ?? '');
    if (headings[index].id !== id) headings[index].id = id;
  });
}
