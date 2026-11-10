import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ReadSessionAttachmentArgs } from '@cindy/mcps';

export interface HistoryAttachmentSource { url: string; name: string; originKind: 'user' | 'tool' }

/** Uses persisted attachment fields only, never links or paths found in message text. */
export function historyAttachmentSource(content: unknown, role: string, index: number): HistoryAttachmentSource | null {
  let parsed = content;
  if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { return null; } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const sources = [...(Array.isArray(record.images) ? record.images : []).map(item => ({ item, field: 'url' })),
    ...(Array.isArray(record.files) ? record.files : []).map(item => ({ item, field: 'path' }))];
  const selected = sources[index];
  if (!selected) return null;
  const item = selected?.item as Record<string, unknown> | undefined;
  const raw = item?.[selected.field];
  if (typeof raw !== 'string' || !raw || raw.includes('\0')) return null;
  const url = path.isAbsolute(raw) ? `xdt-file://attachment?path=${encodeURIComponent(raw)}` : raw;
  return { url, name: path.basename(String(item?.originalName ?? item?.name ?? 'attachment')), originKind: role === 'user' ? 'user' : 'tool' };
}

export async function readHistoryAttachment(args: ReadSessionAttachmentArgs, ports: {
  assertCurrent(): void;
  source(): Promise<HistoryAttachmentSource | null>;
  read(source: HistoryAttachmentSource): Promise<{ bytes: Buffer; mimeType: string }>;
  /** Present only for a Host-attested plugin caller. */
  transfer?: (source: HistoryAttachmentSource, file: { bytes: Buffer; mimeType: string }) => Promise<{ attachment_ref?: string; mediaHash?: string }>;
  handoff?: (ref: string) => Promise<{ bytes: Buffer; name: string; mimeType: string } | null>;
}) {
  ports.assertCurrent();
  const held = args.attachment_ref ? await ports.handoff?.(args.attachment_ref) : null;
  ports.assertCurrent();
  if (args.attachment_ref && !held) return { ok: false as const, errorCode: 'HANDOFF_UNAVAILABLE', message: 'Attachment receipt is unavailable; request the source attachment again.' };
  const source = held ? null : await ports.source();
  ports.assertCurrent();
  if (!held && !source) return { ok: false as const, errorCode: 'NOT_FOUND', message: 'Message attachment does not exist.' };
  const file = held ?? await ports.read(source!);
  ports.assertCurrent();
  const receipt = held ? { attachment_ref: args.attachment_ref } : await ports.transfer?.(source!, file);
  ports.assertCurrent();
  const end = Math.min(args.offset + args.length, file.bytes.byteLength);
  return { ok: true as const, name: held?.name ?? source!.name, mimeType: file.mimeType,
    size: file.bytes.byteLength, sha256: createHash('sha256').update(file.bytes).digest('hex'),
    offset: args.offset, base64: file.bytes.subarray(args.offset, end).toString('base64'),
    nextOffset: end < file.bytes.byteLength ? end : null, ...receipt };
}
