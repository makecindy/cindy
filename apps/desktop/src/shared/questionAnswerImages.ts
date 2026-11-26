import type { QuestionAnswerImage } from '@cindy/maker-shared/interaction';
import type { AgentInputSerializedFile } from './agentInputQueue.js';

export const QUESTION_ANSWER_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const MAX_QUESTION_ANSWER_IMAGES = 20;
export const MAX_QUESTION_ANSWER_IMAGE_BYTES = 100 * 1024 * 1024;

export function questionAnswerImageName(name: string): string {
  return name.replace(/[\\/\p{Cc}]/gu, '_').trim().slice(0, 255).trimEnd() || 'image';
}

export function questionAnswerImageFiles(images: readonly QuestionAnswerImage[]): AgentInputSerializedFile[] {
  return images.map(({ url, mimeType, originalName, size }, index) => ({
    id: `answer-image-${index}`, name: originalName, originalName, size, mimeType,
    ext: url.slice(url.lastIndexOf('.')), category: 'image', path: url, url, pathOrigin: 'desktop-host',
  }));
}
