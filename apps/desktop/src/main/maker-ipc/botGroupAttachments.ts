/**
 * Attachments on group chat messages (docs/product-rules/bot-group-chat.md §3.1,
 * docs/dev-rules/media-storage-and-protocols.md).
 *
 * - Images live in cindy-media with a `bot-group-attachment` reference on the group, dropped
 *   in the same transaction that deletes the group. Each member's Session adds its usual
 *   `session-attachment` reference when the turn is saved.
 * - A file picked on this computer stays where it is, exactly as in a task message.
 * - A phone's upload is fetched once; when it is not an image it is kept in the group's
 *   folder (`bot-groups/<groupId>/attachments/`), which goes to the trash with the group.
 */

import { chatErrorDiagnostic } from './chatServerErrors.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { AttachmentIntegrity } from '@cindy/device-link';

import * as blobStore from '../cindy-media/blobStore.js';
import { ingestMedia } from '../cindy-media/ingest.js';
import * as ledger from '../cindy-media/ledger.js';
import { getDbClient } from '../localDb/client/current.js';
import { removeRemote } from '../device-link/mediaTransfer.js';
import {
  materializeRemoteAttachment,
  parseRemoteAttachmentRef,
  type RemoteAttachment,
} from '../device-link/remoteAttachment.js';
import { isDangerousAttachmentName } from '../../shared/attachmentSafety.js';
import {
  BOT_GROUP_ATTACHMENTS_MAX,
  type BotGroupAttachment,
  type BotGroupAttachmentCategory,
  type BotGroupFailure,
} from '../../shared/botGroupChat.js';
import type { BotGroupPreparedAttachments } from './botGroupChatService.js';
import { botGroupAttachmentsPath } from './botGroupWorkDir.js';

const CATEGORIES: ReadonlySet<string> = new Set<BotGroupAttachmentCategory>(['image', 'pdf', 'text', 'office', 'file']);
const MAX_ID_CHARS = 128;
const MAX_NAME_CHARS = 255;

interface AttachmentEntry {
  id: string;
  name: string;
  path: string;
  category: BotGroupAttachmentCategory;
  mimeType: string;
  url: string | null;
  annotated: boolean;
}

function invalid(): BotGroupFailure {
  return { ok: false, errorCode: 'INVALID_PARAMS', message: '附件无效' };
}

function readEntry(value: unknown): AttachmentEntry | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const name = typeof raw.originalName === 'string' && raw.originalName.trim() ? raw.originalName : raw.name;
  if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME_CHARS) return null;
  if (typeof raw.path !== 'string' || typeof raw.mimeType !== 'string') return null;
  if (typeof raw.category !== 'string' || !CATEGORIES.has(raw.category)) return null;
  if (raw.url !== undefined && typeof raw.url !== 'string') return null;
  const id = typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= MAX_ID_CHARS ? raw.id : randomUUID();
  return {
    id,
    name: name.trim(),
    path: raw.path,
    category: raw.category as BotGroupAttachmentCategory,
    mimeType: raw.mimeType,
    url: typeof raw.url === 'string' ? raw.url : null,
    annotated: raw.annotated === true,
  };
}

/** A name that is safe as the last segment of a path on every platform. */
export function safeAttachmentFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '');
  return (cleaned || 'attachment').slice(0, 120);
}

function integrityFor(ref: RemoteAttachment): AttachmentIntegrity | undefined {
  return ref.size === undefined ? undefined : { size: ref.size, sha256: ref.sha256! };
}

