import path from 'node:path';
import type { LiziMcpSessionContext, ReadSessionAttachmentArgs } from '@cindy/mcps';
import { getDbClient, tryGetDbClient } from '../localDb/client/current.js';
import { getActiveDataOwnerPushStamp } from '../appSessionState.js';
import { getPluginHostToolCaller } from './hostToolCaller.js';
import { historyAttachmentSource, readHistoryAttachment, type HistoryAttachmentSource } from './historyAttachment.js';
import { isDepositExcludedFileName } from '../cindy-brain/dirDeposit.js';
import { GHOST_HANDOFF_MAX_BYTES_PER_FILE } from '../../shared/ghost.js';
import { readBoundedFileNoFollow } from '../utils/readBoundedFile.js';
import { getGhostHandoffStore } from '../cindy-brain/handoffStore.desktop.js';
import { ingestMedia } from '../cindy-media/ingest.js';
import { chatAttachmentOrigin } from '../cindy-media/attachmentGrantGate.js';
import { captureMediaRefCompensationScope } from '../cindy-media/refCompensationJournal.desktop.js';
import { ghostCanRead, getBlobInfo } from '../cindy-media/ledger.js';
import { blobUrl, openBlobFile, parseBlobUrl, resolveSafe } from '../cindy-media/blobStore.desktop.js';

async function resolveStoredHistoryAttachment(args: ReadSessionAttachmentArgs): Promise<HistoryAttachmentSource | null> {
  const row = await getDbClient().queryOne<{ content: unknown; role: string }>(
    'SELECT content, role FROM messages WHERE id = ? AND session_id = ? AND rewind_at IS NULL',
    [args.message_id, args.session_id]);
  const source = row ? historyAttachmentSource(row.content, row.role, args.attachment_index) : null;
  return source && !isDepositExcludedFileName(source.name) ? source : null;
}

/** Shared attachment read and transfer. The plugin branch uses existing media grants
 * and handoff storage; paths remain exclusively within these Host services. */
export async function readDesktopHistoryAttachment(args: ReadSessionAttachmentArgs, context: LiziMcpSessionContext | undefined) {
  if (args.session_id.includes('::')) return { ok: false as const, errorCode: 'UNSUPPORTED_CAPABILITY', message: 'Remote attachment reads are not supported.' };
  const db = getDbClient(), owner = getActiveDataOwnerPushStamp();
  const plugin = context?.hostCaller ? getPluginHostToolCaller() : undefined;
  const assertCurrent = () => {
    const active = getActiveDataOwnerPushStamp();
    if (tryGetDbClient() !== db || active.dataOwnerId !== owner.dataOwnerId || active.ownerGeneration !== owner.ownerGeneration)
      throw new Error('PERMISSION_DENIED');
    plugin?.assertCurrent();
  };
  try {
    const store = plugin ? getGhostHandoffStore() : null;
    return await readHistoryAttachment(args, {
      assertCurrent,
      source: () => resolveStoredHistoryAttachment(args),
      read: async source => {
        const media = parseBlobUrl(source.url);
        if (!media) throw new Error('UNSUPPORTED_CAPABILITY');
        const origin = await chatAttachmentOrigin(media.hash, db.drizzle);
        assertCurrent();
        if (!origin) {
          const granted = plugin && await ghostCanRead(media.hash, plugin.caller.pluginId, db.drizzle);
          assertCurrent();
          if (!granted) throw new Error('PERMISSION_DENIED');
        }
        source.originKind = origin ?? 'tool';
        if (isDepositExcludedFileName(source.name)) throw new Error('PERMISSION_DENIED');
        const resolved = resolveSafe(source.url);
        const bytes = await readBoundedFileNoFollow(resolved.absPath, GHOST_HANDOFF_MAX_BYTES_PER_FILE,
          { containWithin: path.dirname(resolved.absPath), nonBlocking: true, verifyContentStability: true });
        if (!bytes) throw new Error('ATTACHMENT_UNAVAILABLE');
        return { bytes, mimeType: resolved.mimeType };
      },
      ...(plugin && store ? {
        handoff: async (ref: string, offset: number, length: number) => {
          const opened = await store.open(plugin.caller.pluginId, ref);
          if (!opened) return null;
          try {
            assertCurrent();
            const bytes = Buffer.alloc(Math.max(0, Math.min(length, opened.info.size - offset)));
            const { bytesRead } = await opened.file.read(bytes, 0, bytes.byteLength, offset);
            if (bytesRead !== bytes.byteLength || (await opened.file.stat()).size !== opened.info.size) return null;
            // The receipt's digest identifies the imported copy. Callers verify
            // the assembled file against it; each page reads only its range.
            return { bytes, name: opened.info.name, mimeType: opened.info.mimeType, size: opened.info.size, sha256: opened.info.sha256 };
          } finally { await opened.file.close(); }
        },
        media: async (hash: string, offset: number, length: number) => {
          if (!await ghostCanRead(hash, plugin.caller.pluginId, db.drizzle)) return null;
          const info = await getBlobInfo(hash, db.drizzle);
          if (!info) return null;
          assertCurrent();
          const opened = await openBlobFile(blobUrl(hash, info.ext));
          try {
            assertCurrent();
            if (opened.totalSize !== info.bytes) return null;
            const bytes = Buffer.alloc(Math.max(0, Math.min(length, opened.totalSize - offset)));
            const { bytesRead } = await opened.file.read(bytes, 0, bytes.byteLength, offset);
            if (bytesRead === 0 && bytes.byteLength > 0) return null;
            return { bytes: bytes.subarray(0, bytesRead), size: opened.totalSize, mimeType: info.mimeType };
          } finally { await opened.file.close(); }
        },
        transfer: async (source: HistoryAttachmentSource, file: { bytes: Buffer; mimeType: string }) => {
          assertCurrent();
          const refCompensationScope = captureMediaRefCompensationScope();
          const media = await ingestMedia({ buffer: file.bytes, mimeType: file.mimeType, isCache: false,
            refs: [{ refKind: source.originKind === 'user' ? 'ghost-grant' : 'ghost-tool-grant', refId: plugin.caller.pluginId, originKind: source.originKind }],
            assertStillValid: assertCurrent, refCompensationScope }, db.drizzle);
          return { mediaHash: media.hash };
        },
      } : {}),
    });
  } catch (error) {
    assertCurrent();
    const known = ['PERMISSION_DENIED', 'NOT_FOUND', 'HOST_NOT_READY', 'HANDOFF_UNAVAILABLE', 'UNSUPPORTED_CAPABILITY'];
    const code = error instanceof Error && known.includes(error.message) ? error.message : 'ATTACHMENT_UNAVAILABLE';
    return { ok: false as const, errorCode: code, message: code };
  }
}
