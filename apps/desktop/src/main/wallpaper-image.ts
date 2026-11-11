import sharp from 'sharp';
import { throwIpcError } from './utils/ipcValidate.js';

const MAX_BYTES = 20 * 1024 * 1024;

/** Decode real raster bytes, apply orientation, strip metadata and retain a static 4K preview. */
export async function prepareWallpaperImage(bytes: Buffer): Promise<Buffer> {
  if (!bytes.length || bytes.length > MAX_BYTES)
    throwIpcError('INVALID_PARAMS', 'Choose a PNG, JPEG or WebP image up to 20 MB');
  try {
    const image = sharp(bytes, { limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? ''))
      throw new Error('Unsupported image');
    return await image
      .rotate()
      .resize({ width: 3840, height: 3840, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 90 })
      .toBuffer();
  } catch {
    throwIpcError('INVALID_PARAMS', 'Choose a valid PNG, JPEG or WebP image up to 40 megapixels');
  }
}
