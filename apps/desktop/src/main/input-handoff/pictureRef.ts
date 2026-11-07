import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionPathAuthorization } from '@cindy/mcps';
import * as blobStore from '../cindy-media/blobStore.js';
import { classifyLocalAttachmentPath } from '../cindy-brain/ghostLocalPathGrant.js';
import * as imageCacheStore from '../imageCacheStore.js';

/**
 * Reads the screenshot an agent passes to ask_owner(kind="scan"): a local
 * image path (relative to the task folder) or a managed media URL. The bytes
 * only feed the host's QR reader; nothing from them goes back to the agent.
 * A file outside the task folder goes through the task's file grant first,
 * as media.import_image does.
 */

const MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_MIME: Readonly<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

export type HandoffPictureRead =
  | { ok: true; bytes: Buffer }
  | { ok: false; errorCode: 'IMAGE_NOT_FOUND' | 'NOT_AN_IMAGE' | 'PERMISSION_DENIED'; message: string };

const notFound = (): HandoffPictureRead => ({
  ok: false,
  errorCode: 'IMAGE_NOT_FOUND',
  message: 'Cindy cannot read that picture. Pass the path of a PNG or JPEG screenshot (absolute, or relative to the task folder), or a cindy-media:// URL.',
});

const notAnImage = (): HandoffPictureRead => ({ ok: false, errorCode: 'NOT_AN_IMAGE', message: 'Pass a PNG or JPEG screenshot.' });

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

async function readFile(file: string): Promise<HandoffPictureRead> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BYTES) return notFound();
    return { ok: true, bytes: await fs.readFile(file) };
  } catch {
    return notFound();
  }
}

export async function readHandoffPicture(
  ref: string,
  workingDir: string | undefined,
  authorize: (absPath: string) => Promise<SessionPathAuthorization>,
): Promise<HandoffPictureRead> {
  const trimmed = ref.trim();
  const file = localPath(trimmed, workingDir);
  if (!file) return notFound();
  // Host-managed media of this account; resolveSafe already confined it to the store.
  if (trimmed.startsWith('cindy-media://') || trimmed.startsWith('xdt-image://')) return readFile(file);
  const source = classifyLocalAttachmentPath(file, workingDir ?? null, { mimeForExt: (ext) => IMAGE_MIME[ext] ?? null });
  if (source.kind === 'not-local') return notFound();
  if (source.kind === 'unsupported-type') return notAnImage();
  if (source.kind === 'outside-workdir') {
    const grant = await authorize(source.absPath);
    if (!grant.allowed) return { ok: false, errorCode: 'PERMISSION_DENIED', message: grant.reason };
  }
  return readFile(source.absPath);
}
