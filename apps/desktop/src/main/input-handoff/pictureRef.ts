import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorizedSessionPathStillBound, type SessionPathAuthorization } from '@cindy/mcps';
import * as blobStore from '../cindy-media/blobStore.js';
import { classifyLocalAttachmentPath } from '../cindy-brain/ghostLocalPathGrant.js';
import { isNetworkOrDevicePath } from '../filePathPolicy.js';
import * as imageCacheStore from '../imageCacheStore.js';

/**
 * Reads the screenshot an agent passes to request_input_handoff(image): a local
 * image path (relative to the task folder) or a managed media URL. The bytes
 * only feed the host's QR reader; nothing from them goes back to the agent.
 * A file outside the task folder goes through the task's file grant first,
 * as media.import_image does.
 */

const MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_MIME: Readonly<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const AVATAR_IMAGE_MIME: Readonly<Record<string, string>> = { ...IMAGE_MIME, '.webp': 'image/webp' };

export type HandoffPictureRead =
  | { ok: true; bytes: Buffer }
  | { ok: false; errorCode: 'IMAGE_NOT_FOUND' | 'NOT_AN_IMAGE' | 'PERMISSION_DENIED'; message: string };

const notFound = (allowWebp = false): HandoffPictureRead => ({
  ok: false,
  errorCode: 'IMAGE_NOT_FOUND',
  message: allowWebp
    ? 'Cindy cannot read that picture. Pass a PNG, JPEG or WebP path (absolute, or relative to the task folder), or a cindy-media:// URL.'
    : 'Cindy cannot read that picture. Pass the path of a PNG or JPEG screenshot (absolute, or relative to the task folder), or a cindy-media:// URL.',
});

const notAnImage = (allowWebp = false): HandoffPictureRead => ({ ok: false, errorCode: 'NOT_AN_IMAGE',
  message: allowWebp ? 'Pass a PNG, JPEG or WebP picture.' : 'Pass a PNG or JPEG screenshot.' });

function localPath(ref: string, workingDir: string | undefined): string | null {
  try {
    if (ref.startsWith('cindy-media://')) return blobStore.parseBlobUrl(ref) ? blobStore.resolveSafe(ref).absPath : null;
    if (ref.startsWith('xdt-image://')) return imageCacheStore.resolveSafe(ref).absPath;
    if (ref.startsWith('file://')) return fileURLToPath(ref);
  } catch {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) return null;
  if (path.isAbsolute(ref)) return ref;
  return workingDir ? path.resolve(workingDir, ref) : null;
}

async function readFile(file: string, maxBytes = MAX_BYTES, allowWebp = false): Promise<HandoffPictureRead> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) return notFound(allowWebp);
    return { ok: true, bytes: await fs.readFile(file) };
  } catch {
    return notFound(allowWebp);
  }
}

async function readAuthorizedFile(file: string, workingDir: string | undefined, maxBytes: number,
  allowWebp: boolean, isGrantCurrent?: () => boolean): Promise<HandoffPictureRead> {
  const root = workingDir ?? path.dirname(file);
  if (isGrantCurrent?.() === false || !await authorizedSessionPathStillBound(root, file))
    return { ok: false, errorCode: 'PERMISSION_DENIED', message: '图片路径或任务权限已变化，请重试。' };
  try {
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) return notFound(allowWebp);
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, length);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      const bound = await fs.stat(file);
      if (length !== stat.size || bound.dev !== stat.dev || bound.ino !== stat.ino
        || isGrantCurrent?.() === false || !await authorizedSessionPathStillBound(root, file)
        || isGrantCurrent?.() === false)
        return { ok: false, errorCode: 'PERMISSION_DENIED', message: '读取期间图片路径或内容已变化，请重试。' };
      return { ok: true, bytes: bytes.subarray(0, length) };
    } finally {
      await handle.close();
    }
  } catch {
    return notFound(allowWebp);
  }
}

export async function readHandoffPicture(
  ref: string,
  workingDir: string | undefined,
  authorize: (absPath: string) => Promise<SessionPathAuthorization>,
  options: { allowWebp?: boolean; maxBytes?: number } = {},
): Promise<HandoffPictureRead> {
  const trimmed = ref.trim();
  const managedMedia = trimmed.startsWith('cindy-media://') || trimmed.startsWith('xdt-image://');
  // Classifying a local file resolves both the image and its task folder.
  // Reject network/device paths before any lookup, including after file URL decoding.
  if (isNetworkOrDevicePath(trimmed) || (!managedMedia && workingDir && isNetworkOrDevicePath(workingDir)))
    return notFound(options.allowWebp);
  const file = localPath(trimmed, workingDir);
  if (!file || isNetworkOrDevicePath(file)) return notFound(options.allowWebp);
  const maxBytes = Math.min(MAX_BYTES, options.maxBytes ?? MAX_BYTES);
  // Host-managed media of this account; resolveSafe already confined it to the store.
  if (managedMedia) return readFile(file, maxBytes, options.allowWebp);
  const mime = options.allowWebp ? AVATAR_IMAGE_MIME : IMAGE_MIME;
  const source = classifyLocalAttachmentPath(file, workingDir ?? null, { mimeForExt: (ext) => mime[ext] ?? null });
  if (source.kind === 'not-local') return notFound(options.allowWebp);
  if (source.kind === 'unsupported-type') return notAnImage(options.allowWebp);
  let isGrantCurrent: (() => boolean) | undefined;
  if (source.kind === 'outside-workdir') {
    const grant = await authorize(source.absPath);
    if (!grant.allowed) return { ok: false, errorCode: 'PERMISSION_DENIED', message: grant.reason };
    isGrantCurrent = grant.isCurrent;
  }
  return readAuthorizedFile(source.absPath, workingDir, maxBytes, options.allowWebp ?? false, isGrantCurrent);
}
