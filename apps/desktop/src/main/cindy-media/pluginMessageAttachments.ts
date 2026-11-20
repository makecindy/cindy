import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentInputSerializedFile } from '../../shared/agentInputQueue.js';
import {
  PLUGIN_ATTACHMENT_MAX_BYTES,
  pluginAttachmentBytes,
  validPluginMessageAttachmentSet,
  type PluginMessageAttachment,
} from '../../shared/pluginAttachments.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { adoptStagedInboundFiles, stageInboundFile } from '../im/shared/inboundFileStaging.js';
import { blobUrl, extForMime, resolveSafe, supportedMime } from './blobStore.desktop.js';
import { ingestMedia } from './ingest.js';
import { sniffMediaMime } from './sniffMediaMime.js';

/**
 * One plugin-supplied attachment after Host parsing. Where it goes is decided once, from the
 * bytes, like Cindy's own IM channels: media the store accepts (images, audio, video) enters
 * cindy-media; anything else is a file kept in the task's attachment directory.
 */
export interface PluginMessageItem {
  buffer: Buffer;
  /** Sniffed media type; `application/octet-stream` for files. Never the plugin's claim. */
  mimeType: string;
  hash: string;
  name: string;
  kind: 'image' | 'media' | 'file';
}
const FILE_MIME = 'application/octet-stream';
const invalid = () => Object.assign(new Error('INVALID_ATTACHMENTS'), { code: 'INVALID_ATTACHMENTS' });
function parseItem(item: PluginMessageAttachment): PluginMessageItem {
  const buffer = Buffer.from(item.base64, 'base64');
  if (buffer.toString('base64') !== item.base64) throw invalid();
  const sniffed = sniffMediaMime(buffer);
  const media = sniffed && supportedMime(sniffed) ? sniffed : null;
  const kind = !media ? 'file' : media.startsWith('image/') ? 'image' : 'media';
  const fallback = kind === 'file' ? 'attachment'
    : `${kind === 'image' ? 'image' : media!.startsWith('video/') ? 'video' : media!.startsWith('audio/') ? 'audio' : 'media'}${extForMime(media!) ?? ''}`;
  return { buffer, mimeType: media ?? FILE_MIME, hash: createHash('sha256').update(buffer).digest('hex'),
    name: item.name ?? fallback, kind };
}

// Shared by tasks and targets, including time spent waiting for their receipt locks.
let inFlightBytes = 0;
/**
 * Validate, budget and decode. `contextValue` (tasks.send only) holds model-only reference
 * attachments, such as images from group history; both lists share one byte budget.
 */
export async function withParsedPluginMessageAttachments<T>(
  value: unknown,
  use: (items: PluginMessageItem[], contextItems: PluginMessageItem[]) => Promise<T>,
  contextValue?: unknown,
): Promise<T> {
  if (!validPluginMessageAttachmentSet(value, contextValue)) throw invalid();
  const attachments = value as PluginMessageAttachment[] | undefined;
  const context = contextValue as PluginMessageAttachment[] | undefined;
  const bytes = pluginAttachmentBytes(attachments, context);
  if (inFlightBytes + bytes > PLUGIN_ATTACHMENT_MAX_BYTES * 2)
    throw Object.assign(new Error('TASK_BUSY'), { code: 'TASK_BUSY', retryable: true });
  inFlightBytes += bytes;
  try {
    return await use((attachments ?? []).map(parseItem), (context ?? []).map(parseItem));
  } finally {
    inFlightBytes -= bytes;
  }
}

// Extend the existing draft/queued-message live set across import → durable queue.
// Register before the first await, including deduplicated blobs older than the GC buffer.
const inFlight = new Set<string[]>();
export function collectPluginAttachmentPayloadTexts(): string[] {
  return [...inFlight].map(urls => JSON.stringify(urls));
}
/**
 * Store parsed attachments and hand them to `deliver` as queue files.
 *
 * - Shown attachments are kept with the message: media as user attachments (pinned when the
 *   message is persisted), files moved into the task's own `im-attachments/plugin/sessions/` folder.
 * - Context attachments only reach the model: media is written as reclaimable cache and files stay
 *   in the age-swept staging folder, as Cindy's IM channels do with group-history attachments.
 */
export async function withPluginMessageAttachments<T>(
  items: PluginMessageItem[],
  assertCurrent: () => void,
  deliver: (files: AgentInputSerializedFile[], contextFiles: AgentInputSerializedFile[]) => Promise<T>,
  options: { sessionId?: string; contextItems?: PluginMessageItem[] } = {},
): Promise<T> {
  assertCurrent();
  const contextItems = options.contextItems ?? [];
  if (!items.length && !contextItems.length) return deliver([], []);
  const snapshot = getCurrentDbClientSnapshot();
  if (!snapshot) throw Object.assign(new Error('HOST_NOT_READY'), { code: 'HOST_NOT_READY' });
  const guard = () => {
    assertCurrent();
    if (snapshot !== getCurrentDbClientSnapshot())
      throw Object.assign(new Error('PERMISSION_DENIED'), { code: 'PERMISSION_DENIED' });
  };
  const urls = [...items, ...contextItems].filter(item => item.kind !== 'file')
    .map(item => blobUrl(item.hash, extForMime(item.mimeType) ?? '.bin'));
  inFlight.add(urls);
  // Files written before the hand-off. Once `deliver` runs, a queue may own them even if it throws.
  const written: string[] = [];
  let handedOff = false;
  const store = async (item: PluginMessageItem, context: boolean): Promise<AgentInputSerializedFile> => {
    if (item.kind !== 'file') {
      const media = await ingestMedia({ buffer: item.buffer, mimeType: item.mimeType,
        isCache: context, refs: [], assertStillValid: guard }, snapshot.client.drizzle);
      guard();
      const image = item.kind === 'image';
      // Audio and video persist like IM inbound media: a path for the Agent, and the URL
      // that pins the blob to the message.
      return { id: randomUUID(), name: item.name, originalName: item.name, category: image ? 'image' : 'file',
        path: image ? '' : resolveSafe(media.url).absPath, ext: media.ext, size: media.bytes,
        mimeType: media.mimeType, url: media.url };
    }
    if (!options.sessionId) throw invalid();
    guard();
    const staged = await stageInboundFile({ integration: 'plugin', buffer: item.buffer, fileName: item.name });
    written.push(staged.absPath);
    const attachment = { kind: 'file' as const, absPath: staged.absPath, originalName: item.name, mimeType: FILE_MIME };
    if (!context) {
      await adoptStagedInboundFiles(options.sessionId, [attachment]);
      written[written.length - 1] = attachment.absPath;
    }
    guard();
    return { id: randomUUID(), name: item.name, originalName: item.name, category: 'file',
      path: attachment.absPath, ext: path.extname(attachment.absPath).toLowerCase(),
      size: item.buffer.length, mimeType: FILE_MIME };
  };
  try {
    const files: AgentInputSerializedFile[] = [];
    for (const item of items) files.push(await store(item, false));
    const contextFiles: AgentInputSerializedFile[] = [];
    for (const item of contextItems) contextFiles.push(await store(item, true));
    handedOff = true;
    // Caller awaits the existing durable queue write, or same-turn message persistence.
    // Those existing owners protect the URL after this in-flight scope is released.
    return await deliver(files, contextFiles);
  } finally {
    inFlight.delete(urls);
    if (!handedOff) await Promise.all(written.map(file => fs.rm(file, { force: true }).catch(() => undefined)));
  }
}
