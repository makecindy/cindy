/**
 * Images a plugin asks to show the model with its tool result.
 *
 * A plugin's logic page may add a top-level `images: [{ data: <base64> }]` to its
 * `tool-result` message (next to `result`, never inside it, so hosts that do not
 * know the field drop it instead of pasting base64 into the model's context).
 * The host checks every image here, re-encodes it under the inline budget and
 * ghost_call returns it as MCP image content after the JSON text.
 *
 * The bytes decide the format: only PNG, JPEG, WebP and GIF are accepted, never
 * a type the plugin claims. Images are not added to the media library or the
 * per-call media ledger, so they are never delivered to IM by themselves.
 */
import type { GhostModelImage } from './shared/ghost.js';
import { sniffMediaMime } from '@cindy/media-core';

export const GHOST_MODEL_IMAGE_MAX_COUNT = 2;
/** Decoded bytes per image before re-encoding. */
export const GHOST_MODEL_IMAGE_MAX_BYTES = 6 * 1024 * 1024;
/**
 * Total bytes of inline images in one ghost_call result. Same value and reason
 * as `INLINE_IMAGE_TARGET_BYTES` in @cindy/mcps: Claude Code writes stream-json
 * lines over 256 KiB in chunks that other output can interleave with.
 */
export const GHOST_MODEL_IMAGE_BUDGET_BYTES = 140_000;

const MODEL_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_BASE64_LENGTH = Math.ceil(GHOST_MODEL_IMAGE_MAX_BYTES / 3) * 4;

/** Keep the valid images (at most the limit); report how many were dropped. */
export function normalizeGhostModelImages(raw: unknown): { images: GhostModelImage[]; dropped: number } {
  if (raw === undefined || raw === null) return { images: [], dropped: 0 };
  if (!Array.isArray(raw)) return { images: [], dropped: 1 };
  const images: GhostModelImage[] = [];
  let dropped = 0;
  for (const item of raw) {
    const data = (item as { data?: unknown } | null)?.data;
    if (images.length >= GHOST_MODEL_IMAGE_MAX_COUNT || typeof data !== 'string' || data.length === 0
      || data.length > MAX_BASE64_LENGTH || !BASE64.test(data)) {
      dropped++;
      continue;
    }
    const bytes = Buffer.from(data, 'base64');
    const mimeType = sniffMediaMime(bytes);
    if (!bytes.byteLength || bytes.byteLength > GHOST_MODEL_IMAGE_MAX_BYTES || !mimeType || !MODEL_IMAGE_MIMES.has(mimeType)) {
      dropped++;
      continue;
    }
    images.push({ data: bytes.toString('base64'), mimeType });
  }
  return { images, dropped };
}

