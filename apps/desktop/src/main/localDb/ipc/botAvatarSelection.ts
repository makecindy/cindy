import path from 'node:path';
import { app } from 'electron';
import { writeBlob } from '../../cindy-media/blobStore.js';
import { recordBlob, type LedgerDb } from '../../cindy-media/ledger.js';
import { sniffImageMime } from '../../lightboxMediaActions.js';
import { throwIpcError } from '../../utils/ipcValidate.js';

import { BOT_AVATAR_MAX_BYTES } from '../../../shared/botAvatarValue.js';
export { BOT_AVATAR_MAX_BYTES };
const BOT_AVATAR_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** Validates host-read avatar bytes instead of trusting the selected extension. */
export function validateBotAvatarBuffer(buffer: Buffer): string {
  if (buffer.byteLength === 0 || buffer.byteLength > BOT_AVATAR_MAX_BYTES) {
    throwIpcError('INVALID_PARAMS', '头像图片必须小于 5 MB');
  }
  const mimeType = sniffImageMime(buffer);
  if (!mimeType || !BOT_AVATAR_MIME_TYPES.has(mimeType)) {
    throwIpcError('INVALID_PARAMS', '头像只支持 PNG、JPEG 或 WebP 图片');
  }
  return mimeType;
}

/** Creation accepts bounded image bytes, never a caller-provided file path or media URL. */
export function decodeBotAvatarImage(value: unknown): { buffer: Buffer; mimeType: string } | null {
  if (value === undefined) return null;
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > Math.ceil(BOT_AVATAR_MAX_BYTES / 3) * 4 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throwIpcError('INVALID_PARAMS', '头像图片格式无效，请重新选择 PNG、JPEG 或 WebP 图片');
  }
  const buffer = Buffer.from(value, 'base64');
  return { buffer, mimeType: validateBotAvatarBuffer(buffer) };
}

/** Shared upload/migration ingress; the caller atomically attaches the returned blob to the profile. */
export async function storeTeammateAvatarImage(
  image: { buffer: Buffer; mimeType: string },
  db: LedgerDb,
  assertCurrent: () => void,
) {
  assertCurrent();
  const written = await writeBlob({ buffer: image.buffer, mimeType: validateBotAvatarBuffer(image.buffer) });
  assertCurrent();
  await recordBlob({ hash: written.hash, ext: written.ext, mimeType: written.mimeType, bytes: written.bytes, isCache: false }, db);
  assertCurrent();
  return written;
}

/** The same bundled gallery used by the picker; no model or renderer is needed. */
export async function readDefaultTeammatePortrait(index: number): Promise<{ buffer: Buffer; mimeType: string }> {
  const { default: sharp } = await import('sharp');
  const root = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
  const image = sharp(path.join(root, 'teammate-portrait-gallery.png'));
  const { width, height } = await image.metadata();
  if (!width || !height || width < 4 || height < 4) throw new Error('Invalid teammate portrait gallery');
  const cell = Math.abs(Math.trunc(index)) % 16;
  const column = cell % 4;
  const row = Math.floor(cell / 4);
  const left = Math.floor(column * width / 4);
  const top = Math.floor(row * height / 4);
  const buffer = await image.extract({
    left, top,
    width: Math.floor((column + 1) * width / 4) - left,
    height: Math.floor((row + 1) * height / 4) - top,
  }).resize(256, 256).png().toBuffer();
  return { buffer, mimeType: validateBotAvatarBuffer(buffer) };
}
