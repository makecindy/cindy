import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { discardMobileUploadedAttachment } from '@/session/mobileAttachmentUpload';

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
