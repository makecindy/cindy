import type { NativeImage } from 'electron';
import sharp from 'sharp';

const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Large opaque PNGs use the existing libvips thread pool. NativeImage owns
 * premultiplied BGRA pixels, so translucent images retain Electron's exact
 * unpremultiplication and encoding. JPEG quality and small exports stay native. */
export async function encodeScreenshotImage(image: NativeImage, jpeg = false): Promise<Buffer> {
  if (jpeg) return image.toJPEG(92);
  const { width, height } = image.getSize();
  if (!littleEndian || width * height < 2_000_000) return image.toPNG();
  const bitmap = image.toBitmap();
  if (bitmap.byteOffset % 4 !== 0 || bitmap.byteLength !== width * height * 4) return image.toPNG();
  const pixels = new Uint32Array(bitmap.buffer, bitmap.byteOffset, bitmap.byteLength / 4);
  // toBitmap returns a copy. Swapping that owned buffer avoids another full
  // RGBA allocation and cannot mutate the NativeImage used by other actions.
  for (let i = 0; i < pixels.length; i++) {
    const pixel = pixels[i];
    if ((pixel >>> 24) !== 255) return image.toPNG();
    pixels[i] = (pixel & 0xff00ff00) | ((pixel & 0xff) << 16) | ((pixel >>> 16) & 0xff);
  }
  try {
    return await sharp(bitmap, { raw: { width, height, channels: 4 } }).removeAlpha().png({ compressionLevel: 3, adaptiveFiltering: true }).toBuffer();
  } catch {
    // An encoder failure must not break save.
    return image.toPNG();
  }
}
