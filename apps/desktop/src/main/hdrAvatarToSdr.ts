/**
 * hdrAvatarToSdr.ts — 头像入口的 HDR → SDR 归一化。
 * ---------------------------------------------------------------------------
 * 头像会在列表、通知、手机端等大量 SDR 语境里与其它界面元素并排显示；HDR 头像
 * 在 HDR 屏上会比周围 UI 亮出一截（高光刺眼），在不同端又各自走不同的色调映射。
 * 因此用户上传的头像在入库 / 上传前就转成真正的 SDR 字节，而不是靠 CSS 调暗。
 *
 * 只处理头像白名单（PNG / JPEG / WebP）里浏览器会按 HDR 渲染的两类信号：
 *   1. 增益图（gain map）JPEG：以 libvips 从文件结构解析出的增益图为准（Ultra HDR /
 *      ISO 21496-1，即 sharp `metadata.gainMap`），不按元数据里的字符串猜测。
 *      主图本身就是 SDR 版本，丢弃增益图与相关元数据后按主图重编码即可；
 *   2. PQ / HLG 传递函数：PNG `cICP` 块或 ICC v4.4 `cicp` 标签声明 transfer=16/18。
 *      这类像素本身是 HDR 编码，需解码到线性光 → 转 BT.709 色域 → 高光压缩 →
 *      sRGB 编码为 8-bit。
 * 其它输入（含一切 SDR 图片、无法解析头部的字节）原样返回，保证既有 SDR 头像的
 * 字节、颜色、方向、透明度与尺寸行为完全不变。
 */

import sharp, { type Metadata, type Sharp } from 'sharp';
import { throwIpcError } from './utils/ipcValidate';

export interface AvatarImageBytes {
  buffer: Buffer;
  mimeType: string;
}

type AvatarFormat = 'png' | 'jpeg' | 'webp';
type HdrTransfer = 'pq' | 'hlg';

interface Cicp {
  primaries: number;
  transfer: number;
  fullRange: boolean;
}

/** H.273 TransferCharacteristics：16 = SMPTE ST 2084 (PQ)，18 = ARIB STD-B67 (HLG)。 */
const H273_TRANSFER_PQ = 16;
const H273_TRANSFER_HLG = 18;

/** BT.2408 的 HDR 参考白（203 cd/m²）对应 SDR 的 1.0。 */
const HDR_REFERENCE_WHITE_NITS = 203;
/** 无 cLLI 时 PQ 内容的假定峰值，及 HLG 的标称显示峰值（BT.2100 Lw = 1000）。 */
const DEFAULT_HDR_PEAK_NITS = 1000;
/** 线性 SDR 中低于该值的部分保持不变，只把以上到峰值的高光平滑压进 (knee, 1]。 */
const TONE_MAP_KNEE = 0.8;
/**
 * 两条转换路径的输出像素上限；超出先等比缩小。头像展示远小于 2048²，按此上限单次
 * PQ / HLG 转换在 main 进程持有的像素缓冲 ≤ 48 MiB（16-bit RGBA 32 MiB + 8-bit 输出 16 MiB）。
 */
const HDR_MAX_PIXELS = 2048 * 2048;
/**
 * 源图像素上限：≤5 MB 的 PNG / WebP 也能声明上亿像素，超出时在解码前按头部尺寸拒绝，
 * 并作为每次解码的 limitInputPixels 兜底（sharp 默认上限约 2.7 亿）。覆盖 4800 万像素手机原片。
 */
const HDR_MAX_INPUT_PIXELS = 64_000_000;
/** 每处理这么多像素让出一次事件循环，避免长时间阻塞 main。 */
const PIXELS_PER_YIELD = 1 << 18;

