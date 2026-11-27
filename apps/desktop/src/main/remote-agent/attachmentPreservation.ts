import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reserveAttachmentTransferDisk } from '@cindy/anthropic-compat-proxy';
import { attachmentMimeType, type PreserveAttachment, type PreserveAttachmentBatch } from '../maker-host/attachmentPreservation.js';

export const ATTACHMENT_PRESERVATION_PATH = '/cindy/attachment-preservation';
const CHUNK_BYTES = 512 * 1024;
const IDLE_MS = 60_000;

type Request = Record<string, unknown>;
type Exchange = (request: Request, signal: AbortSignal) => Promise<unknown>;

function preservedPath(reply: unknown): string {
  const file = (reply as { path?: unknown } | null)?.path;
  if (typeof file !== 'string' || (!path.posix.isAbsolute(file) && !path.win32.isAbsolute(file))) {
    throw new Error('Attachment preservation returned an invalid path');
  }
  return file;
}

/** Only removed attachments cross the existing authenticated reverse HTTP lane. */
export function remoteAttachmentPreservation(exchange: Exchange, assertCurrent: () => void): PreserveAttachmentBatch {
  return async (signal, operation) => {
    const id = randomUUID();
    let begun = false;
    const send = async (request: Request, requestSignal = signal) => {
      assertCurrent();
      requestSignal.throwIfAborted();
      const result = await exchange({ ...request, id }, requestSignal);
      assertCurrent();
      requestSignal.throwIfAborted();
      return result;
    };
    try {
      const result = await operation(async (bytes, mimeType, index) => {
        if (!begun) {
          // Mark before awaiting: an unknown begin receipt still needs cleanup.
          begun = true;
          await send({ action: 'begin' });
        }
        const found = await send({ action: 'find', hash: createHash('sha256').update(bytes).digest('hex'),
          mimeType: attachmentMimeType(bytes, mimeType) });
        if (found && (found as { path?: unknown }).path != null) return preservedPath(found);
        for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
          await send({ action: 'chunk', index, offset, data: bytes.subarray(offset, offset + CHUNK_BYTES).toString('base64') });
        }
        const reply = await send({ action: 'prepare', index, bytes: bytes.length, mimeType });
        return preservedPath(reply);
      });
      if (result !== null && begun) await send({ action: 'commit' });
      return result;
    } finally {
      // No write replay after uncertain delivery. The receiver also owns timeout/close cleanup.
      if (begun) await exchange({ action: 'abort', id }, AbortSignal.timeout(5000)).catch(() => undefined);
    }
  };
}

interface Batch {
  abort: AbortController;
  ready: Promise<PreserveAttachment>;
  finish(commit: boolean): void;
  done: Promise<unknown>;
  tail: Promise<unknown>;
  timer?: ReturnType<typeof setTimeout>;
  directory?: string;
  index?: number;
  bytes: number;
  prepared: Set<number>;
  committing?: boolean;
  releaseDisk: Array<() => void>;
}

/**
 * The receiving task is captured locally. Neither session IDs nor destinations
 * are accepted from the provider. The normal media keeper owns publication,
 * compensation, account checks and eventual task deletion.
 */
