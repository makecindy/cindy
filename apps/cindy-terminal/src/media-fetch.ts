import path from 'node:path';
import { createHash } from 'node:crypto';
import { FILE_INLINE_MAX_BYTES } from '@cindy/device-link';
import type { InvocationContext } from './contracts.js';
import type { TerminalFileBrowser } from './file-browser.js';
import type { TerminalMediaTransfer } from './media-transfer.js';

/** The established media:fetch response lets old GUI clients use inline bytes,
 * native file peers, or authenticated OSS without a terminal-only protocol. */
export async function fetchMedia(browser: TerminalFileBrowser, transfer: TerminalMediaTransfer, input: unknown, context: InvocationContext,
  authorizeShared?: (url:string,file:string,sessionId:string)=>Promise<void>) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_MEDIA_ARGUMENT');
  const request = input as Record<string, unknown>;
  if (typeof request.url !== 'string') throw new Error('INVALID_MEDIA_ARGUMENT');
  const check = () => { context.signal?.throwIfAborted(); context.assertCurrent?.(); };
  const source = await browser.openMedia(request.url, { assertCurrent: check });
  try {
    if(context.sharedTask){if(!authorizeShared)throw new Error('SHARED_TASK_MEDIA_SCOPE_REQUIRED');await authorizeShared(request.url,source.path,context.sharedTask.sessionId);}
    check(); const before = await source.handle.stat();
    const versionOf = (info: typeof before) => createHash('sha256').update(JSON.stringify([source.path,info.size,info.mtimeMs,info.ctimeMs,info.ino])).digest('hex');
    const metadata = { ossKey: '', size: before.size, mimeType: source.mimeType, version: versionOf(before) };
    if (request.prepareOnly === true || request.metadataOnly === true) {
      if (request.metadataOnly === true || before.size > FILE_INLINE_MAX_BYTES) return { ...metadata, transferRequired: true };
      const bytes = Buffer.alloc(before.size); let offset = 0;
      while (offset < bytes.length) {
        check(); const part = await source.handle.read(bytes,offset,bytes.length-offset,offset);
        if (!part.bytesRead) throw new Error('MEDIA_FILE_CHANGED'); offset += part.bytesRead;
      }
      check(); if (versionOf(await source.handle.stat()) !== metadata.version) throw new Error('MEDIA_FILE_CHANGED');
      return { ...metadata, inlineBase64: bytes.toString('base64') };
    }
    const uploaded = await transfer.upload(source.handle,source.mimeType,path.basename(source.path),context);
    return { ...metadata, ossKey: uploaded.key, size: uploaded.size, sha256: uploaded.sha256 };
  } finally { await source.handle.close(); }
}
