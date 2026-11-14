
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { controlRequestSize, recoverInlineAttachments, type ImageRouteInfo, type InlineImagePreprocessor, type OversizedRequestRecovery, type RequestSizeController } from '@cindy/anthropic-compat-proxy';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { sessions, mediaRefs } from '../localDb/schema.js';
import { addRef, removeRefById } from '../cindy-media/ledger.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';


export function createAttachmentRecoveryService(ports: {
  getUserDataDir: typeof import('../userDataPath.js').getUserDataDir;
  media: Pick<typeof import('../cindy-media/blobStore.desktop.js'), 'blobUrl' | 'extForMime' | 'resolveSafe'>
    & Pick<typeof import('../cindy-media/ingest.js'), 'ingestMedia'>
    & Pick<typeof import('../cindy-media/refCompensationJournal.desktop.js'), 'captureMediaRefCompensationScope' | 'withMediaRefCompensation'>;
}) {
const { getUserDataDir } = ports;
const { blobUrl, extForMime, resolveSafe, ingestMedia, captureMediaRefCompensationScope, withMediaRefCompensation } = ports.media;


async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// A retry must not reuse another recovery's uncommitted file or reference.
const recoveryLocks = new Map<string, Promise<unknown>>();
const learnedRequestBudgets = new Map<string, { trigger: number; target: number }>();
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

function createRequestSizeController(
  resolveSession: (headers: Record<string, string>) => string | null | undefined,
  preprocessor: InlineImagePreprocessor = { prepare: async () => null },
): RequestSizeController {
  const controller: RequestSizeController = {
    enabled: () => process.env.XDT_REQUEST_SIZE_CONTROL_DISABLE !== '1',
    format: ctx => ctx.url.includes('/responses') ? 'responses' : ctx.url.includes('/messages') ? 'anthropic' : ctx.url.includes('/chat/completions') ? 'chat' : null,
    route: (ctx, body) => {
      const providerId = ctx.headers['x-cindy-pi-provider-id'] ?? ctx.headers['x-cindy-provider-id'] ?? ctx.headers['x-openai-provider-id'];
      const modelId = typeof body === 'object' && body !== null && typeof (body as { model?: unknown }).model === 'string'
        ? (body as { model: string }).model : undefined;
      const sessionId = resolveSession(ctx.headers) ?? '';
      const prefix = `${sessionId}|${providerId ?? ''}|${ctx.url}|${modelId ?? ''}|`;
      const denied = new Set<string>();
      for (const [key, mimes] of deniedRouteMimes) if (key.startsWith(prefix)) for (const mime of mimes) denied.add(mime);
      return { endpoint: ctx.url, providerId, modelId, deniedMimeTypes: [...denied] };
    },
    preprocessor,
    retry: async (body, error, ctx, signal) => {
      const parsedHint = (() => {
        const match = /"model"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(body.toString('utf8', 0, Math.min(body.length, 64 * 1024)));
        return match ? { model: JSON.parse(`"${match[1]}"`) } : {};
      })();
      const format = controller.format?.(ctx, parsedHint);
      if (!format) return null;
      const route = controller.route?.(ctx, parsedHint) ?? {};
      const sessionId = resolveSession(ctx.headers) ?? '';
      const routeKey = `${sessionId}|${route.providerId ?? ''}|${route.endpoint ?? ''}|${route.modelId ?? ''}|${format}`;
      route.deniedMimeTypes = [...(deniedRouteMimes.get(routeKey) ?? [])];
      const limit = error.limitBytes ?? body.length;
      const result = await controller.control(body, format, {
        route,
        signal,
        context: ctx,
        triggerBytes: limit,
        targetBytes: Math.max(1, Math.floor(limit * 0.44)),
        singleImageMaxBytes: error.kind === 'single-image-too-large' ? error.limitBytes : undefined,
        reason: `retry:${error.kind}`,
        allowRemoval: true,
      });
      if (result) {
        const model = typeof parsedHint.model === 'string' ? parsedHint.model : '';
        const key = `${sessionId}|${route.providerId ?? ''}|${route.endpoint ?? ''}|${model}|${format}`;
        learnedRequestBudgets.set(key, { trigger: limit, target: Math.max(1, Math.floor(limit * 0.44)) });
      }
      if (error.kind === 'unsupported-image-format') {
        const denied = deniedRouteMimes.get(routeKey) ?? new Set<string>();
        denied.add('image/webp');
        deniedRouteMimes.set(routeKey, denied);
      }
      return result?.body ?? null;
    },
    control: async (body, format, policy) => {
      // Session resolution is performed by the existing recovery callback. The size controller
      // keeps persistence scoped to the current DB owner and never exposes a path to the model.
      const snapshot = getCurrentDbClientSnapshot();
      if (!snapshot) return null;
      const scope = captureMediaRefCompensationScope();
      const db = snapshot.client.drizzle;
      const sessionId = resolveSession(policy.context?.headers ?? {});
      if (!sessionId || !/^[\w-]+$/.test(sessionId)) return null;
      const session = await db.select({ status: sessions.status, remoteHostId: sessions.remoteHostId })
        .from(sessions).where(eq(sessions.id, sessionId)).get();
      if (!session || session.status === 'deleted' || session.remoteHostId) return null;
      const assertCurrent = () => {
        scope.assertStillValid();
        if (getCurrentDbClientSnapshot() !== snapshot || resolveSession(policy.context?.headers ?? {}) !== sessionId) {
          throw new Error('Attachment recovery owner changed');
        }
      };
      const directory = await mkdtemp(path.join(tmpdir(), 'cindy-request-size-'));
      const staged = new Map<string, { source: string; hash: string; mimeType: string; refId?: string }>();
      try {
        const route = policy.route as ImageRouteInfo;
        const model = route.modelId?.toLowerCase() ?? '';
        const modelFamily = /(?:^|[/_-])(?:gpt|o[1-9]|codex)(?:[/_.-]|$)/.test(model)
          ? 'gpt' : model.includes('claude') ? 'claude' : 'other';
        const modelKey = route.modelId ?? '';
        const budgetKey = `${sessionId}|${route.providerId ?? ''}|${route.endpoint ?? ''}|${modelKey}|${format}`;
        const learned = learnedRequestBudgets.get(budgetKey);
        const result = await serializeRecovery(`${scope.ownerStorageKey}/${sessionId}`, async () => controlRequestSize(
          body, format, { route, modelFamily, signal: policy.signal, preprocessor, singleImageMaxBytes: policy.singleImageMaxBytes, triggerBytes: policy.triggerBytes ?? learned?.trigger, targetBytes: policy.targetBytes ?? learned?.target, reason: policy.reason, allowRemoval: policy.allowRemoval },
          async (bytes, mimeType, index) => {
            const hash = createHash('sha256').update(bytes).digest('hex');
            const ext = extForMime(mimeType) ?? '.bin';
            const destination = resolveSafe(blobUrl(hash, ext)).absPath;
            const source = path.join(directory, `${index}-${hash}${ext}`);
            await writeFile(source, bytes, { flag: 'wx', mode: 0o600 });
            if (!staged.has(destination)) {
              const existing = await db.select({ id: mediaRefs.id }).from(mediaRefs)
                .where(and(eq(mediaRefs.hash, hash), eq(mediaRefs.refKind, 'session-attachment'), eq(mediaRefs.refId, sessionId))).get();
              staged.set(destination, { source, hash, mimeType, refId: existing ? undefined : randomUUID() });
            }
            return destination;
          },
        ));
        if (!result) return null;
        for (const [destination, item] of staged) {
          const media = await ingestMedia({ filePath: item.source, mimeType: item.mimeType, isCache: false,
            refs: [], assertStillValid: assertCurrent, refCompensationScope: scope }, db);
          if (resolveSafe(media.url).absPath !== destination) throw new Error('Recovered attachment path changed');
          if (item.refId) await addRef({ id: item.refId, hash: item.hash, refKind: 'session-attachment', refId: sessionId,
            originSessionId: sessionId, originKind: 'user' }, db);
        }
        return result;
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
  };
  return controller;
}

return { createAttachmentRecovery, createRequestSizeController };
}