function sniffFormat(buffer: Buffer): AvatarFormat | null {
  if (
    buffer.length >= 8 &&
    buffer.readUInt32BE(0) === 0x89504e47 &&
    buffer.readUInt32BE(4) === 0x0d0a1a0a
  ) {
    return 'png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return 'jpeg';
  if (
    buffer.length >= 12 &&
    buffer.toString('latin1', 0, 4) === 'RIFF' &&
    buffer.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

/**
 * 读取 IDAT 之前的 cICP / cLLI 块，以及标记 APNG 的 acTL 块（PNG / APNG 规范要求三者
 * 都出现在 IDAT 之前）。
 */
export function readPngHdrChunks(buffer: Buffer): {
  cicp: Cicp | null;
  maxCllNits: number | null;
  animated: boolean;
} {
  let cicp: Cicp | null = null;
  let maxCllNits: number | null = null;
  let animated = false;
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = offset + 8;
    if (type === 'IDAT' || type === 'IEND' || data + length > buffer.length) break;
    if (type === 'cICP' && length === 4) {
      cicp = {
        primaries: buffer[data]!,
        transfer: buffer[data + 1]!,
        fullRange: buffer[data + 3] !== 0,
      };
    } else if (type === 'cLLI' && length === 8) {
      // MaxCLL 单位 0.0001 cd/m²；0 表示未知。
      const value = buffer.readUInt32BE(data) / 10_000;
      maxCllNits = value > 0 ? value : null;
    } else if (type === 'acTL') {
      animated = true;
    }
    offset = data + length + 4;
  }
  return { cicp, maxCllNits, animated };
}

/** 读取 ICC v4.4 的 `cicp` 标签；没有或结构不完整时返回 null。 */
export function readIccCicp(icc: Buffer | undefined): Cicp | null {
  if (!icc || icc.length < 132) return null;
  const count = icc.readUInt32BE(128);
  for (let index = 0; index < count; index++) {
    const entry = 132 + index * 12;
    if (entry + 12 > icc.length) return null;
    if (icc.toString('latin1', entry, entry + 4) !== 'cicp') continue;
    const offset = icc.readUInt32BE(entry + 4);
    const size = icc.readUInt32BE(entry + 8);
    if (
      size < 12 ||
      offset + 12 > icc.length ||
      icc.toString('latin1', offset, offset + 4) !== 'cicp'
    ) {
      return null;
    }
    return {
      primaries: icc[offset + 8]!,
      transfer: icc[offset + 9]!,
      fullRange: icc[offset + 11] !== 0,
    };
  }
  return null;
}

function hdrTransferOf(cicp: Cicp | null): HdrTransfer | null {
  if (cicp?.transfer === H273_TRANSFER_PQ) return 'pq';
  if (cicp?.transfer === H273_TRANSFER_HLG) return 'hlg';
  return null;
}

// ── 色彩数学 ────────────────────────────────────────────────────────────────

type Mat3 = [number, number, number, number, number, number, number, number, number];
type Chromaticities = {
  r: [number, number];
  g: [number, number];
  b: [number, number];
  white: [number, number];
};

const D65: [number, number] = [0.3127, 0.329];
/** CIE 标准光源 C（BT.470 System M 与通用胶片原色的白点）。 */
const ILLUMINANT_C: [number, number] = [0.31, 0.316];
const BT709: Chromaticities = { r: [0.64, 0.33], g: [0.3, 0.6], b: [0.15, 0.06], white: D65 };
/** BT.601 525 行（SMPTE 170M / 240M）。 */
const SMPTE_170M: Chromaticities = {
  r: [0.63, 0.34],
  g: [0.31, 0.595],
  b: [0.155, 0.07],
  white: D65,
};
const BT2020: Chromaticities = {
  r: [0.708, 0.292],
  g: [0.17, 0.797],
  b: [0.131, 0.046],
  white: D65,
};
const P3_D65: Chromaticities = { r: [0.68, 0.32], g: [0.265, 0.69], b: [0.15, 0.06], white: D65 };
/** SMPTE ST 431-2：与 P3-D65 同原色，但白点是 DCI 白。 */
const DCI_P3: Chromaticities = { ...P3_D65, white: [0.314, 0.351] };
const BRADFORD: Mat3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];

/**
 * H.273 ColourPrimaries → 色度。2（未指定）按 HDR 惯例视为 BT.2020；10（ST 428-1 XYZ）
 * 与保留值无法用 RGB 原色表达，返回 null 由调用方拒绝，不猜色域。
 */
const PRIMARIES_BY_CODE: Record<number, Chromaticities> = {
  1: BT709,
  2: BT2020,
  4: { r: [0.67, 0.33], g: [0.21, 0.71], b: [0.14, 0.08], white: ILLUMINANT_C },
  5: { r: [0.64, 0.33], g: [0.29, 0.6], b: [0.15, 0.06], white: D65 },
  6: SMPTE_170M,
  7: SMPTE_170M,
  8: { r: [0.681, 0.319], g: [0.243, 0.692], b: [0.145, 0.049], white: ILLUMINANT_C },
  9: BT2020,
  11: DCI_P3,
  12: P3_D65,
  22: { r: [0.63, 0.34], g: [0.295, 0.605], b: [0.155, 0.077], white: D65 },
};

function primariesFor(code: number): Chromaticities | null {
  return PRIMARIES_BY_CODE[code] ?? null;
}

function multiply(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9).fill(0) as Mat3;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] =
        a[row * 3]! * b[col]! + a[row * 3 + 1]! * b[3 + col]! + a[row * 3 + 2]! * b[6 + col]!;
    }
  }
  return out;
}

