/**
 * An attachment for a mail card of a task that runs on another computer.
 *
 * The file is chosen on this computer and uploaded through the same transfer area as message
 * attachments. Only the resulting reference (with size and SHA-256) and the file name cross to the
 * task's computer, which accepts it exactly like a phone upload (`mail:attach` with
 * `input.mailAttachment`). This computer's file path never leaves it.
 */
import path from 'node:path';
import { buildLegacyAttachmentOssRef } from '@cindy/device-link';
import { parseMailAttachmentUpload, type MailAttachmentUpload } from './mailAttachmentUpload.js';

/** The task's computer accepts at most this much per uploaded mail attachment. */
export const REMOTE_MAIL_ATTACHMENT_MAX_BYTES = 16 * 1024 * 1024;

export interface RemoteMailAttachmentDeps {
  /** Native file picker; null when the user cancels. */
  pick(): Promise<string | null>;
  upload(file: string, options: { contentType: string; maxBytes: number }): Promise<{ key: string; size: number; contentType: string; sha256: string }>;
  mimeOf(ext: string): string;
}

/** `attachment: null` = the user cancelled. Throws when the file cannot be read or uploaded. */
export async function uploadRemoteMailAttachment(deps: RemoteMailAttachmentDeps): Promise<{ attachment: MailAttachmentUpload | null }> {
  const file = await deps.pick();
  if (!file) return { attachment: null };
  const name = path.basename(file);
  const uploaded = await deps.upload(file, {
    contentType: deps.mimeOf(path.extname(file).slice(1).toLowerCase()),
    maxBytes: REMOTE_MAIL_ATTACHMENT_MAX_BYTES,
  });
  const attachment = parseMailAttachmentUpload({
    url: buildLegacyAttachmentOssRef({ ossKey: uploaded.key, mimeType: uploaded.contentType, originalName: name, size: uploaded.size, sha256: uploaded.sha256 }),
    name,
  });
  if (!attachment) throw new Error('MAIL_ATTACHMENT_INVALID');
  return { attachment };
}
