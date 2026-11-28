import type { RequestTransform } from '@cindy/anthropic-compat-proxy';

export const INVALID_IMAGE_BLOCK_NOTICE =
  '[image omitted: the attached image data was invalid or truncated and could not be delivered. ' +
  'Do not guess or fabricate what it shows. Tell the user the image could not be delivered and ' +
  'ask them to attach it again.]';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function imageUrlFromBlock(value: Record<string, unknown>): string | null {
  if (typeof value.image_url === 'string') return value.image_url;
  if (typeof value.imageUrl === 'string') return value.imageUrl;
  if (isPlainObject(value.image_url) && typeof value.image_url.url === 'string') {
    return value.image_url.url;
  }
  if (isPlainObject(value.imageUrl) && typeof value.imageUrl.url === 'string') {
    return value.imageUrl.url;
  }
  return null;
}

function isInputImageBlock(value: Record<string, unknown>): boolean {
  return value.type === 'input_image' || value.type === 'inputImage';
}

/**
 * Decode only image data URLs. Non-data URLs (http/https) and non-base64 data
 * URLs are left alone: the proxy cannot validate remote bytes without a fetch,
 * and the reported failure is an inline tool-result image.
 */
function decodeImageDataUrl(value: string): Buffer | null {
  if (!value.startsWith('data:image/')) return null;
  if (!value.includes(';base64,')) return null;
  const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return Buffer.alloc(0); // claims to be base64 but is malformed
  if (match[1].length % 4 !== 0) return Buffer.alloc(0);
  try {
    const bytes = Buffer.from(match[1], 'base64');
    return bytes.length > 0 ? bytes : Buffer.alloc(0);
  } catch {
    return Buffer.alloc(0);
  }
}

/**
 * Container completeness check. This is deliberately structural rather than a
 * full decode: the upstream failure was a JPEG with its EOI cut off, while
 * phone screenshots legitimately carry metadata after the EOI. A full decode
 * would reject some valid trailing-metadata files and costs much more per
 * request.
 */
export function hasCompleteImageContainer(bytes: Buffer): boolean {
  if (bytes.length < 12) return false;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return bytes.lastIndexOf(JPEG_EOI) >= 0;
  }
  if (bytes.subarray(0, 8).equals(PNG_MAGIC)) {
    return bytes.lastIndexOf(Buffer.from('IEND')) >= 0;
  }
  if (bytes.subarray(0, 3).toString('ascii') === 'GIF') {
    return bytes[bytes.length - 1] === 0x3b;
  }
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    const declared = bytes.readUInt32LE(4) + 8;
    return declared >= 12 && declared <= bytes.length;
  }
  return false;
}

interface RewriteState {
  count: number;
}

function rewriteNode(node: unknown, state: RewriteState): unknown {
  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((entry) => {
      const rewritten = rewriteNode(entry, state);
      if (rewritten !== entry) changed = true;
      return rewritten;
    });
    return changed ? next : node;
  }
  if (!isPlainObject(node)) return node;

  const imageUrl = imageUrlFromBlock(node);
  if (typeof imageUrl === 'string') {
    const bytes = decodeImageDataUrl(imageUrl);
    if (bytes !== null && !hasCompleteImageContainer(bytes)) {
      state.count += 1;
      if (isInputImageBlock(node)) {
        return { type: 'input_text', text: INVALID_IMAGE_BLOCK_NOTICE };
      }
      const next: Record<string, unknown> = { ...node };
      delete next.image_url;
      delete next.imageUrl;
      return next;
    }
  }

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    const rewritten = rewriteNode(value, state);
    if (rewritten !== value) changed = true;
    next[key] = rewritten;
  }
  return changed ? next : node;
}

/**
 * Replace invalid inline image blocks with a text notice so a single truncated
 * image cannot make every later request fail with an upstream 400. Old
 * histories are repaired on the wire without rewriting the rollout.
 */
export function rewriteInvalidImageBlocks(
  body: Record<string, unknown>,
): { body: Record<string, unknown>; count: number } | null {
  const state: RewriteState = { count: 0 };
  const input = rewriteNode(body.input, state);
  if (state.count === 0) return null;
  return { body: { ...body, input }, count: state.count };
}

export function createInvalidImageBlockNoticeTransform(): RequestTransform {
  return (body) => {
    if (!isPlainObject(body) || !Array.isArray(body.input)) return null;
    const rewritten = rewriteInvalidImageBlocks(body);
    return rewritten ? rewritten.body : null;
  };
}
