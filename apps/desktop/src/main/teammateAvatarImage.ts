import sharp from 'sharp';
import { toSdrAvatarImage } from './hdrAvatarToSdr.js';
import { validateBotAvatarBuffer } from './localDb/ipc/botAvatarSelection.js';
import { throwIpcError } from './utils/ipcValidate.js';

export interface TeammateAvatarCrop { left: number; top: number; width: number; height: number }

/** Decode actual pixels, orient, crop, and remove metadata before local avatar binding. */
export async function prepareTeammateAvatarImage(buffer: Buffer, options: {
  crop?: TeammateAvatarCrop;
} = {}): Promise<{ buffer: Buffer; mimeType: string }> {
  const mimeType = validateBotAvatarBuffer(buffer);
  try {
    const sdr = await toSdrAvatarImage({ buffer, mimeType });
    let image = sharp(sdr.buffer, { limitInputPixels: 40_000_000, failOn: 'error' }).rotate();
    if (options.crop) {
      const { left, top, width, height } = options.crop;
      if (![left, top, width, height].every(Number.isSafeInteger) || left < 0 || top < 0 || width < 1 || width !== height)
        throw new Error('Invalid crop');
      image = image.extract({ left, top, width, height });
    }
    image = image.resize(256, 256, { fit: 'cover', position: 'centre' });
    const output = await image.png().toBuffer();
    validateBotAvatarBuffer(output);
    return { buffer: output, mimeType: 'image/png' };
  } catch {
    throwIpcError('INVALID_PARAMS', '头像无法解码或裁剪，请选择有效图片');
  }
}
