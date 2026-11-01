import { createHash } from 'node:crypto';
import { and, eq, isNotNull, or } from 'drizzle-orm';
import type { AgentEvent, GeneratedImageEventData } from '@cindy/maker-core';
import { REMOTE_AGENT_CHANNEL, REMOTE_AGENT_READ_MAX_BYTES } from '@cindy/device-link';
import { sessions, messages } from '@cindy/runtime-db/schema';
import {
  generatedImageId,
  initialGeneratedImageRecord,
  type GeneratedImageCleanup,
} from './generatedImageJournal.js';
import type {createGeneratedImageStorageRuntime} from './generatedImageStorage.js';
import type {createMessageService} from './messageService.js';
import type {OwnerBroadcastTap} from './ownerBroadcast.js';
import type {createChatAttachments} from './chatAttachments.js';
export interface GeneratedImageDeliveryHost extends Pick<ReturnType<typeof createGeneratedImageStorageRuntime>,'captureGeneratedImageStorage'|'generatedImageErrorCode'|'releaseGeneratedImageUpstream'>,
 Pick<ReturnType<typeof createMessageService>,'broadcastMessageRow'|'createMessage'>,
 Pick<OwnerBroadcastTap,'captureDataOwnerBroadcastScope'>,
 Pick<ReturnType<typeof createChatAttachments>,'commitChatImageUrls'> {
 MAX_GENERATED_IMAGE_BYTES:number;
 t(key:string):string;
}


export interface GeneratedImageDeliveryDeps {
  invoke(
    deviceId: string,
    channel: string,
    args: unknown[],
    options?: { preSend?: () => void },
  ): Promise<{ ok: boolean; result?: unknown }>;
  publish(sessionId: string, event: AgentEvent, persistId: string, resolvedContent?: string): void;
  readSource?(
    sessionId: string,
    image: GeneratedImageEventData,
    origin: { remoteHostId: string | null; workingDir: string | null },
  ): Promise<{ buffer: Buffer; mimeType: string }>;
}
export function createGeneratedImageDeliveryRuntime(host: GeneratedImageDeliveryHost) {
const {broadcastMessageRow,createMessage,captureDataOwnerBroadcastScope,captureGeneratedImageStorage,generatedImageErrorCode,releaseGeneratedImageUpstream,commitChatImageUrls,MAX_GENERATED_IMAGE_BYTES,t}=host;


const taskFields = {
  id: sessions.id,
  status: sessions.status,
  clearedAt: sessions.clearedAt,
  agentDeviceId: sessions.agentDeviceId,
  remoteHostId: sessions.remoteHostId,
  workingDir: sessions.workingDir,
};

/** Deliberately has no Agent.send/imagegen dependency. Every retry reuses an existing artifact. */
function createGeneratedImageDelivery(deps: GeneratedImageDeliveryDeps) {
  const inFlight = new Map<string, Promise<void>>();

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

  async function deliver(sessionId: string, event: AgentEvent): Promise<void> {
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
    const operation = perform(storage, sessionId, id, image, event, Date.now());
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
    let record = await storage.journal.update(
      scope,
      id,
      (previous) =>
        previous ?? {
          ...initialGeneratedImageRecord(scope, image),
          clearedAt: session.clearedAt,
          remoteHostId: session.remoteHostId,
          workingDir: session.workingDir,
          ...(session.agentDeviceId ? { agentDeviceId: session.agentDeviceId } : {}),
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
        await remote(
          value.agentDeviceId,
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
          if (!cached)
            source = {
              ...image,
              data: await download(record.agentDeviceId, sessionId, id, storage.assertCurrent),
            };
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
  async function cleanupUnknown(receipt: GeneratedImageCleanup) {
    const storage = captureGeneratedImageStorage();
    const caps = await remote(receipt.agentDeviceId, { op: 'caps' }, storage.assertCurrent);
    if (caps.imageRecovery !== true) return;
    let offset = 0;
    for (;;) {
      const page = await remote(
        receipt.agentDeviceId,
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
          receipt.agentDeviceId,
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
      const scope = `cleanup:${sessionId}:${session.agentDeviceId}`;
      const receipt = await storage.journal.updateCleanup(scope, (previous) => ({
        version: 1,
        scope,
        sessionId,
        agentDeviceId: session.agentDeviceId!,
        clearedAt: Math.max(previous?.clearedAt ?? 0, session.clearedAt ?? 0),
        deleted: previous?.deleted === true || session.status === 'deleted',
      }));
      await cleanupUnknown(receipt).catch(() => undefined);
      storage.assertCurrent();
    }
    for (const record of await storage.journal.list(`task:${sessionId}`)) {
      if (session && session.status !== 'deleted' && record.clearedAt === session.clearedAt)
        continue;
      await storage.release(record.scope, record.id);
      if (record.agentDeviceId && !record.sourceReleased) {
        try {
          await remote(
            record.agentDeviceId,
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
    const caps = await remote(session.agentDeviceId, { op: 'caps' }, storage.assertCurrent);
    if (caps.imageRecovery !== true) return;
    let offset = 0;
    for (;;) {
      const page = await remote(
        session.agentDeviceId,
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
        await deliver(sessionId, {
          type: 'image',
          source: 'codex',
          data: { ...value.image, pathOrigin: 'remote-agent' },
        });
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
return {
  createGeneratedImageDelivery
};
}
