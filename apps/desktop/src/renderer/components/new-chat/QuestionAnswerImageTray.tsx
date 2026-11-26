import { useLayoutEffect, useState } from 'react';
import { extractExt, type AttachedFile } from '@/lib/fileTypes';
import type { QuestionDraftImage } from '@/lib/questionAnswerAttachments';
import { ThumbnailStrip } from './ComposerAttachments';

/** Keep unsubmitted bytes in the question draft; preview URLs belong to the mounted tray. */
export function QuestionAnswerImageTray({ images, onRemove }: {
  images: readonly QuestionDraftImage[];
  onRemove: (id: string) => void;
}) {
  const [previews, setPreviews] = useState<AttachedFile[]>([]);
  useLayoutEffect(() => {
    const next = images.map(({ id, file, mimeType }) => ({
      id, name: file.name, ext: extractExt(file.name), size: file.size, mimeType,
      category: 'image' as const, path: '', url: URL.createObjectURL(file),
    }));
    setPreviews(next);
    return () => { for (const image of next) URL.revokeObjectURL(image.url); };
  }, [images]);
  return <ThumbnailStrip attachments={previews} onRemove={onRemove} />;
}
