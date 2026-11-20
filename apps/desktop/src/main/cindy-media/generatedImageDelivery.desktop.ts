import { broadcastMessageRow, createMessage } from '../localDb/ipc/messages';
import { t } from '../i18n.desktop';
import { commitChatImageUrls } from './chatAttachments';
import { captureGeneratedImageStorage, releaseGeneratedImageUpstream } from './generatedImageStorage';
import {
  createGeneratedImageDelivery,
  type GeneratedImageDeliveryDeps,
  type GeneratedImageDeliveryPlatform,
} from './generatedImageDelivery';

/** The delivery with the desktop's storage, message writer and copy, read at call time. */
export function createDesktopGeneratedImageDelivery(
  deps: Omit<GeneratedImageDeliveryDeps, keyof GeneratedImageDeliveryPlatform>,
) {
  return createGeneratedImageDelivery({
    ...deps,
    captureGeneratedImageStorage: () => captureGeneratedImageStorage(),
    releaseGeneratedImageUpstream: (storage, record, invoke) =>
      releaseGeneratedImageUpstream(storage, record, invoke),
    createMessage: (sessionId, body, opts) => createMessage(sessionId, body, opts),
    broadcastMessageRow: (sessionId, msg, ownerScope) =>
      broadcastMessageRow(sessionId, msg, ownerScope),
    commitChatImageUrls: (params, db) => commitChatImageUrls(params, db),
    t: (key) => t(key),
  });
}