async function isRegularFile(file: string): Promise<number | null> {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

export interface BotGroupAttachmentStore {
  prepare: (input: {
    groupId: string;
    attachments: readonly unknown[];
    controllerDeviceId?: string;
  }) => Promise<BotGroupPreparedAttachments | BotGroupFailure>;
}

export function createBotGroupAttachmentStore(deps: {
  ownerRoot: () => string;
  log?: { warn: (message: string, fields: Record<string, unknown>) => void };
}): BotGroupAttachmentStore {
  const prepare: BotGroupAttachmentStore['prepare'] = async (input) => {
    if (input.attachments.length > BOT_GROUP_ATTACHMENTS_MAX) return invalid();
    // One account for the whole batch: an account switch while a phone upload is fetched must
    // neither write into nor clean up the next account's data.
    const db = getDbClient().drizzle;
    const ownerRoot = deps.ownerRoot();
    const refIds: string[] = [];
    const folders: string[] = [];
    const uploads: string[] = [];
    const discard = async () => {
      for (const refId of refIds.splice(0)) await ledger.removeRefById(refId, db).catch(() => undefined);
      for (const folder of folders.splice(0)) await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined);
    };

    /**
     * The group's reference to an image already in the media store. Every batch keeps its
     * own, never another send's: undoing a batch must not unpin an image a posted message shows.
     */
    const referenceImage = async (hash: string) => {
      await ledger.pinBlob(hash, db);
      refIds.push(await ledger.addRef({ hash, refKind: 'bot-group-attachment', refId: input.groupId, originKind: 'user' }, db));
    };

    /** Picked on this computer: images are already in the media store, files stay in place. */
    const local = async (entry: AttachmentEntry): Promise<BotGroupAttachment | null> => {
      if (entry.category === 'image' && entry.url?.startsWith('cindy-media://')) {
        const blob = blobStore.parseBlobUrl(entry.url);
        if (!blob) return null;
        const size = await isRegularFile(blobStore.resolveSafe(entry.url).absPath);
        if (size === null) return null;
        await referenceImage(blob.hash);
        return { id: entry.id, name: entry.name, category: 'image', mimeType: entry.mimeType, size, url: entry.url, path: null, ...(entry.annotated ? { annotated: true } : {}) };
      }
      if (!path.isAbsolute(entry.path)) return null;
      const size = await isRegularFile(entry.path);
      if (size === null) return null;
      // An image the media store could not take goes to the members as a plain file.
      const category = entry.category === 'image' ? 'file' : entry.category;
      return { id: entry.id, name: entry.name, category, mimeType: entry.mimeType, size, url: null, path: entry.path };
    };

    /** Sent by a phone: only its own uploads are accepted, never a path on this computer. */
    const remote = async (entry: AttachmentEntry): Promise<BotGroupAttachment | null> => {
      const refText = entry.url && parseRemoteAttachmentRef(entry.url) ? entry.url : entry.path;
      const ref = parseRemoteAttachmentRef(refText);
      if (!ref) return null;
      const mimeType = ref.mimeType ?? entry.mimeType;
      const dir = botGroupAttachmentsPath(ownerRoot, input.groupId);
      await fs.mkdir(dir, { recursive: true });
      const incoming = path.join(dir, `.incoming-${randomUUID()}`);
      try {
        await materializeRemoteAttachment(ref, incoming, integrityFor(ref));
        if (ref.ossKey) uploads.push(ref.ossKey);
        if (mimeType.startsWith('image/') && blobStore.supportedMime(mimeType) && !isDangerousAttachmentName(entry.name)) {
          const written = await ingestMedia({
            buffer: await fs.readFile(incoming),
            mimeType,
            refs: [{ refKind: 'bot-group-attachment', refId: input.groupId, originKind: 'user' }],
          }, db);
          refIds.push(...written.refIds);
          const size = await isRegularFile(blobStore.resolveSafe(written.url).absPath) ?? 0;
          return { id: entry.id, name: entry.name, category: 'image', mimeType, size, url: written.url, path: null, ...(entry.annotated ? { annotated: true } : {}) };
        }
        const folder = path.join(dir, randomUUID());
        await fs.mkdir(folder);
        folders.push(folder);
        const file = path.join(folder, safeAttachmentFileName(entry.name));
        await fs.rename(incoming, file);
        const size = await isRegularFile(file) ?? 0;
        const category = entry.category === 'image' ? 'file' : entry.category;
        return { id: entry.id, name: entry.name, category, mimeType, size, url: null, path: file };
      } finally {
        await fs.rm(incoming, { force: true }).catch(() => undefined);
      }
    };

    const attachments: BotGroupAttachment[] = [];
    try {
      for (const value of input.attachments) {
        const entry = readEntry(value);
        const attachment = entry ? await (input.controllerDeviceId ? remote(entry) : local(entry)) : null;
        if (!attachment) {
          await discard();
          return invalid();
        }
        attachments.push(attachment);
      }
    } catch (error) {
      await discard();
      // Transfer errors carry no host paths; anything else is reported generically.
      const diagnostic = chatErrorDiagnostic(error);
      const { code } = diagnostic;
      deps.log?.warn('Chat attachment preparation failed', { groupId: input.groupId, stage: 'prepare', ...diagnostic });
      return { ok: false, errorCode: code.startsWith('FILE_PEER_') || code.startsWith('DEVICE_LINK_') || code.startsWith('OSS_DOWNLOAD_') ? 'ATTACHMENT_UNAVAILABLE' : 'INVALID_ATTACHMENT', message: code };
    }
    return {
      ok: true,
      attachments,
      commit: () => {
        for (const key of uploads.splice(0)) void removeRemote(key).catch(() => undefined);
      },
      discard,
    };
  };

  return { prepare };
}
