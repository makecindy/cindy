
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { requestSizeBudgetAfterRejection, requestSizeModelFamily, countInlineRequestImages, hasRequestMediaMarkers, DEFAULT_REQUEST_SIZE_TRIGGER, controlRequestSize, recoverInlineAttachments, type ImageRouteInfo, type InlineImagePreprocessor, type OversizedRequestRecovery, type RequestSizeController } from '@cindy/anthropic-compat-proxy';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { sessions, mediaRefs } from '../localDb/schema.js';
import { addRef, removeRefById } from '../cindy-media/ledger.js';
import { createLogger } from '../logger.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';


export function createAttachmentRecoveryService(ports: {
  getUserDataDir: typeof import('../userDataPath.js').getUserDataDir;
  media: Pick<typeof import('../cindy-media/blobStore.desktop.js'), 'blobUrl' | 'extForMime' | 'resolveSafe'>
    & Pick<typeof import('../cindy-media/ingest.js'), 'ingestMedia'>
    & Pick<typeof import('../cindy-media/refCompensationJournal.desktop.js'), 'captureMediaRefCompensationScope' | 'withMediaRefCompensation'>;
}) {
const { getUserDataDir } = ports;
const log = createLogger('request-size-control');
const { blobUrl, extForMime, resolveSafe, ingestMedia, captureMediaRefCompensationScope, withMediaRefCompensation } = ports.media;


async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// Non-media attachments retain the legacy hook-attachments path, validation and
// no-overwrite semantics. Only files created by this recovery may be rolled back.
async function persistNonMediaAttachment(
  item: { source: string; file: string; hash: string },
  createdFiles: string[],
  assertCurrent: () => void,
): Promise<void> {
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

// A retry must not reuse another recovery's uncommitted file or reference.
const recoveryLocks = new Map<string, Promise<unknown>>();
const deniedRouteMimes = new Map<string, Set<string>>();
async function serializeRecovery<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = recoveryLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(run);
  recoveryLocks.set(key, current);
  try { return await current; }
  finally { if (recoveryLocks.get(key) === current) recoveryLocks.delete(key); }
} function createAttachmentRecovery(
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
          : path.join(getUserDataDir(), 'hook-attachments', sessionId, `${hash}-recovered${ext}`);
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
              await persistNonMediaAttachment(item, createdFiles, assertCurrent);
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

function createRequestSizeController(
  resolveSession: (headers: Record<string, string>) => string | null | undefined,
  preprocessor: InlineImagePreprocessor = { prepare: async () => null },
  resolveProvider?: (headers: Record<string, string>, modelId: string) => string | null | undefined,
): RequestSizeController {
  const controller: RequestSizeController = {
    enabled: () => process.env.XDT_REQUEST_SIZE_CONTROL_DISABLE !== '1',
    format: ctx => ctx.url.includes('/responses') ? 'responses' : ctx.url.includes('/messages') ? 'anthropic' : ctx.url.includes('/chat/completions') ? 'chat' : null,
    route: (ctx, body) => {
      const modelId = typeof body === 'object' && body !== null && typeof (body as { model?: unknown }).model === 'string'
        ? (body as { model: string }).model : undefined;
      const providerId = resolveProvider ? resolveProvider(ctx.headers, modelId ?? '') ?? undefined : ctx.headers['x-cindy-pi-provider-id'];
      const sessionId = resolveSession(ctx.headers) ?? '';
      const prefix = `${sessionId}|${providerId ?? ''}|${ctx.url}|${modelId ?? ''}|`;
      const denied = new Set<string>();
      for (const [key, mimes] of deniedRouteMimes) if (key.startsWith(prefix)) for (const mime of mimes) denied.add(mime);
      return { endpoint: ctx.url, providerId, modelId, deniedMimeTypes: [...denied] };
    },
    preprocessor,
    retry: async (body, error, ctx, signal) => {
      if (controller.enabled?.() === false) return null;
      const parsedHint = (() => {
        const match = /"model"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(body.toString('utf8', 0, Math.min(body.length, 64 * 1024)));
        return match ? { model: JSON.parse(`"${match[1]}"`) } : {};
      })();
      const format = controller.format?.(ctx, parsedHint);
      if (!format) return null;
      const route = controller.route?.(ctx, parsedHint) ?? {};
      const sessionId = resolveSession(ctx.headers) ?? '';
      const routeKey = `${sessionId}|${route.providerId ?? ''}|${route.endpoint ?? ''}|${route.modelId ?? ''}|${format}`;
      if (error.kind === 'unsupported-image-format') {
        const denied = deniedRouteMimes.get(routeKey) ?? new Set<string>();
        denied.add('image/webp');
        deniedRouteMimes.set(routeKey, denied);
      }
      route.deniedMimeTypes = [...(deniedRouteMimes.get(routeKey) ?? [])];
      const budget = requestSizeBudgetAfterRejection(undefined, error,
        { bytes: body.length, images: countInlineRequestImages(body, format) }, requestSizeModelFamily(route.modelId));
      const result = await controller.control(body, format, {
        route,
        signal,
        context: ctx,
        ...budget,
        reason: `retry:${error.kind}`,
        allowRemoval: error.kind !== 'unsupported-image-format',
      });
      // Only the proxy sees the retried response. It commits size rules after
      // success; generating a body here must never teach a route a new budget.
      return result?.body ?? null;
    },
    control: async (body, format, policy) => {
      // Ordinary text traffic must not touch session storage, scratch directories
      // or INFO logging. Do this before resolving any attachment ownership.
      if (!hasRequestMediaMarkers(body)) {
        // Text cannot be offloaded. Retain the route's byte ceiling without
        // consulting ownership or storage; the kill switch keeps legacy limits.
        if (controller.enabled?.() !== false && policy.allowRemoval !== false
          && body.length > (policy.triggerBytes ?? DEFAULT_REQUEST_SIZE_TRIGGER)) {
          throw new Error('REQUEST_TEXT_TOO_LARGE');
        }
        return null;
      }
      let imageCount = 0;
      const countingPreprocessor: InlineImagePreprocessor = {
        prepare: input => {
          if (input.mimeType.startsWith('image/')) imageCount++;
          return preprocessor.prepare(input);
        },
        tighten: preprocessor.tighten?.bind(preprocessor),
      };
      const skipped = (reason: string, error?: unknown) => log.info('request size control skipped', {
        reqId: policy.context?.reqId,
        reason,
        originalBytes: body.length,
        imageCount: error === undefined ? imageCount : countInlineRequestImages(body, format),
        ...(error === undefined ? {} : { errorType: error instanceof TypeError ? 'TypeError'
          : error instanceof SyntaxError ? 'SyntaxError' : error instanceof RangeError ? 'RangeError'
          : error instanceof Error ? 'Error' : typeof error }),
      });
      const compressOnly = async (reason: string) => {
        const result = await controlRequestSize(body, format,
          { ...policy, preprocessor: countingPreprocessor, allowRemoval: false },
          async () => { throw new Error('Image preservation unavailable'); });
        skipped(reason);
        return result;
      };
      try {
        // Session resolution is performed by the existing recovery callback. The size controller
        // keeps persistence scoped to the current DB owner and never exposes a path to the model.
        const snapshot = getCurrentDbClientSnapshot();
        if (!snapshot) return await compressOnly('no-db');
        const db = snapshot.client.drizzle;
        const sessionId = resolveSession(policy.context?.headers ?? {});
        if (!sessionId || !/^[\w-]+$/.test(sessionId)) return await compressOnly('no-session');
        const session = await db.select({ status: sessions.status, remoteHostId: sessions.remoteHostId })
          .from(sessions).where(eq(sessions.id, sessionId)).get();
        if (!session || session.status === 'deleted') return await compressOnly('session-missing');
        if (session.remoteHostId) return await compressOnly('remote-session');
        const scope = captureMediaRefCompensationScope();
        const assertCurrent = () => {
          policy.signal.throwIfAborted();
          scope.assertStillValid();
          if (getCurrentDbClientSnapshot() !== snapshot || resolveSession(policy.context?.headers ?? {}) !== sessionId) {
            throw new Error('Attachment recovery owner changed');
          }
        };
        // Keep preparation, commit and rollback under the same lock as legacy
        // recovery: another request must not reuse an uncommitted attachment.
        return await serializeRecovery(`${scope.ownerStorageKey}/${sessionId}`, async () => {
          let directory: string | undefined;
          const staged = new Map<string, { source: string; hash: string; mimeType: string | null; refId?: string }>();
          const createdFiles: string[] = [];
          try {
            assertCurrent();
            const route = policy.route as ImageRouteInfo;
            const modelFamily = requestSizeModelFamily(route.modelId);
            const result = await controlRequestSize(
              body, format, { route, modelFamily, signal: policy.signal, preprocessor: countingPreprocessor, singleImageMaxBytes: policy.singleImageMaxBytes, triggerBytes: policy.triggerBytes, targetBytes: policy.targetBytes, triggerImages: policy.triggerImages, targetImages: policy.targetImages, reason: policy.reason, allowRemoval: policy.allowRemoval },
              async (bytes, declaredMime, index) => {
                assertCurrent();
                const hash = createHash('sha256').update(bytes).digest('hex');
                const mimeType = sniffMediaMime(bytes.subarray(0, 64 * 1024), declaredMime);
                const ext = mimeType ? extForMime(mimeType)! : bytes.subarray(0, 5).toString() === '%PDF-' ? '.pdf' : '.bin';
                const destination = mimeType
                  ? resolveSafe(blobUrl(hash, ext)).absPath
                  : path.join(getUserDataDir(), 'hook-attachments', sessionId, `${hash}-recovered${ext}`);
                directory ??= await mkdtemp(path.join(tmpdir(), 'cindy-request-size-'));
                const source = path.join(directory, `${index}-${hash}${ext}`);
                await writeFile(source, bytes, { flag: 'wx', mode: 0o600 });
                if (!staged.has(destination)) {
                  const existing = mimeType ? await db.select({ id: mediaRefs.id }).from(mediaRefs)
                    .where(and(eq(mediaRefs.hash, hash), eq(mediaRefs.refKind, 'session-attachment'), eq(mediaRefs.refId, sessionId))).get() : null;
                  staged.set(destination, { source, hash, mimeType, refId: mimeType && !existing ? randomUUID() : undefined });
                }
                assertCurrent();
                return destination;
              },
            );
            if (!result) return null;
            const persist = async () => {
              for (const [destination, item] of staged) {
                assertCurrent();
                if (item.mimeType) {
                  const media = await ingestMedia({ filePath: item.source, mimeType: item.mimeType, isCache: false,
                    refs: [], assertStillValid: assertCurrent, refCompensationScope: scope }, db);
                  assertCurrent();
                  if (resolveSafe(media.url).absPath !== destination) throw new Error('Recovered attachment path changed');
                  if (item.refId) await addRef({ id: item.refId, hash: item.hash, refKind: 'session-attachment', refId: sessionId,
                    originSessionId: sessionId, originKind: 'user' }, db);
                } else await persistNonMediaAttachment({ ...item, file: destination }, createdFiles, assertCurrent);
                assertCurrent();
              }
            };
            const refIds = [...staged.values()].flatMap(item => item.refId ? [item.refId] : []);
            if (refIds.length) {
              await withMediaRefCompensation({ scope: { ...scope, assertStillValid: assertCurrent }, refIds,
                perform: persist, compensate: id => removeRefById(id, db) });
            } else await persist();
            return result;
          } catch (error) {
            await Promise.all(createdFiles.map(file => rm(file, { force: true })));
            throw error;
          } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'REQUEST_TEXT_TOO_LARGE') throw error;
        skipped('error', error);
        return null;
      }
    },
  };
  return controller;
}

return { createAttachmentRecovery, createRequestSizeController };
}
