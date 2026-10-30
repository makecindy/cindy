import { useTranslation } from 'react-i18next';
import {
  burnInAnnotations,
  isImageBytesReachable,
  loadImageSourceBase64,
  xdtFileUrlToPath,
} from '@/lib/annotationBurnIn';
import {
  MAX_CLIPBOARD_PNG_BYTES,
  MAX_CLIPBOARD_PNG_EDGE,
  MAX_CLIPBOARD_PNG_PIXELS,
} from '../../../shared/pngClipboard';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { extractIpcError, mapIpcErrorToI18nKey } from '@/utils/ipcError';
import type { AnnotationStroke } from './lightboxAnnotations';

const log = createLogger('ImageClipboard');

/** Only local resources have a file reference. Never unwrap remote media URLs. */
export function localImageFileParams(src: string): { url?: string; filePath?: string } | null {
  if (src.startsWith('xdt-image://') || src.startsWith('cindy-media://')) return { url: src };
  const filePath = xdtFileUrlToPath(src);
  return filePath ? { filePath } : null;
}

/** Shared by inline images, attachment thumbnails and the preview toolbar. */
export function useImageClipboard(src: string) {
  const { t } = useTranslation();
  const localParams = localImageFileParams(src);

  async function copyImage(strokes: readonly AnnotationStroke[] = []): Promise<void> {
    let stage: 'read' | 'encode' | 'clipboard' = 'clipboard';
    try {
      if (localParams && strokes.length === 0) {
        // Preserve Finder/Explorer file-paste semantics for unannotated local images.
        const result = await window.electronAPI.copyMediaToClipboard(localParams);
        if (!result.success) throw new Error(result.error || 'Image copy failed');
      } else {
        stage = 'read';
        const source = await loadImageSourceBase64(src);
        stage = 'encode';
        const { blob } = await burnInAnnotations(source, strokes, 'image/png');
        stage = 'clipboard';
        const png = await blob.arrayBuffer();
        const header = new DataView(png);
        const width = header.getUint32(16);
        const height = header.getUint32(20);
        if (
          png.byteLength > MAX_CLIPBOARD_PNG_BYTES ||
          width > MAX_CLIPBOARD_PNG_EDGE ||
          height > MAX_CLIPBOARD_PNG_EDGE ||
          width * height > MAX_CLIPBOARD_PNG_PIXELS
        ) {
          // Preserve the existing large-image path without downscaling or widening
          // the native export boundary. It still needs document focus.
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        } else {
          // Native clipboard IPC works after asynchronous loading and focus changes.
          // Rejections are reported, never retried through a less restrictive route.
          await window.electronAPI.copyPngToClipboard({ png });
        }
      }
      toast.success(t('chat.media.imageCopied'));
    } catch (error) {
      // Do not log paths, signed URLs, image data or upstream error text.
      log.warn('image copy failed', { stage, code: extractIpcError(error)?.code ?? 'UNKNOWN' });
      toast.error(t(mapIpcErrorToI18nKey(error, { fallback: 'chat.media.copyFailed' })));
    }
  }

  async function revealImage(): Promise<void> {
    if (!localParams) return;
    try {
      const result = await window.electronAPI.showItemInFolder(localParams);
      if (!result.success) throw new Error(result.error || 'Image reveal failed');
    } catch (error) {
      toast.error(t(mapIpcErrorToI18nKey(error, { fallback: 'chat.media.openFolderFailed' })));
    }
  }

  return {
    canCopy: isImageBytesReachable(src),
    canReveal: localParams !== null,
    copyImage,
    revealImage,
  };
}
