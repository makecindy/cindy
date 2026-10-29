import { createHash } from 'node:crypto';
import type { AgentEvent, GeneratedImageEventData } from '@cindy/maker-core';
import {
  REMOTE_AGENT_CHANNEL,
  REMOTE_AGENT_READ_MAX_BYTES,
  type RemoteAgentRequest,
} from '@cindy/device-link';
import {
  getActiveAppSession,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState';
import { getCurrentDbClientSnapshot } from '../localDb/client/current';
import { captureMediaRefCompensationScope } from './refCompensationJournal';
import {
  createGeneratedImageJournal,
  generatedImageId,
  initialGeneratedImageRecord,
  type GeneratedImageRecord,
  type GeneratedImageUpstream,
} from './generatedImageJournal';
import { generatedImageBytes, readGeneratedImageFile } from './generatedMedia';
import { blobUrl, extForMime, parseBlobUrl, resolveSafe } from './blobStore';
import { ingestMedia } from './ingest';
import {
  hasRef,
  removeRefs,
  removeSessionAttachmentRefIfUnreferencedByLiveMessage,
  withSessionMediaRefLock,
} from './ledger';

export function captureGeneratedImageStorage() {
  const owner = getActiveAppSession();
  const snapshot = getCurrentDbClientSnapshot();
  if (
    !owner.dataOwnerId ||
    !snapshot ||
    snapshot.userId !== owner.dataOwnerId ||
    isAppSessionBoundaryPending()
  )
    throw new Error('HOST_NOT_READY');
  const assertCurrent = () => {
    const active = getActiveAppSession();
    if (
      isAppSessionBoundaryPending() ||
      active.dataOwnerId !== owner.dataOwnerId ||
      active.generation !== owner.generation ||
      getCurrentDbClientSnapshot() !== snapshot
    )
      throw new Error('IMAGE_DELIVERY_SCOPE_CHANGED');
  };
  const journal = createGeneratedImageJournal(
    ownerScopedUserDataPath('cindy-media', 'generated-images-v1'),
    assertCurrent,
  );
  const db = snapshot.client.drizzle;
  const compensation = captureMediaRefCompensationScope();
  const reference = (scope: string, id: string) => ({
    refKind: 'integration-cache' as const,
    refId: `native-image:${createHash('sha256').update(scope).digest('hex')}:${id}`,
  });

  async function read(record: GeneratedImageRecord) {
    assertCurrent();
    if (record.blobUrl) {
      const parsed = parseBlobUrl(record.blobUrl);
      if (!parsed) throw new Error('INVALID_IMAGE_DELIVERY');
      try {
        const bytes = await readGeneratedImageFile(resolveSafe(record.blobUrl).absPath);
        if (createHash('sha256').update(bytes.buffer).digest('hex') !== parsed.hash)
          throw new Error('INVALID_IMAGE');
        assertCurrent();
        return bytes;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // A planned address may precede the atomic blob write. Only retry an owned source.
        if (!record.image.path || record.image.pathOrigin || record.remoteHostId) throw error;
      }
    }
    if (record.image.path && !record.image.pathOrigin && !record.remoteHostId) {
      const bytes = await readGeneratedImageFile(record.image.path);
      if (
        record.blobUrl &&
        createHash('sha256').update(bytes.buffer).digest('hex') !==
          parseBlobUrl(record.blobUrl)?.hash
      )
        throw new Error('IMAGE_DELIVERY_CONFLICT');
      assertCurrent();
      return bytes;
    }
    throw new Error(
      record.image.pathOrigin || record.remoteHostId
        ? 'REMOTE_SOURCE_REQUIRED'
        : 'MEDIA_SOURCE_MISSING',
    );
  }

  async function stage(
    scope: string,
    image: GeneratedImageEventData,
    readSource?: () => Promise<{ buffer: Buffer; mimeType: string }>,
  ) {
    assertCurrent();
    const id = generatedImageId(image);
    let record = await journal.update(
      scope,
      id,
      (previous) => previous ?? initialGeneratedImageRecord(scope, image),
    );
    if (record.state === 'released') {
      await removeRefs(reference(scope, id), db);
      throw new Error('IMAGE_DELIVERY_RELEASED');
    }
    try {
      const nativeBytes = generatedImageBytes(image);
      if (!nativeBytes && image.pathOrigin === 'remote-agent' && !record.blobUrl)
        throw new Error('REMOTE_SOURCE_REQUIRED');
      const readSaved = async () => {
        if (!record.blobUrl && readSource) return readSource();
        try {
          return await read(record);
        } catch (error) {
          if (
            !readSource ||
            image.pathOrigin === 'remote-agent' ||
            ((error as NodeJS.ErrnoException).code !== 'ENOENT' &&
              (error as Error).message !== 'REMOTE_SOURCE_REQUIRED')
          )
            throw error;
          return readSource();
        }
      };
      const bytes = nativeBytes ?? (await readSaved());
      assertCurrent();
      const ext = extForMime(bytes.mimeType);
      if (!ext) throw new Error('INVALID_IMAGE');
      const hash = createHash('sha256').update(bytes.buffer).digest('hex');
      const url = blobUrl(hash, ext);
      // Record the deterministic address before ingestion. If ledger writes fail after
      // writeBlob, recovery can still find the same bytes without generating again.
      record = await journal.update(scope, id, (current) => {
        if (!current || current.state === 'released') throw new Error('IMAGE_DELIVERY_RELEASED');
        if (current.blobUrl && current.blobUrl !== url) throw new Error('IMAGE_DELIVERY_CONFLICT');
        return { ...current, blobUrl: url };
      });
      await withSessionMediaRefLock(db, reference(scope, id).refId, async () => {
        assertCurrent();
        if ((await journal.read(scope, id))?.state === 'released')
          throw new Error('IMAGE_DELIVERY_RELEASED');
        const exists = await hasRef({ hash, ...reference(scope, id) }, db);
        await ingestMedia(
          {
            ...bytes,
            isCache: false,
            assertStillValid: assertCurrent,
            refCompensationScope: compensation,
            refs: exists
              ? []
              : [{ ...reference(scope, id), originKind: 'tool', originId: 'codex-imagegen' }],
          },
          db,
        );
      });
      assertCurrent();
      return { record, ...bytes };
    } catch (error) {
      assertCurrent();
      const code = generatedImageErrorCode(error);
      await journal.update(scope, id, (current) => {
        if (!current || current.state === 'released') throw new Error('IMAGE_DELIVERY_RELEASED');
        return { ...current, state: 'failed', errorCode: code };
      });
      throw error;
    }
  }

  async function release(scope: string, id: string) {
    const current = await journal.read(scope, id);
    if (!current) return;
    // A tombstone stops a delayed/replayed event resurrecting deleted task output.
    await journal.update(scope, id, (record) => ({
      ...record!,
      state: 'released',
      image: {
        kind: 'generation',
        blockId: record!.image.blockId,
        threadId: record!.image.threadId,
        turnId: record!.image.turnId,
      },
      // Retain the managed address so restart can finish attachment compensation.
      blobUrl: record!.blobUrl,
      sourceUrl: undefined,
      errorCode: undefined,
    }));
    await withSessionMediaRefLock(db, reference(scope, id).refId, () =>
      removeRefs(reference(scope, id), db),
    );
    assertCurrent();
    const blob = current.blobUrl && parseBlobUrl(current.blobUrl);
    if (scope.startsWith('task:') && blob) {
      await removeSessionAttachmentRefIfUnreferencedByLiveMessage(
        { sessionId: scope.slice(5), hash: blob.hash, visibleOnly: true },
        db,
      );
      assertCurrent();
    }
  }
  const unpin = (scope: string, id: string) => removeRefs(reference(scope, id), db);
  return {
    journal,
    stage,
    read,
    release,
    unpin,
    assertCurrent,
    snapshot,
    db,
    compensation,
    reference,
  };
}

/** Read the task Host's logical clear boundary; source-device clocks are irrelevant. */
export async function readGeneratedImageEpoch(sessionId: string): Promise<number> {
  const storage = captureGeneratedImageStorage();
  const row = await storage.snapshot.client.queryOne<{ cleared_at: number | null }>(
    'SELECT cleared_at FROM sessions WHERE id = ?',
    [sessionId],
  );
  storage.assertCurrent();
  return row?.cleared_at ?? 0;
}

export function generatedImageErrorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (code === 'ENOENT') return 'MEDIA_SOURCE_MISSING';
  const message = error instanceof Error ? error.message : '';
  return /^(?:INVALID_IMAGE|MEDIA_SOURCE_MISSING|MEDIA_TOO_LARGE|REMOTE_SOURCE_REQUIRED|IMAGE_DELIVERY_CONFLICT)$/.test(
    message,
  )
    ? message
    : 'MEDIA_PUBLISH_FAILED';
}

