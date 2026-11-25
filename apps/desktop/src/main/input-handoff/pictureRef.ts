import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionPathAuthorization } from '@cindy/mcps';
import * as blobStore from '../cindy-media/blobStore.desktop.js';
import { classifyLocalAttachmentPath } from '../cindy-brain/ghostLocalPathGrant.js';
import * as imageCacheStore from '../imageCacheStore.desktop.js';

/**
 * Reads the screenshot an agent passes to request_input_handoff(image): a local
 * image path (relative to the task folder) or a managed media URL. The bytes
 * only feed the host's QR reader; nothing from them goes back to the agent.
 * A file outside the task folder goes through the task's file grant first,
 * as media.import_image does. WebP (what Cindy's own browser screenshots are)
 * is turned into PNG here, since the QR reader only decodes PNG and JPEG.
 */

const MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};

export type HandoffPictureRead =
  | { ok: true; bytes: Buffer }
  | { ok: false; errorCode: 'IMAGE_NOT_FOUND' | 'NOT_AN_IMAGE' | 'PERMISSION_DENIED'; message: string };

const notFound = (): HandoffPictureRead => ({
  ok: false,
  errorCode: 'IMAGE_NOT_FOUND',
  message: 'Cindy cannot read that picture. Pass the path of a PNG, JPEG or WebP screenshot (absolute, or relative to the task folder), or a cindy-media:// URL.',
});

// The agent may run on another computer than Cindy (a remote agent): its own files are not here.
const missingHere = (file: string): HandoffPictureRead => ({
  ok: false,
  errorCode: 'IMAGE_NOT_FOUND',
  message: `There is no file at ${file} on the computer running Cindy. If the screenshot was saved where the agent runs (a remote agent), save it into the task folder or pass a cindy-media:// URL instead.`,
});

const notAnImage = (): HandoffPictureRead => ({ ok: false, errorCode: 'NOT_AN_IMAGE', message: 'Pass a PNG, JPEG or WebP screenshot.' });

const isWebp = (bytes: Buffer) => bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP';

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
  let bytes: Buffer;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BYTES) return notFound();
    bytes = await fs.readFile(file);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? missingHere(file) : notFound();
  }
  if (!isWebp(bytes)) return { ok: true, bytes };
  try {
    // Loaded on demand: most screenshots are PNG, and the native image library is heavy at startup.
    const { default: sharp } = await import('sharp');
    return { ok: true, bytes: await sharp(bytes, { limitInputPixels: 40_000_000 }).png().toBuffer() };
  } catch {
    return notAnImage();
  } finally {
    bytes.fill(0);
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
  if (source.kind === 'not-local') return (await fs.stat(file).then(() => true, () => false)) ? notFound() : missingHere(file);
  if (source.kind === 'unsupported-type') return notAnImage();
  if (source.kind === 'outside-workdir') {
    const grant = await authorize(source.absPath);
    if (!grant.allowed) return { ok: false, errorCode: 'PERMISSION_DENIED', message: grant.reason };
  }
  return readFile(source.absPath);
}
