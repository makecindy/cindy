import { createHash } from 'node:crypto';
import type { createLegacyImageCache } from '@cindy/media-core/legacy-image-cache';
import type { DbLogger } from '@cindy/runtime-db/logging';


export interface ImportedImageRef {
  url: string;
  mimeType: string;
  originalName: string;
}

export interface ImportedImagePayload {
  mimeType: string;
  base64Data: string;
}
export function createImportedUserContent(host: { imageCacheStore: Pick<ReturnType<typeof createLegacyImageCache>, 'writeBufferStable'>; logger: DbLogger }) {
const { imageCacheStore, logger: log } = host;


const MAX_IMPORTED_IMAGE_BYTES = 25 * 1024 * 1024;
const IDE_OPENED_FILE_OPEN_TAG = '<ide_opened_file>';
const IDE_OPENED_FILE_CLOSE_TAG = '</ide_opened_file>';

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

function importedUserContent(text: string, images: ImportedImageRef[]): unknown {
  return images.length > 0 ? { text, images, files: [] } : text;
}

/**
 * Remove complete Claude IDE context blocks from imported user text.
 *
 * Malformed or unclosed blocks are preserved. This intentionally uses a
 * deterministic scanner instead of a broad XML-like regex so one broken open
 * tag cannot consume later real user input or a separate valid block.
 */
function stripCompleteIdeOpenedFileBlocks(text: string): string {
  let cursor = 0;
  let output = '';

  while (cursor < text.length) {
    const openIndex = text.indexOf(IDE_OPENED_FILE_OPEN_TAG, cursor);
    if (openIndex < 0) return output + text.slice(cursor);

    const contentStart = openIndex + IDE_OPENED_FILE_OPEN_TAG.length;
    const closeIndex = text.indexOf(IDE_OPENED_FILE_CLOSE_TAG, contentStart);
    if (closeIndex < 0) return output + text.slice(cursor);

    const nestedOpenIndex = text.indexOf(IDE_OPENED_FILE_OPEN_TAG, contentStart);
    if (nestedOpenIndex >= 0 && nestedOpenIndex < closeIndex) {
      output += text.slice(cursor, nestedOpenIndex);
      cursor = nestedOpenIndex;
      continue;
    }

    output += text.slice(cursor, openIndex);
    output += '\n';
    cursor = closeIndex + IDE_OPENED_FILE_CLOSE_TAG.length;
  }

  return output;
}

function parseImageDataUrl(raw: string): ImportedImagePayload | null {
  const value = raw.trim();
  const comma = value.indexOf(',');
  if (!value.startsWith('data:') || comma < 0) return null;
  const header = value.slice(5, comma);
  const data = value.slice(comma + 1);
  const parts = header.split(';').map((part) => part.trim().toLowerCase());
  const mimeType = normalizeImageMime(parts[0] ?? '');
  if (!mimeType || !parts.includes('base64')) return null;
  return { mimeType, base64Data: data };
}

function normalizeImageMime(raw: string): string | null {
  const mime = raw.trim().toLowerCase();
  if (mime === 'image/jpg') return 'image/jpeg';
  return IMAGE_EXT_BY_MIME[mime] ? mime : null;
}

async function cacheImportedBase64Image(params: {
  sessionId: string;
  source: 'claude' | 'codex';
  lineNo: number;
  partIndex: number;
  imageIndex: number;
  mimeType: string;
  base64Data: string;
}): Promise<ImportedImageRef | null> {
  const mimeType = normalizeImageMime(params.mimeType);
  if (!mimeType) return null;

  const base64Data = params.base64Data.replace(/\s/g, '');
  if (!base64Data) return null;
  if (estimatedBase64Bytes(base64Data) > MAX_IMPORTED_IMAGE_BYTES) return null;

  try {
    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMPORTED_IMAGE_BYTES) return null;

    const ext = IMAGE_EXT_BY_MIME[mimeType];
    const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 32);
    const filename = `${params.source}-import-${hash}${ext}`;
    const originalName = `${params.source}-import-${params.lineNo}-${params.partIndex}-${params.imageIndex}${ext}`;
    const cached = await imageCacheStore.writeBufferStable({
      sessionId: params.sessionId,
      buffer,
      mimeType,
      filename,
    });
    return { url: cached.url, mimeType, originalName };
  } catch (err) {
    log.debug('imported image cache write skipped', {
      source: params.source,
      lineNo: params.lineNo,
      partIndex: params.partIndex,
      imageIndex: params.imageIndex,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function estimatedBase64Bytes(base64Data: string): number {
  return Math.floor((base64Data.length * 3) / 4);
}
return {
  importedUserContent,
  stripCompleteIdeOpenedFileBlocks,
  parseImageDataUrl,
  normalizeImageMime,
  cacheImportedBase64Image
};
}
