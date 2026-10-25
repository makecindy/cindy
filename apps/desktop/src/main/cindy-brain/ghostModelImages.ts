export * from '@cindy/plugin-runtime/modelImages';
import { GHOST_MODEL_IMAGE_BUDGET_BYTES } from '@cindy/plugin-runtime/modelImages';
import type { GhostModelImage } from '../../shared/ghost.js';
import { isDecodableInlineImage } from '../mcp-integrations/inlineImageCompressor.js';

export type CompressModelImage = (
  buffer: Buffer,
  mime: string,
  opts: { targetBytes: number },
) => Promise<{ buffer: Buffer; mime: string } | null>;

/**
 * Fit the images into the inline budget, sharing it equally. An image that is
 * already small enough is passed through untouched (its pixel size is part of
 * what it shows); a larger one is re-encoded, and one that still does not fit is
 * left out and counted.
 */
export async function fitGhostModelImages(
  images: GhostModelImage[],
  compress: CompressModelImage,
  budget = GHOST_MODEL_IMAGE_BUDGET_BYTES,
): Promise<{ images: GhostModelImage[]; omitted: number }> {
  if (!images.length) return { images: [], omitted: 0 };
  const share = Math.floor(budget / images.length);
  const out: GhostModelImage[] = [];
  let omitted = 0;
  for (const image of images) {
    const buffer = Buffer.from(image.data, 'base64');
    if (!(await isDecodableInlineImage(buffer))) {
      omitted++;
      continue;
    }
    if (buffer.byteLength <= share) {
      out.push(image);
      continue;
    }
    const smaller = await compress(buffer, image.mimeType, { targetBytes: share }).catch(() => null);
    if (smaller && smaller.buffer.byteLength <= share) {
      out.push({ data: smaller.buffer.toString('base64'), mimeType: smaller.mime });
    } else {
      omitted++;
    }
  }
  return { images: out, omitted };
}