function invert(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det,
    -(b * i - c * h) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    -(a * f - c * d) / det,
    C / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det,
  ];
}

function xyToXyz([x, y]: [number, number]): [number, number, number] {
  return [x / y, 1, (1 - x - y) / y];
}

function apply(m: Mat3, [x, y, z]: [number, number, number]): [number, number, number] {
  return [
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z,
  ];
}

function diagonal([a, b, c]: [number, number, number]): Mat3 {
  return [a, 0, 0, 0, b, 0, 0, 0, c];
}

/**
 * 由 RGB 原色与其白点推导线性 RGB → XYZ 矩阵；白点不是 D65 时再经 Bradford 色适应到 D65，
 * 与后续 BT.709 / sRGB 的 D65 目标对齐。
 */
function rgbToXyz({ r, g, b, white }: Chromaticities): Mat3 {
  const [rx, ry, rz] = xyToXyz(r);
  const [gx, gy, gz] = xyToXyz(g);
  const [bx, by, bz] = xyToXyz(b);
  const primaries: Mat3 = [rx, gx, bx, ry, gy, by, rz, gz, bz];
  const toXyz = multiply(primaries, diagonal(apply(invert(primaries), xyToXyz(white))));
  if (white === D65) return toXyz;
  const [ls, ms, ss] = apply(BRADFORD, xyToXyz(white));
  const [ld, md, sd] = apply(BRADFORD, xyToXyz(D65));
  const scale = diagonal([ld / ls, md / ms, sd / ss]);
  return multiply(multiply(invert(BRADFORD), multiply(scale, BRADFORD)), toXyz);
}

function pqToNits(encoded: number): number {
  const m1 = 2610 / 16384;
  const m2 = (2523 / 4096) * 128;
  const c1 = 3424 / 4096;
  const c2 = (2413 / 4096) * 32;
  const c3 = (2392 / 4096) * 32;
  const p = Math.pow(Math.max(encoded, 0), 1 / m2);
  return 10_000 * Math.pow(Math.max(p - c1, 0) / (c2 - c3 * p), 1 / m1);
}

/** BT.2100 HLG 逆 OETF：非线性信号 → 归一化场景线性光 [0, 1]。 */
function hlgToSceneLinear(encoded: number): number {
  const a = 0.17883277;
  const b = 1 - 4 * a;
  const c = 0.5 - a * Math.log(4 * a);
  const e = Math.max(encoded, 0);
  return e <= 0.5 ? (e * e) / 3 : (Math.exp((e - c) / a) + b) / 12;
}

function srgbEncode(linear: number): number {
  return linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
}

