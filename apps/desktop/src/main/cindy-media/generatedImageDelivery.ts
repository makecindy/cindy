import { createHash } from 'node:crypto';
import { and, eq, isNotNull, or } from 'drizzle-orm';
import type { AgentEvent, GeneratedImageEventData } from '@cindy/maker-core';
import {
  parseProviderSharePeer,
  REMOTE_AGENT_CHANNEL,
  REMOTE_AGENT_READ_MAX_BYTES,
} from '@cindy/device-link';
import { sessions, messages } from '../localDb/schema';
import { broadcastMessageRow, createMessage } from '../localDb/ipc/messages';
import { captureDataOwnerBroadcastScope } from '../device-link/broadcast-tap';
import {
  captureGeneratedImageStorage,
  generatedImageErrorCode,
  releaseGeneratedImageUpstream,
} from './generatedImageStorage';
import {
  generatedImageId,
  initialGeneratedImageRecord,
  type GeneratedImageCleanup,
  type GeneratedImageRecord,
} from './generatedImageJournal';
import { commitChatImageUrls } from './chatAttachments';
import { MAX_GENERATED_IMAGE_BYTES } from './generatedMedia';
import { t } from '../i18n';

const taskFields = {
  id: sessions.id,
  status: sessions.status,
  clearedAt: sessions.clearedAt,
  agentDeviceId: sessions.agentDeviceId,
  remoteHostId: sessions.remoteHostId,
  workingDir: sessions.workingDir,
};

/** Additive journal metadata: old share aliases meant O, never a dynamic executor. */
type LegacyImageOrigin = { legacyOwnerRoute?: string };

export interface GeneratedImageDeliveryDeps {
  invoke(
    deviceId: string,
    channel: string,
    args: unknown[],
    options?: { preSend?: () => void },
  ): Promise<{ ok: boolean; result?: unknown }>;
  publish(sessionId: string, event: AgentEvent, persistId: string, resolvedContent?: string): void;
  /** Live routing is evidence of the image's source, not authorization for later access. */
  liveSharedTaskTarget?(sessionId: string, ownerRoute: string): string | null;
  /** Locate the durable task and acquire a fresh, task-scoped executor lease. */
  authorizeSharedTaskHistory?(sessionId: string, ownerRoute: string): Promise<string>;
  /** Resolve the share's original O identity; O enforces its existing guest/task access. */
  resolveSharedOwnerTarget?(ownerRoute: string): Promise<string>;
  readSource?(
    sessionId: string,
    image: GeneratedImageEventData,
    origin: { remoteHostId: string | null; workingDir: string | null },
  ): Promise<{ buffer: Buffer; mimeType: string }>;
}

