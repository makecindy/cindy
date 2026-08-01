import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { IMAttachment } from '@cindy/im';
import type { WechatMediaRef, WechatTransport } from '@cindy/wechat-ilink';

import * as blobStore from '../../cindy-media/blobStore';
import { ingestMedia } from '../../cindy-media/ingest';
import type {
  WechatPollFileAttachmentInput,
  WechatPollMediaBlobInput,
  WechatPollMediaRefInput,
} from '../../localDb/client/tx/types';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';
import { decodeWechatSilkToWav } from './silkDecoder';

const MAX_ATTACHMENTS_PER_MESSAGE = 4;

export interface WechatTaskAttachment extends IMAttachment {
  storage: 'cindy-media' | 'file';
}

export interface StagedWechatTaskMedia {
  attachments: WechatTaskAttachment[];
  unsupportedMedia: string[];
  mediaBlobs: WechatPollMediaBlobInput[];
  mediaRefs: WechatPollMediaRefInput[];
  fileAttachments: WechatPollFileAttachmentInput[];
}

export async function stageWechatTaskMedia(args: {
  bindingEpoch: string;
  taskId: string;
  sessionId: string;
  media: readonly WechatMediaRef[];
  transport: WechatTransport;
  signal: AbortSignal;
  now: number;
}): Promise<StagedWechatTaskMedia> {
  const result: StagedWechatTaskMedia = {
    attachments: [],
    unsupportedMedia: [],
    mediaBlobs: [],
    mediaRefs: [],
    fileAttachments: [],
  };
  const selected = args.media.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  if (args.media.length > selected.length) {
    result.unsupportedMedia.push(`attachment-limit:${args.media.length - selected.length}`);
  }

  for (const ref of selected) {
    let bytes: Uint8Array;
    try {
      bytes = await args.transport.downloadMedia(ref, args.signal);
    } catch (error) {
      if (args.signal.aborted) throw error;
      result.unsupportedMedia.push(`${ref.kind}:download-failed`);
      continue;
    }
    if (ref.kind === 'voice' && ref.voiceEncoding === 6) {
      try {
        bytes = await decodeWechatSilkToWav(bytes, args.signal);
      } catch (error) {
        if (args.signal.aborted) throw error;
        result.unsupportedMedia.push(`${ref.kind}:decode-failed`);
        continue;
      }
    }
    const detected = detectWechatMedia(ref, bytes);
    if (!detected) {
      result.unsupportedMedia.push(`${ref.kind}:unsupported-format`);
      continue;
    }
    try {
      if (detected.storage === 'cindy-media') {
        // Poll commit happens after downloads finish. Ingest with no refs
        // before exposing the URL so duplicate, overload, stale-cursor, and
        // interaction-only paths leave a recycler-visible zero-ref ledger row
        // instead of an untracked content-addressed file.
        const written = await ingestMedia({
          buffer: bytes,
          mimeType: detected.mimeType,
          isCache: false,
          refs: [],
        });
        const resolved = blobStore.resolveSafe(written.url);
        result.attachments.push({
          kind: detected.attachmentKind,
          absPath: resolved.absPath,
          originalName: detected.fileName,
          mimeType: detected.mimeType,
          url: written.url,
          storage: 'cindy-media',
        });
        result.mediaBlobs.push({
          hash: written.hash,
          ext: written.ext,
          mimeType: written.mimeType,
          bytes: written.bytes,
          isCache: false,
          createdAt: args.now,
          lastAccessAt: args.now,
        });
        result.mediaRefs.push({
          id: randomUUID(),
          hash: written.hash,
          taskId: args.taskId,
          label: detected.fileName,
          createdAt: args.now,
        });
        continue;
      }

      const root = ownerScopedImUserDataPath(
        'im-attachments',
        'wechat',
        'sessions',
        args.sessionId,
      );
      await fs.mkdir(root, { recursive: true });
      const fileName = `${args.taskId}-${randomUUID()}-${detected.fileName}`;
      const absPath = path.resolve(root, fileName);
      const resolvedRoot = path.resolve(root);
      if (!absPath.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new Error('WECHAT_ATTACHMENT_PATH_OUT_OF_BOUNDS');
      }
      await fs.writeFile(absPath, bytes, { flag: 'wx' });
      result.attachments.push({
        kind: 'file',
        absPath,
        originalName: detected.fileName,
        mimeType: detected.mimeType,
        storage: 'file',
      });
      result.fileAttachments.push({
        id: randomUUID(),
        taskId: args.taskId,
        sessionId: args.sessionId,
        absPath,
        originalName: detected.fileName,
        mimeType: detected.mimeType,
        bytes: bytes.byteLength,
        createdAt: args.now,
      });
    } catch (error) {
      if (args.signal.aborted) throw error;
      result.unsupportedMedia.push(`${ref.kind}:staging-failed`);
    }
  }
  return result;
}

