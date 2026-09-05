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
