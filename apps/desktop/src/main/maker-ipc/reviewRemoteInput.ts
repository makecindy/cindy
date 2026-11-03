import { isAttachmentOssRef, isPeerAttachmentRef, parseAttachmentOssRef, parsePeerAttachmentRef } from '@cindy/device-link';
import { throwIpcError } from '../utils/ipcValidate.js';
import { readStartReviewRequest, type StartReviewRequest } from './reviewStartHandler.js';
import type { materializeQueuedOssAttachmentsDeferred } from './normalizeAttachments.js';

/** Translate controller uploads before Review authorizes and snapshots host files. */
export async function prepareRemoteReviewAttachments(
  request: StartReviewRequest,
  reviewerSessionId: string,
  materialize: typeof materializeQueuedOssAttachmentsDeferred,
): Promise<{ attachments: StartReviewRequest['attachments']; onAccepted(): void; cleanup(): Promise<void> }> {
  // Controller-local paths must never be resolved against the host filesystem.
  for (const attachment of request.attachments) {
    const ref = attachment.url || attachment.path;
    const parsed = ref && (isPeerAttachmentRef(ref) ? parsePeerAttachmentRef(ref) : parseAttachmentOssRef(ref));
    if (!parsed || parsed.size === undefined) {
      throwIpcError('INVALID_PARAMS', 'Remote review attachments must be uploaded before review');
    }
  }
  const prepared = await materialize(reviewerSessionId, { files: request.attachments });
  let accepted = false;
  const onAccepted = () => {
    if (accepted) return;
    accepted = true;
    prepared.cleanupAfterAcceptance?.();
  };
  let cleanupPromise: Promise<void> | undefined;
  // Acceptance releases only transport staging. Review still reads and checks
  // the host materialization until its terminal cleanup. Rejections retain
  // the upload for retry, as required by the shared materializer contract.
  const cleanup = () => cleanupPromise ??= (async () => {
    if (!accepted && prepared.cleanupBeforeAcceptance) {
      await prepared.cleanupBeforeAcceptance();
    } else {
      await prepared.cleanupLocalMaterialization?.();
    }
  })();
  try {
    const files = (prepared.item as { files: unknown }).files;
    const { attachments } = readStartReviewRequest({ ...request, attachments: files });
    if (attachments.some((file) => isAttachmentOssRef(file.url || file.path) || isPeerAttachmentRef(file.url || file.path))) {
      throwIpcError('DEVICE_LINK_MEDIA_TRANSFER_FAILED', 'Review attachment was not downloaded');
    }
    return { attachments, onAccepted, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
