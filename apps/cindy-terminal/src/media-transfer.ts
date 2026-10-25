import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rm, type FileHandle } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { buildLegacyAttachmentOssRef, parseAttachmentOssRef, parsePeerAttachmentRef, type AttachmentIntegrity } from '@cindy/device-link';
import { createPeerAttachmentStore } from '@cindy/remote-agent/peerAttachmentStore';
import type { InvocationContext } from './contracts.js';

const MAX_BYTES = 2 * 1024 ** 3;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_MEDIA_RESPONSE');
  return value as Record<string, unknown>;
};
export interface MaterializedAttachment {
  path: string; mimeType?: string; name?: string;
  cleanup(): Promise<void>;
  afterAcceptance?(): Promise<void>;
}
interface Options {
  ownerDir: string;
  getOwnerScope(): string | null;
  getToken(): Promise<string | null>;
  getApiBaseUrl(): string;
  fetch?: typeof fetch;
}
/** Existing device-link OSS wire format and durable peer inbox, without Electron.
 * Downloaded bytes are temporary until the task host adopts them into its store. */
export class TerminalMediaTransfer {
  readonly inbox;
  private readonly fetch: typeof fetch;
  constructor(private readonly options: Options) {
    this.fetch = options.fetch ?? fetch;
    this.inbox = createPeerAttachmentStore({
      root: () => path.join(options.ownerDir, 'peer-attachment-inbox'),
      captureScope: options.getOwnerScope,
      isCurrent: scope => scope !== null && scope === options.getOwnerScope(),
    });
  }
  private check(context?: InvocationContext) {
    const owner = this.options.getOwnerScope();
    if (!owner) throw new Error('AUTH_REQUIRED');
    return () => {
      context?.signal?.throwIfAborted(); context?.assertCurrent?.();
      if (owner !== this.options.getOwnerScope()) throw new Error('OWNER_CHANGED');
    };
  }
  private async api(endpoint: 'presign-get' | 'presign-put' | 'delete', body: unknown, check: () => void, signal?: AbortSignal) {
    check(); const token = await this.options.getToken(); check();
    if (!token) throw new Error('AUTH_REQUIRED');
    const response = await this.fetch(new URL(`/api/device-link/media${endpoint === 'delete' ? '' : `/${endpoint}`}`, this.options.getApiBaseUrl()), {
      method: endpoint === 'delete' ? 'DELETE' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
      redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    try {
      check();
      if (!response.ok) throw new Error(response.status === 401 ? 'AUTH_REQUIRED' : 'MEDIA_TRANSFER_FAILED');
      const result = object(await response.json()); check(); return result;
    } finally { if (!response.bodyUsed) await response.body?.cancel(); }
  }
  private signedUrl(value: unknown): string {
    if (typeof value !== 'string') throw new Error('INVALID_MEDIA_RESPONSE');
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('INVALID_MEDIA_RESPONSE');
    return url.href;
  }
  async remove(key: string, check = this.check()): Promise<void> {
    try { await this.api('delete', { key }, check); } catch { /* OSS lifecycle is the final cleanup. */ }
  }
  private async temp() {
    const root = path.join(this.options.ownerDir, 'attachment-staging');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const file = path.join(root, randomUUID());
    return { file, cleanup: () => rm(file, { force: true }) };
  }
  async resolve(reference: string, context: InvocationContext): Promise<MaterializedAttachment> {
    const check = this.check(context); check();
    const peer = parsePeerAttachmentRef(reference);
    const oss = parseAttachmentOssRef(reference);
    if (!peer && !oss) throw new Error('INVALID_ATTACHMENT_REFERENCE');
    const temp = await this.temp();
    try {
      check();
      if (peer) {
        if (!context.deviceId) throw new Error('FILE_PEER_DENIED');
        await this.inbox.copyFromPeer(context.deviceId, peer, temp.file); check();
        return { path: temp.file, mimeType: peer.mimeType, name: peer.originalName, cleanup: temp.cleanup };
      }
      const ref = oss!;
      await this.download(ref.ossKey, temp.file, ref.size === undefined ? undefined : ref as AttachmentIntegrity, check, context.signal);
      return { path: temp.file, mimeType: ref.mimeType, name: ref.originalName, cleanup: temp.cleanup,
        afterAcceptance: () => this.remove(ref.ossKey, check) };
    } catch (error) { await temp.cleanup(); throw error; }
  }
  async download(key: string, destination: string, expected?: AttachmentIntegrity, check = this.check(), signal?: AbortSignal): Promise<void> {
    const signed = await this.api('presign-get', { key }, check, signal);
    const response = await this.fetch(this.signedUrl(signed.getUrl), { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) });
    try { check(); if (!response.ok || !response.body) throw new Error('MEDIA_DOWNLOAD_FAILED'); }
    catch(error) { await response.body?.cancel(); throw error; }
    const hash = createHash('sha256'); let bytes = 0;
    // Acquire exclusively before marking this path as ours; EEXIST must never
    // remove a user's pre-existing destination during failure cleanup.
    let handle: FileHandle | undefined;
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    try {
      handle = await open(destination, 'wx', 0o600); check();
      for await (const chunk of source) {
        check(); const buffer = Buffer.from(chunk); bytes += buffer.length;
        if (bytes > MAX_BYTES || expected && bytes > expected.size) throw new Error('ATTACHMENT_INTEGRITY_FAILED');
        hash.update(buffer);
        let offset = 0;
        while (offset < buffer.length) {
          check(); const written = await handle.write(buffer, offset, buffer.length - offset);
          if (!written.bytesWritten) throw new Error('FILE_WRITE_FAILED'); offset += written.bytesWritten;
        }
      }
      check(); const sha256 = hash.digest('hex');
      if (expected && (bytes !== expected.size || sha256 !== expected.sha256)) throw new Error('ATTACHMENT_INTEGRITY_FAILED');
      await handle.sync(); check();
    } catch (error) {
      if (handle) { await handle.close().catch(() => {}); await rm(destination, { force: true }); }
      throw error;
    } finally { source.destroy(); await handle?.close().catch(() => {}); }
  }
  async upload(handle: FileHandle, mimeType: string, name: string, context?: InvocationContext): Promise<{ key: string; size: number; sha256: string; contentType: string; reference: string }> {
    const check = this.check(context); check();
    const before = await handle.stat(); check();
    if (!before.isFile() || before.size <= 0 || before.size > MAX_BYTES) throw new Error('INVALID_ATTACHMENT_SIZE');
    const ext = path.extname(name).slice(1).toLowerCase();
    const signed = await this.api('presign-put', { size: before.size, ext: /^[a-z0-9]{1,12}$/.test(ext) ? ext : 'bin', contentType: mimeType,
      ...(context?.sharedTask ? { sharedTaskId: context.sharedTask.sharedTaskId } : {}) }, check, context?.signal);
    if (typeof signed.key !== 'string' || !signed.key) throw new Error('INVALID_MEDIA_RESPONSE');
    let source: Readable | undefined;
    try {
      const hash = createHash('sha256'); let bytes = 0;
      source = handle.createReadStream({ autoClose: false, start: 0 });
      const counter = new Transform({ transform(chunk: Buffer, _encoding, done) {
        try { check(); bytes += chunk.length; if (bytes > before.size) throw new Error('ATTACHMENT_CHANGED'); hash.update(chunk); done(null, chunk); }
        catch (error) { done(error as Error); }
      } });
      source.on('error', error => counter.destroy(error)); source.pipe(counter);
      const response = await this.fetch(this.signedUrl(signed.putUrl), {
        method: 'PUT', headers: { 'content-type': mimeType, 'content-length': String(before.size), 'x-oss-object-acl': 'private' },
        body: Readable.toWeb(counter), duplex: 'half', redirect: 'error',
        signal: context?.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
      } as RequestInit);
      await response.body?.cancel(); check();
      if (!response.ok) throw new Error('MEDIA_UPLOAD_FAILED');
      const after = await handle.stat(); check();
      if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('ATTACHMENT_CHANGED');
      const sha256 = hash.digest('hex');
      return { key: signed.key, size: bytes, sha256, contentType: mimeType,
        reference: buildLegacyAttachmentOssRef({ ossKey: signed.key, size: bytes, sha256, mimeType, originalName: name }) };
    } catch (error) { await this.remove(signed.key, check); throw error; }
    finally { source?.destroy(); }
  }
  async uploadPath(file: string, context?: InvocationContext) {
    const handle = await open(file, 'r');
    try { return await this.upload(handle, 'application/octet-stream', path.basename(file), context); }
    finally { await handle.close(); }
  }
}
