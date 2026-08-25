import {
  categorizeByFilename,
  categorizeFile,
  extractExt,
  getMimeType,
  type AttachedFile,
} from '@/lib/fileTypes';
import type { FileRef, ImageRef } from '@/lib/imageRef';

export type RewindDraftImage =
  | ImageRef
  | { base64: string; mimeType: string; originalName?: string };

function extForMime(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'image/png':
    default:
      return '.png';
  }
}

function basename(raw: string): string {
  return raw.split(/[\\/]/).filter(Boolean).pop() ?? raw;
}

function filenameFromXdtImageUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const name = basename(decodeURIComponent(parsed.pathname));
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

function imageName(image: RewindDraftImage, index: number): string {
  const fallback = `image-${index + 1}${extForMime(image.mimeType)}`;
  if ('url' in image) {
    return image.originalName || filenameFromXdtImageUrl(image.url) || fallback;
  }
  return image.originalName || fallback;
}

function fileAttachmentFromRef(file: FileRef): AttachedFile | null {
  const name = file.name || basename(file.path);
  const ext = extractExt(name);
  const category = ext ? categorizeFile(ext) : (categorizeByFilename(name) ?? 'file');
  if (!category) return null;

  return {
    id: crypto.randomUUID(),
    name,
    path: file.path,
    ext,
    size: 0,
    category,
    mimeType: getMimeType(ext, category),
  };
}

export function buildRewindDraftAttachments(input: {
  images?: readonly RewindDraftImage[];
  files?: readonly FileRef[];
}): AttachedFile[] {
  const attachments: AttachedFile[] = [];

  for (const image of input.images ?? []) {
    const name = imageName(image, attachments.length);
    const ext = extractExt(name) || extForMime(image.mimeType);
    const common = {
      id: crypto.randomUUID(),
      name,
      path: 'url' in image ? image.url : `clipboard://rewind-${attachments.length + 1}`,
      ext,
      size: 0,
      category: 'image' as const,
      mimeType: image.mimeType,
      originalName: name,
    };

    if ('url' in image && image.annotationSourceUrl && image.annotationStrokes?.length) {
      // 带标注的历史图:恢复成可再编辑的托盘态——原图为编辑源、矢量笔迹随
      // 附件,发送时重新烧录(review P1:此前只带烧录位图,rewind 后笔迹
      // 不可撤销、重发也不再注入标注说明)。原图可能是更早历史消息的共享
      // 缓存文件(ImageRef 无法区分来源),一律标记 cacheUrlShared——删除
      // 草稿不清理它;若原图实为本消息私有,rewind 后的孤儿由 sweep 兜底。
      const sourceExt = extractExt(image.annotationSourceUrl) || common.ext;
      attachments.push({
        ...common,
        path: image.annotationSourceUrl,
        ext: sourceExt,
        mimeType: getMimeType(sourceExt, 'image'),
        url: image.annotationSourceUrl,
        cacheUrlShared: true,
        annotationStrokes: image.annotationStrokes.map((stroke) => ({
          points: stroke.points.map((pt) => ({ x: pt.x, y: pt.y })),
        })),
      });
      continue;
    }
    attachments.push(
      'url' in image ? { ...common, url: image.url } : { ...common, base64: image.base64 },
    );
  }

  for (const file of input.files ?? []) {
    const attachment = fileAttachmentFromRef(file);
    if (attachment) attachments.push(attachment);
  }

  return attachments;
}
