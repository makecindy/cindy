import { Buffer } from 'node:buffer';

import type { AnthropicImageCodec } from './types.js';

export const MANY_IMAGE_THRESHOLD = 20;
export const MANY_IMAGE_MAX_DIMENSION = 2000;
export const ABSOLUTE_MAX_DIMENSION = 8000;
export const MAX_IMAGES_PER_REQUEST = 100;
export const MAX_IMAGE_BASE64_LENGTH = 5 * 1024 * 1024;
export const TOTAL_IMAGE_BASE64_BUDGET = 20 * 1024 * 1024;
export const MAX_INPUT_BASE64_LENGTH = 20 * 1024 * 1024;

// Sharp holds the decoded input and resized output concurrently. Keep one worker per
// request, then additionally serialize all requests sharing the same native codec
// instance below so large-but-admissible images cannot multiply that peak.
const IMAGE_NORMALIZE_CONCURRENCY = 1;
const codecNormalizeTails = new WeakMap<AnthropicImageCodec, Promise<void>>();
const ALLOWED_IMAGE_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);
const OMITTED_TEXT =
  '[image omitted: Anthropic request exceeded its image-count or dimension limits; older screenshots were dropped]';
const OVERSIZED_TEXT = "[image omitted: exceeds Anthropic's 8000px per-side limit]";
const PER_IMAGE_TOO_LARGE_TEXT = "[image omitted: exceeds Anthropic's 5MB per-image limit]";
const BYTE_BUDGET_TEXT =
  '[image omitted: total image payload exceeded the provider request budget; older screenshots were dropped]';
const UNDECODABLE_TEXT = '[image omitted: undecodable or corrupt image data]';
const BOMB_TEXT = '[image omitted: image too large to process safely]';

interface ImageDimensions {
  width: number;
  height: number;
}

interface ImageBlockRef {
  container: unknown[];
  index: number;
  base64: string | null;
  mediaType: string;
}

interface TierSpec {
  maxEdge: number;
  qualities: readonly number[];
  hardCap: number;
}

const TIER_SPECS: readonly TierSpec[] = [
  { maxEdge: 2000, qualities: [80, 60, 40, 30], hardCap: 2 * 1024 * 1024 },
  { maxEdge: 1024, qualities: [70, 50], hardCap: 512 * 1024 },
  { maxEdge: 700, qualities: [60, 40], hardCap: 192 * 1024 },
  { maxEdge: 500, qualities: [40], hardCap: 100 * 1024 },
  { maxEdge: 400, qualities: [30], hardCap: 100 * 1024 },
  { maxEdge: 320, qualities: [25], hardCap: Number.POSITIVE_INFINITY },
];
const TERMINAL_TIER = TIER_SPECS.length - 1;

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] << 24)
    | (bytes[offset + 1] << 16)
    | (bytes[offset + 2] << 8)
    | bytes[offset + 3]
  ) >>> 0;
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (
    bytes.length < 24
    || bytes[0] !== 0x89
    || bytes[1] !== 0x50
    || bytes[2] !== 0x4e
    || bytes[3] !== 0x47
  ) return null;
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (
      marker >= 0xc0
      && marker <= 0xcf
      && marker !== 0xc4
      && marker !== 0xc8
      && marker !== 0xcc
    ) {
      return {
        height: u16be(bytes, offset + 5),
        width: u16be(bytes, offset + 7),
      };
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = u16be(bytes, offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function gifDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (
    bytes.length < 10
    || bytes[0] !== 0x47
    || bytes[1] !== 0x49
    || bytes[2] !== 0x46
  ) return null;
  return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (
    bytes.length < 30
    || bytes[0] !== 0x52
    || bytes[1] !== 0x49
    || bytes[2] !== 0x46
    || bytes[3] !== 0x46
    || bytes[8] !== 0x57
    || bytes[9] !== 0x45
    || bytes[10] !== 0x42
    || bytes[11] !== 0x50
  ) return null;
  const fourcc = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (fourcc === 'VP8X') {
    return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  }
  if (fourcc === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }
  if (fourcc === 'VP8L') {
    if (bytes[20] !== 0x2f) return null;
    const raw = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return {
      width: (raw & 0x3fff) + 1,
      height: ((raw >> 14) & 0x3fff) + 1,
    };
  }
  return null;
}

export function sniffImageDimensions(base64: string): ImageDimensions | null {
  const slice = base64.slice(0, 65_536);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(slice)) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(slice, 'base64'));
  } catch {
    return null;
  }
  return pngDimensions(bytes)
    ?? jpegDimensions(bytes)
    ?? gifDimensions(bytes)
    ?? webpDimensions(bytes)
    ?? null;
}

