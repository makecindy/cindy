/**
 * Images embedded in a completed assistant reply, in display order, for the task
 * image gallery. Reply images reach the gallery through the same parse
 * (`extractMarkdownGalleryTargets`) and address derivation
 * (`markdownImageAddress`) the reply renderer uses, so code examples never count
 * and a clicked image is found among the entries by its destination as written.
 */
import {
  RichAnswerStream,
  richMarkdown,
  splitRichAnswer,
  type RichDocument,
} from '@cindy/maker-shared/rich-answer';
import { rewriteToRemoteMediaOrigin } from '../../../shared/remoteMediaUrl';
import type { GalleryImage } from './ImageGalleryContext';
import { markdownImageAddress, type MarkdownImageAddressOptions } from './MarkdownRenderer';
import {
  extractMarkdownGalleryTargets,
  type MarkdownImageTargetCache,
} from './markdownImageTargets';
import { peekWorkspaceMediaSrc, usesWorkspaceLookup } from './useWorkspaceMediaPath';

export interface ReplyGalleryOptions extends MarkdownImageAddressOptions {
  /** Reply targets by message id; the stored content guards in-place updates. */
  cache: MarkdownImageTargetCache;
  /** Same switch as the renderer's workspace search for relative paths. */
  resolveInWorkspace: boolean;
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/;
// The schemes the reply renderer lets through to <img>; anything else renders empty.
const RENDERED_SCHEME_RE =
  /^(?:https?:|data:|file:|xdt-(?:image|video|file|audio):|cindy-media:|cindy-remote-media:)/i;

function rendersAsImage(target: string): boolean {
  return !SCHEME_RE.test(target) || WINDOWS_ABSOLUTE_RE.test(target) || RENDERED_SCHEME_RE.test(target);
}

/** Rich component order follows the layout tree, not creation order. */
function richImageMarkdown(doc: RichDocument): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    const node = doc.nodes.get(id);
    if (!node || seen.has(id)) return;
    seen.add(id);
    if (node.kind === 'image' || node.kind === 'markdown') {
      const markdown = richMarkdown(node);
      if (markdown) out.push(markdown);
    }
    for (const child of node.children) visit(child);
  };
  for (const root of doc.roots) visit(root);
  return out;
}

/** Destinations of images a completed reply renders, in order, as written. */
export function replyImageTargets(content: string): string[] {
  if (!content.includes('![') && !/<img/i.test(content) && !content.includes('cindy-ui')) return [];
  const targets: string[] = [];
  for (const part of splitRichAnswer(content)) {
    if (part.kind === 'markdown') {
      targets.push(...extractMarkdownGalleryTargets(part.source));
      continue;
    }
    // A finished reply renders an unclosed component block as complete too.
    const doc = new RichAnswerStream().update(part.source, true);
    for (const markdown of richImageMarkdown(doc)) targets.push(...extractMarkdownGalleryTargets(markdown));
  }
  return targets;
}

function cachedReplyImageTargets(
  content: string,
  cache: MarkdownImageTargetCache,
  cacheKey: string,
): string[] {
  const cached = cache.get(cacheKey);
  if (cached?.content === content) return cached.targets;
  const targets = replyImageTargets(content);
  cache.set(cacheKey, { content, targets });
  return targets;
}

/** Gallery entries for one completed reply. */
export function replyGalleryImages(
  content: string,
  cacheKey: string,
  scope: string,
  options: ReplyGalleryOptions,
): GalleryImage[] {
  const address = (local: string | undefined): string | undefined => {
    const { normalized, mediaOrigin } = markdownImageAddress(local, options);
    return normalized ? rewriteToRemoteMediaOrigin(normalized, mediaOrigin) : undefined;
  };
  const images: GalleryImage[] = [];
  for (const target of cachedReplyImageTargets(content, options.cache, cacheKey)) {
    if (!rendersAsImage(target)) continue;
    const src = address(peekWorkspaceMediaSrc(target, options.workingDir, options.resolveInWorkspace));
    if (!src) continue;
    images.push({
      src,
      target,
      scope,
      // The folder search may finish after the gallery is built, or never start
      // for rows outside the render window; the viewer resolves when it shows it.
      ...(usesWorkspaceLookup(target, options.workingDir, options.resolveInWorkspace)
        ? { workspace: { path: target, workingDir: options.workingDir, address } }
        : {}),
    });
  }
  return images;
}
