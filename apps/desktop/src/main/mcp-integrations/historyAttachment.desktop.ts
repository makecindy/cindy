import path from 'node:path';
import type { LiziMcpSessionContext, ReadSessionAttachmentArgs } from '@cindy/mcps';
import { DL_MEDIA_FETCH_CHANNEL } from '@cindy/device-link';
import { getDbClient, tryGetDbClient } from '../localDb/client/current.js';
import { getActiveDataOwnerPushStamp } from '../appSessionState.js';
import { getPluginHostToolCaller } from './hostToolCaller.js';
import { historyAttachmentSource, readHistoryAttachment, type HistoryAttachmentSource } from './historyAttachment.js';
import { isDepositExcludedFileName } from '../cindy-brain/dirDeposit.js';
import { GHOST_HANDOFF_MAX_BYTES_PER_FILE } from '../../shared/ghost.js';
import { readBoundedFileNoFollow } from '../utils/readBoundedFile.js';
import { getGhostHandoffStore } from '../cindy-brain/handoffStore.desktop.js';
import { handoffMimeType } from '../cindy-brain/handoffStore.js';
import { readRemoteDeviceFile } from '../device-link/fileAccess.js';
import { downloadToBuffer } from '../device-link/mediaTransfer.js';
import { resolveAuthorizedMedia } from '../device-link/mediaFetch.js';
import { ingestMedia, supportedMime } from '../cindy-media/ingest.js';
import { captureMediaRefCompensationScope } from '../cindy-media/refCompensationJournal.desktop.js';
import { ghostCanRead, getBlobInfo } from '../cindy-media/ledger.js';
import { blobUrl, openBlobFile } from '../cindy-media/blobStore.desktop.js';
import { remoteVisibleSessionSql } from '../localDb/ipc/botRemoteVisibility.js';

/** Also used on the source computer by the authenticated history query handler. */
export async function resolveStoredHistoryAttachment(args: ReadSessionAttachmentArgs, remoteVisibleOnly = false): Promise<HistoryAttachmentSource | null> {
  const row = await getDbClient().queryOne<{ content: unknown; role: string }>(
    `SELECT content, role FROM messages WHERE id = ? AND session_id = ? AND rewind_at IS NULL
     ${remoteVisibleOnly ? `AND EXISTS (SELECT 1 FROM sessions WHERE sessions.id = messages.session_id AND ${remoteVisibleSessionSql('sessions')})` : ''}`,
    [args.message_id, args.session_id]);
  const source = row ? historyAttachmentSource(row.content, row.role, args.attachment_index) : null;
  return source && !isDepositExcludedFileName(source.name) ? source : null;
}

/** Shared attachment read and transfer. The plugin branch uses existing media grants
 * and handoff storage; paths remain exclusively within these Host services. */
