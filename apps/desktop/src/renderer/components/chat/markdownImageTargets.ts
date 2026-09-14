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

/**
 * Per-session cache for image targets extracted from completed assistant
 * messages. The content is checked as well as the client id because a live
 * message is updated in place while it streams; stale targets must never
 * leak into the next turn.
 */
export interface MarkdownImageTargetCacheEntry {
  content: string;
  targets: string[];
}

export type MarkdownImageTargetCache = Map<string, MarkdownImageTargetCacheEntry>;

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

/**
 * Read or populate the completed-message cache used by MessageStream.
 * Empty results are cached too: most assistant messages contain no images,
 * and treating that as a cacheable result avoids repeatedly parsing prose.
 */
export function extractCachedRenderedMarkdownImageTargets(
  markdown: string,
  cache: MarkdownImageTargetCache,
  cacheKey: string,
): string[] {
  const cached = cache.get(cacheKey);
  if (cached?.content === markdown) return cached.targets;

  const targets = extractRenderedMarkdownImageTargets(markdown);
  cache.set(cacheKey, { content: markdown, targets });
  return targets;
}