/** Deliberately has no Agent.send/imagegen dependency. Every retry reuses an existing artifact. */
export function createGeneratedImageDelivery(deps: GeneratedImageDeliveryDeps) {
  const inFlight = new Map<string, Promise<void>>();

  async function authorizeSource(sessionId: string, source: string, assertCurrent: () => void) {
    assertCurrent();
    const peer = parseProviderSharePeer(source);
    const ownerRoute = peer ? `share:${peer.shareId}` : source.startsWith('share:') ? source : null;
    if (!ownerRoute) return source;
    if (!deps.authorizeSharedTaskHistory) throw new Error('REMOTE_SOURCE_REQUIRED');
    const target = await deps.authorizeSharedTaskHistory(sessionId, ownerRoute);
    assertCurrent();
    const authorizedPeer = parseProviderSharePeer(target);
    // A remembered executor may not be replaced by O (or another member), even when
    // that machine would successfully acknowledge releasing an absent artifact.
    if (
      (peer && (peer.role !== 'host' || target !== source)) ||
      !authorizedPeer ||
      authorizedPeer.role !== 'host' ||
      `share:${authorizedPeer.shareId}` !== ownerRoute
    )
      throw new Error('REMOTE_SOURCE_REQUIRED');
    return target;
  }

  async function currentSource(sessionId: string, source: string, assertCurrent: () => void) {
    if (!source.startsWith('share:')) return source;
    const live = deps.liveSharedTaskTarget?.(sessionId, source);
    if (!live) return authorizeSource(sessionId, source, assertCurrent);
    const peer = parseProviderSharePeer(live);
    if (!peer || peer.role !== 'host' || `share:${peer.shareId}` !== source)
      throw new Error('REMOTE_SOURCE_REQUIRED');
    return live;
  }

  async function historicalSource(
    sessionId: string,
    value: { agentDeviceId?: string } & LegacyImageOrigin,
    assertCurrent: () => void,
  ): Promise<{ agentDeviceId: string } & LegacyImageOrigin> {
    const source = value.agentDeviceId;
    if (!source) throw new Error('REMOTE_SOURCE_REQUIRED');
    const legacyOwnerRoute =
      value.legacyOwnerRoute ?? (source.startsWith('share:') ? source : undefined);
    if (!legacyOwnerRoute)
      return { agentDeviceId: await authorizeSource(sessionId, source, assertCurrent) };
    assertCurrent();
    if (!deps.resolveSharedOwnerTarget) throw new Error('REMOTE_SOURCE_REQUIRED');
    const target = await deps.resolveSharedOwnerTarget(legacyOwnerRoute);
    assertCurrent();
    const peer = parseProviderSharePeer(target);
    if (
      !peer ||
      peer.role !== 'host' ||
      `share:${peer.shareId}` !== legacyOwnerRoute ||
      (source !== legacyOwnerRoute && source !== target)
    )
      throw new Error('REMOTE_SOURCE_REQUIRED');
    return { agentDeviceId: target, legacyOwnerRoute };
  }

  async function authorizeRecordSource(
    storage: ReturnType<typeof captureGeneratedImageStorage>,
    sessionId: string,
    record: GeneratedImageRecord & LegacyImageOrigin,
  ) {
    const origin = await historicalSource(sessionId, record, storage.assertCurrent);
    if (
      origin.agentDeviceId !== record.agentDeviceId ||
      origin.legacyOwnerRoute !== record.legacyOwnerRoute
    ) {
      await storage.journal.update(record.scope, record.id, (current) => {
        if (!current || current.agentDeviceId !== record.agentDeviceId)
          throw new Error('REMOTE_SOURCE_REQUIRED');
        return { ...current, ...origin };
      });
    }
    return origin.agentDeviceId;
  }

  async function remote(deviceId: string, request: object, assertCurrent: () => void) {
    assertCurrent();
    const response = await deps.invoke(deviceId, REMOTE_AGENT_CHANNEL, [request], {
      preSend: assertCurrent,
    });
    assertCurrent();
    if (!response.ok || !response.result || typeof response.result !== 'object')
      throw new Error('REMOTE_SOURCE_REQUIRED');
    return response.result as Record<string, unknown>;
  }

  async function download(
    deviceId: string,
    sessionId: string,
    id: string,
    assertCurrent: () => void,
  ) {
    const caps = await remote(deviceId, { op: 'caps' }, assertCurrent);
    assertCurrent();
    if (caps.imageRecovery !== true) throw new Error('REMOTE_SOURCE_REQUIRED');
    const chunks: Buffer[] = [];
    let offset = 0;
    let expected: { hash: string; bytes: number } | undefined;
    for (;;) {
      assertCurrent();
      const result = await remote(
        deviceId,
        {
          op: 'images',
          sessionId,
          action: 'read',
          imageId: id,
          offset,
        },
        assertCurrent,
      );
      assertCurrent();
      if (
        typeof result.data !== 'string' ||
        result.data.length > Math.ceil(REMOTE_AGENT_READ_MAX_BYTES / 3) * 4 ||
        typeof result.bytes !== 'number' ||
        result.bytes <= 0 ||
        result.bytes > MAX_GENERATED_IMAGE_BYTES ||
        typeof result.hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(result.hash) ||
        result.offset !== offset ||
        typeof result.next !== 'number'
      )
        throw new Error('INVALID_IMAGE');
      if (expected && (expected.hash !== result.hash || expected.bytes !== result.bytes))
        throw new Error('INVALID_IMAGE');
      expected = { hash: result.hash as string, bytes: result.bytes };
      const chunk = Buffer.from(result.data, 'base64');
      if (!chunk.length || result.next !== offset + chunk.length || result.next > result.bytes)
        throw new Error('INVALID_IMAGE');
      chunks.push(chunk);
      offset = result.next;
      if (result.done === true) {
        if (offset !== result.bytes) throw new Error('INVALID_IMAGE');
        // stage() performs the same byte/MIME validation as a live native event.
        const buffer = Buffer.concat(chunks, offset);
        if (createHash('sha256').update(buffer).digest('hex') !== expected.hash)
          throw new Error('INVALID_IMAGE');
        return buffer.toString('base64');
      }
    }
  }

  async function deliver(
    sessionId: string,
    event: AgentEvent,
    sourceDeviceId?: string,
  ): Promise<void> {
    const image = event.data as GeneratedImageEventData;
    if (
      event.type !== 'image' ||
      event.source !== 'codex' ||
      image?.kind !== 'generation' ||
      !image.blockId
    )
      return;
    const storage = captureGeneratedImageStorage();
    const id = generatedImageId(image);
    const key = `${storage.snapshot.clientEpoch}:${sessionId}:${id}`;
    const pending = inFlight.get(key);
    if (pending) return pending;
    const operation = perform(storage, sessionId, id, image, event, Date.now(), sourceDeviceId);
    inFlight.set(key, operation);
    try {
      await operation;
    } finally {
      if (inFlight.get(key) === operation) inFlight.delete(key);
    }
  }

  async function perform(
    storage: ReturnType<typeof captureGeneratedImageStorage>,
    sessionId: string,
    id: string,
    image: GeneratedImageEventData,
    event: AgentEvent,
    admittedAt: number,
    sourceDeviceId?: string,
  ) {
    const scope = `task:${sessionId}`;
    const [session] = await storage.db
      .select(taskFields)
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    storage.assertCurrent();
    if (!session || session.status === 'deleted') {
      await cleanup(sessionId);
      return;
    }
    if (session.clearedAt !== null && session.clearedAt >= admittedAt) return;
    if (image.deliveryEpoch !== undefined && image.deliveryEpoch !== (session.clearedAt ?? 0)) {
      await cleanup(sessionId);
      return;
    }
    // Never create another ambiguous share alias. Early direct events can precede
    // live-handle registration; locate them before the first receipt is written.
    // If O is unavailable, M keeps the recoverable artifact and no source is guessed.
    const existing = await storage.journal.read(scope, id);
    const source = existing
      ? existing.agentDeviceId
      : (sourceDeviceId ??
        (session.agentDeviceId
          ? await currentSource(sessionId, session.agentDeviceId, storage.assertCurrent)
          : null));
    storage.assertCurrent();
    let record = await storage.journal.update(
      scope,
      id,
      (previous) =>
        previous ?? {
          ...initialGeneratedImageRecord(scope, image),
          clearedAt: session.clearedAt,
          remoteHostId: session.remoteHostId,
          workingDir: session.workingDir,
          ...(source ? { agentDeviceId: source } : {}),
        },
    );
    const toolUseId = `codex-image-${id}`;
    const useClientId = `${toolUseId}-use`,
      resultClientId = `${toolUseId}-result`;
    const ownerScope = captureDataOwnerBroadcastScope();
    const assertTask = async () => {
      storage.assertCurrent();
      const [current] = await storage.db
        .select({ status: sessions.status, clearedAt: sessions.clearedAt })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      const [result] = await storage.db
        .select({ role: messages.role, rewindAt: messages.rewindAt })
        .from(messages)
        .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, resultClientId)))
        .limit(1);
      storage.assertCurrent();
      if (
        !current ||
        current.status === 'deleted' ||
        current.clearedAt !== record.clearedAt ||
        result?.rewindAt != null ||
        result?.role === 'message_tombstone'
      )
        throw new Error('IMAGE_DELIVERY_RELEASED');
    };
    if (record.state === 'released') {
      await storage.release(scope, id);
      await releaseSource(record);
      return;
    }
    try {
      await assertTask();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'IMAGE_DELIVERY_RELEASED') throw error;
      await storage.release(scope, id);
      await releaseSource(record);
      return;
    }
    async function releaseSource(value: typeof record) {
      if (!value.agentDeviceId || value.sourceReleased) return;
      try {
        const target = await authorizeRecordSource(storage, sessionId, value);
        await remote(
          target,
          {
            op: 'images',
            sessionId,
            action: 'release',
            imageId: id,
          },
          storage.assertCurrent,
        );
        storage.assertCurrent();
        await storage.journal.update(scope, id, (current) => ({
          ...current!,
          sourceReleased: true,
        }));
      } catch {
        /* Retry the durable receipt on the next history load. */
      }
    }

    const input = { ...(image.revisedPrompt ? { prompt: image.revisedPrompt } : {}) };
    async function publish(state: 'failed' | 'stored', errorCode?: string) {
      await assertTask();
      const content = JSON.stringify({
        ok: state === 'stored',
        kind: 'generation',
        generation_status: image.status ?? 'completed',
        native_image_delivery: { id, state, ...(errorCode ? { errorCode } : {}) },
        text: t(state === 'stored' ? 'chat.imageDelivery.stored' : 'chat.imageDelivery.failed'),
        ...(state === 'stored'
          ? { xdt_image_url: record.blobUrl, filename: record.blobUrl!.split('/').pop() }
          : {}),
      });
      const meta = (event.agentMeta ?? null) as Parameters<typeof createMessage>[1]['agentMeta'];
      await createMessage(
        sessionId,
        {
          clientId: useClientId,
          role: 'tool_use',
          toolUseId,
          content: { toolUseId, toolName: 'imagegen', input },
          agentKind: 'codex',
          agentMeta: meta,
          createdAt: record.createdAt,
        },
        {
          beforePublish: assertTask,
          deferMediaRefs: true,
          broadcastOwnerScope: ownerScope,
          shouldBroadcast: () => {
            storage.assertCurrent();
            return true;
          },
        },
      );
      await assertTask();
      const resultMessage = await createMessage(
        sessionId,
        {
          clientId: resultClientId,
          role: 'tool_result',
          toolUseId,
          content,
          agentKind: 'codex',
          agentMeta: meta,
          createdAt: record.createdAt + 1,
        },
        {
          beforePublish: assertTask,
          deferMediaRefs: true,
          broadcastOwnerScope: ownerScope,
          shouldBroadcast: () => {
            storage.assertCurrent();
            return true;
          },
        },
      );
      await assertTask();
      // Conditional update cannot rewrite a removed/rewound message or cross a task clear.
      const changed = await storage.snapshot.client.exec(
        `UPDATE messages SET content = ? WHERE session_id = ? AND client_id = ? AND role = 'tool_result'
         AND rewind_at IS NULL AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND status != 'deleted' AND cleared_at IS ?)`,
        [JSON.stringify(content), sessionId, resultClientId, sessionId, record.clearedAt ?? null],
      );
      if (changed.changes !== 1) throw new Error('IMAGE_DELIVERY_RELEASED');
      await assertTask();
      if (state === 'stored') {
        const refs = await commitChatImageUrls(
          { sessionId, urls: [record.blobUrl!], originKind: 'tool', assertStillValid: assertTask },
          storage.db,
        );
        await assertTask();
        if (refs.failed || refs.committed + refs.skipped !== 1)
          throw new Error('MEDIA_PUBLISH_FAILED');
      }
      // Idempotent createMessage returns the previous row without broadcasting on retry.
      // Mobile consumes persisted row updates, so publish the committed content with its stable ID.
      broadcastMessageRow(sessionId, { ...resultMessage, content }, ownerScope);
      deps.publish(
        sessionId,
        {
          type: 'tool_use',
          source: 'codex',
          agentMeta: event.agentMeta,
          data: { toolUseId, toolName: 'imagegen', input },
        },
        useClientId,
      );
      deps.publish(
        sessionId,
        {
          type: 'tool_result_full',
          source: 'codex',
          agentMeta: event.agentMeta,
          data: { toolUseId, fullText: content, isError: false },
        },
        resultClientId,
        content,
      );
      deps.publish(
        sessionId,
        {
          type: 'tool_result',
          source: 'codex',
          agentMeta: event.agentMeta,
          data: { toolUseIds: [toolUseId], summary: content },
        },
        resultClientId,
        content,
      );
    }

    try {
      if (record.state !== 'stored') {
        let source = image;
        if (!image.data && !image.url?.startsWith('data:') && record.agentDeviceId) {
          let cached = false;
          if (record.blobUrl) {
            try {
              await storage.read(record);
              cached = true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          }
          if (!cached) {
            const target = await authorizeRecordSource(storage, sessionId, record);
            source = {
              ...image,
              data: await download(target, sessionId, id, storage.assertCurrent),
            };
          }
        }
        const staged = await storage.stage(
          scope,
          source,
          !record.agentDeviceId && deps.readSource
            ? () =>
                deps.readSource!(sessionId, source, {
                  remoteHostId: record.remoteHostId ?? null,
                  workingDir: record.workingDir ?? null,
                })
            : undefined,
        );
        record = staged.record;
        await assertTask();
        await publish('stored');
        record = await storage.journal.update(scope, id, (current) => {
          if (!current || current.state === 'released') throw new Error('IMAGE_DELIVERY_RELEASED');
          return { ...current, state: 'stored', errorCode: undefined };
        });
        // Cleanup failure cannot downgrade a durably published image.
      }
      await storage.unpin(scope, id).catch(() => undefined);
      await releaseSource(record);
    } catch (error) {
      storage.assertCurrent();
      if (error instanceof Error && error.message === 'IMAGE_DELIVERY_RELEASED') {
        await storage.release(scope, id);
        await releaseSource(record);
        return;
      }
      record = await storage.journal.update(scope, id, (current) => {
        if (!current || current.state === 'released') throw new Error('IMAGE_DELIVERY_RELEASED');
        return { ...current, state: 'failed', errorCode: generatedImageErrorCode(error) };
      });
      await publish('failed', record.errorCode);
    }
  }

  // Release-only enumeration: never passes an unknown artifact to the message writer.
  async function cleanupUnknown(receipt: GeneratedImageCleanup & LegacyImageOrigin) {
    const storage = captureGeneratedImageStorage();
    const origin = await historicalSource(receipt.sessionId, receipt, storage.assertCurrent);
    const target = origin.agentDeviceId;
    if (target !== receipt.agentDeviceId || origin.legacyOwnerRoute !== receipt.legacyOwnerRoute)
      await storage.journal.updateCleanup(receipt.scope, (current) => ({
        ...current!,
        ...origin,
      }));
    const caps = await remote(target, { op: 'caps' }, storage.assertCurrent);
    if (caps.imageRecovery !== true) return;
    let offset = 0;
    for (;;) {
      const page = await remote(
        target,
        { op: 'images', sessionId: receipt.sessionId, action: 'list', offset },
        storage.assertCurrent,
      );
      if (!Array.isArray(page.images) || page.images.length > 64)
        throw new Error('INVALID_IMAGE_DELIVERY');
      for (const value of page.images as Array<{ id?: unknown; image?: GeneratedImageEventData }>) {
        if (
          !value.image ||
          value.image.kind !== 'generation' ||
          typeof value.image.blockId !== 'string' ||
          generatedImageId(value.image) !== value.id
        )
          throw new Error('INVALID_IMAGE_DELIVERY');
        // Legacy source images without an epoch cannot safely be ordered across a clear.
        const epoch = value.image.deliveryEpoch;
        if (
          !receipt.deleted &&
          !(
            typeof epoch === 'number' &&
            Number.isSafeInteger(epoch) &&
            epoch >= 0 &&
            receipt.clearedAt !== null &&
            epoch < receipt.clearedAt
          )
        )
          continue;
        await remote(
          target,
          { op: 'images', sessionId: receipt.sessionId, action: 'release', imageId: value.id },
          storage.assertCurrent,
        );
      }
      if (page.next === null) return;
      if (typeof page.next !== 'number' || !Number.isSafeInteger(page.next) || page.next <= offset)
        throw new Error('INVALID_IMAGE_DELIVERY');
      offset = page.next;
    }
  }

  async function cleanup(sessionId: string) {
    const storage = captureGeneratedImageStorage();
    const [session] = await storage.db
      .select(taskFields)
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    storage.assertCurrent();
    if (session?.agentDeviceId && (session.status === 'deleted' || session.clearedAt !== null)) {
      const legacy = await storage.journal.readCleanup(
        `cleanup:${sessionId}:${session.agentDeviceId}`,
      );
      if (legacy) await cleanupUnknown(legacy).catch(() => undefined);
      try {
        const source = await currentSource(sessionId, session.agentDeviceId, storage.assertCurrent);
        // Keep old O and new M enumeration receipts independent across a task clear.
        const scope = `cleanup:${sessionId}:${source}`;
        const receipt = await storage.journal.updateCleanup(scope, (previous) => ({
          ...previous,
          version: 1,
          scope,
          sessionId,
          agentDeviceId: source,
          clearedAt: Math.max(previous?.clearedAt ?? 0, session.clearedAt ?? 0),
          deleted: previous?.deleted === true || session.status === 'deleted',
        }));
        await cleanupUnknown(receipt);
      } catch {
        /* A later reconcile retries the cleared/deleted task without guessing its source. */
      }
      storage.assertCurrent();
    }
    for (const record of await storage.journal.list(`task:${sessionId}`)) {
      if (session && session.status !== 'deleted' && record.clearedAt === session.clearedAt)
        continue;
      await storage.release(record.scope, record.id);
      if (record.agentDeviceId && !record.sourceReleased) {
        try {
          const target = await authorizeRecordSource(storage, sessionId, record);
          await remote(
            target,
            {
              op: 'images',
              sessionId,
              action: 'release',
              imageId: record.id,
            },
            storage.assertCurrent,
          );
          storage.assertCurrent();
          await storage.journal.update(record.scope, record.id, (current) => ({
            ...current!,
            sourceReleased: true,
          }));
        } catch {
          /* Retain the pending release receipt while the source is offline. */
        }
      }
    }
  }

  async function recoverOnce(sessionId: string, imageId?: string) {
    await cleanup(sessionId);
    const storage = captureGeneratedImageStorage();
    const scope = `task:${sessionId}`;
    const records = await storage.journal.list(scope);
    if (imageId && !records.some((record) => record.id === imageId))
      throw new Error('MEDIA_SOURCE_MISSING');
    for (const record of records) {
      if (imageId && record.id !== imageId) continue;
      if (record.state === 'stored' && (!record.agentDeviceId || record.sourceReleased)) {
        await storage.unpin(scope, record.id).catch(() => undefined);
        continue;
      }
      await deliver(sessionId, {
        type: 'image',
        source: 'codex',
        data: { ...record.image, ...(record.sourceUrl ? { url: record.sourceUrl } : {}) },
      });
    }
    if (imageId) return;
    const [session] = await storage.db
      .select(taskFields)
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!session?.agentDeviceId || session.status === 'deleted') return;
    // Each stable result ID is checked by perform/assertTask. An unrelated tombstone or
    // rewound row must not permanently disable recovery for all future paid outputs.
    const target = await authorizeSource(sessionId, session.agentDeviceId, storage.assertCurrent);
    for (const record of (await storage.journal.list(scope)) as Array<
      GeneratedImageRecord & LegacyImageOrigin
    >) {
      if (
        record.clearedAt === session.clearedAt &&
        !record.legacyOwnerRoute &&
        record.agentDeviceId &&
        parseProviderSharePeer(record.agentDeviceId) &&
        record.agentDeviceId !== target
      )
        throw new Error('REMOTE_SOURCE_REQUIRED');
    }
    const caps = await remote(target, { op: 'caps' }, storage.assertCurrent);
    if (caps.imageRecovery !== true) return;
    let offset = 0;
    for (;;) {
      const page = await remote(
        target,
        {
          op: 'images',
          sessionId,
          action: 'list',
          offset,
        },
        storage.assertCurrent,
      );
      storage.assertCurrent();
      if (!Array.isArray(page.images) || page.images.length > 64)
        throw new Error('INVALID_IMAGE_DELIVERY');
      for (const value of page.images as Array<{ id?: unknown; image?: GeneratedImageEventData }>) {
        if (
          !value.image ||
          value.image.kind !== 'generation' ||
          typeof value.image.blockId !== 'string' ||
          generatedImageId(value.image) !== value.id
        )
          throw new Error('INVALID_IMAGE_DELIVERY');
        if (session.clearedAt !== null && value.image.deliveryEpoch !== session.clearedAt) continue;
        await deliver(
          sessionId,
          {
            type: 'image',
            source: 'codex',
            data: { ...value.image, pathOrigin: 'remote-agent' },
          },
          target,
        );
      }
      if (page.next === null) break;
      if (typeof page.next !== 'number' || page.next <= offset)
        throw new Error('INVALID_IMAGE_DELIVERY');
      offset = page.next;
    }
  }
  const recoveries = new Map<string, Promise<void>>();
  async function recover(sessionId: string, imageId?: string) {
    const storage = captureGeneratedImageStorage();
    const key = `${storage.snapshot.clientEpoch}:${sessionId}:${imageId ?? ''}`;
    const existing = recoveries.get(key);
    if (existing) return existing;
    const operation = recoverOnce(sessionId, imageId);
    recoveries.set(key, operation);
    try {
      await operation;
    } finally {
      if (recoveries.get(key) === operation) recoveries.delete(key);
    }
  }
  async function reconcile() {
    const storage = captureGeneratedImageStorage();
    const tasks = new Set<string>();
    // A crash may precede the first image journal or cleanup receipt write.
    for (const session of await storage.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          isNotNull(sessions.agentDeviceId),
          or(isNotNull(sessions.clearedAt), eq(sessions.status, 'deleted')),
        ),
      ))
      tasks.add(session.id);
    for (const receipt of await storage.journal.listCleanups()) {
      await cleanupUnknown(receipt).catch(() => undefined);
      storage.assertCurrent();
    }
    for (const record of await storage.journal.listAll()) {
      storage.assertCurrent();
      if (record.scope.startsWith('task:')) tasks.add(record.scope.slice(5));
      else {
        if (record.state === 'released') await storage.release(record.scope, record.id);
        await releaseGeneratedImageUpstream(storage, record, deps.invoke).catch(() => undefined);
      }
    }
    for (const sessionId of tasks) {
      storage.assertCurrent();
      await cleanup(sessionId);
    }
  }
  return { deliver, recover, cleanup, reconcile };
}
