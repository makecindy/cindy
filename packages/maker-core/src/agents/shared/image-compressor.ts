/**
 * Deterministic image encoding (metadata-free when re-encoding) shared by maker-core and Desktop.
 * The caller decides whether the target route accepts WebP; this module never
 * guesses a remote capability from an image MIME type.
 */

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

export type SupportedImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface ImageCompressionRoute {
  providerId?: string;
  modelId?: string;
  /** Proxy supplies the resolved capability. Omitted means false (fail closed). */
  acceptsWebp?: boolean;
  /** Explicit upstream refusal; ordinary WebP preparation must use PNG. */
  rejectsWebp?: boolean;
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

// Process-local provenance shared by the path resizer and proxy callback.
// Keep only 512 SHA-256 digests, never source pixels; evict least recently used.
const compressedOutputs = new Set<string>();
const outputDigest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export function rememberCompressedImage(bytes: Buffer): void {
  const hash = outputDigest(bytes);
  compressedOutputs.delete(hash);
  compressedOutputs.add(hash);
  if (compressedOutputs.size > 512) compressedOutputs.delete(compressedOutputs.values().next().value!);
}

export function isCompressedImageOutput(bytes: Buffer): boolean {
  const hash = outputDigest(bytes);
  if (!compressedOutputs.has(hash)) return false;
  compressedOutputs.delete(hash);
  compressedOutputs.add(hash);
  return true;
}

type SharpModule = (typeof import('sharp'))['default'];
let sharpInstance: SharpModule | null = null;
let sharpLoadAttempted = false;

function loadSharp(): SharpModule | null {
  if (sharpLoadAttempted) return sharpInstance;
  sharpLoadAttempted = true;
  try {
    const req = createRequire(import.meta.url);
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
      rejectsWebp: request.route?.rejectsWebp === true,
    },
    budget: { maxBytes: request.budget?.maxBytes ?? null, maxEdgePx: request.budget?.maxEdgePx ?? null },
    policy: { revision: 4, quality: 90, mozjpeg: true, chromaSubsampling: '4:4:4', pngLevel: 9, adaptiveFiltering: true, palette: false, colourspace: 'srgb', autoOrient: true, minSaving: 0.15, scale: 0.75, steps: 4 },
    versions: versions(sharp),
  });
  return createHash('sha256').update(bytes).update('\0').update(params).digest('hex');
}

/** Encoding from original bytes; each budget attempt starts from the source. */
export async function compressImageBuffer(request: ImageCompressionRequest): Promise<ImageCompressionResult> {
  const { bytes } = request;
  const sharp = loadSharp();
  const cacheKey = imageCompressionCacheKey(bytes, request, sharp);
  const originalMime = detectSupportedImageMime(bytes) ?? request.mimeType;
  let width = 0;
  let height = 0;
  const unchanged = (): ImageCompressionResult => ({ bytes, mimeType: originalMime, width, height, changed: false, cacheKey });
  if (!bytes.length || !sharp || !detectSupportedImageMime(bytes)) return unchanged();
  try {
    const meta = await sharp(bytes, { failOn: 'error', limitInputPixels: 100_000_000 }).metadata();
    const rotated = (meta.orientation ?? 0) >= 5;
    width = (rotated ? meta.height : meta.width) ?? 0;
    height = (rotated ? meta.width : meta.height) ?? 0;
    // Never flatten any animated container, including APNG/animated WebP.
    if ((meta.pages ?? 1) > 1) return unchanged();
    const maxBytes = request.budget?.maxBytes;
    const budget = maxBytes !== undefined;
    if (budget && (!Number.isFinite(maxBytes) || maxBytes <= 0)) return unchanged();
    const maxEdge = request.budget?.maxEdgePx;
    // Ordinary proxy preparation preserves JPEG bytes. The attachment resizer
    // supplies maxEdgePx and retains its existing q90 policy; tighten supplies
    // maxBytes and may still encode the original to meet an upstream limit.
    if (!budget && maxEdge === undefined && originalMime === 'image/jpeg') return unchanged();
    const resize = maxEdge !== undefined && Number.isFinite(maxEdge) && maxEdge > 0 && Math.max(width, height) > maxEdge;
    const convertRejectedWebp = request.budget === undefined && originalMime === 'image/webp' && request.route?.rejectsWebp === true;
    if (!budget && !resize && !convertRejectedWebp && (originalMime === 'image/webp' || originalMime === 'image/gif')) return unchanged();
    if (budget && bytes.length <= maxBytes) return unchanged();
    const webp = request.route?.acceptsWebp === true;
    let edge = resize && !budget ? Math.floor(maxEdge) : Math.max(width, height);
    for (let step = 0; step <= (budget ? 4 : 0); step++) {
      let pipeline = sharp(bytes, { failOn: 'error', limitInputPixels: 100_000_000 }).rotate().toColourspace('srgb');
      if (edge < Math.max(width, height)) pipeline = pipeline.resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true });
      let mimeType: SupportedImageMime;
      if (convertRejectedWebp) {
        mimeType = 'image/png';
      } else if (originalMime === 'image/jpeg') {
        mimeType = 'image/jpeg';
      } else if (originalMime === 'image/webp' && !budget) {
        mimeType = 'image/webp';
      } else if (webp && originalMime !== 'image/gif') {
        mimeType = 'image/webp';
      } else {
        mimeType = budget && !meta.hasAlpha ? 'image/jpeg' : 'image/png';
      }
      if (mimeType === 'image/jpeg') pipeline = pipeline.jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: '4:4:4' });
      else if (mimeType === 'image/webp') pipeline = pipeline.webp(budget || originalMime === 'image/webp' ? { quality: 90 } : { lossless: true });
      else pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true, palette: false });
      const output = await pipeline.toBuffer({ resolveWithObject: true });
      if (budget && output.data.length > maxBytes) {
        edge = Math.max(1, Math.floor(edge * 0.75));
        continue;
      }
      if (!budget && !resize && !convertRejectedWebp && output.data.length > Math.floor(bytes.length * 0.85)) return unchanged();
      rememberCompressedImage(output.data);
      return { bytes: output.data, mimeType, width: output.info.width, height: output.info.height, changed: true, cacheKey };
    }
    return unchanged();
  } catch {
    return unchanged();
  }
}

export function detectSupportedImageMime(bytes: Buffer): SupportedImageMime | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && /GIF8[79]a/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
