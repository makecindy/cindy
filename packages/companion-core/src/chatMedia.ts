import { createHash, randomUUID } from 'node:crypto';
import type { BotGroupAttachment } from '@cindy/maker-shared/botGroupChat';
export type ChatApi = <T>(route:string,method?:string,data?:unknown,actorId?:string)=>Promise<T>;
export interface ChatContentBlock {type:string;mediaId?:string;caption?:string}
export interface ChatMediaDependencies {
 fetch(url: string, init?: RequestInit): Promise<Response>;
 read(attachment:BotGroupAttachment,maxSize:number,check:()=>void):Promise<Buffer|null>;
 cache(input:{roomId:string;mediaId:string;name:string;mimeType:string;size:number;buffer:Buffer},check:()=>void):Promise<BotGroupAttachment>;
 retryAfterDeadline(response:Response):number|undefined;
 diagnostic(error:unknown):Record<string,unknown>;
}
const MAX_SIZE = 100 * 1024 * 1024;
/** Files of one send uploaded at once; each holds its bytes in memory until sealed. */
const UPLOAD_CONCURRENCY = 3;
export function createChatMedia(api: ChatApi, current: () => boolean, deps: ChatMediaDependencies, log?: { warn(message: string, meta?: Record<string, unknown>): void }, options: { allowLoopback?: boolean } = {}) {
  const cache = new Map<string, Promise<BotGroupAttachment>>();
  const check = () => { if (!current()) throw new Error('OWNER_CHANGED'); };
  const signedUrl = (value: string) => {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && !(options.allowLoopback && url.origin === 'http://127.0.0.1:3018')) || url.username || url.password) throw new Error('INVALID_MEDIA_URL');
    return url.href;
  };
  return {
    /**
     * Uploads a send's files a few at a time (prepare → PUT → complete each), keeping the
     * blocks in the files' order. Every file settles before a failure is reported, so no
     * upload keeps running after the send has given up; the first failure in order wins.
     */
    async upload(roomId: string, source: string, attachments: BotGroupAttachment[], actorId: string, assertCurrent?: () => void): Promise<ChatContentBlock[]> {
      const checkUpload = () => { check(); assertCurrent?.(); };
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

      async function uploadOne(attachment: BotGroupAttachment): Promise<ChatContentBlock> {
        let stage = 'read';
        const started = Date.now();
        try {
          checkUpload();
          if (attachment.size > MAX_SIZE) throw new Error('ATTACHMENT_TOO_LARGE');
          const bytes = await deps.read(attachment, MAX_SIZE, checkUpload);
          checkUpload();
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
          checkUpload();
          stage = 'upload';
          const response = await deps.fetch(signedUrl(upload.uploadUrl), { method: 'PUT', redirect: 'error',
            headers: { 'Content-Type': attachment.mimeType }, body: new Uint8Array(bytes), signal: AbortSignal.timeout(60000) });
          if (!response.ok) throw Object.assign(new Error('MEDIA_UPLOAD_FAILED'), { status: response.status,
            ...(response.status === 429 ? { retryAt: deps.retryAfterDeadline(response) } : {}) });
          checkUpload();
          stage = 'complete';
          await api(`/conversations/${roomId}/media/${upload.id}/complete`, 'POST', { operationId: `seal:${upload.id}` }, actorId);
          return { type: 'media', mediaId: upload.id, caption: attachment.name };
        } catch (error) {
          log?.warn('Chat media upload failed', { stage, groupId: roomId,
            trace: createHash('sha256').update(source).digest('hex').slice(0, 16), durationMs: Date.now() - started, ...deps.diagnostic(error) });
          throw error;
        }
      }
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
        const response = await deps.fetch(signedUrl(media.url), { redirect: 'error', signal: AbortSignal.timeout(60000) });
        // The status tells a file that is gone (4xx: never comes) from a failing server (retried).
        if (!response.ok || !response.body) throw Object.assign(new Error('MEDIA_DOWNLOAD_FAILED'), response.ok ? {} : { status: response.status });
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
        return deps.cache({roomId,mediaId,name:media.name,mimeType:media.type,size,buffer},check);
      })().catch(error => { cache.delete(key); throw error; }));
      return cache.get(key)!;
    },
  };
}
