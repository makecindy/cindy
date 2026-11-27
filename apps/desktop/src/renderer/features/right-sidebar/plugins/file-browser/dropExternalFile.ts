import { isVideoPath } from '@/features/cc-agent/workdir-browse/lib/videoExt';
import { isTextPreviewSupported } from '@/lib/textPreview';
import { isDrawioPath } from '@/features/cc-agent/workdir-browse/lib/drawioExt';
import { isImagePath } from '@/features/cc-agent/workdir-browse/lib/imageExt';
import { isPdfPath } from '@/features/cc-agent/workdir-browse/lib/pdfExt';

export interface ExternalFileSelection {
  absPath: string;
  workdir: string;
  relPath: string;
}

interface FileDragPayload {
  types: ArrayLike<string>;
  files?: { length: number };
  items?: {
    length: number;
    [index: number]: { kind?: string } | undefined;
  };
}

/**
 * 执行一次由 plugin state 触发的外部文件打开请求。调用方用 isCancelled 绑定
 * 当前 effect 生命周期；旧请求被新 nonce 替代后既不能再改预览，也不能清掉新请求。
 */
export async function runExternalFileOpenRequest({
  absPath,
  open,
  isCancelled,
  clearRequest,
}: {
  absPath: string;
  open: (path: string, isCancelled: () => boolean) => Promise<void>;
  isCancelled: () => boolean;
  clearRequest: () => void;
}): Promise<void> {
  await open(absPath, isCancelled);
  if (!isCancelled()) clearRequest();
}

export function hasFileDragPayload(dataTransfer: FileDragPayload): boolean {
  for (let i = 0; i < dataTransfer.types.length; i++) {
    if (dataTransfer.types[i] === 'Files') return true;
  }
  return (dataTransfer.files?.length ?? 0) > 0;
}

export function countFileDragItems(dataTransfer: Pick<FileDragPayload, 'items' | 'files'>): number {
  const items = dataTransfer.items;
  if (items && items.length > 0) {
    let fileItems = 0;
    for (let i = 0; i < items.length; i++) {
      if (items[i]?.kind === 'file') fileItems++;
    }
    if (fileItems > 0) return fileItems;
  }
  return dataTransfer.files?.length ?? 0;
}

export function isDroppedFilePreviewSupported(filePath: string): boolean {
  return (
    isTextPreviewSupported(filePath) ||
    isImagePath(filePath) ||
    isPdfPath(filePath) ||
    isVideoPath(filePath) ||
    isDrawioPath(filePath)
  );
}

export function splitExternalFilePath(filePath: string): ExternalFileSelection | null {
  if (!filePath) return null;
  const sep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (sep < 0) return null;
  const relPath = filePath.slice(sep + 1);
  if (!relPath) return null;

  let workdir = filePath.slice(0, sep);
  if (sep === 0) {
    workdir = filePath.slice(0, 1);
  } else if (/^[A-Za-z]:$/.test(workdir)) {
    workdir = filePath.slice(0, sep + 1);
  }
  if (!workdir) return null;
  return { absPath: filePath, workdir, relPath };
}
