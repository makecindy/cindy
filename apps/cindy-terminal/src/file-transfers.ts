import path from 'node:path';
import { open, rm } from 'node:fs/promises';
import { FILE_INLINE_MAX_BYTES } from '@cindy/device-link';
import type { TerminalFilePeerService } from './remote/files.js';
import type { TerminalMediaTransfer } from './media-transfer.js';
import type { InvocationContext } from './contracts.js';

interface DownloadOptions {
  files: Pick<TerminalFilePeerService, 'receive'>;
  media: Pick<TerminalMediaTransfer, 'download'>;
  invokeRemote(device: string, channel: string, args: unknown[]): Promise<unknown>;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_MEDIA_RESPONSE');
  return value as Record<string, unknown>;
};

/** Local, explicit file export. Remote hosts authorize the URL through their
 * normal media/file-peer entry points; this end only creates a new destination. */
export async function downloadRemoteFile(options: DownloadOptions, args: unknown[], context: InvocationContext) {
  if (context.source !== 'local' || context.sharedTask) throw new Error('LOCAL_ONLY_COMMAND');
  const [device, url, target] = args;
  if (typeof device !== 'string' || !device || typeof url !== 'string' || !url || typeof target !== 'string' || !target)
    throw new Error('INVALID_ARGUMENT');
  const destination = path.resolve(target);
  const check = () => { context.signal?.throwIfAborted(); context.assertCurrent?.(); };
  check();
  let opened = false;
  try {
    return await options.files.receive(device, url, async metadata => {
      check(); const handle = await open(destination, 'wx', 0o600); opened = true;
      let offset = 0;
      return {
        async write(at, bytes) {
          check(); if (at !== offset || at + bytes.byteLength > metadata.size) throw new Error('INVALID_FILE_OFFSET');
          let written = 0;
          while (written < bytes.byteLength) {
            check(); const result = await handle.write(bytes, written, bytes.byteLength - written, at + written);
            if (!result.bytesWritten) throw new Error('FILE_WRITE_FAILED'); written += result.bytesWritten;
          }
          offset += written;
        },
        async finish() { check(); if (offset !== metadata.size) throw new Error('FILE_SIZE_MISMATCH'); await handle.sync(); check(); await handle.close(); return { path: destination, size: offset, mimeType: metadata.mimeType }; },
        async abort() { await handle.close().catch(() => {}); await rm(destination, { force: true }); },
      };
    }, context.signal);
  } catch (error) {
    check();
    // An open/write failure belongs to this explicit destination, not to peer
    // negotiation. Do not retry it through another transport.
    if (opened || (error as NodeJS.ErrnoException)?.code === 'EEXIST') throw error;
  }
  const prepared = object(await options.invokeRemote(device, 'device-link:media:fetch', [{ url, prepareOnly: true }])); check();
  if (typeof prepared.inlineBase64 === 'string') {
    if (!Number.isSafeInteger(prepared.size) || (prepared.size as number) < 0 || (prepared.size as number) > FILE_INLINE_MAX_BYTES
      || prepared.inlineBase64.length > Math.ceil(FILE_INLINE_MAX_BYTES / 3) * 4 + 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(prepared.inlineBase64)) throw new Error('INVALID_MEDIA_RESPONSE');
    const bytes = Buffer.from(prepared.inlineBase64, 'base64');
    if (bytes.length !== prepared.size) throw new Error('FILE_SIZE_MISMATCH');
    const handle = await open(destination, 'wx', 0o600);
    try { check(); await handle.writeFile(bytes); await handle.sync(); check(); }
    catch (error) { await handle.close().catch(() => {}); await rm(destination, { force: true }); throw error; }
    finally { await handle.close().catch(() => {}); }
    return { path: destination, size: bytes.length, mimeType: prepared.mimeType };
  }
  const transfer = object(await options.invokeRemote(device, 'device-link:media:fetch', [{ url }])); check();
  if (typeof transfer.ossKey !== 'string' || !transfer.ossKey || !Number.isSafeInteger(transfer.size)
    || (transfer.size as number) < 0 || typeof transfer.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(transfer.sha256)) throw new Error('INVALID_MEDIA_RESPONSE');
  await options.media.download(transfer.ossKey, destination, { size: transfer.size as number, sha256: transfer.sha256 }, check, context.signal);
  check(); return { path: destination, size: transfer.size, mimeType: transfer.mimeType };
}
