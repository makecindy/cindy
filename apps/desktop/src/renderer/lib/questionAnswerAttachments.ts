import type { QuestionAnswerImage } from '@cindy/maker-shared/interaction';
import { QUESTION_ANSWER_IMAGE_TYPES, questionAnswerImageName } from '../../shared/questionAnswerImages';
import { extractExt, getMimeType, type AttachedFile } from './fileTypes';

export interface QuestionDraftImage {
  id: string;
  file: File;
  mimeType: string;
}

export function questionImageMime(file: File): string | undefined {
  const mime = file.type || getMimeType(extractExt(file.name), 'image');
  return QUESTION_ANSWER_IMAGE_TYPES.includes(mime) ? mime : undefined;
}

/** Import only the images explicitly sent with this answer, one file at a time. */
export async function stageQuestionAnswerImages(
  sessionId: string,
  images: readonly QuestionDraftImage[],
  isCurrent: () => boolean,
): Promise<(AttachedFile & QuestionAnswerImage)[] | null> {
  const attachments: (AttachedFile & QuestionAnswerImage)[] = [];
  for (const { id, file, mimeType } of images) {
    if (!isCurrent()) return null;
    const buffer = new Uint8Array(await file.arrayBuffer());
    if (!isCurrent()) return null;
    const { url } = await window.electronAPI.cacheImageFromBuffer({ sessionId, buffer, mimeType });
    const name = questionAnswerImageName(file.name);
    attachments.push({
      id, name, originalName: name, size: buffer.byteLength, mimeType,
      ext: extractExt(url), category: 'image', path: url, url,
    });
  }
  return isCurrent() ? attachments : null;
}
