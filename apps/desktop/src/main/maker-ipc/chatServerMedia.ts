import { chatErrorDiagnostic } from './chatServerErrors.js';
import { net } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFile as readMedia, supportedMime } from '../cindy-media/blobStore.js';
import { ingestMedia } from '../cindy-media/ingest.js';
import { getDbClient } from '../localDb/client/current.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { botGroupAttachmentsPath } from './botGroupWorkDir.js';
import { safeAttachmentFileName } from './botGroupAttachments.js';
import type { BotGroupAttachment } from '../../shared/botGroupChat.js';
import type { ChatApi, ChatContentBlock } from './chatServerMigration.js';

const MAX_SIZE = 100 * 1024 * 1024;
export function createChatMedia(api: ChatApi, current: () => boolean, log?: { warn(message: string, meta?: Record<string, unknown>): void }, options: { allowLoopback?: boolean } = {}) {
  const cache = new Map<string, Promise<BotGroupAttachment>>();
  const check = () => { if (!current()) throw new Error('OWNER_CHANGED'); };
  const signedUrl = (value: string) => {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && !(options.allowLoopback && url.origin === 'http://127.0.0.1:3018')) || url.username || url.password) throw new Error('INVALID_MEDIA_URL');
    return url.href;
  };
  return {
    async upload(roomId: string, source: string, attachments: BotGroupAttachment[], actorId: string): Promise<ChatContentBlock[]> {
      const blocks: ChatContentBlock[] = [];
      for (const attachment of attachments) {
        let stage = 'read';
        const started = Date.now();
        try {
          check();
          if (attachment.size > MAX_SIZE) throw new Error('ATTACHMENT_TOO_LARGE');
          if (attachment.path) {
            const stat = await fs.stat(attachment.path); check();
            if (!stat.isFile() || stat.size > MAX_SIZE) throw new Error('ATTACHMENT_TOO_LARGE');
          }
          const bytes = attachment.url?.startsWith('cindy-media://') ? (await readMedia(attachment.url)).buffer
            : attachment.path ? await fs.readFile(attachment.path) : null;
          check();
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
          check();
          stage = 'upload';
          const response = await net.fetch(signedUrl(upload.uploadUrl), { method: 'PUT', redirect: 'error',
            headers: { 'Content-Type': attachment.mimeType }, body: new Uint8Array(bytes), signal: AbortSignal.timeout(60000) });
          if (!response.ok) throw Object.assign(new Error('MEDIA_UPLOAD_FAILED'), { status: response.status });
          check();
          stage = 'complete';
          await api(`/conversations/${roomId}/media/${upload.id}/complete`, 'POST', { operationId: `seal:${upload.id}` }, actorId);
          blocks.push({ type: 'media', mediaId: upload.id, caption: attachment.name });
        } catch (error) {
          log?.warn('Chat media upload failed', { stage, groupId: roomId,
            trace: createHash('sha256').update(source).digest('hex').slice(0, 16), durationMs: Date.now() - started, ...chatErrorDiagnostic(error) });
          throw error;
        }
      }
      return blocks;
    },
    async download(roomId: string, mediaId: string): Promise<BotGroupAttachment> {
      check();
      // Authorization is checked for each projection, even when bytes are cached.
      const media = await api<{ name: string; type: string; size: string | number; url: string }>(`/conversations/${roomId}/media/${mediaId}`);
      check();
      const key = `${roomId}:${mediaId}`;
      if (!cache.has(key)) cache.set(key, (async () => {
        const size = Number(media.size);
        if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_SIZE) throw new Error('INVALID_MEDIA_SIZE');
        const root = ownerScopedUserDataPath();
        const db = getDbClient().drizzle;
        const response = await net.fetch(signedUrl(media.url), { redirect: 'error', signal: AbortSignal.timeout(60000) });
        if (!response.ok || !response.body) throw new Error('MEDIA_DOWNLOAD_FAILED');
        const chunks: Uint8Array[] = []; let received = 0;
        const reader = response.body.getReader();
        try {
          for (;;) {
            const next = await reader.read(); check();
            if (next.done) break;
            received += next.value.byteLength;
            if (received > size) throw new Error('INVALID_MEDIA_SIZE');
            chunks.push(next.value);
          }
        } finally { await reader.cancel(); }
        if (received !== size) throw new Error('INVALID_MEDIA_SIZE');
        const buffer = Buffer.concat(chunks);
        const base = { id: mediaId, name: media.name, mimeType: media.type, size };
        check();
        if (media.type.startsWith('image/') && supportedMime(media.type)) {
          const stored = await ingestMedia({ buffer, mimeType: media.type, isCache: true, refs: [], assertStillValid: check }, db);
          return { ...base, category: 'image' as const, url: stored.url, path: null };
        }
        // Non-media files use the existing account/group attachment directory.
        const dir = path.join(botGroupAttachmentsPath(root, roomId), mediaId);
        await fs.mkdir(dir, { recursive: true }); check();
        const file = path.join(dir, safeAttachmentFileName(media.name));
        await fs.writeFile(file, buffer); check();
        return { ...base, category: 'file' as const, url: null, path: file };
      })().catch(error => { cache.delete(key); throw error; }));
      return cache.get(key)!;
    },
  };
}
