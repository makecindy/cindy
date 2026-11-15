import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isAttachmentOssRef, isPeerAttachmentRef } from '@cindy/device-link';
import { createAttachmentNormalizer, type AttachmentNormalizerIO } from '../../desktop/src/main/maker-ipc/normalizeAttachments.js';
import { buildMakerUserMessage, type AgentInputQueuedMessage } from '../../desktop/src/shared/agentInputQueue.js';
import { createImageCacheStore } from '../../desktop/src/main/imageCacheStore.js';
import * as ledger from '../../desktop/src/main/cindy-media/ledger.js';
import type { CurrentDbClientSnapshot } from '../../desktop/src/main/localDb/client/current.js';
import { getUserDataDir } from '../../desktop/src/main/userDataPath.js';
import { throwIpcError } from '../../desktop/src/main/utils/ipcValidate.js';
import { hostBlobStore, hostMediaIngest, hostMediaJournal } from './media-store.js';

// Owner runtimes have separate temporary roots, even for identical task ids.
// They share the process identity so orphan recovery never deletes a live peer.
const processOwner = { instanceId: randomUUID(), processId: process.pid };
const unsupportedRemote = () => throwIpcError('UNSUPPORTED_CAPABILITY',
  'Remote attachments require the shared relay transfer service, which Host has not connected yet');

