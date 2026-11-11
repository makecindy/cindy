import {
  categorizeByFilename,
  categorizeFile,
  extractExt,
  getMimeType,
  type AttachedFile,
} from '@/lib/fileTypes';
import type { FileRef, ImageRef } from '@/lib/imageRef';
import { toEditableAnnotatedAttachment } from '@/lib/annotationRestore';

export type RewindDraftImage =
  | (ImageRef & {
      /** 未烧录原图已丢失、退回烧录图:底图本身带标注红线(见 AttachedFile.baseAnnotated)。 */
      baseAnnotated?: boolean;
    })
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
      // 原图已被清理时由调用方先经 dropMissingAnnotationSources 退回烧录图。
      attachments.push({
        ...toEditableAnnotatedAttachment(common, {
          sourceUrl: image.annotationSourceUrl,
          strokes: image.annotationStrokes,
        }),
        cacheUrlShared: true,
      });
      continue;
    }
    attachments.push(
      'url' in image
        ? { ...common, url: image.url, ...(image.baseAnnotated ? { baseAnnotated: true } : {}) }
        : { ...common, base64: image.base64 },
    );
  }

  for (const file of input.files ?? []) {
    const attachment = fileAttachmentFromRef(file);
    if (attachment) attachments.push(attachment);
  }

  return attachments;
}

/** 这批历史图里是否有可还原为"原图 + 笔迹"的标注图(需要探测原图是否还在)。 */
export function hasRestorableAnnotationSources(
  images: readonly RewindDraftImage[] | undefined,
): boolean {
  return Boolean(
    images?.some(
      (image) =>
        'url' in image && image.annotationSourceUrl && image.annotationStrokes?.length,
    ),
  );
}

/** 探测单张原图时的超时(ms):超时按"仍存在"处理,保持可编辑还原(旧行为)。 */
const SOURCE_PROBE_TIMEOUT_MS = 3000;

/**
 * 用 `<img>` 同款加载链路探测图片地址是否可读(自定义协议在 renderer 内由 main
 * 流式提供,无需额外 IPC)。加载成功或无法判定(无 DOM / 超时)均返回 true,
 * 只有明确的加载失败返回 false——宁可保留可编辑态,也不误把可用原图降级。
 */
export function probeImageSource(
  url: string,
  timeoutMs = SOURCE_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  if (typeof Image === 'undefined') return Promise.resolve(true);
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(ok);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    image.src = url;
  });
}

/**
 * 历史标注图的未烧录原图已被清理时,去掉该图的标注元数据:恢复出的草稿附件
 * 退回烧录图本身(可在其上叠加新标注),而不是指向一张打不开的原图——后者在
 * 托盘里显示为坏图,发送时也无法重新烧录。烧录图不存在的情况不在此处理
 * (与无标注元数据的历史图同一行为)。从不 reject。
 */
export async function dropMissingAnnotationSources<T extends RewindDraftImage>(
  images: readonly T[],
  probe: (url: string) => Promise<boolean> = probeImageSource,
): Promise<T[]> {
  return Promise.all(
    images.map(async (image) => {
      if (!('url' in image) || !image.annotationSourceUrl || !image.annotationStrokes?.length) {
        return image;
      }
      let exists = true;
      try {
        exists = await probe(image.annotationSourceUrl);
      } catch {
        exists = true;
      }
      if (exists) return image;
      // 烧录图本身带着红线:保留标注身份,重发时模型仍会收到标注说明。
      const burnedOnly: ImageRef & { baseAnnotated?: boolean } = { ...image, baseAnnotated: true };
      delete burnedOnly.annotationSourceUrl;
      delete burnedOnly.annotationStrokes;
      return burnedOnly as T;
    }),
  );
}

/** 回退草稿的原图预探测句柄(见 {@link startRewindSourceProbe})。 */
export interface RewindSourceProbe<T extends RewindDraftImage> {
  /** 发起探测时的图片列表(调用方用它确认探测对象未变)。 */
  readonly images: readonly T[];
  /**
   * 同步取写草稿用的图片:探测已完成则返回"丢失原图已退回烧录图"的结果;
   * 尚未完成则原样返回发起时的列表(即旧行为:可编辑还原),绝不等待。
   */
  imagesForDraft(): readonly T[];
}

/**
 * 在回退确认框打开时就开始探测历史标注图的原图是否还在,提交回退时同步取用
 * 结果写草稿。这样草稿写入时序与旧版完全一致(提交后同步写一次),不会有迟到
 * 的二次写入覆盖用户在输入框里刚输入 / 添加的内容;探测未完成时按旧行为还原。
 * 无可还原标注图时不发起任何探测。
 */
export function startRewindSourceProbe<T extends RewindDraftImage>(
  images: readonly T[],
  probe: (url: string) => Promise<boolean> = probeImageSource,
): RewindSourceProbe<T> {
  let resolved: readonly T[] | null = null;
  if (hasRestorableAnnotationSources(images)) {
    void dropMissingAnnotationSources(images, probe).then((checked) => {
      resolved = checked;
    });
  }
  return {
    images,
    imagesForDraft: () => resolved ?? images,
  };
}