export function createAttachmentPreservationReceiver(
  preserveBatch: PreserveAttachmentBatch,
  projectPath: (file: string) => Promise<string>,
) {
  const batches = new Map<string, Batch>();
  let closed = false;
  const release = async (id: string, batch: Batch) => {
    clearTimeout(batch.timer);
    batch.abort.abort();
    batch.finish(false);
    await batch.tail.catch(() => undefined);
    await batch.done.catch(() => undefined);
    try { if (batch.directory) await rm(batch.directory, { recursive: true, force: true }); }
    finally {
      for (const releaseDisk of batch.releaseDisk.splice(0)) releaseDisk();
      if (batches.get(id) === batch) batches.delete(id);
    }
  };
  const arm = (id: string, batch: Batch) => {
    clearTimeout(batch.timer);
    batch.timer = setTimeout(() => { void release(id, batch).catch(() => undefined); }, IDLE_MS);
    batch.timer.unref();
  };
  const handle = async (value: unknown, signal?: AbortSignal): Promise<unknown> => {
    if (closed) throw new Error('Attachment preservation closed');
    signal?.throwIfAborted();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid attachment request');
    const request = value as Request;
    const { id, action } = request;
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid attachment batch');
    if (action === 'abort') {
      const batch = batches.get(id);
      if (batch) await release(id, batch);
      return {};
    }
    if (action === 'begin') {
      if (batches.has(id) || batches.size >= 4) throw new Error('Attachment preservation busy');
      const abort = new AbortController();
      let ready!: (preserve: PreserveAttachment) => void;
      let failed!: (error: unknown) => void;
      const prepared = new Promise<PreserveAttachment>((resolve, reject) => { ready = resolve; failed = reject; });
      let finish!: (commit: boolean) => void;
      const completion = new Promise<boolean>(resolve => { finish = resolve; });
      const batch: Batch = { abort, ready: prepared, finish, bytes: 0, prepared: new Set<number>(),
        tail: Promise.resolve(), done: Promise.resolve(), releaseDisk: [] };
      batch.done = preserveBatch(abort.signal, async preserve => {
        ready(preserve);
        return await completion ? true : null;
      });
      // Capture rejection immediately, including owner changes while waiting for the store lock.
      void batch.done.catch(failed);
      batches.set(id, batch);
      arm(id, batch);
      const cancel = () => { void release(id, batch).catch(() => undefined); };
      signal?.addEventListener('abort', cancel, { once: true });
      try { await prepared; signal?.throwIfAborted(); return {}; }
      catch (error) { await release(id, batch); throw error; }
      finally { signal?.removeEventListener('abort', cancel); }
    }
    const batch = batches.get(id);
    if (!batch) throw new Error('Attachment batch missing');
    const run = async () => {
      const current = () => { batch.abort.signal.throwIfAborted(); signal?.throwIfAborted(); };
      current();
      arm(id, batch);
      if (batch.committing) throw new Error('Attachment batch already committed');
      if (action === 'commit') {
        if (batch.index !== undefined) throw new Error('Unfinished attachment');
        batch.committing = true;
        batch.finish(true);
        await batch.done;
        current();
        return {};
      }
      if (action === 'find') {
        if (typeof request.hash !== 'string' || !/^[a-f0-9]{64}$/.test(request.hash)
          || typeof request.mimeType !== 'string' || request.mimeType.length > 128) throw new Error('Invalid attachment lookup');
        const preserve = await batch.ready;
        const file = await preserve.find?.(request.hash, request.mimeType);
        current();
        const projected = file ? await projectPath(file) : null;
        current();
        return { path: projected };
      }
      const { index } = request;
      if (!Number.isSafeInteger(index) || (index as number) < 0 || batch.prepared.has(index as number)) throw new Error('Invalid attachment index');
      if (batch.index !== undefined && batch.index !== index) throw new Error('Unfinished attachment');
      if (action === 'chunk') {
        const { data, offset } = request;
        if (offset !== batch.bytes || typeof data !== 'string' || !data.length || data.length > Math.ceil(CHUNK_BYTES / 3) * 4) throw new Error('Invalid attachment chunk');
        const bytes = Buffer.from(data, 'base64');
        if (bytes.toString('base64') !== data || bytes.length > CHUNK_BYTES) throw new Error('Invalid attachment encoding');
        // Incoming chunk, staged keeper copy and publication share the normal
        // process-wide recovery admission budget, including allocation overhead.
        batch.releaseDisk.push(await reserveAttachmentTransferDisk((bytes.length + 8192) * 4));
        current();
        batch.directory ??= await mkdtemp(path.join(tmpdir(), 'cindy-remote-attachment-'));
        current();
        await appendFile(path.join(batch.directory, String(index)), bytes, { mode: 0o600 });
        current();
        batch.index = index as number;
        batch.bytes += bytes.length;
        return {};
      }
      if (action === 'prepare') {
        const { mimeType } = request;
        if (!batch.directory || batch.index !== index || request.bytes !== batch.bytes || typeof mimeType !== 'string' || mimeType.length > 128) throw new Error('Invalid attachment');
        const source = path.join(batch.directory, String(index));
        const bytes = await readFile(source);
        current();
        const preserve = await batch.ready;
        const file = await preserve(bytes, mimeType, index as number);
        current();
        const projected = await projectPath(file);
        current();
        await rm(source);
        batch.prepared.add(index as number);
        batch.index = undefined;
        batch.bytes = 0;
        return { path: projected };
      }
      throw new Error('Invalid attachment action');
    };
    const cancel = () => { batch.abort.abort(); batch.finish(false); };
    signal?.addEventListener('abort', cancel, { once: true });
    const pending = batch.tail.then(run);
    batch.tail = pending.catch(() => undefined);
    try { return await pending; }
    catch (error) { await release(id, batch); throw error; }
    finally { signal?.removeEventListener('abort', cancel); }
  };
  return {
    handle,
    async dispose() {
      closed = true;
      await Promise.all([...batches].map(([id, batch]) => release(id, batch)));
    },
  };
}
