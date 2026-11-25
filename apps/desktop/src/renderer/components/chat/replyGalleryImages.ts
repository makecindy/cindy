/**
 * Images embedded in a completed assistant reply, in display order, for the task
 * image gallery. Reply images reach the gallery through the same parse
 * (`extractMarkdownGalleryImages`) and address derivation
 * (`markdownImageAddress`) the reply renderer uses, so code examples never count
 * and a clicked image is found among the entries by its destination as written
 * (plus which repeat of it, within the reply section that rendered it).
 */
import {
  RichAnswerStream,
  richMarkdown,
  splitRichAnswer,
  type RichDocument,
} from '@cindy/maker-shared/rich-answer';
import { rewriteToRemoteMediaOrigin } from '../../../shared/remoteMediaUrl';
import { replySectionId, type GalleryImage } from './ImageGalleryContext';
import { markdownImageAddress, type MarkdownImageAddressOptions } from './MarkdownRenderer';
import { extractMarkdownGalleryImages } from './markdownImageTargets';
import { peekWorkspaceMediaSrc, usesWorkspaceLookup } from './useWorkspaceMediaPath';

/** One image a reply renders, located in the reply section the renderer receives. */
export interface ReplyImageRef {
  target: string;
  /** Section id (replySectionId): a plain-text part, or one component node. */
  section: string;
  /** Which repeat of `target` within `section` (0 for the first). */
  occurrence: number;
}

/** Reply images by message id; the stored content guards in-place updates. */
export type ReplyImageCache = Map<string, { content: string; images: ReplyImageRef[] }>;

export interface ReplyGalleryOptions extends MarkdownImageAddressOptions {
  cache: ReplyImageCache;
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
function richImageMarkdown(doc: RichDocument): { id: string; markdown: string }[] {
  const out: { id: string; markdown: string }[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    const node = doc.nodes.get(id);
    if (!node || seen.has(id)) return;
    seen.add(id);
    if (node.kind === 'image' || node.kind === 'markdown') {
      const markdown = richMarkdown(node);
      if (markdown) out.push({ id, markdown });
    }
    for (const child of node.children) visit(child);
  };
  for (const root of doc.roots) visit(root);
  return out;
}

function sectionImages(markdown: string, section: string): ReplyImageRef[] {
  const seen = new Map<string, number>();
  return extractMarkdownGalleryImages(markdown).map(({ target }) => {
    const occurrence = seen.get(target) ?? 0;
    seen.set(target, occurrence + 1);
    return { target, section, occurrence };
  });
}

/** Images a completed reply renders, in order, with their destinations as written. */
export function replyImages(content: string, messageKey: string): ReplyImageRef[] {
  if (!content.includes('![') && !/<img/i.test(content) && !content.includes('cindy-ui')) return [];
  const images: ReplyImageRef[] = [];
  for (const part of splitRichAnswer(content)) {
    if (part.kind === 'markdown') {
      images.push(...sectionImages(part.source, replySectionId(messageKey, part.key)));
      continue;
    }
    // A finished reply renders an unclosed component block as complete too.
    const doc = new RichAnswerStream().update(part.source, true);
    for (const { id, markdown } of richImageMarkdown(doc))
      images.push(...sectionImages(markdown, replySectionId(messageKey, part.key, id)));
  }
  return images;
}

function cachedReplyImages(content: string, cache: ReplyImageCache, messageKey: string): ReplyImageRef[] {
  const cached = cache.get(messageKey);
  if (cached?.content === content) return cached.images;
  const images = replyImages(content, messageKey);
  cache.set(messageKey, { content, images });
  return images;
}

/** Gallery entries for one completed reply; `messageKey` is the reply's client id. */
export function replyGalleryImages(
  content: string,
  messageKey: string,
  scope: string,
  options: ReplyGalleryOptions,
): GalleryImage[] {
  const address = (local: string | undefined): string | undefined => {
    const { normalized, mediaOrigin } = markdownImageAddress(local, options);
    return normalized ? rewriteToRemoteMediaOrigin(normalized, mediaOrigin) : undefined;
  };
  const images: GalleryImage[] = [];
  for (const { target, section, occurrence } of cachedReplyImages(content, options.cache, messageKey)) {
    if (!rendersAsImage(target)) continue;
    const src = address(peekWorkspaceMediaSrc(target, options.workingDir, options.resolveInWorkspace));
    if (!src) continue;
    images.push({
      src,
      target,
      occurrence: { section, index: occurrence },
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
