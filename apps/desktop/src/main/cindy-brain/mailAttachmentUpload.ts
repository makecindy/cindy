import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseAttachmentOssRef, parsePeerAttachmentRef } from '@cindy/device-link';
import type { writeTempFile, materializeDirectSendOssAttachments } from '../maker-ipc/normalizeAttachments.js';

interface MailAttachmentHost {
  writeTempFile: typeof writeTempFile;
  materializeDirectSendOssAttachments: typeof materializeDirectSendOssAttachments;
}
let attachmentHost: MailAttachmentHost | undefined;
/** Main bootstrap owns assembly; importing the plugin runtime must not load maker-ipc. */
export function configureMailAttachmentHost(host: MailAttachmentHost): void { attachmentHost = host; }
function requireAttachmentHost(): MailAttachmentHost {
  if (!attachmentHost) throw new Error('MAIL_ATTACHMENT_HOST_NOT_READY');
  return attachmentHost;
}

const parseUploadRef = (url: string) => parsePeerAttachmentRef(url) || parseAttachmentOssRef(url);

export interface MailAttachmentUpload { url: string; name: string }
/** Both local selection and phone uploads share the dispatch acceptance lifecycle. */
export interface PreparedMailAttachment {
  attachment: { path: string; filename: string; bytes: number; sha256: string; contentId?: string };
  accepted(): void;
  discard(): Promise<void>;
}

/** Snapshot the selected bytes into the existing session-owned temporary store.
 * The sandbox/Node adapter never receives the user's source path or rereads it. */
export async function prepareMailAttachmentSelection(filePath: string, sessionId: string, inline: boolean, writeSnapshot = requireAttachmentHost().writeTempFile): Promise<PreparedMailAttachment> {
  const handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('attachment-too-large');
    bytes = await handle.readFile();
    if (bytes.length > 16 * 1024 * 1024) throw new Error('attachment-too-large');
  } finally { await handle.close(); }
  const stagedPath = await writeSnapshot(sessionId, bytes, undefined);
  return {
    attachment: { path: stagedPath, filename: path.basename(filePath), bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(inline ? { contentId: randomUUID() + '@cindy.local' } : {}) },
    accepted: () => {}, // Session/orphan cleanup already owns accepted files.
    discard: async () => { await fs.rm(stagedPath, { force: true }); },
  };
}
export function parseMailAttachmentUpload(value: unknown): MailAttachmentUpload | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  if (typeof p.url !== 'string' || p.url.length > 8192 || typeof p.name !== 'string' ||
      !p.name.trim() || p.name.length > 255 || /[\\/\x00-\x1f]/.test(p.name)) return null;
  const ref = parseUploadRef(p.url);
  if (!ref || !Number.isSafeInteger(ref.size) || ref.size! < 0 || ref.size! > 16 * 1024 * 1024 ||
      !ref.sha256 || !/^[a-f0-9]{64}$/.test(ref.sha256)) return null;
  return { url: p.url, name: p.name };
}

/** Reuse task attachment materialization and its owner/session cleanup. Never
 * accept a phone-supplied desktop path, or create a second upload store. */
export async function prepareMailAttachmentUpload(input: MailAttachmentUpload, sessionId: string, materialize = requireAttachmentHost().materializeDirectSendOssAttachments): Promise<PreparedMailAttachment> {
  const upload = parseMailAttachmentUpload(input);
  if (!upload) throw new Error('INVALID_MAIL_ATTACHMENT');
  const ref = parseUploadRef(upload.url)!;
  const staged = await materialize(sessionId, {
    type: 'user', content: [{ type: 'file', path: upload.url, name: upload.name, mimeType: ref.mimeType }],
  }, {});
  const discard = async () => { await staged.cleanupBeforeAcceptance?.(); };
  try {
    const file = (staged.message as { content: { path: string }[] }).content[0].path;
    if (file === upload.url) throw new Error('MAIL_ATTACHMENT_NOT_MATERIALIZED');
    const bytes = await fs.readFile(file);
    if (bytes.length !== ref.size || createHash('sha256').update(bytes).digest('hex') !== ref.sha256)
      throw new Error('MAIL_ATTACHMENT_INTEGRITY');
    return {
      attachment: { path: file, filename: upload.name, bytes: bytes.length, sha256: ref.sha256 },
      accepted: () => staged.cleanupAfterAcceptance?.(),
      discard,
    };
  } catch (error) { await discard(); throw error; }
}