function collectImageRefs(messages: unknown[]): ImageBlockRef[] {
  const refs: ImageBlockRef[] = [];
  const scan = (content: unknown[]): void => {
    for (let index = 0; index < content.length; index += 1) {
      const block = objectValue(content[index]);
      if (!block) continue;
      if (block.type === 'image') {
        const source = objectValue(block.source);
        refs.push({
          container: content,
          index,
          base64: source?.type === 'base64' && typeof source.data === 'string'
            ? source.data
            : null,
          mediaType: typeof source?.media_type === 'string'
            ? source.media_type.toLowerCase()
            : '',
        });
      } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
        scan(block.content);
      }
    }
  };
  for (const message of messages) {
    const content = objectValue(message)?.content;
    if (Array.isArray(content)) scan(content);
  }
  return refs;
}

function textify(ref: ImageBlockRef, text: string): void {
  ref.container[ref.index] = { type: 'text', text };
}

function replaceImage(ref: ImageBlockRef, data: string, mediaType: string): void {
  ref.container[ref.index] = {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data },
  };
  ref.base64 = data;
  ref.mediaType = mediaType;
}

function initialTier(newestFirstIndex: number, bias: number): number {
  const base = newestFirstIndex < 6 ? 0 : newestFirstIndex < 20 ? 1 : 2;
  return Math.min(base + Math.max(0, bias), TERMINAL_TIER);
}

async function runCodecNormalization<T>(
  codec: AnthropicImageCodec,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = codecNormalizeTails.get(codec) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  codecNormalizeTails.set(codec, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (codecNormalizeTails.get(codec) === tail) codecNormalizeTails.delete(codec);
  }
}

async function normalizeAtTier(
  data: string,
  mediaType: string,
  startTier: number,
  codec: AnthropicImageCodec | undefined,
): Promise<{ data: string; mediaType: string; tier: number } | null> {
  if (!codec) {
    // A host without a native decoder cannot resize or fully validate the payload.
    // Preserve supported inputs here and let the deterministic guard below enforce
    // per-image/count/request budgets. Unknown dimensions are intentionally fail-open
    // for <=20 images, matching Anthropic's own validation boundary.
    return ALLOWED_IMAGE_MEDIA_TYPES.has(mediaType)
      ? { data, mediaType, tier: startTier }
      : null;
  }
  for (let tier = startTier; tier <= TERMINAL_TIER; tier += 1) {
    const spec = TIER_SPECS[tier];
    const normalized = await runCodecNormalization(codec, () => codec.normalize({
      data,
      mediaType,
      maxEdge: spec.maxEdge,
      qualities: spec.qualities,
      hardCap: spec.hardCap,
    }));
    if (normalized && (normalized.data.length <= spec.hardCap || tier === TERMINAL_TIER)) {
      return { ...normalized, tier };
    }
  }
  return null;
}

interface NormalizedEntry {
  ref: ImageBlockRef;
  originalData: string;
  originalMediaType: string;
  tier: number;
  size: number;
  live: boolean;
}

/**
 * Normalize inline images in memory, preserving newest screenshots at the highest
 * fidelity. URL images are counted by the deterministic guard but are never fetched.
 */
