/**
 * annotationRestore — 「烧录标注附件 → 可编辑态(原图 + 矢量笔迹)」的唯一实现。
 *
 * 三处入口共用本模块,避免还原规则各写一份后漂移:
 * - 队列消息进入输入框编辑(queueComposerEdit.queueMessageToComposerEditDraft);
 * - 队列编辑保存时判断附件是否"实际未改"(makerChatStore.queueEditFilesRemainUnchanged);
 * - 回退 / 编辑重发把历史消息附件恢复进草稿(rewindDraftAttachments)。
 *
 * 可编辑态约定:`url` / `path` 指向未烧录原图,扩展名与 MIME 随原图,`annotated`
 * 去掉(发送时会按笔迹重新烧录),笔迹深拷贝(草稿与历史 / 队列数据互不共享可变
 * 对象)。所有权标记(cacheUrlShared / stagedPathShared)与来源相关,由调用方加。
 */

import {
  extractExt,
  getMimeType,
  type AttachedFile,
  type ImageAnnotationStroke,
} from '@/lib/fileTypes';

/** 可还原的标注元数据:未烧录原图 url + 持久化笔迹。 */
export interface AnnotationEditMeta {
  sourceUrl: string;
  strokes: readonly ImageAnnotationStroke[];
}

/** 深拷贝笔迹,只保留坐标字段。 */
export function cloneAnnotationStrokes(
  strokes: readonly ImageAnnotationStroke[],
): ImageAnnotationStroke[] {
  return strokes.map((stroke) => ({
    points: stroke.points.map((point) => ({ x: point.x, y: point.y })),
  }));
}

/** 两组笔迹坐标是否逐点相同(用于判断用户是否改过标注)。 */
export function annotationStrokesEqual(
  left: readonly ImageAnnotationStroke[] | undefined,
  right: readonly ImageAnnotationStroke[] | undefined,
): boolean {
  const a = left ?? [];
  const b = right ?? [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const pa = a[i].points;
    const pb = b[i].points;
    if (pa.length !== pb.length) return false;
    for (let j = 0; j < pa.length; j++) {
      if (pa[j].x !== pb[j].x || pa[j].y !== pb[j].y) return false;
    }
  }
  return true;
}

/**
 * 队列附件(wire 形态,不含编辑元数据)与同 id 的 retryFile(完整 AttachedFile,
 * 保留烧录前的原图与笔迹)配对,得出可还原的标注元数据。
 *
 * 必须两者都标 annotated、path 与 url 完全一致(retryFile 描述的正是这张烧录图),
 * 且原图与笔迹齐备;任一不满足返回 null——附件按普通图片处理,绝不把一张
 * 无关的原图换进来。
 */
export function queuedAnnotationEditMeta(
  file: { annotated?: boolean; path: string; url?: string },
  retryFile: AttachedFile | undefined,
): AnnotationEditMeta | null {
  if (
    file.annotated !== true ||
    retryFile?.annotated !== true ||
    retryFile.path !== file.path ||
    retryFile.url !== file.url ||
    !retryFile.annotationSourceUrl ||
    !retryFile.annotationStrokes?.length
  ) {
    return null;
  }
  return { sourceUrl: retryFile.annotationSourceUrl, strokes: retryFile.annotationStrokes };
}

/**
 * 烧录附件 → 可编辑附件。原图扩展名推不出时沿用附件原扩展名。烧录期派生
 * 字段(annotated / annotationSourceUrl / annotationRegions)一并去掉:编辑后
 * 以笔迹为唯一事实源,发送时重新物化。
 */
export function toEditableAnnotatedAttachment<
  T extends {
    path: string;
    ext: string;
    mimeType: string;
    url?: string;
    annotated?: boolean;
    annotationSourceUrl?: string;
    annotationStrokes?: ImageAnnotationStroke[];
    annotationRegions?: unknown;
  },
>(file: T, meta: AnnotationEditMeta): T {
  const sourceExt = extractExt(meta.sourceUrl) || file.ext;
  const editable = { ...file };
  delete editable.annotated;
  delete editable.annotationSourceUrl;
  delete editable.annotationRegions;
  return {
    ...editable,
    path: meta.sourceUrl,
    url: meta.sourceUrl,
    ext: sourceExt,
    mimeType: getMimeType(sourceExt, 'image'),
    annotationStrokes: cloneAnnotationStrokes(meta.strokes),
  };
}