export type GeneratedImageInvoke = (
  deviceId: string,
  channel: string,
  args: unknown[],
  options?: { preSend?: () => void },
) => Promise<{ ok: boolean; result?: unknown }>;

/** A relay owns its copy before it acknowledges the member's copy. Failed ACKs survive restart. */
export async function releaseGeneratedImageUpstream(
  storage: ReturnType<typeof captureGeneratedImageStorage>,
  record: GeneratedImageRecord,
  invoke: GeneratedImageInvoke,
) {
  if (!record.upstream || record.upstreamReleased) return;
  if (record.state !== 'released') {
    await storage.read(record);
    const parsed = record.blobUrl && parseBlobUrl(record.blobUrl);
    if (
      !parsed ||
      !(await hasRef(
        { hash: parsed.hash, ...storage.reference(record.scope, record.id) },
        storage.db,
      ))
    )
      throw new Error('REMOTE_SOURCE_REQUIRED');
  }
  const { agentDeviceId, sessionId, relay } = record.upstream;
  const call = async (request: object) => {
    storage.assertCurrent();
    const response = await invoke(agentDeviceId, REMOTE_AGENT_CHANNEL, [request], {
      preSend: storage.assertCurrent,
    });
    storage.assertCurrent();
    if (!response.ok) throw new Error('REMOTE_SOURCE_REQUIRED');
    return response.result as Record<string, unknown> | undefined;
  };
  // An older image-recovery Host would silently discard relay and release the wrong namespace.
  if ((await call({ op: 'caps' }))?.imageRecoveryRelay !== true)
    throw new Error('REMOTE_SOURCE_REQUIRED');
  if (
    (await call({ op: 'images', sessionId, relay, action: 'release', imageId: record.id }))?.ok !==
    true
  )
    throw new Error('REMOTE_SOURCE_REQUIRED');
  await storage.journal.update(record.scope, record.id, (current) => ({
    ...current!,
    upstreamReleased: true,
  }));
}

