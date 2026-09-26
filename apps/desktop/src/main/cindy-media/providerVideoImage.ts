/** 本地订阅视频参考图的严格、无落盘输入边界。不得记录输入或解码器原始错误。 */
import { crc32 } from 'node:zlib';
import sharp from 'sharp';

export const VIDEO_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const VIDEO_IMAGE_MAX_PIXELS = 16 * 1024 * 1024;
export const VIDEO_IMAGE_MAX_EDGE = 8192;
export const VIDEO_IMAGE_MAX_DATA_URL_LENGTH = Math.ceil(VIDEO_IMAGE_MAX_BYTES / 3) * 4 + 23;
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
let activeDecoders = 0;

export class VideoImageInputError extends Error {
  constructor(readonly code = 'MEDIA_INPUT_INVALID') {
    super(
      code === 'MEDIA_INPUT_BUSY'
        ? '参考图校验繁忙，请稍后重试原准备调用；尚未提交生成'
        : '参考图须为规范 Base64 编码的完整单帧 PNG/JPEG，最多 20 MiB、16777216 像素，最长边 8192；不接受路径或网络 URL',
    );
    this.name = 'VideoImageInputError';
  }
}

function invalid(): never {
  throw new VideoImageInputError();
}

function assertDimensions(width: number | undefined, height: number | undefined): void {
  if (
    !width ||
    !height ||
    width > VIDEO_IMAGE_MAX_EDGE ||
    height > VIDEO_IMAGE_MAX_EDGE ||
    width * height > VIDEO_IMAGE_MAX_PIXELS
  )
    invalid();
}

/** 完整 PNG chunk 边界、CRC 和终止符；不是仅凭八字节文件头认定有效。 */
function assertPngContainer(bytes: Buffer): void {
  if (!bytes.subarray(0, 8).equals(PNG_HEADER)) invalid();
  let offset = 8,
    chunks = 0,
    hasPixels = false;
  while (offset + 12 <= bytes.length) {
    if (++chunks > 4096) invalid();
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) invalid();
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalid();
    if (chunks === 1) {
      if (type !== 'IHDR' || length !== 13) invalid();
      assertDimensions(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12));
    } else if (type === 'IHDR') invalid();
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') invalid();
    if (type === 'IDAT') hasPixels = true;
    if (type === 'IEND') {
      if (length !== 0 || !hasPixels || end !== bytes.length) invalid();
      return;
    }
    offset = end;
  }
  invalid();
}

/** 检查 JPEG marker/scan 边界，要求实际 EOI 位于末尾；像素仍交给完整解码器验证。 */
function assertJpegContainer(bytes: Buffer): void {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) invalid();
  let offset = 2,
    hasScan = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) invalid();
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!hasScan || offset !== bytes.length) invalid();
      return;
    }
    if (marker === 0xd8 || marker === 0 || (marker >= 0xd0 && marker <= 0xd7)) invalid();
    if (marker === 1) continue;
    if (offset + 2 > bytes.length) invalid();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) invalid();
    // SOF dimensions before native allocation (exclude DHT, JPG and DAC markers).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) invalid();
      assertDimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    }
    offset += length;
    if (marker !== 0xda) continue;
    hasScan = true;
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const start = offset++;
      while (bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) invalid();
      const next = bytes[offset];
      if (next === 0 || (next >= 0xd0 && next <= 0xd7)) {
        offset++;
        continue;
      }
      offset = start;
      break;
    }
  }
  invalid();
}

/** 不修改像素或原字节；每次最多两路完整解码，每路限时五秒、最多 64 MiB 原始像素。 */
export async function validateProviderVideoImage(data: string): Promise<string> {
  if (data.length > VIDEO_IMAGE_MAX_DATA_URL_LENGTH) invalid();
  const header = data.startsWith('data:image/png;base64,')
    ? 'data:image/png;base64,'
    : data.startsWith('data:image/jpeg;base64,')
      ? 'data:image/jpeg;base64,'
      : null;
  if (!header) invalid();
  if (activeDecoders >= 2) throw new VideoImageInputError('MEDIA_INPUT_BUSY');
  activeDecoders++;
  let decoder: ReturnType<typeof sharp> | undefined;
  try {
    const encoded = data.slice(header.length);
    if (!encoded.length || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
      invalid();
    const bytes = Buffer.from(encoded, 'base64');
    // Round trip rejects Node's permissive decoding, partial quartets and non-zero padding bits.
    if (
      !bytes.length ||
      bytes.length > VIDEO_IMAGE_MAX_BYTES ||
      bytes.toString('base64') !== encoded
    )
      invalid();
    const format = header.includes('/png;') ? 'png' : 'jpeg';
    if (format === 'png') assertPngContainer(bytes);
    else assertJpegContainer(bytes);
    decoder = sharp(bytes, {
      failOn: 'warning',
      limitInputPixels: VIDEO_IMAGE_MAX_PIXELS,
      limitInputChannels: 4,
      unlimited: false,
      sequentialRead: true,
      pages: 1,
    }).timeout({ seconds: 5 });
    const metadata = await decoder.metadata();
    if (metadata.format !== format || (metadata.pages ?? 1) !== 1) invalid();
    assertDimensions(metadata.width, metadata.height);
    // metadata() alone does not decode IDAT/entropy data. Force every pixel to be decoded.
    const decoded = await decoder.raw().toBuffer({ resolveWithObject: true });
    assertDimensions(decoded.info.width, decoded.info.height);
    if (
      decoded.info.width !== metadata.width ||
      decoded.info.height !== metadata.height ||
      decoded.info.channels < 1 ||
      decoded.info.channels > 4 ||
      decoded.data.length !== decoded.info.width * decoded.info.height * decoded.info.channels
    )
      invalid();
    return data;
  } catch {
    // No raw decoder error, data URL or image body reaches logs/tool errors.
    throw new VideoImageInputError();
  } finally {
    decoder?.destroy();
    activeDecoders--;
  }
}
