import sharp from 'sharp';
import { toSdrAvatarImage } from './hdrAvatarToSdr.js';
import { validateBotAvatarBuffer } from './localDb/ipc/botAvatarSelection.js';
import { throwIpcError } from './utils/ipcValidate.js';

export interface TeammateAvatarCrop { left: number; top: number; width: number; height: number }

/** Crop uses EXIF-oriented original pixels; HDR conversion may resize the working image. */
export async function prepareTeammateAvatarImage(buffer: Buffer, options: {
  crop?: TeammateAvatarCrop;
} = {}): Promise<{ buffer: Buffer; mimeType: string }> {
  const mimeType = validateBotAvatarBuffer(buffer);
  try {
    let crop = options.crop;
    let sourceSize: { width: number; height: number } | undefined;
    if (crop) {
      const { left, top, width, height } = crop;
      if (![left, top, width, height].every(Number.isSafeInteger) || left < 0 || top < 0 || width < 1 || width !== height)
        throw new Error('Invalid crop');
      const source = await sharp(buffer, { limitInputPixels: 40_000_000, failOn: 'error' }).metadata();
      sourceSize = source.autoOrient;
      if (!sourceSize || left + width > sourceSize.width || top + height > sourceSize.height)
        throw new Error('Crop exceeds oriented source');
    }
    const sdr = await toSdrAvatarImage({ buffer, mimeType });
    let image = sharp(sdr.buffer, { limitInputPixels: 40_000_000, failOn: 'error' }).rotate();
    if (crop && sourceSize) {
      // HDR conversion can both orient and downscale. Map the original oriented
      // rectangle to the actual converted dimensions, rounding outward so a
      // valid edge/tiny crop remains in bounds and contains at least one pixel.
      if (sdr.buffer !== buffer) {
        const { autoOrient: size } = await image.metadata();
        const left = Math.floor(crop.left * size.width / sourceSize.width);
        const top = Math.floor(crop.top * size.height / sourceSize.height);
        const right = Math.min(size.width, Math.ceil((crop.left + crop.width) * size.width / sourceSize.width));
        const bottom = Math.min(size.height, Math.ceil((crop.top + crop.height) * size.height / sourceSize.height));
        crop = { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
      }
      image = image.extract(crop);
    }
    image = image.resize(256, 256, { fit: 'cover', position: 'centre' });
    const output = await image.png().toBuffer();
    validateBotAvatarBuffer(output);
    return { buffer: output, mimeType: 'image/png' };
  } catch {
    throwIpcError('INVALID_PARAMS', '头像无法解码或裁剪，请选择有效图片');
  }
}
