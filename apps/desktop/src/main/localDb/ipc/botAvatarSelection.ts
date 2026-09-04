import { sniffImageMime } from '../../lightboxMediaActions.js';
import { throwIpcError } from '../../utils/ipcValidate.js';

export const BOT_AVATAR_MAX_BYTES = 5 * 1024 * 1024;
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
