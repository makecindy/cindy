/**
 * Shim: openclaw/plugin-sdk/media-runtime.
 *
 * Upstream uses `rastermill` (an OpenClaw image lib) + an OpenClaw media store.
 * We re-implement the small surface the browser core actually calls using
 * `sharp` (already a first-class dep in Cindy) for image ops, and plain fs
 * for media persistence. Image resize/metadata are standard, well-defined ops
 * (not security-sensitive). The media dir is the neutral scratch CONFIG_DIR.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

import { CONFIG_DIR } from './_local/text-utils.js';

export const IMAGE_REDUCE_QUALITY_STEPS = [85, 75, 65, 55, 45, 35] as const;

export interface ImageMetadata {
  width: number;
  height: number;
}

export interface ResizeToJpegParams {
  buffer: Buffer;
  maxSide: number;
  quality: number;
  withoutEnlargement?: boolean;
}

export class ImageProcessorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageProcessorUnavailableError';
  }
}

export function isImageProcessorUnavailableError(err: unknown): boolean {
  return err instanceof ImageProcessorUnavailableError;
}

/** Candidate max-side grid, mirrors upstream ordering (descending, deduped). */
export function buildImageResizeSideGrid(maxSide: number, sideStart: number): number[] {
  return [sideStart, 1800, 1600, 1400, 1200, 1000, 800]
    .map((value) => Math.min(maxSide, value))
    .filter((value, idx, arr) => value > 0 && arr.indexOf(value) === idx)
    .toSorted((a, b) => b - a);
}

export async function getImageMetadata(buffer: Buffer): Promise<ImageMetadata | null> {
  try {
    const meta = await sharp(buffer).metadata();
    if (typeof meta.width === 'number' && typeof meta.height === 'number') {
      return { width: meta.width, height: meta.height };
    }
    return null;
  } catch {
    return null;
  }
}

export async function resizeToJpeg(params: ResizeToJpegParams): Promise<Buffer> {
  try {
    return await sharp(params.buffer)
      .resize({
        width: params.maxSide,
        height: params.maxSide,
        fit: 'inside',
        withoutEnlargement: params.withoutEnlargement !== false,
      })
      .jpeg({ quality: params.quality })
      .toBuffer();
  } catch (error) {
    throw new ImageProcessorUnavailableError(
      `sharp image processing failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const MEDIA_ROOT = path.join(CONFIG_DIR, 'media');

/** Ensure the media scratch root exists. */
export async function ensureMediaDir(): Promise<string> {
  await fs.mkdir(MEDIA_ROOT, { recursive: true, mode: 0o700 });
  return MEDIA_ROOT;
}

export interface SavedMedia {
  path: string;
  size: number;
}

function extForContentType(contentType?: string): string {
  if (!contentType) return 'bin';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg';
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('pdf')) return 'pdf';
  return 'bin';
}

/** Persist a media buffer under the scratch media dir; returns its path. */
export async function saveMediaBuffer(
  buffer: Buffer,
  contentType?: string,
  subdir = 'inbound',
  maxBytes = 25 * 1024 * 1024,
): Promise<SavedMedia> {
  if (buffer.byteLength > maxBytes) {
    throw new Error(`Media exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`);
  }
  const dir = path.join(MEDIA_ROOT, subdir);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  const file = path.join(dir, `${hash}.${extForContentType(contentType)}`);
  await fs.writeFile(file, buffer, { mode: 0o600 });
  return { path: file, size: buffer.byteLength };
}