/** Receipted controllers get durable source ownership; legacy controllers get transport bytes only. */
export async function prepareGeneratedImageTransport(
  scope: string,
  event: AgentEvent,
  options: {
    retainForRecovery: boolean;
    upstream?: GeneratedImageUpstream;
    invoke?: GeneratedImageInvoke;
  },
): Promise<AgentEvent> {
  if (event.type !== 'image' || event.source !== 'codex') return event;
  const image = event.data as GeneratedImageEventData;
  if (image?.kind !== 'generation') return event;
  try {
    const storage = captureGeneratedImageStorage();
    const { upstream, invoke } = options;
    let bytes: { buffer: Buffer; mimeType: string };
    if (!options.retainForRecovery) {
      // Legacy controllers cannot ACK durable recovery ownership. Still deliver bytes,
      // but do not create an indefinitely pinned source artifact for them.
      bytes =
        generatedImageBytes(image) ??
        (await storage.read(initialGeneratedImageRecord(scope, image)));
    } else {
      if (upstream)
        await storage.journal.update(scope, generatedImageId(image), (previous) => {
          const current = previous ?? initialGeneratedImageRecord(scope, image);
          if (
            current.upstream &&
            (current.upstream.agentDeviceId !== upstream.agentDeviceId ||
              current.upstream.sessionId !== upstream.sessionId ||
              current.upstream.relay !== upstream.relay)
          )
            throw new Error('IMAGE_DELIVERY_CONFLICT');
          return { ...current, upstream };
        });
      const staged = await storage.stage(scope, image);
      if (invoke)
        await releaseGeneratedImageUpstream(storage, staged.record, invoke).catch(() => undefined);
      bytes = staged;
    }
    const { buffer, mimeType } = bytes;
    storage.assertCurrent();
    // url keeps new-source/old-controller normal delivery compatible. Do not send
    // a path alongside it: old controllers prefer the path and lose the bytes.
    const { data: _data, path: _path, url: _url, ...metadata } = image;
    return {
      ...event,
      data: { ...metadata, url: `data:${mimeType};base64,${buffer.toString('base64')}` },
    };
  } catch (error) {
    // Storage failure must not discard valid native bytes or let an old controller prefer a foreign path.
    const { path: _path, data: _data, url: _url, ...metadata } = image;
    let bytes: ReturnType<typeof generatedImageBytes> = null;
    try {
      bytes = generatedImageBytes(image);
    } catch {
      /* Report invalid/oversized output without copying it into transport. */
    }
    return {
      ...event,
      data: {
        ...metadata,
        pathOrigin: 'remote-agent',
        deliveryError: generatedImageErrorCode(error),
        ...(bytes
          ? { url: `data:${bytes.mimeType};base64,${bytes.buffer.toString('base64')}` }
          : image.url && !image.url.startsWith('data:')
            ? { url: image.url }
            : {}),
      },
    };
  }
}

