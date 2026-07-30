import type {
  AnthropicImageCodec,
  AnthropicImageCodecInput,
  AnthropicImageCodecOutput,
} from '@cindy/responses-anthropic-bridge';
import { Buffer } from 'node:buffer';
import sharp from 'sharp';

const MAX_INPUT_PIXELS = 100_000_000;
const PASSTHROUGH_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);
const MEDIA_TYPE_BY_SHARP_FORMAT: Readonly<Record<string, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

function strictBase64Bytes(data: string): Buffer | null {
  const compact = data.replace(/\s/g, '');
  if (
    compact.length === 0
    || compact.length % 4 === 1
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)
  ) return null;
  try {
    return Buffer.from(compact, 'base64');
  } catch {
    return null;
  }
}

/**
 * Desktop's native Sharp-backed codec. It performs the actual decode/resize work while
 * the bridge package remains responsible for age tiers, request budgets, and ordering.
 */
class DesktopAnthropicImageCodec implements AnthropicImageCodec {
  async normalize(input: AnthropicImageCodecInput): Promise<AnthropicImageCodecOutput | null> {
    const bytes = strictBase64Bytes(input.data);
    if (!bytes) return null;
    try {
      const source = sharp(bytes, {
        failOn: 'error',
        limitInputPixels: MAX_INPUT_PIXELS,
        animated: false,
      }).rotate();
      const metadata = await source.metadata();
      const width = metadata.width ?? 0;
      const height = metadata.height ?? 0;
      const decodedMediaType = metadata.format
        ? MEDIA_TYPE_BY_SHARP_FORMAT[metadata.format]
        : undefined;
      if (
        width <= 0
        || height <= 0
        || width * height > MAX_INPUT_PIXELS
      ) return null;

      if (
        decodedMediaType
        && PASSTHROUGH_MEDIA_TYPES.has(decodedMediaType)
        && width <= input.maxEdge
        && height <= input.maxEdge
        && input.data.length <= input.hardCap
      ) {
        // metadata() is header-only; force one decoded pixel before trusting passthrough.
        await source.clone().resize(1, 1).jpeg({ quality: 1 }).toBuffer();
        return { data: input.data, mediaType: decodedMediaType };
      }

      const resized = source.resize({
        width: input.maxEdge,
        height: input.maxEdge,
        fit: 'inside',
        withoutEnlargement: true,
      });
      let last: Buffer | null = null;
      for (const quality of input.qualities) {
        last = await resized.clone().jpeg({ quality }).toBuffer();
        const data = last.toString('base64');
        if (data.length <= input.hardCap) return { data, mediaType: 'image/jpeg' };
      }
      return last
        ? { data: last.toString('base64'), mediaType: 'image/jpeg' }
        : null;
    } catch {
      return null;
    }
  }
}

export const desktopAnthropicImageCodec: AnthropicImageCodec =
  new DesktopAnthropicImageCodec();
