import { chatErrorDiagnostic } from './chatServerErrors.js';
import { retryAfterDeadline } from '@cindy/auth-client';
import { net } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFile as readMedia, supportedMime } from '../cindy-media/blobStore.js';
import { captureRemoteMediaCacheValidity, chatMediaPersistentCache, remoteMediaCacheGeneration } from '../device-link/remoteMediaPersistentCache.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { botGroupAttachmentsPath } from './botGroupWorkDir.js';
import { safeAttachmentFileName } from './botGroupAttachments.js';
import type { BotGroupAttachment } from '../../shared/botGroupChat.js';
import type { ChatApi, ChatContentBlock } from './chatServerMigration.js';

/** Internal-only readers: never serialized in group messages or IPC. */
export type ChatUploadAttachment = BotGroupAttachment & {
  /** Offset in the file-rewritten Markdown, before image materialization. Never sent over the wire. */
  sourceOffset?: number;
  /** Canonical local image/file sources, used only to reconcile the two reply passes. */
  sourcePaths?: string[];
  /** Original Markdown target, for shared reference definitions; never serialized. */
  sourceUrl?: string;
  readBytes?: () => Promise<Buffer>;
  assertCurrent?: () => void;
};

const MAX_SIZE = 100 * 1024 * 1024;
/** Files of one send uploaded at once; each holds its bytes in memory until sealed. */
const UPLOAD_CONCURRENCY = 3;
export function createChatMedia(api: ChatApi, current: () => boolean, endpoint: string, log?: { warn(message: string, meta?: Record<string, unknown>): void }, options: { allowLoopback?: boolean } = {}) {
  // Images keep only in-flight transfers here; ordinary files retain service-local reuse.
  const cache = new Map<string, Promise<BotGroupAttachment>>();
  const check = () => { if (!current()) throw new Error('OWNER_CHANGED'); };
  const signedUrl = (value: string) => {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && !(options.allowLoopback && url.origin === 'http://127.0.0.1:3018')) || url.username || url.password) throw new Error('INVALID_MEDIA_URL');
    return url.href;
  };
  return {
    get cacheGeneration() { return remoteMediaCacheGeneration(); },
    /**
     * Uploads a send's files a few at a time (prepare → PUT → complete each), keeping the
     * blocks in the files' order. Every file settles before a failure is reported, so no
     * upload keeps running after the send has given up; the first failure in order wins.
     */
    async upload(roomId: string, source: string, attachments: ChatUploadAttachment[], actorId: string, assertCurrent?: () => void | Promise<void>): Promise<ChatContentBlock[]> {
      const assertCacheCurrent = captureRemoteMediaCacheValidity();
      const checkUpload = async () => { check(); await assertCurrent?.(); check(); };
      const results: Array<PromiseSettledResult<ChatContentBlock>> = new Array(attachments.length);
      let next = 0;
      const worker = async () => {
        while (next < attachments.length) {
          const index = next++;
          results[index] = await uploadOne(attachments[index]!).then(
            value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason }));
        }
      };
      await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, attachments.length) }, worker));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      return results.map(result => (result as PromiseFulfilledResult<ChatContentBlock>).value);

      async function uploadOne(attachment: ChatUploadAttachment): Promise<ChatContentBlock> {
        let stage = 'read';
        const started = Date.now();
        const checkFile = async () => { await checkUpload(); attachment.assertCurrent?.(); };
        try {
          await checkFile();
          if (attachment.size > MAX_SIZE) throw new Error('ATTACHMENT_TOO_LARGE');
          if (attachment.path && !attachment.readBytes) {
            const stat = await fs.stat(attachment.path); await checkFile();
            if (!stat.isFile() || stat.size > MAX_SIZE) throw new Error('ATTACHMENT_TOO_LARGE');
          }
          const bytes = attachment.readBytes ? await attachment.readBytes() : attachment.url?.startsWith('cindy-media://') ? (await readMedia(attachment.url)).buffer
            : attachment.path ? await fs.readFile(attachment.path) : null;
          await checkFile();
          if (!bytes || !bytes.length || bytes.length > MAX_SIZE) throw new Error('ATTACHMENT_UNAVAILABLE');
          const key = createHash('sha256').update(source).update(attachment.id).update(bytes).digest('hex');
          // Expired abandoned uploads must get a new prepare receipt, but a successful
          // message keeps the same content even when the request's ACK was lost.
          let upload: { id: string; uploadUrl: string };
          stage = 'prepare';
          try {
            upload = await api(`/conversations/${roomId}/media`, 'POST', {
              operationId: `media:${key}`, name: attachment.name, type: attachment.mimeType, size: bytes.length,
            }, actorId);
          } catch (error) {
            if (!(error instanceof Error) || error.message !== 'UPLOAD_EXPIRED') throw error;
            upload = await api(`/conversations/${roomId}/media`, 'POST', {
              operationId: `media:${key}:${randomUUID()}`, name: attachment.name, type: attachment.mimeType, size: bytes.length,
            }, actorId);
          }
          await checkFile();
          stage = 'upload';
          const response = await net.fetch(signedUrl(upload.uploadUrl), { method: 'PUT', redirect: 'error',
            headers: { 'Content-Type': attachment.mimeType }, body: new Uint8Array(bytes), signal: AbortSignal.timeout(60000) });
          if (!response.ok) throw Object.assign(new Error('MEDIA_UPLOAD_FAILED'), { status: response.status,
            ...(response.status === 429 ? { retryAt: retryAfterDeadline(response) } : {}) });
          await checkFile();
          stage = 'complete';
          await api(`/conversations/${roomId}/media/${upload.id}/complete`, 'POST', { operationId: `seal:${upload.id}` }, actorId);
          check(); attachment.assertCurrent?.();
          if (attachment.mimeType.startsWith('image/') && supportedMime(attachment.mimeType)) {
            // Keep the bytes actually uploaded, not a later re-read of a mutable source.
            // Cache failure must not turn an already sealed upload into a failed send.
            try {
              assertCacheCurrent();
              await chatMediaPersistentCache(endpoint, roomId, upload.id, () => { check(); assertCacheCurrent(); })
                ?.put(bytes, attachment.mimeType);
            } catch { log?.warn('Chat image cache write failed', { stage: 'retain' }); }
            check(); attachment.assertCurrent?.();
          }
          return { type: 'media', mediaId: upload.id, caption: attachment.name };
        } catch (error) {
          log?.warn('Chat media upload failed', { stage, groupId: roomId,
            trace: createHash('sha256').update(source).digest('hex').slice(0, 16), durationMs: Date.now() - started, ...chatErrorDiagnostic(error) });
          throw error;
        }
      }
    },
    async download(roomId: string, mediaId: string): Promise<BotGroupAttachment> {
      check();
      const generation = remoteMediaCacheGeneration();
      const assertCacheCurrent = captureRemoteMediaCacheValidity();
      // Authorization is checked for each projection, even when bytes are cached.
      const media = await api<{ name: string; type: string; size: string | number; url: string }>(`/conversations/${roomId}/media/${mediaId}`);
      check();
      const isImage = media.type.startsWith('image/') && supportedMime(media.type);
      const checkDownload = () => { check(); if (isImage) assertCacheCurrent(); };
      checkDownload();
      const persistent = isImage ? chatMediaPersistentCache(endpoint, roomId, mediaId, checkDownload) : null;
      const key = JSON.stringify([roomId, mediaId, isImage ? generation : null]);
      if (!cache.has(key)) cache.set(key, (async () => {
        const size = Number(media.size);
        if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_SIZE) throw new Error('INVALID_MEDIA_SIZE');
        const root = ownerScopedUserDataPath();
        const base = { id: mediaId, name: media.name, mimeType: media.type, size };
        if (isImage) {
          const hit = await persistent?.get(size);
          checkDownload();
          if (hit && hit.bytes.length === size)
            return { ...base, mimeType: hit.mimeType, category: 'image' as const, url: hit.url, path: null };
        }
        const response = await net.fetch(signedUrl(media.url), { redirect: 'error', signal: AbortSignal.timeout(60000) });
        // The status tells a file that is gone (4xx: never comes) from a failing server (retried).
        if (!response.ok || !response.body) throw Object.assign(new Error('MEDIA_DOWNLOAD_FAILED'), response.ok ? {} : { status: response.status });
        const chunks: Uint8Array[] = []; let received = 0;
        const reader = response.body.getReader();
        try {
          for (;;) {
            const next = await reader.read(); checkDownload();
            if (next.done) break;
            received += next.value.byteLength;
            if (received > size) throw new Error('INVALID_MEDIA_SIZE');
            chunks.push(next.value);
          }
        } finally { await reader.cancel(); }
        if (received !== size) throw new Error('INVALID_MEDIA_SIZE');
        const buffer = Buffer.concat(chunks);
        checkDownload();
        if (isImage) {
          const stored = await persistent?.put(buffer, media.type);
          checkDownload();
          if (!stored) throw new Error('INVALID_MEDIA_IMAGE');
          return { ...base, mimeType: stored.mimeType, category: 'image' as const, url: stored.url, path: null };
        }
        // Non-media files use the existing account/group attachment directory.
        const dir = path.join(botGroupAttachmentsPath(root, roomId), mediaId);
        await fs.mkdir(dir, { recursive: true }); check();
        const file = path.join(dir, safeAttachmentFileName(media.name));
        await fs.writeFile(file, buffer); check();
        return { ...base, category: 'file' as const, url: null, path: file };
      })().then(value => {
        if (isImage) cache.delete(key);
        return value;
      }, error => { cache.delete(key); throw error; }));
      const result = await cache.get(key)!;
      checkDownload();
      return result;
    },
  };
}