/** maxRGB 高光压缩：knee 以下恒等，(knee, peak] 用扩展 Reinhard 平滑压进 (knee, 1]。 */
function toneMapMax(max: number, peak: number): number {
  if (max <= TONE_MAP_KNEE || peak <= 1) return Math.min(max, 1);
  if (max >= peak) return 1;
  const t = (max - TONE_MAP_KNEE) / (1 - TONE_MAP_KNEE);
  const white = (peak - TONE_MAP_KNEE) / (1 - TONE_MAP_KNEE);
  return TONE_MAP_KNEE + (1 - TONE_MAP_KNEE) * ((t * (1 + t / (white * white))) / (1 + t));
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

// ── 转换 ────────────────────────────────────────────────────────────────────

async function encode(pipeline: Sharp, format: AvatarFormat): Promise<AvatarImageBytes> {
  if (format === 'png') return { buffer: await pipeline.png().toBuffer(), mimeType: 'image/png' };
  if (format === 'webp')
    return { buffer: await pipeline.webp({ quality: 90 }).toBuffer(), mimeType: 'image/webp' };
  return { buffer: await pipeline.jpeg({ quality: 90 }).toBuffer(), mimeType: 'image/jpeg' };
}

/**
 * 两条转换路径共用的解码入口：EXIF 方向烘焙进像素，源图受 HDR_MAX_INPUT_PIXELS 约束，
 * 按旋转后的尺寸超出 HDR_MAX_PIXELS 时等比缩小。
 */
function openHdrSource(buffer: Buffer, metadata: Metadata, ignoreIcc: boolean): Sharp {
  const pipeline = sharp(buffer, {
    ignoreIcc,
    autoOrient: true,
    limitInputPixels: HDR_MAX_INPUT_PIXELS,
  });
  const width = metadata.autoOrient?.width ?? metadata.width ?? 0;
  const height = metadata.autoOrient?.height ?? metadata.height ?? 0;
  if (width * height <= HDR_MAX_PIXELS) return pipeline;
  const scale = Math.sqrt(HDR_MAX_PIXELS / (width * height));
  return pipeline.resize(
    Math.max(1, Math.floor(width * scale)),
    Math.max(1, Math.floor(height * scale)),
    { fit: 'fill' },
  );
}

/**
 * 增益图 JPEG：主图即 SDR 版本。sharp 默认不保留增益图、XMP 与 MPF 次图，
 * 保留主图 ICC（常见为 Display P3）以免改变 SDR 颜色。
 */
async function dropGainMap(buffer: Buffer, metadata: Metadata): Promise<AvatarImageBytes> {
  return encode(openHdrSource(buffer, metadata, false).keepIccProfile(), 'jpeg');
}

async function toneMapToSdr(
  buffer: Buffer,
  metadata: Metadata,
  format: AvatarFormat,
  cicp: Cicp,
  primaries: Chromaticities,
  transfer: HdrTransfer,
  maxCllNits: number | null,
): Promise<AvatarImageBytes> {
  const wide = metadata.depth === 'ushort';
  // ignoreIcc：像素必须保持 PQ / HLG 编码原值，不能先被 lcms 按 ICC 转成 sRGB（会过曝裁切）。
  const { data, info } = await openHdrSource(buffer, metadata, true)
    .toColourspace(wide ? 'rgb16' : 'srgb')
    .raw({ depth: wide ? 'ushort' : 'uchar' })
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  if (channels < 3) throw new Error('unexpected channel count');
  const source = wide
    ? new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const maxCode = wide ? 65535 : 255;

  // 码值 → 线性：PQ 直接到「相对参考白」的显示线性；HLG 先到场景线性，OOTF 需逐像素亮度。
  const narrowScale = wide ? 256 : 1;
  const decode = new Float32Array(maxCode + 1);
  for (let code = 0; code <= maxCode; code++) {
    const signal = cicp.fullRange
      ? code / maxCode
      : (code - 16 * narrowScale) / (219 * narrowScale);
    decode[code] =
      transfer === 'pq' ? pqToNits(signal) / HDR_REFERENCE_WHITE_NITS : hlgToSceneLinear(signal);
  }
  const encodeLut = new Uint8Array(65536);
  for (let index = 0; index < encodeLut.length; index++) {
    encodeLut[index] = Math.round(srgbEncode(index / 65535) * 255);
  }

  const sourceToXyz = rgbToXyz(primaries);
  const toBt709 = multiply(invert(rgbToXyz(BT709)), sourceToXyz);
  const [yr, yg, yb] = [sourceToXyz[3], sourceToXyz[4], sourceToXyz[5]];
  const peakNits =
    transfer === 'pq'
      ? Math.min(Math.max(maxCllNits ?? DEFAULT_HDR_PEAK_NITS, HDR_REFERENCE_WHITE_NITS), 10_000)
      : DEFAULT_HDR_PEAK_NITS;
  const peak = peakNits / HDR_REFERENCE_WHITE_NITS;

  const pixels = info.width * info.height;
  const out = Buffer.alloc(pixels * channels);
  for (let start = 0; start < pixels; start += PIXELS_PER_YIELD) {
    const end = Math.min(pixels, start + PIXELS_PER_YIELD);
    for (let pixel = start; pixel < end; pixel++) {
      const i = pixel * channels;
      let r = decode[source[i]!]!;
      let g = decode[source[i + 1]!]!;
      let b = decode[source[i + 2]!]!;
      if (transfer === 'hlg') {
        // BT.2100 OOTF（γ = 1.2，Lw = 1000）后再相对参考白归一。
        const ys = yr * r + yg * g + yb * b;
        const gain =
          (DEFAULT_HDR_PEAK_NITS * Math.pow(Math.max(ys, 0), 0.2)) / HDR_REFERENCE_WHITE_NITS;
        r *= gain;
        g *= gain;
        b *= gain;
      }
      const lr = Math.max(0, toBt709[0] * r + toBt709[1] * g + toBt709[2] * b);
      const lg = Math.max(0, toBt709[3] * r + toBt709[4] * g + toBt709[5] * b);
      const lb = Math.max(0, toBt709[6] * r + toBt709[7] * g + toBt709[8] * b);
      const max = Math.max(lr, lg, lb);
      const scale = max > 0 ? toneMapMax(max, peak) / max : 0;
      out[i] = encodeLut[Math.round(Math.min(lr * scale, 1) * 65535)]!;
      out[i + 1] = encodeLut[Math.round(Math.min(lg * scale, 1) * 65535)]!;
      out[i + 2] = encodeLut[Math.round(Math.min(lb * scale, 1) * 65535)]!;
      // Alpha 为直通（非预乘）通道，只做位深缩放。
      if (channels === 4)
        out[i + 3] = wide ? Math.round((source[i + 3]! * 255) / 65535) : source[i + 3]!;
    }
    if (end < pixels) await yieldToEventLoop();
  }
  // 输出不带 ICC / cICP / EXIF，即隐式 sRGB 8-bit；方向已在解码时烘焙。
  return encode(
    sharp(out, { raw: { width: info.width, height: info.height, channels: channels as 3 | 4 } }),
    format,
  );
}

/**
 * 头像入口统一调用：HDR 输入返回转换后的 SDR 字节与真实 MIME，其它输入原样返回
 * 同一对象。头部无法解析且字节中没有 HDR 信号时按既有行为放行；带 HDR 信号却无法
 * 解析、超限、为多帧动画或转换失败时一律拒绝，不把 HDR 字节静默落库或上传，也不把
 * 动画静默压成首帧。
 */
export async function toSdrAvatarImage(image: AvatarImageBytes): Promise<AvatarImageBytes> {
  const format = sniffFormat(image.buffer);
  if (!format) return image;
  const png =
    format === 'png'
      ? readPngHdrChunks(image.buffer)
      : { cicp: null, maxCllNits: null, animated: false };
  let metadata: Metadata;
  try {
    // 只读头部、不解码像素：关闭默认像素上限，超大 HDR 才能被识别并在下方按尺寸拒绝。
    metadata = await sharp(image.buffer, { limitInputPixels: false }).metadata();
  } catch {
    if (hdrTransferOf(png.cicp)) {
      throwIpcError('INVALID_PARAMS', 'HDR avatar could not be converted to SDR');
    }
    return image;
  }
  // PNG 规范：cICP 优先于 iCCP；其它格式只有 ICC 能声明传递函数。
  const cicp = png.cicp ?? readIccCicp(metadata.icc);
  const transfer = hdrTransferOf(cicp);
  const gainMap = format === 'jpeg' && Boolean(metadata.gainMap);
  if (!transfer && !gainMap) return image;
  // 转换只处理单帧：动画 WebP（pages > 1）与 APNG（acTL；libvips 只读首帧）都会丢帧。
  if ((metadata.pages ?? 1) > 1 || png.animated) {
    throwIpcError('INVALID_PARAMS', 'Animated HDR avatars cannot be converted to SDR');
  }
  if ((metadata.width ?? 0) * (metadata.height ?? 0) > HDR_MAX_INPUT_PIXELS) {
    throwIpcError('INVALID_PARAMS', 'HDR avatar dimensions exceed the conversion limit');
  }
  const primaries = cicp ? primariesFor(cicp.primaries) : null;
  if (transfer && !primaries) {
    throwIpcError('INVALID_PARAMS', 'HDR avatar declares unsupported colour primaries');
  }
  try {
    return transfer && cicp && primaries
      ? await toneMapToSdr(image.buffer, metadata, format, cicp, primaries, transfer, png.maxCllNits)
      : await dropGainMap(image.buffer, metadata);
  } catch {
    throwIpcError('INVALID_PARAMS', 'HDR avatar could not be converted to SDR');
  }
}
