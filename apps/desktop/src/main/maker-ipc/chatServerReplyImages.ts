import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RichAnswerStream, splitRichAnswer, richString } from '@cindy/maker-shared/rich-answer';
import { BOT_GROUP_ATTACHMENTS_MAX } from '../../shared/botGroupChat.js';
import { parseBlobUrl, resolveSafe } from '../cindy-media/blobStore.js';
import { sessionCanRead } from '../cindy-media/ledger.js';
import { materializeTaskImageTextResult } from '../cindy-media/taskImageDelivery.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';
import { hasLocalTaskImages, localTaskImagePath, taskImageReferences, rewriteTaskImageReferences } from '../cindy-media/taskImageMarkdown.js';
import type { ChatUploadAttachment } from './chatServerMedia.js';
import { getDbClient } from '../localDb/client/current.js';
import { isNetworkOrDevicePath } from './chatServerReplyAttachments.js';

const imageLabel = (image: { alt: string }) => image.alt.replace(/[\\`*_{}[\]<>#!|]/g, '\\$&');

type ReplyImageReference = { url: string; start: number; identifier?: string };

/** Normalize only local file URLs; the existing importer still owns file authority. */
function componentImageSource(src: string): string {
  if (!/^file:/i.test(src)) return src;
  try {
    const url = new URL(src);
    if (!/^file:\//i.test(src) || !['', 'localhost'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) throw new Error('invalid file URL');
    const local = fileURLToPath(url);
    if (!path.isAbsolute(local) || isNetworkOrDevicePath(local) || local.includes('\0')) throw new Error('invalid local path');
    return local;
  } catch {
    throw new Error('ATTACHMENT_UNAVAILABLE');
  }
}

/** Collect final rendered references in display order, keeping Markdown scopes independent.
 * The Markdown AST still owns reference definitions and code-example exclusion; the
 * component parser owns patches, moves and removed subtrees.
 */
function replyImageReferences(text: string): ReplyImageReference[] {
  const markdown = taskImageReferences(text);
  return splitRichAnswer(text).flatMap<ReplyImageReference>(part => {
    if (part.kind === 'markdown') return markdown.filter(ref =>
      ref.start >= part.key && ref.start < part.key + part.source.length);
    const doc = new RichAnswerStream().update(part.source, true);
    if (doc.issues) return [];
    const images: Array<{ url: string; start: number }> = [];
    const visit = (id: string) => {
      const node = doc.nodes.get(id);
      if (!node) return;
      if (node.kind === 'image') {
        const src = richString(node, 'src');
        if (src) images.push({ url: componentImageSource(src), start: part.key });
      }
      node.children.forEach(visit);
    };
    doc.roots.forEach(visit);
    return images;
  });
}

/** Feed exact references to the existing importer without exposing synthetic text.
 * Character references prevent source paths from injecting Markdown structure.
 */
function imageReferenceMarkdown(refs: Array<{ url: string }>): string {
  return refs.map(ref => `![](<${ref.url.replace(/[&<>\\\r\n]/g, char => `&#${char.charCodeAt(0)};`)}>)`).join('\n');
}

/** Prepare only rendered, task-owned generated images. Never reads legacy caches. */
export async function prepareChatReplyImages(text: string, sessionId: string, assertCurrent: () => void,
  authorizedFiles: ChatUploadAttachment[] = []) {
  assertCurrent();
  const originalImages = replyImageReferences(text);
  const localSources = new Map<string, string>();
  for (const ref of originalImages) {
    const local = localTaskImagePath(ref.url);
    if (!local || isNetworkOrDevicePath(local) || localSources.has(ref.url)) continue;
    const real = await fs.realpath(local).catch(() => undefined);
    assertCurrent();
    if (real) localSources.set(ref.url, real);
  }
  const fileOnly = new Map<string, string>();
  const fileOnlyAttachments = new Set<ChatUploadAttachment>();
  const inspected = new Set<string>();
  for (const ref of originalImages) {
    if (!ref.identifier || inspected.has(ref.url)) continue;
    const real = localSources.get(ref.url);
    const file = authorizedFiles.find(file => file.sourceUrl === ref.url
      || (real !== undefined && file.sourcePaths?.includes(real)));
    if (!file) continue;
    inspected.add(ref.url);
    // A shared PDF definition must not enter image import, while real images
    // (including extensionless ones) retain the existing materialization path.
    // The caller verifies live file authority before these bounded descriptor reads.
    if (localTaskImagePath(ref.url)) {
      if (!file.readBytes) throw new Error('ATTACHMENT_UNAVAILABLE');
      const bytes = await file.readBytes();
      assertCurrent();
      if (sniffMediaMime(bytes)?.startsWith('image/')) continue;
    }
    fileOnly.set(ref.url, ref.url);
    fileOnlyAttachments.add(file);
    if (fileOnlyAttachments.size > BOT_GROUP_ATTACHMENTS_MAX) throw new Error('ATTACHMENT_UNAVAILABLE');
  }
  text = rewriteTaskImageReferences(text, fileOnly, imageLabel);
  let refs = originalImages.filter(ref => !fileOnly.has(ref.url));
  const imageMarkdown = imageReferenceMarkdown(refs);
  let replacements = new Map<string, string>();
  if (hasLocalTaskImages(imageMarkdown)) {
    const imported = await materializeTaskImageTextResult(sessionId, imageMarkdown);
    assertCurrent();
    if (imported.failures.length || hasLocalTaskImages(imported.text)) throw new Error('ATTACHMENT_UNAVAILABLE');
    refs = taskImageReferences(imported.text);
    text = rewriteTaskImageReferences(text, imported.replacements);
    replacements = imported.replacements;
  }
  const positions = new Map<string, number>();
  const sources = new Map<string, Set<string>>();
  for (const ref of originalImages) {
    const url = replacements.get(ref.url) ?? ref.url;
    if (!positions.has(url)) positions.set(url, ref.start);
    const source = localSources.get(ref.url);
    if (source) {
      if (!sources.has(url)) sources.set(url, new Set());
      sources.get(url)!.add(source);
    }
  }
  const attachments: ChatUploadAttachment[] = [];
  const delivered = new Map<string, string>();
  for (const ref of refs) {
    if (!/^(cindy-media|xdt-image):\/\//.test(ref.url) || delivered.has(ref.url)) continue;
    const blob = parseBlobUrl(ref.url);
    if (!blob || attachments.length >= BOT_GROUP_ATTACHMENTS_MAX
      || !await sessionCanRead(blob.hash, sessionId, getDbClient().drizzle)) throw new Error('ATTACHMENT_UNAVAILABLE');
    assertCurrent();
    const image = resolveSafe(ref.url);
    if (!image.mimeType.startsWith('image/')) throw new Error('ATTACHMENT_UNAVAILABLE');
    const stat = await fs.stat(image.absPath);
    assertCurrent();
    if (!stat.isFile() || stat.size <= 0 || stat.size > 100 * 1024 * 1024) throw new Error('ATTACHMENT_UNAVAILABLE');
    attachments.push({ id: ref.url, sourceOffset: positions.get(ref.url), name: path.basename(image.absPath), category: 'image',
      sourcePaths: [...sources.get(ref.url) ?? []],
      mimeType: image.mimeType, size: stat.size, url: ref.url, path: null });
    delivered.set(ref.url, ref.url);
  }
  return { attachments, text: rewriteTaskImageReferences(text, delivered, imageLabel) };
}
