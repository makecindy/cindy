import { app } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { recoverInlineAttachments, type OversizedRequestRecovery } from '@cindy/anthropic-compat-proxy';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { sessions, mediaRefs } from '../localDb/schema.js';
import { captureMediaRefCompensationScope, withMediaRefCompensation } from '../cindy-media/refCompensationJournal.js';
import { ingestMedia } from '../cindy-media/ingest.js';
import { blobUrl, extForMime, resolveSafe } from '../cindy-media/blobStore.js';
import { addRef, removeRefById } from '../cindy-media/ledger.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// A retry must not reuse another recovery's uncommitted file or reference.
const recoveryLocks = new Map<string, Promise<unknown>>();
async function serializeRecovery<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = recoveryLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(run);
  recoveryLocks.set(key, current);
  try { return await current; }
  finally { if (recoveryLocks.get(key) === current) recoveryLocks.delete(key); }
}

/** All three local harnesses share this overflow-only recovery and storage lifecycle. */
export function createAttachmentRecovery(
  resolveSession: (headers: Record<string, string>) => string | null | undefined,
): OversizedRequestRecovery {
  return ctx => {
    if (!/\/(?:responses(?:\/compact)?|messages|chat\/completions)(?:\?|$)/.test(ctx.url)) return null;
    const sessionId = resolveSession(ctx.headers);
    if (!sessionId || !/^[\w-]+$/.test(sessionId)) return null;
    const snapshot = getCurrentDbClientSnapshot();
    if (!snapshot) return null;
    const scope = captureMediaRefCompensationScope();
    const db = snapshot.client.drizzle;
    const assertCurrent = () => {
      scope.assertStillValid();
      if (getCurrentDbClientSnapshot() !== snapshot || resolveSession(ctx.headers) !== sessionId) {
        throw new Error('Attachment recovery owner changed');
      }
    };
    return (body, targetBytes) => serializeRecovery(`${scope.ownerStorageKey}/${sessionId}`, async () => {
      assertCurrent();
      const session = await db.select({ status: sessions.status, remoteHostId: sessions.remoteHostId })
        .from(sessions).where(eq(sessions.id, sessionId)).get();
      assertCurrent();
      // A Desktop path must never be presented as a path on an SSH host.
      if (!session || session.status === 'deleted' || session.remoteHostId) return null;
      const staged = new Map<string, { source: string; file: string; hash: string; mimeType: string | null; refId?: string }>();
      return recoverInlineAttachments(body, targetBytes, { prepare: async attachment => {
        body.signal.throwIfAborted();
        assertCurrent();
        const probe = Buffer.alloc(64 * 1024);
        const handle = await open(attachment.filePath, 'r');
        let bytesRead: number;
        try { ({ bytesRead } = await handle.read(probe, 0, probe.length, 0)); }
        finally { await handle.close(); }
        assertCurrent();
        const mimeType = sniffMediaMime(probe.subarray(0, bytesRead), attachment.mimeType);
        const hash = await hashFile(attachment.filePath);
        body.signal.throwIfAborted();
        assertCurrent();
        const ext = mimeType ? extForMime(mimeType)! : probe.subarray(0, 5).toString() === '%PDF-' ? '.pdf' : '.bin';
        const file = mimeType
          ? resolveSafe(blobUrl(hash, ext)).absPath
          : path.join(app.getPath('userData'), 'hook-attachments', sessionId, `${hash}-recovered${ext}`);
        if (!staged.has(file)) {
          const existing = mimeType ? await db.select({ id: mediaRefs.id }).from(mediaRefs)
            .where(and(eq(mediaRefs.hash, hash), eq(mediaRefs.refKind, 'session-attachment'), eq(mediaRefs.refId, sessionId))).get() : null;
          assertCurrent();
          staged.set(file, { source: attachment.filePath, file, hash, mimeType, refId: mimeType && !existing ? randomUUID() : undefined });
        }
        return file;
      }, commit: async () => {
        const createdFiles: string[] = [];
        const persist = async () => {
          for (const item of staged.values()) {
            body.signal.throwIfAborted();
            assertCurrent();
            if (item.mimeType) {
              const media = await ingestMedia({ filePath: item.source, mimeType: item.mimeType, isCache: false,
                refs: [], assertStillValid: assertCurrent, refCompensationScope: scope }, db);
              assertCurrent();
              if (resolveSafe(media.url).absPath !== item.file) throw new Error('Recovered attachment path changed');
              if (item.refId) {
                await addRef({ id: item.refId, hash: item.hash, refKind: 'session-attachment', refId: sessionId,
                  originSessionId: sessionId, originKind: 'user' }, db);
              }
            } else {
              const dir = path.dirname(item.file);
              const root = path.dirname(dir);
              await mkdir(dir, { recursive: true, mode: 0o700 });
              assertCurrent();
              if ((await lstat(root)).isSymbolicLink() || (await lstat(dir)).isSymbolicLink() || path.dirname(await realpath(dir)) !== await realpath(root)) {
                throw new Error('Invalid attachment directory');
              }
              try {
                await copyFile(item.source, item.file, constants.COPYFILE_EXCL);
                createdFiles.push(item.file);
              } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
              const stat = await lstat(item.file);
              if (!stat.isFile() || stat.isSymbolicLink() || await hashFile(item.file) !== item.hash) {
                throw new Error('Recovered attachment verification failed');
              }
            }
            body.signal.throwIfAborted();
            assertCurrent();
          }
        };
        const refIds = [...staged.values()].flatMap(item => item.refId ? [item.refId] : []);
        try {
          if (refIds.length) {
            await withMediaRefCompensation({ scope: { ...scope, assertStillValid: () => {
              assertCurrent();
              body.signal.throwIfAborted();
            } }, refIds, perform: persist,
              compensate: id => removeRefById(id, db) });
          } else await persist();
        } catch (error) {
          // Only this serialized recovery's new files; never pre-existing/shared blobs.
          await Promise.all(createdFiles.map(file => rm(file, { force: true })));
          throw error;
        }
      }
      });
    });
  };
}
