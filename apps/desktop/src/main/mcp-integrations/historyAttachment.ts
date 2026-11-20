import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ReadSessionAttachmentArgs } from '@cindy/mcps';

export interface HistoryAttachmentSource { url: string; name: string; originKind: 'user' | 'tool' }

/** Locates managed media; persisted file paths do not prove read authority. */
export function historyAttachmentSource(content: unknown, role: string, index: number): HistoryAttachmentSource | null {
  let parsed = content;
  if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { return null; } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const images = Array.isArray(record.images) ? record.images : [];
  if (index >= images.length && Array.isArray(record.files) && record.files[index - images.length])
    throw new Error('UNSUPPORTED_CAPABILITY');
  const item = images[index] as Record<string, unknown> | undefined;
  const raw = item?.url;
  if (typeof raw !== 'string' || !raw || raw.includes('\0')) return null;
  return { url: raw, name: path.basename(String(item?.originalName ?? item?.name ?? 'attachment')), originKind: role === 'user' ? 'user' : 'tool' };
}

export async function readHistoryAttachment(args: ReadSessionAttachmentArgs, ports: {
  assertCurrent(): void;
  source(): Promise<HistoryAttachmentSource | null>;
  read(source: HistoryAttachmentSource): Promise<{ bytes: Buffer; mimeType: string }>;
  /** Present only for a Host-attested plugin caller. */
  transfer?: (source: HistoryAttachmentSource, file: { bytes: Buffer; mimeType: string }) => Promise<{ attachment_ref?: string; mediaHash?: string }>;
  handoff?: (ref: string, offset: number, length: number) => Promise<{ bytes: Buffer; name: string; mimeType: string; size: number; sha256: string } | null>;
  media?: (hash: string, offset: number, length: number) => Promise<{ bytes: Buffer; size: number; mimeType: string } | null>;
}) {
  ports.assertCurrent();
  if (args.attachment_ref) {
    const held = await ports.handoff?.(args.attachment_ref, args.offset, args.length);
    ports.assertCurrent();
    if (!held) return { ok: false as const, errorCode: 'HANDOFF_UNAVAILABLE', message: 'Attachment receipt is unavailable; obtain a new receipt through the existing authorized handoff flow.' };
    const end = args.offset + held.bytes.byteLength;
    return { ok: true as const, name: held.name, mimeType: held.mimeType, size: held.size, sha256: held.sha256,
      offset: args.offset, base64: held.bytes.toString('base64'), nextOffset: end < held.size ? end : null, attachment_ref: args.attachment_ref };
  }
  const source = await ports.source();
  ports.assertCurrent();
  if (!source) return { ok: false as const, errorCode: 'NOT_FOUND', message: 'Message attachment does not exist.' };
  if (args.mediaHash) {
    const chunk = await ports.media?.(args.mediaHash, args.offset, args.length);
    ports.assertCurrent();
    if (!chunk) return { ok: false as const, errorCode: 'ATTACHMENT_UNAVAILABLE', message: 'Granted media is unavailable.' };
    const end = args.offset + chunk.bytes.byteLength;
    return { ok: true as const, name: source.name, mimeType: chunk.mimeType, size: chunk.size, sha256: args.mediaHash,
      offset: args.offset, base64: chunk.bytes.toString('base64'), nextOffset: end < chunk.size ? end : null, mediaHash: args.mediaHash };
  }
  const file = await ports.read(source);
  ports.assertCurrent();
  const receipt = await ports.transfer?.(source, file);
  ports.assertCurrent();
  const end = Math.min(args.offset + args.length, file.bytes.byteLength);
  return { ok: true as const, name: source.name, mimeType: file.mimeType,
    size: file.bytes.byteLength, sha256: createHash('sha256').update(file.bytes).digest('hex'),
    offset: args.offset, base64: file.bytes.subarray(args.offset, end).toString('base64'),
    nextOffset: end < file.bytes.byteLength ? end : null, ...receipt };
}
