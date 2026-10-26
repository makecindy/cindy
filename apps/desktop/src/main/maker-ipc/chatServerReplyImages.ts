import fs from 'node:fs/promises';
import path from 'node:path';
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

/** Prepare only rendered, task-owned generated images. Never reads legacy caches. */
export async function prepareChatReplyImages(text: string, sessionId: string, assertCurrent: () => void,
  authorizedFiles: ChatUploadAttachment[] = []) {
  assertCurrent();
  const originalImages = taskImageReferences(text);
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
  let replacements = new Map<string, string>();
  if (hasLocalTaskImages(text)) {
    const imported = await materializeTaskImageTextResult(sessionId, text);
    assertCurrent();
    if (imported.failures.length || hasLocalTaskImages(imported.text)) throw new Error('ATTACHMENT_UNAVAILABLE');
    text = imported.text;
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
  for (const ref of taskImageReferences(text)) {
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
