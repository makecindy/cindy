import type { QuestionAnswerImage } from '@cindy/maker-shared/interaction';
import {
  MAX_QUESTION_ANSWER_IMAGES,
  MAX_QUESTION_ANSWER_IMAGE_BYTES,
  QUESTION_ANSWER_IMAGE_TYPES,
  questionAnswerImageName,
} from '../../shared/questionAnswerImages.js';
import { openBlobFile, parseBlobUrl } from '../cindy-media/blobStore.desktop.js';
import { hasNonCacheBlob, type LedgerDb } from '../cindy-media/ledger.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';

/** Only pick up verified chat image blobs in the active owner's ledger. */
export async function readQuestionAnswerImages(raw: unknown, db: LedgerDb): Promise<QuestionAnswerImage[] | null> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_QUESTION_ANSWER_IMAGES) return null;
  const images: QuestionAnswerImage[] = [];
  let remaining = MAX_QUESTION_ANSWER_IMAGE_BYTES;
  for (const input of raw) {
    const { url, originalName } = input ?? {};
    if (typeof url !== 'string' || url.length > 128 || typeof originalName !== 'string' ||
        originalName.length > 255 || questionAnswerImageName(originalName) !== originalName) return null;
    const parsed = parseBlobUrl(url);
    if (!parsed || !await hasNonCacheBlob(parsed.hash, db)) return null;
    try {
      const { file, mimeType, totalSize } = await openBlobFile(url);
      try {
        if (!QUESTION_ANSWER_IMAGE_TYPES.includes(mimeType) || totalSize <= 0 || totalSize > remaining) return null;
        const header = Buffer.alloc(32);
        const { bytesRead } = await file.read(header, 0, header.length, 0);
        if (sniffMediaMime(header.subarray(0, bytesRead), mimeType) !== mimeType) return null;
        remaining -= totalSize;
        images.push({ url, mimeType, originalName, size: totalSize });
      } finally {
        await file.close();
      }
    } catch {
      return null;
    }
  }
  return images;
}