export function createHostAttachments(deps: {
  getOwner(): CurrentDbClientSnapshot | null;
  assertCurrent(): void;
  getTempDir?: () => string;
  imageCacheStore?: ReturnType<typeof createImageCacheStore>;
  blobStore?: typeof hostBlobStore;
  ingest?: typeof hostMediaIngest;
  journal?: typeof hostMediaJournal;
}) {
  const blobs = deps.blobStore ?? hostBlobStore;
  const images = deps.imageCacheStore ?? createImageCacheStore(getUserDataDir);
  const ingest = deps.ingest ?? hostMediaIngest;
  const journal = deps.journal ?? hostMediaJournal;
  const operations = new AsyncLocalStorage<{ owner: CurrentDbClientSnapshot; check(): void; error?: unknown }>();
  const captureIO = (): AttachmentNormalizerIO => {
    const operation = operations.getStore();
    if (!operation) throw new Error('Attachment operation is not bound to an account');
    const { owner, check } = operation;
    check();
    const scope = journal.captureMediaRefCompensationScope(`${owner.userId}:${owner.clientEpoch}`);
    return {
      imageCacheStore: images,
      cindyMediaBlobStore: {
        ...blobs,
        // Byte deletion needs a recycler that accounts for every profile using
        // this shared root. No queue cleanup is allowed to delete those bytes.
        deleteBlobFile: async () => { throw new Error('Host media recycling is not connected'); },
      },
      cindyMediaLedger: {
        removeRefById: id => ledger.removeRefById(id, owner.client.drizzle),
        // Keep the zero-ref record with its bytes for formal recycling. Looking
        // at only this owner's ledger cannot prove another owner has no refs.
        deleteZeroRefBlobRecord: async () => false,
      },
      ingestMedia: async params => {
        try {
          return await ingest.ingestMedia({ ...params, assertStillValid: check,
            refCompensationScope: scope }, owner.client.drizzle);
        } catch (error) {
          // Desktop's legacy materializer can retain a failed local path. Host
          // must not acknowledge a durable attachment when its ingest failed.
          operation.error = error;
          throw error;
        }
      },
      materializeRemoteAttachment: async () => unsupportedRemote(),
      removeRemote: async () => unsupportedRemote(),
    };
  };
  // Defaults are never used: every non-text entry is bound by run(). No current
  // account lookup may escape into the deferred cleanup callbacks.
  const normalizer = createAttachmentNormalizer({
    getTempDir: deps.getTempDir ?? os.tmpdir,
    imageCacheStore: images,
    cindyMediaBlobStore: blobs,
    cindyMediaLedger: ledger,
    ingestMedia: ingest.ingestMedia,
    isRemoteAttachmentRef: (value): value is string => isAttachmentOssRef(value) || isPeerAttachmentRef(value),
    parseRemoteAttachmentRef: () => unsupportedRemote(),
    materializeRemoteAttachment: async () => unsupportedRemote(),
    removeRemote: async () => unsupportedRemote(),
    captureIO,
  });
  normalizer.configureTempAttachmentOwner(processOwner);
  let ready: Promise<unknown> | undefined;

  async function run<T>(checkAdmission: () => void, fn: (check: () => void) => Promise<T>): Promise<T> {
    deps.assertCurrent();
    const owner = deps.getOwner();
    if (!owner) throw new Error('DbClient not ready');
    const operation = { owner, check() {
      deps.assertCurrent();
      if (deps.getOwner() !== owner) throw new Error('Attachment owner changed');
      checkAdmission();
    }, error: undefined as unknown };
    return operations.run(operation, async () => {
      operation.check();
      await (ready ??= normalizer.cleanupOrphanedTempAttachments({ currentOwner: processOwner }));
      operation.check();
      return fn(() => { operation.check(); if (operation.error) throw operation.error; });
    });
  }

  async function validateRef(ref: string): Promise<void> {
    const operation = operations.getStore()!;
    operation.check();
    if (isAttachmentOssRef(ref) || isPeerAttachmentRef(ref)) unsupportedRemote();
    let file = ref;
    if (ref.startsWith('cindy-media://')) {
      const resolved = blobs.resolveSafe(ref);
      if (!await ledger.getBlobInfo(resolved.hash, operation.owner.client.drizzle)) {
        throwIpcError('NOT_FOUND', 'Attachment is not available in this account');
      }
      file = resolved.absPath;
    } else if (ref.startsWith('xdt-image://')) file = images.resolveSafe(ref).absPath;
    else if (!path.isAbsolute(ref)) {
      throwIpcError('UNSUPPORTED_CAPABILITY', 'Host cannot resolve this attachment source');
    }
    await fs.access(file);
    operation.check();
  }

  type UserMessage = Parameters<typeof normalizer.normalizeUserMessage>[1];
  async function validateMessage(message: UserMessage) {
    if (typeof message === 'string' || typeof message.content === 'string') return;
    for (const block of message.content) {
      if (block.type !== 'image' && block.type !== 'file') continue;
      const attachment = block as { path?: string; base64?: string };
      // Memory images are materialized by the shared normalizer at dispatch.
      if (!attachment.base64) await validateRef(attachment.path ?? '');
    }
  }

  return {
    collectRefs: normalizer.collectQueuedAttachmentRefs,
    async materialize(id: string, item: AgentInputQueuedMessage, checkAdmission: () => void) {
      return run(checkAdmission, async check => {
        await validateMessage(buildMakerUserMessage(item));
        // Validate hidden transcript refs as well as the model's input. No
        // remote reference may be acknowledged just because it was not sent.
        for (const ref of normalizer.collectQueuedAttachmentRefs({ persistedContent: item.persistedContent })) {
          await validateRef(ref);
        }
        check();
        const result = await normalizer.materializeQueuedOssAttachmentsDeferred(id, item);
        try { check(); return result; }
        catch (error) { await result.cleanupBeforeAcceptance?.(); throw error; }
      });
    },
    async prepareUserMessage(id: string, message: UserMessage) {
      return run(() => {}, async check => {
        await validateMessage(message);
        check();
        const normalized = await normalizer.normalizeUserMessage(id, message);
        check();
        const count = (value: UserMessage) => typeof value === 'string' || typeof value.content === 'string'
          ? 0 : value.content.filter(block => block.type === 'image' || block.type === 'file').length;
        if (count(normalized) !== count(message)) throwIpcError('INTERNAL', 'Attachment preparation failed');
        return normalized;
      });
    },
    closeSession: normalizer.cleanupSessionTempAttachments,
  };
}