export async function readDesktopHistoryAttachment(args: ReadSessionAttachmentArgs, context: LiziMcpSessionContext | undefined,
  remote: { query(device: string, args: ReadSessionAttachmentArgs): Promise<Record<string, unknown>>;
    invoke: Parameters<typeof readRemoteDeviceFile>[2] }) {
  const db = getDbClient(), owner = getActiveDataOwnerPushStamp();
  const plugin = context?.hostCaller ? getPluginHostToolCaller() : undefined;
  const assertCurrent = () => {
    const active = getActiveDataOwnerPushStamp();
    if (tryGetDbClient() !== db || active.dataOwnerId !== owner.dataOwnerId || active.ownerGeneration !== owner.ownerGeneration)
      throw new Error('PERMISSION_DENIED');
    plugin?.assertCurrent();
  };
  const split = args.session_id.indexOf('::');
  const device = split > 0 ? args.session_id.slice(0, split) : null;
  try {
    const store = plugin ? getGhostHandoffStore() : null;
    return await readHistoryAttachment(args, {
      assertCurrent,
      source: async () => {
        if (!device) return resolveStoredHistoryAttachment(args);
        const result = await remote.query(device, { ...args, session_id: args.session_id.slice(split + 2), attachment_ref: undefined });
        assertCurrent();
        if (result.ok !== true && (result.errorCode === 'INVALID_ARGS' || result.errorCode === 'REMOTE_UNSUPPORTED_QUERY')) throw new Error('REMOTE_UNSUPPORTED');
        if (result.ok !== true || typeof result.url !== 'string' || typeof result.name !== 'string')
          throw new Error(typeof result.errorCode === 'string' ? result.errorCode : 'REMOTE_UNSUPPORTED');
        return { url: result.url, name: result.name, originKind: result.originKind === 'user' ? 'user' : 'tool' };
      },
      read: async source => {
        if (isDepositExcludedFileName(source.name)) throw new Error('PERMISSION_DENIED');
        if (device) {
          const maximum = GHOST_HANDOFF_MAX_BYTES_PER_FILE;
          let url = source.url;
          if (url.startsWith('xdt-file://') || url.startsWith('xdt-audio://')) {
            const bounded = new URL(url), existing = bounded.searchParams.get('maxBytes');
            const limit = existing === null ? maximum : Number(existing);
            if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('ATTACHMENT_UNAVAILABLE');
            bounded.searchParams.set('maxBytes', String(Math.min(limit, maximum)));
            url = bounded.toString();
          }
          const assertSize = (value: unknown) => {
            const metadata = value as { size?: unknown; inlineBase64?: unknown } | null;
            if (!metadata || typeof metadata.size !== 'number' || !Number.isSafeInteger(metadata.size)
              || metadata.size < 0 || metadata.size > maximum
              || (typeof metadata.inlineBase64 === 'string' && metadata.inlineBase64.length > 4 * Math.ceil(maximum / 3)))
              throw new Error('ATTACHMENT_UNAVAILABLE');
          };
          const result = await readRemoteDeviceFile(device, url, async (target, channel, input) => {
            const response = await remote.invoke(target, channel, input);
            // Reject source metadata before the shared service starts peer/OSS transfer.
            if (channel === DL_MEDIA_FETCH_CHANNEL && response.ok) { assertCurrent(); assertSize(response.result); }
            return response;
          }, { maxBytes: maximum, maxPeerBytes: maximum, cacheFirst: false });
          try {
            assertCurrent();
            assertSize(result);
            const bytes = result.inlineBase64 ? Buffer.from(result.inlineBase64, 'base64')
              : 'path' in result ? await readBoundedFileNoFollow(result.path, maximum)
              : (await downloadToBuffer(result.ossKey, maximum)).bytes;
            if (!bytes || bytes.byteLength > maximum || bytes.byteLength !== result.size) throw new Error('ATTACHMENT_UNAVAILABLE');
            return { bytes, mimeType: result.mimeType };
          } finally { if ('dispose' in result) await result.dispose(); }
        }
        const resolved = await resolveAuthorizedMedia({ url: source.url }, GHOST_HANDOFF_MAX_BYTES_PER_FILE);
        if (isDepositExcludedFileName(path.basename(resolved.absPath))) throw new Error('PERMISSION_DENIED');
        const bytes = await readBoundedFileNoFollow(resolved.absPath, GHOST_HANDOFF_MAX_BYTES_PER_FILE,
          { containWithin: path.dirname(resolved.absPath), nonBlocking: true, verifyContentStability: true });
        if (!bytes) throw new Error('ATTACHMENT_UNAVAILABLE');
        return { bytes, mimeType: resolved.mimeType ?? handoffMimeType(source.name) };
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
          if (supportedMime(file.mimeType)) {
            const refCompensationScope = captureMediaRefCompensationScope();
            const media = await ingestMedia({ buffer: file.bytes, mimeType: file.mimeType, isCache: false,
              refs: [{ refKind: source.originKind === 'user' ? 'ghost-grant' : 'ghost-tool-grant', refId: plugin.caller.pluginId, originKind: source.originKind }],
              assertStillValid: assertCurrent, refCompensationScope }, db.drizzle);
            return { mediaHash: media.hash };
          }
          const [receipt] = await store.import(plugin.caller.pluginId, [{ name: source.name, bytes: file.bytes }], assertCurrent);
          return { attachment_ref: receipt.ref };
        },
      } : {}),
    });
  } catch (error) {
    assertCurrent();
    const known = ['PERMISSION_DENIED', 'NOT_FOUND', 'HOST_NOT_READY', 'REMOTE_UNSUPPORTED', 'REMOTE_DEVICE_OFFLINE',
      'REMOTE_LINK_REQUIRED', 'DEVICE_LINK_NOT_READY', 'REMOTE_TIMEOUT', 'REMOTE_PAYLOAD_TOO_LARGE', 'REMOTE_DISABLED', 'REMOTE_ACCESS_REVOKED', 'HANDOFF_UNAVAILABLE'];
    const code = error instanceof Error && known.includes(error.message) ? error.message : 'ATTACHMENT_UNAVAILABLE';
    return { ok: false as const, errorCode: code, message: code };
  }
}
