import type { AgentEvent } from '@cindy/maker-core';
import { createGeneratedImageStorage } from '../../../desktop/src/main/cindy-media/generatedImageStorageCore.js';
import {
  createGeneratedImageDelivery,
  type GeneratedImageDeliveryPlatform,
} from '../../../desktop/src/main/cindy-media/generatedImageDelivery.js';
import { setGeneratedImageRecovery } from '../../../desktop/src/main/cindy-media/generatedImageRecovery.js';
import { readGeneratedImageFile } from '../../../desktop/src/main/cindy-media/generatedImageBytes.js';
import { uiText } from '../../../desktop/src/main/uiText.js';
import { createLogger } from '../../../desktop/src/main/logger.js';
import { getCurrentDbClientSnapshot } from '../../../desktop/src/main/localDb/client/current.js';
import type { Message } from '../../../desktop/src/renderer/lib/ccAgent.types.js';
import { isDataOwnerBroadcastScopeCurrent } from '../../../desktop/src/main/device-link/broadcast-tap.js';
import type { DataOwnerBroadcastScope } from '../../../desktop/src/main/device-link/broadcastTapCore.js';
import { hostBlobStore, hostChatAttachments, hostMediaIngest, hostMediaJournal } from '../media-store.js';

/** The desktop's generated-image storage (generatedImageStorageCore.ts) over the Host's media store. */
export const hostGeneratedImageStorage = createGeneratedImageStorage({
  captureMediaRefCompensationScope: () => hostMediaJournal.captureMediaRefCompensationScope(),
  parseBlobUrl: url => hostBlobStore.parseBlobUrl(url),
  resolveSafe: url => hostBlobStore.resolveSafe(url),
  extForMime: mimeType => hostBlobStore.extForMime(mimeType),
  blobUrl: (hash, ext) => hostBlobStore.blobUrl(hash, ext),
  ingestMedia: (params, db) => hostMediaIngest.ingestMedia(params, db),
});

/**
 * A Codex generated image, as the desktop delivers it (register.ts, generatedImageDelivery.ts): the
 * bytes go into the media store, the image becomes the imagegen tool rows of the task's history with
 * its media reference, and clients get those rows and events with the stored address, never the bytes.
 * The rows go through the Host's message writer; the copy is the main i18n the Host binds (ui-text.ts).
 */
export function createHostGeneratedImages(deps: {
  createMessage: GeneratedImageDeliveryPlatform['createMessage'];
  publish: (event: unknown) => void;
  isProfileHeld: () => boolean;
  registerProfileRelease: (resumeRecovery: () => Promise<void>) => void;
}) {
  const log = createLogger('generated-images');
  const delivery = createGeneratedImageDelivery({
    captureGeneratedImageStorage: () => hostGeneratedImageStorage.captureGeneratedImageStorage(),
    releaseGeneratedImageUpstream: (storage, record, invoke) =>
      hostGeneratedImageStorage.releaseGeneratedImageUpstream(storage, record, invoke),
    createMessage: (sessionId, body, opts) => deps.createMessage(sessionId, body, opts),
    // The desktop's broadcastMessageRow: the committed row reaches clients as a created message, only
    // while the owner it was captured under is still current.
    broadcastMessageRow: (sessionId: string, message: Message, ownerScope?: DataOwnerBroadcastScope | null) => {
      if (ownerScope && !isDataOwnerBroadcastScopeCurrent(ownerScope)) return;
      deps.publish({ type: 'message_created', sessionId, messageId: message.id, message });
    },
    commitChatImageUrls: (params, db) => hostChatAttachments.commitChatImageUrls(params, db),
    // The catalog always has both keys (chat.imageDelivery.stored / failed).
    t: key => uiText(key, key),
    // The Host has no Device Link: an image whose source is another computer is not reachable, the
    // answer the desktop gets when that computer is not connected (REMOTE_SOURCE_REQUIRED). The shared
    // task ports are left out, as the Host refuses shared tasks at admission.
    invoke: async () => ({ ok: false }),
    publish: (sessionId, event, persistId, resolvedContent) =>
      deps.publish({ ...event, sessionId, event, persistId, resolvedContent }),
    // As the desktop's readSource, without its SSH file service and its legacy xdt-image cache: a
    // managed address, then the file the image names on this machine.
    readSource: async (_sessionId, image, session) => {
      if (image.pathOrigin === 'remote-agent') throw new Error('REMOTE_SOURCE_REQUIRED');
      if (session.remoteHostId) throw new Error('REMOTE_SOURCE_REQUIRED');
      const managed = image.url?.startsWith('cindy-media://') ? hostBlobStore.resolveSafe(image.url) : undefined;
      if (managed) {
        try { return await readGeneratedImageFile(managed.absPath); }
        catch (error) { if (!image.path) throw error; }
      }
      const source = image.path;
      if (!source) throw new Error('MEDIA_SOURCE_MISSING');
      return readGeneratedImageFile(source);
    },
  });
  let deferred: { clientEpoch: number; sessions: Set<string> } | undefined;
  async function recoverFromHistory(sessionId: string) {
    if (!deps.isProfileHeld()) return delivery.recover(sessionId);
    const owner = getCurrentDbClientSnapshot();
    if (!owner) return;
    if (deferred?.clientEpoch !== owner.clientEpoch) {
      deferred = { clientEpoch: owner.clientEpoch, sessions: new Set() };
    }
    deferred.sessions.add(sessionId);
  }
  // History reads and task deletion can start writes to the image store. Resume work deferred by a
  // hold only for the same open owner database. A new hold can defer the remaining work again.
  async function onProfileReleased() {
    const pending = deferred;
    deferred = undefined;
    if (!pending) return;
    for (const sessionId of pending.sessions) {
      if (getCurrentDbClientSnapshot()?.clientEpoch !== pending.clientEpoch) return;
      await recoverFromHistory(sessionId).catch(() => undefined);
    }
  }
  setGeneratedImageRecovery(recoverFromHistory, () => delivery.reconcile());
  deps.registerProfileRelease(onProfileReleased);

  /** register.ts deliverCodexGeneratedImage: the tool events published for the image, `[]` when none. */
  function deliverCodexGeneratedImage(sessionId: string, event: AgentEvent): Promise<readonly AgentEvent[]> {
    const warn = () => log.warn('Codex generated image delivery could not be persisted', { sessionId });
    try {
      const run = delivery.start(sessionId, event);
      if (!run) return Promise.resolve([]);
      run.completion.catch(warn);
      return run.published;
    } catch {
      warn();
      return Promise.resolve([]);
    }
  }
  return { delivery, deliverCodexGeneratedImage };
}
