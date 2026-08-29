import type { Image, Root } from 'mdast';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import {
  normalizeMarkdownRendererContent,
  REMARK_PLUGINS_PRIVILEGED,
} from './MarkdownRenderer';

const markdownImageParser = unified()
  .use(remarkParse)
  .use(REMARK_PLUGINS_PRIVILEGED);

/** 与 MarkdownRenderer 同源解析，只返回实际会进入 img renderer 的图片地址。 */
export function extractRenderedMarkdownImageTargets(markdown: string): string[] {
  if (!markdown.includes('![') && !/<img/i.test(markdown)) return [];

  const normalized = normalizeMarkdownRendererContent(markdown);
  const tree = markdownImageParser.runSync(markdownImageParser.parse(normalized)) as Root;
  const urls: string[] = [];
  const seen = new Set<string>();
  visit(tree, 'image', (node: Image) => {
    if (!node.url || seen.has(node.url)) return;
    seen.add(node.url);
    urls.push(node.url);
  });
  return urls;
}
