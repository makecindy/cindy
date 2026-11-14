/**
 * Deterministic, metadata-free image encoding shared by maker-core and Desktop.
 * The caller decides whether the target route accepts WebP; this module never
 * guesses a remote capability from an image MIME type.
 */

import { createHash } from 'node:crypto';

export type SupportedImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface ImageCompressionRoute {
  providerId?: string;
  modelId?: string;
  /** Proxy supplies the resolved capability. Omitted means false (fail closed). */
  acceptsWebp?: boolean;
}

export interface ImageCompressionBudget {
  maxBytes?: number;
  maxEdgePx?: number;
}

export interface ImageCompressionRequest {
  bytes: Buffer;
  mimeType: string;
  route?: ImageCompressionRoute;
  budget?: ImageCompressionBudget;
}

export interface ImageCompressionResult {
  bytes: Buffer;
  mimeType: string;
  width: number;
  height: number;
  changed: boolean;
  cacheKey: string;
}

type SharpModule = (typeof import('sharp'))['default'];
let sharpInstance: SharpModule | null = null;
let sharpLoadAttempted = false;

function loadSharp(): SharpModule | null {
  if (sharpLoadAttempted) return sharpInstance;
  sharpLoadAttempted = true;
  try {
    const req: NodeJS.Require = typeof require !== 'undefined' ? require : (eval('require') as NodeJS.Require);
    sharpInstance = req('sharp') as SharpModule;
  } catch {
    sharpInstance = null;
  }
  return sharpInstance;
}

function normalizeMime(mimeType: string): SupportedImageMime | null {
  const mime = mimeType.split(';', 1)[0]?.trim().toLowerCase();
  return mime === 'image/jpg' ? 'image/jpeg' : (['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as string[]).includes(mime)
    ? mime as SupportedImageMime
    : null;
}

function versions(sharp: SharpModule | null): string {
  const values = (sharp as unknown as { versions?: Record<string, string> } | null)?.versions;
  if (!values) return 'sharp:unavailable';
  return Object.keys(values).sort().map((key) => `${key}=${values[key]}`).join(',');
}

export function imageCompressionCacheKey(
  bytes: Buffer,
  request: Pick<ImageCompressionRequest, 'mimeType' | 'route' | 'budget'>,
  sharp: SharpModule | null = loadSharp(),
): string {
  const params = JSON.stringify({
    mimeType: normalizeMime(request.mimeType) ?? request.mimeType.toLowerCase(),
    route: {
      providerId: request.route?.providerId ?? null,
      modelId: request.route?.modelId ?? null,
      acceptsWebp: request.route?.acceptsWebp === true,
    },
    budget: request.budget ?? null,
    versions: versions(sharp),
  });
  return createHash('sha256').update(bytes).update('\0').update(params).digest('hex');
}

/**
 * Encode one image. A result is replaced only when it saves at least 15%.
 * GIF and WebP are intentionally returned byte-for-byte unchanged so animated
 * GIFs cannot accidentally become a single still frame.
 */
export async function compressImageBuffer(request: ImageCompressionRequest): Promise<ImageCompressionResult> {
  const bytes = request.bytes;
  const sharp = loadSharp();
  const cacheKey = imageCompressionCacheKey(bytes, request, sharp);
  const originalMime = normalizeMime(request.mimeType) ?? request.mimeType;
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || !sharp) {
    return { bytes, mimeType: originalMime, width: 0, height: 0, changed: false, cacheKey };
  }

  try {
    const input = sharp(bytes, { failOn: 'none' });
    const metadata = await input.metadata();
    const detected = metadata.format === 'png' ? 'image/png'
    : metadata.format === 'jpeg' ? 'image/jpeg'
      : metadata.format === 'webp' ? 'image/webp'
        : metadata.format === 'gif' ? 'image/gif' : normalizeMime(request.mimeType);
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (!detected || detected === 'image/gif' || detected === 'image/webp') {
      return { bytes, mimeType: detected ?? originalMime, width, height, changed: false, cacheKey };
    }

    const maxBytes = request.budget?.maxBytes;
    const maxEdgePx = request.budget?.maxEdgePx;
    const needsBudget = Number.isFinite(maxBytes) && (maxBytes as number) > 0 && bytes.length > (maxBytes as number);
    const wantsResize = Number.isFinite(maxEdgePx) && (maxEdgePx as number) > 0;
    const alpha = metadata.hasAlpha === true;
    const acceptsWebp = request.route?.acceptsWebp === true;

    const encode = async (quality: number | undefined, edge: number | undefined): Promise<{ bytes: Buffer; mimeType: SupportedImageMime }> => {
    let pipeline = sharp(bytes, { failOn: 'none' }).rotate().toColourspace('srgb');
    if (edge && width > 0 && height > 0 && Math.max(width, height) > edge) {
      pipeline = pipeline.resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true });
    }
    if (detected === 'image/png') {
      if (acceptsWebp) {
        return quality === undefined
          ? { bytes: await pipeline.webp({ lossless: true }).toBuffer(), mimeType: 'image/webp' }
          : { bytes: await pipeline.webp({ quality, lossless: false }).toBuffer(), mimeType: 'image/webp' };
      }
      // Budget mode may use lossy JPEG for opaque PNGs when the route does not
      // accept WebP. Normal mode always remains lossless PNG.
      if (quality !== undefined && !alpha) {
        return { bytes: await pipeline.jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer(), mimeType: 'image/jpeg' };
      }
      return { bytes: await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true, palette: false }).toBuffer(), mimeType: 'image/png' };
    }
    if (alpha) {
      return { bytes: await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true, palette: false }).toBuffer(), mimeType: 'image/png' };
    }
    return { bytes: await pipeline.jpeg({ quality: quality ?? 90, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer(), mimeType: 'image/jpeg' };
    };

    let output = await encode(needsBudget ? 90 : undefined, wantsResize ? maxEdgePx : undefined);
    if (needsBudget && maxBytes && output.bytes.length > maxBytes) {
    const edge = maxEdgePx ?? Math.max(width, height);
    output = await encode(90, edge);
    if (output.bytes.length > maxBytes && edge > 1) {
      output = await encode(90, Math.max(1, Math.floor(edge * 0.75)));
    }
    }
  // A normal path must not increase bytes. The 15% threshold is deliberately
  // strict because recompressing history repeatedly is worse than a cache miss.
    if (output.bytes.length >= Math.ceil(bytes.length * 0.85)) {
      return { bytes, mimeType: originalMime, width, height, changed: false, cacheKey };
    }
    const outMeta = await sharp(output.bytes, { failOn: 'none' }).metadata();
    return {
      bytes: output.bytes,
      mimeType: output.mimeType,
      width: outMeta.width ?? width,
      height: outMeta.height ?? height,
      changed: true,
      cacheKey,
    };
  } catch {
    return { bytes, mimeType: originalMime, width: 0, height: 0, changed: false, cacheKey };
  }
}

/** Stable name used by proxy hosts; kept separate from the lower-level helper name. */
export const processBuffer = compressImageBuffer;

export function detectSupportedImageMime(bytes: Buffer): SupportedImageMime | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && /GIF8[79]a/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