/** Called only after remote-agent has authenticated the peer and derived its Host task id. */
export async function handleGeneratedImageArtifacts(
  hostSessionId: string,
  request: Extract<RemoteAgentRequest, { op: 'images' }>,
  invoke?: GeneratedImageInvoke,
) {
  const storage = captureGeneratedImageStorage();
  const scope = `remote:${hostSessionId}`;
  if (request.action === 'list') {
    const records = await storage.journal.list(scope);
    const page = records.slice(request.offset, request.offset + 64);
    return {
      images: page
        .filter((record) => record.state !== 'released')
        .map((record) => {
          const { path: _path, pathOrigin: _origin, ...image } = record.image;
          return { id: record.id, createdAt: record.createdAt, image };
        }),
      next: request.offset + page.length < records.length ? request.offset + page.length : null,
    };
  }
  if (request.action === 'release') {
    await storage.release(scope, request.imageId);
    const record = await storage.journal.read(scope, request.imageId);
    if (record && invoke)
      await releaseGeneratedImageUpstream(storage, record, invoke).catch(() => undefined);
    storage.assertCurrent();
    return { ok: true };
  }
  const record = await storage.journal.read(scope, request.imageId);
  if (!record || record.state === 'released') throw new Error('MEDIA_SOURCE_MISSING');
  const { buffer, mimeType } = record.blobUrl
    ? await storage.read(record)
    : await storage.stage(scope, record.image);
  storage.assertCurrent();
  if (request.offset > buffer.length) throw new Error('INVALID_IMAGE_DELIVERY');
  const chunk = buffer.subarray(request.offset, request.offset + REMOTE_AGENT_READ_MAX_BYTES);
  return {
    data: chunk.toString('base64'),
    mimeType,
    hash: createHash('sha256').update(buffer).digest('hex'),
    bytes: buffer.length,
    offset: request.offset,
    next: request.offset + chunk.length,
    done: request.offset + chunk.length === buffer.length,
  };
}