export async function normalizeAnthropicImages(
  messages: unknown[],
  options: { codec?: AnthropicImageCodec; tierBias?: number } = {},
): Promise<void> {
  const refs = collectImageRefs(messages);
  if (refs.length === 0) return;

  const entries: Array<NormalizedEntry | null> = new Array(refs.length).fill(null);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(IMAGE_NORMALIZE_CONCURRENCY, refs.length) },
    async () => {
      for (;;) {
        const index = cursor++;
        if (index >= refs.length) return;
        const ref = refs[index];
        if (!ref.base64) continue;
        if (ref.base64.length > MAX_INPUT_BASE64_LENGTH) {
          textify(ref, BOMB_TEXT);
          continue;
        }
        const originalData = ref.base64;
        const originalMediaType = ref.mediaType;
        const normalized = await normalizeAtTier(
          originalData,
          originalMediaType,
          initialTier(refs.length - 1 - index, options.tierBias ?? 0),
          options.codec,
        );
        if (!normalized) {
          textify(ref, UNDECODABLE_TEXT);
          continue;
        }
        replaceImage(ref, normalized.data, normalized.mediaType);
        entries[index] = {
          ref,
          originalData,
          originalMediaType,
          tier: normalized.tier,
          size: normalized.data.length,
          live: true,
        };
      }
    },
  );
  await Promise.all(workers);

  let total = entries.reduce((sum, entry) => sum + (entry?.live ? entry.size : 0), 0);
  while (total > TOTAL_IMAGE_BASE64_BUDGET) {
    const candidate = entries.find((entry) => entry?.live && entry.tier < TERMINAL_TIER);
    if (!candidate) break;
    const normalized = await normalizeAtTier(
      candidate.originalData,
      candidate.originalMediaType,
      candidate.tier + 1,
      options.codec,
    );
    if (!normalized) {
      textify(candidate.ref, UNDECODABLE_TEXT);
      candidate.live = false;
      total -= candidate.size;
      continue;
    }
    total += normalized.data.length - candidate.size;
    candidate.size = normalized.data.length;
    candidate.tier = normalized.tier;
    replaceImage(candidate.ref, normalized.data, normalized.mediaType);
  }

  if (total > TOTAL_IMAGE_BASE64_BUDGET) {
    for (const entry of entries) {
      if (!entry?.live || total <= TOTAL_IMAGE_BASE64_BUDGET) continue;
      textify(entry.ref, BYTE_BUDGET_TEXT);
      entry.live = false;
      total -= entry.size;
    }
  }
  enforceAnthropicImageLimits(messages);
}

/** Deterministic backstop for inputs a native codec could not shrink or inspect. */
export function enforceAnthropicImageLimits(messages: unknown[]): void {
  const refs = collectImageRefs(messages);
  if (refs.length === 0) return;
  const dimensions = refs.map((ref) => ref.base64 ? sniffImageDimensions(ref.base64) : null);
  const live = new Set<number>(refs.keys());

  for (let index = 0; index < refs.length; index += 1) {
    const dims = dimensions[index];
    if (dims && (dims.width > ABSOLUTE_MAX_DIMENSION || dims.height > ABSOLUTE_MAX_DIMENSION)) {
      textify(refs[index], OVERSIZED_TEXT);
      live.delete(index);
      continue;
    }
    const data = refs[index].base64;
    if (data && data.length > MAX_IMAGE_BASE64_LENGTH) {
      textify(refs[index], PER_IMAGE_TOO_LARGE_TEXT);
      live.delete(index);
    }
  }

  const riskyForMany = [...live].some((index) => {
    const dims = dimensions[index];
    return dims === null
      || dims.width > MANY_IMAGE_MAX_DIMENSION
      || dims.height > MANY_IMAGE_MAX_DIMENSION;
  });
  if (riskyForMany && live.size > MANY_IMAGE_THRESHOLD) {
    for (const index of [...live]) {
      if (live.size <= MANY_IMAGE_THRESHOLD) break;
      textify(refs[index], OMITTED_TEXT);
      live.delete(index);
    }
  }
  if (live.size > MAX_IMAGES_PER_REQUEST) {
    for (const index of [...live]) {
      if (live.size <= MAX_IMAGES_PER_REQUEST) break;
      textify(refs[index], OMITTED_TEXT);
      live.delete(index);
    }
  }

  let total = [...live].reduce(
    (sum, index) => sum + (refs[index].base64?.length ?? 0),
    0,
  );
  for (const index of [...live]) {
    if (total <= TOTAL_IMAGE_BASE64_BUDGET) break;
    const data = refs[index].base64;
    if (!data) continue;
    textify(refs[index], BYTE_BUDGET_TEXT);
    total -= data.length;
  }
}

export function requestHasInlineImage(messages: unknown[]): boolean {
  return collectImageRefs(messages).some((ref) => ref.base64 !== null);
}