export async function removeUncommittedWechatFiles(
  staged: readonly WechatPollFileAttachmentInput[],
  insertedTaskIds: ReadonlySet<string>,
): Promise<void> {
  await Promise.all(
    staged
      .filter((entry) => !insertedTaskIds.has(entry.taskId))
      .map((entry) => fs.rm(entry.absPath, { force: true }).catch(() => undefined)),
  );
}

export async function removeReleasedWechatFiles(filePaths: readonly string[]): Promise<void> {
  const root = path.resolve(ownerScopedImUserDataPath('im-attachments', 'wechat', 'sessions'));
  await Promise.all(
    filePaths.map(async (candidate) => {
      const resolved = path.resolve(candidate);
      if (!resolved.startsWith(`${root}${path.sep}`)) return;
      await fs.rm(resolved, { force: true }).catch(() => undefined);
    }),
  );
}

export async function removeWechatSessionAttachmentDir(sessionId: string): Promise<void> {
  const root = path.resolve(ownerScopedImUserDataPath('im-attachments', 'wechat', 'sessions'));
  const target = path.resolve(root, sessionId);
  if (!target.startsWith(`${root}${path.sep}`)) return;
  await fs.rm(target, { recursive: true, force: true });
}

interface DetectedMedia {
  attachmentKind: IMAttachment['kind'];
  fileName: string;
  mimeType: string;
  storage: 'cindy-media' | 'file';
}

function detectWechatMedia(ref: WechatMediaRef, bytes: Uint8Array): DetectedMedia | null {
  switch (ref.kind) {
    case 'image': {
      const image = detectImage(bytes);
      return image
        ? {
            attachmentKind: 'image',
            fileName: `wechat-image${image.ext}`,
            mimeType: image.mimeType,
            storage: 'cindy-media',
          }
        : null;
    }
    case 'video':
      return isMp4(bytes)
        ? {
            attachmentKind: 'file',
            fileName: sanitizeAttachmentName(ref.fileName, 'wechat-video.mp4'),
            mimeType: 'video/mp4',
            storage: 'cindy-media',
          }
        : null;
    case 'voice': {
      if (
        ref.voiceEncoding === 6 &&
        startsWithAscii(bytes, 'RIFF') &&
        startsWithAscii(bytes.subarray(8), 'WAVE')
      ) {
        return {
          attachmentKind: 'file',
          fileName: 'wechat-voice.wav',
          mimeType: 'audio/wav',
          storage: 'cindy-media',
        };
      }
      if (ref.voiceEncoding === 7 && isMp3(bytes)) {
        return {
          attachmentKind: 'file',
          fileName: 'wechat-voice.mp3',
          mimeType: 'audio/mpeg',
          storage: 'cindy-media',
        };
      }
      if (ref.voiceEncoding === 8 && startsWithAscii(bytes, 'OggS')) {
        return {
          attachmentKind: 'file',
          fileName: 'wechat-voice.ogg',
          mimeType: 'audio/ogg',
          storage: 'cindy-media',
        };
      }
      return null;
    }
    case 'file': {
      const fileName = sanitizeAttachmentName(ref.fileName, 'wechat-file.bin');
      return {
        attachmentKind: 'file',
        fileName,
        mimeType: mimeForFileName(fileName),
        storage: 'file',
      };
    }
  }
}

function sanitizeAttachmentName(input: string | undefined, fallback: string): string {
  const normalized = (input ?? '')
    .normalize('NFKC')
    .replace(/\p{Cc}/gu, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  const leaf = path.basename(normalized).slice(0, 180);
  return leaf && leaf !== '.' && leaf !== '..' ? leaf : fallback;
}

function detectImage(bytes: Uint8Array): { ext: string; mimeType: string } | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    startsWithAscii(bytes.subarray(1), 'PNG\r\n\u001a\n')
  ) {
    return { ext: '.png', mimeType: 'image/png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: '.jpg', mimeType: 'image/jpeg' };
  }
  if (startsWithAscii(bytes, 'GIF87a') || startsWithAscii(bytes, 'GIF89a')) {
    return { ext: '.gif', mimeType: 'image/gif' };
  }
  if (
    bytes.length >= 12 &&
    startsWithAscii(bytes, 'RIFF') &&
    startsWithAscii(bytes.subarray(8), 'WEBP')
  ) {
    return { ext: '.webp', mimeType: 'image/webp' };
  }
  return null;
}

function isMp4(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && startsWithAscii(bytes.subarray(4), 'ftyp');
}

function isMp3(bytes: Uint8Array): boolean {
  return (
    startsWithAscii(bytes, 'ID3') ||
    (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
  );
}

function startsWithAscii(bytes: Uint8Array, value: string): boolean {
  if (bytes.length < value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function mimeForFileName(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return (
    {
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.json': 'application/json',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.ppt': 'application/vnd.ms-powerpoint',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    }[ext] ?? 'application/octet-stream'
  );
}

export const __testing = {
  detectWechatMedia,
  sanitizeAttachmentName,
};
