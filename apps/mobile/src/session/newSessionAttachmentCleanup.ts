import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { discardMobileUploadedAttachment } from '@/session/mobileAttachmentUpload';
import type { RemoteSerializedAttachment } from './types';

/** Shares uploaded before choosing a computer remain usable on the first selection. */
export function clearNewSessionAttachmentsForDeviceChange(input: {
  previousDeviceId: string;
  nextDeviceId: string;
  attachments: RemoteSerializedAttachment[];
  getToken: () => Promise<string | null>;
  discardAllPendingUploads: () => void;
  releaseUploadedSources: (ids: string[]) => void;
  setAttachments: (attachments: RemoteSerializedAttachment[]) => void;
  setMediaAssetAttachments: (value: Record<string, string>) => void;
  setAttachmentPreviews: (value: Record<string, string>) => void;
  forgetAllAnnotations: () => void;
  setAttachmentError: (value: string | null) => void;
}): void {
  if (!input.previousDeviceId || input.previousDeviceId === input.nextDeviceId) return;
  for (const attachment of input.attachments) {
    discardMobileUploadedAttachment(attachment, { getToken: input.getToken });
  }
  input.discardAllPendingUploads();
  input.releaseUploadedSources(input.attachments.map(attachment => attachment.id));
  input.setAttachments([]);
  input.setMediaAssetAttachments({});
  input.setAttachmentPreviews({});
  input.forgetAllAnnotations();
  input.setAttachmentError(null);
}

/** Best-effort reclaim before the account-change callback drops draft references. */
export function discardNewSessionUploadedAttachments(
  attachments: readonly { path?: string }[],
  getToken: () => Promise<string | null>,
): void {
  if (attachments.length === 0) return;
  const ownerAtClear = getMobileAuthOwner();
  // Start now, while AuthProvider still holds the outgoing account's token.
  // Never ask a later account for credentials from a deferred cleanup callback.
  let token: Promise<string | null>;
  try { token = getToken().catch(() => null); } catch { return; }
  for (const attachment of attachments) {
    discardMobileUploadedAttachment(attachment, {
      getToken: async () => {
        const captured = await token;
        return isMobileAuthOwnerCurrent(ownerAtClear) ? captured : null;
      },
    });
  }
}
