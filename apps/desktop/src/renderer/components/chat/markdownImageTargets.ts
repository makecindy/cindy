import type { Image, ImageReference, Root } from 'mdast';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import {
  normalizeMarkdownRendererContent,
  REMARK_PLUGINS_PRIVILEGED,
} from './MarkdownRenderer';
import { isManagedMarkdownVideoUrl } from './markdownMedia';
import { RAW_IMAGE_TARGET_PROP } from './remarkPreserveRawLocalDestinations';

// Built on first use: MarkdownRenderer imports this module too (gallery
// occurrences), so its plugin list may not be initialised at module load.
let parser: ReturnType<typeof createParser> | undefined;
function createParser() {
  return unified().use(remarkParse).use(REMARK_PLUGINS_PRIVILEGED);
}
function parseRendered(markdown: string): Root {
  const markdownImageParser = (parser ??= createParser());
  const normalized = normalizeMarkdownRendererContent(markdown);
  // Pass the source as the file, as react-markdown does: source-span plugins read it.
  return markdownImageParser.runSync(markdownImageParser.parse(normalized), normalized) as Root;
}

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

  const tree = parseRendered(markdown);
  const urls: string[] = [];
  const seen = new Set<string>();
  visit(tree, 'image', (node: Image) => {
    // Markdown image syntax can carry generated videos. Those targets are
    // rendered by ChatVideoView and must not be counted as images for inline
    // image fallback / delivery decisions.
    if (!node.url || isManagedMarkdownVideoUrl(node.url) || seen.has(node.url)) return;
    seen.add(node.url);
    urls.push(node.url);
  });
  return urls;
}

export interface MarkdownGalleryImage {
  /** Destination the img renderer receives under RAW_IMAGE_TARGET_PROP. */
  target: string;
  /** Source offset of the image in the rendered (normalised) text, when known. */
  offset: number | undefined;
}

/**
 * Every image the renderer shows, in document order and with repeats (reference
 * images resolve through their definition). Videos are excluded.
 */
export function extractMarkdownGalleryImages(markdown: string): MarkdownGalleryImage[] {
  if (!markdown.includes('![') && !/<img/i.test(markdown)) return [];

  const images: MarkdownGalleryImage[] = [];
  visit(parseRendered(markdown), ['image', 'imageReference'], (node) => {
    const image = node as Image | ImageReference;
    const target = image.data?.hProperties?.[RAW_IMAGE_TARGET_PROP];
    if (typeof target === 'string' && target && !isManagedMarkdownVideoUrl(target))
      images.push({ target, offset: image.position?.start.offset });
  });
  return images;
}

/**
 * Which repeat of `target` in `markdown` the rendered image at `offset` is (0 for
 * the first). Undefined when the image cannot be located.
 */
export function markdownImageOccurrence(markdown: string, target: string, offset: number): number | undefined {
  const repeats = extractMarkdownGalleryImages(markdown).filter((image) => image.target === target);
  const occurrence = repeats.findIndex((image) => image.offset === offset);
  return occurrence >= 0 ? occurrence : undefined;
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
