/**
 * ComposerAttachments — the attachment tray shared by the chat composers.
 * ---------------------------------------------------------------------------
 * Thumbnail strip (images, file cards, hover preview, click-to-preview and
 * annotation editing) and the inline rejection strip, driven by the state from
 * `useAttachments`. Used by ChatInput and the bot group chat composer so both
 * show attached files the same way.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Pen, TriangleAlert, X } from 'lucide-react';

import { useStableTranslation as useTranslation } from '@/hooks/useStableTranslation';
import { ImageLightbox } from '@/components/chat/ImageLightbox';
import { AnnotationStrokesSvg } from '@/components/chat/AnnotationStrokesSvg';
import { ImageHoverPreview } from '@/components/chat/ImageHoverPreview';
import { formatBytes, TextLightbox } from '@/components/chat/TextLightbox';
import { AttachmentTypeThumb } from './AttachmentTypeThumb';
import { cn } from '@/lib/utils';
import type { AttachedFile, ImageAnnotationStroke } from '@/lib/fileTypes';
import { shouldOpenTextLightbox } from '@/lib/filePreview';
import { isDangerousAttachmentName } from '../../../shared/attachmentSafety';

// ── Attachment rejection strip ──
//
// Replacement for the old top-center toast.warning on attachment rejection
// (oversize / blocked type / read failure). Floats ABOVE the input card (same
// slot as the voice-input error notice) so it doesn't shrink the typing area,
// and persists until the next add attempt or manual dismiss (no auto-hide).
// Visually mirrors VoiceInputStatusNotice: a neutral rounded pill with a red
// warning icon + a dismiss button, stacked one per rejected file.
export function AttachmentRejectionStrip({
  rejections,
  onDismiss,
}: {
  rejections: { id: string; message: string }[];
  onDismiss: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {rejections.map((r) => (
        <div
          key={r.id}
          role="status"
          className={cn(
            'pointer-events-auto inline-flex max-w-[640px] items-center gap-2',
            'rounded-full border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]',
            'px-4 py-[10px] text-13 font-medium leading-snug text-[var(--cmd-palette-item-text)]',
            'shadow-[var(--shadow-menu)]',
          )}
        >
          <TriangleAlert
            aria-hidden
            className="h-4 w-4 shrink-0 text-[var(--error-fg)]"
            strokeWidth={2}
          />
          <span className="min-w-0 max-w-[calc(100vw-96px)] break-words">{r.message}</span>
          <button
            type="button"
            onClick={() => onDismiss(r.id)}
            aria-label={t('newChat.chatInput.attachmentRejection.dismiss')}
            className="-mr-1 shrink-0 rounded-full p-0.5 opacity-60 transition-opacity hover:opacity-100"
          >
            <X aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>
      ))}
    </>
  );
}

// ── Thumbnail components (F-FI-3/4/5) ──

/**
 * 标注编辑保存回调(惰性烧录):只把矢量笔迹写回附件——url/base64 保持原图
 * 不变,烧录位图在发送消息时由 materializeAnnotatedAttachmentsForSend 统一
 * 生成。空笔迹 = 清掉标注字段,附件回到普通图片。
 */
function applyAnnotationEdit(
  file: AttachedFile,
  result: { strokes: ImageAnnotationStroke[] },
  onUpdate: (id: string, patch: Partial<AttachedFile>) => void,
): void {
  if (result.strokes.length === 0) {
    onUpdate(file.id, { annotationStrokes: undefined });
  } else {
    onUpdate(file.id, { annotationStrokes: result.strokes });
  }
}

export function ThumbnailStrip({
  attachments,
  onRemove,
  onUpdate,
}: {
  attachments: AttachedFile[];
  onRemove: (id: string) => void;
  /** 标注编辑保存后就地替换附件(useAttachments.updateFile)。 */
  onUpdate: (id: string, patch: Partial<AttachedFile>) => void;
}) {
  return (
    <div className="scrollbar-hide flex items-center gap-2 overflow-x-auto pb-2 pl-0 pr-2 pt-2">
      {attachments.map((file) => (
        <ThumbnailItem key={file.id} file={file} onRemove={onRemove} onUpdate={onUpdate} />
      ))}
    </div>
  );
}

function ThumbnailItem({
  file,
  onRemove,
  onUpdate,
}: {
  file: AttachedFile;
  onRemove: (id: string) => void;
  onUpdate: (id: string, patch: Partial<AttachedFile>) => void;
}) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const thumbRef = useRef<HTMLDivElement>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);

  // attachment-thumb-click (2026-04-19): mirror UserMessage behaviour — clicking
  // a thumbnail opens the same overlay used in the message stream:
  //   - image  → ImageLightbox (full-screen image preview)
  //   - other  → TextLightbox (file content / oversize CTA)
  // Lightbox state is local to each item so multiple thumbnails don't fight.
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [textLightboxOpen, setTextLightboxOpen] = useState(false);
  // 缩略图自然尺寸:标注叠加层的 viewBox 基准(onLoad 取得,换图时重置)。
  const [thumbNaturalSize, setThumbNaturalSize] = useState<{
    src: string;
    width: number;
    height: number;
  } | null>(null);
  const isDownloadOnly =
    isDangerousAttachmentName(file.name) || isDangerousAttachmentName(file.path);

  // 非图片附件仍使用路径 tooltip；图片定位由共享 ImageHoverPreview 自己负责。
  useLayoutEffect(() => {
    if (isHovered && file.category !== 'image' && thumbRef.current) {
      const rect = thumbRef.current.getBoundingClientRect();
      setPopoverPos({
        top: rect.top,
        left: rect.left + rect.width / 2,
      });
    } else {
      setPopoverPos(null);
    }
  }, [file.category, isHovered]);

  const handleOpenPreview = useCallback(async () => {
    // attachment-thumb-click polish (2026-04-19): clicking opens the lightbox
    // INSTEAD of leaving the hover preview/tooltip dangling. Reset the hover
    // flag here so the portal popover (image preview / path tooltip) hides
    // immediately — otherwise it stays visible behind the lightbox and is
    // still on screen the moment the lightbox closes (mouse hasn't moved, so
    // onMouseLeave never fires on its own).
    setIsHovered(false);
    if (file.category === 'image') {
      // 惰性烧录:托盘附件的 url/base64 恒为原图,已有笔迹由 lightbox 以矢量
      // 叠加显示(可继续编辑/撤销)。
      const src = file.url ?? (file.base64 ? `data:${file.mimeType};base64,${file.base64}` : null);
      if (src) setLightboxSrc(src);
      return;
    }
    // Historical composer drafts may still contain an executable's original
    // path from before dangerous attachments were staged as `.bin`. Never pass
    // those paths to the OS default-app opener from the attachment tray.
    if (isDownloadOnly) return;
    // Non-image text/code/markdown files preview via TextLightbox. Other
    // supported attachment categories (PDF, etc.) open in the system app.
    if (!file.path) return;
    if (!(await shouldOpenTextLightbox(file.path))) return;
    setTextLightboxOpen(true);
  }, [file, isDownloadOnly]);

  // 图片缩略图恒为 56×56 方块;其余附件走横向文件卡,宽度随文件名自适应
  // (上限 220px)。判定条件必须与下面渲染分支一致——缓存写失败、既无 url 也无
  // base64 的图片同样落到文件卡分支。
  const isImageThumb = file.category === 'image' && Boolean(file.url || file.base64);
  const thumbSrc = file.url ?? `data:${file.mimeType};base64,${file.base64}`;
  // 副行是「类型 · 大小」;无扩展名(Makefile 之类)或 size 缺失时按存在的部分给。
  // file.size 是拖入那一刻的快照:文件在托盘期间被改写后,发出去的是新内容,卡片
  // 却还报旧字节数。缩略图复核时 main 会把当前 stat 大小一并带回,这里优先用它。
  const extLabel = file.ext.replace('.', '').toUpperCase();
  const [liveByteSize, setLiveByteSize] = useState<number | null>(null);
  const shownSize = liveByteSize ?? file.size;
  // 复核回来的 0 是**真实的当前大小**(文件被清空了),要照实显示 0 B;只有拿不到
  // 复核值、且快照本身就是 0/缺失时才省掉大小段。
  const hasSize =
    Number.isFinite(shownSize) && (liveByteSize !== null ? shownSize >= 0 : shownSize > 0);
  const metaLine = [extLabel || null, hasSize ? formatBytes(shownSize) : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      ref={thumbRef}
      className="group relative shrink-0"
      style={isImageThumb ? { width: 56, height: 56 } : { height: 56, maxWidth: 220 }}
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
    >
      {/* Thumbnail content */}
      {/* image-local-cache: prefer xdt-image:// url; fall back to base64 (F6). */}
      <button
        type="button"
        className={cn(
          'h-full w-full border-0 bg-transparent p-0 text-left',
          isDownloadOnly ? 'cursor-default' : 'cursor-pointer',
        )}
        onClick={handleOpenPreview}
        disabled={isDownloadOnly}
        aria-label={
          isDownloadOnly
            ? t('chat.userMessage.attachmentAttachedAria', { name: file.name })
            : `Preview ${file.name}`
        }
      >
        {file.category === 'image' && (file.url || file.base64) ? (
          <span className="relative block h-full w-full">
            <img
              src={thumbSrc}
              alt={file.name}
              className="h-full w-full rounded-lg object-cover"
              draggable={false}
              onLoad={(event) => {
                setThumbNaturalSize({
                  src: thumbSrc,
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                });
              }}
            />
            {file.annotationStrokes?.length &&
            thumbNaturalSize?.src === thumbSrc &&
            thumbNaturalSize.width > 0 &&
            thumbNaturalSize.height > 0 ? (
              // 缩略图是 object-cover:SVG 以 xMidYMid slice 做同样的居中裁切,笔迹与
              // 图片严格对齐;外层圆角裁剪与图片圆角一致。
              <span
                className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg"
                aria-hidden
              >
                <AnnotationStrokesSvg
                  strokes={file.annotationStrokes}
                  naturalWidth={thumbNaturalSize.width}
                  naturalHeight={thumbNaturalSize.height}
                  preserveAspectRatio="xMidYMid slice"
                  className="block h-full w-full"
                />
              </span>
            ) : null}
            {file.annotationStrokes && file.annotationStrokes.length > 0 ? (
              <span
                className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full"
                style={{ backgroundColor: 'var(--annotation-accent)' }}
                aria-hidden
              >
                <Pen className="h-2.5 w-2.5 text-white" />
              </span>
            ) : null}
          </span>
        ) : (
          // 文件卡(2026-07-27):图标块 + 文件名 + 「类型 · 大小」。此前是一个只印
          // 扩展名的 56×56 方块,并排两份 PDF 根本认不出谁是谁——文件名必须直接
          // 可见,不能只挂在 hover tooltip 上。
          <div
            className="flex h-full w-full items-center gap-2 rounded-xl px-2"
            style={{ backgroundColor: 'var(--surface-chip)' }}
          >
            <span
              // 缩略区比卡片底再抬一层:--file-chip-bg 与 --surface-chip 在 Light
              // 下只差一档灰(#D8D9DB / #e5e5e5),实机上根本看不出块。内容由
              // AttachmentTypeThumb 决定:优先系统缩略图,拿不到回落自绘类型图标。
              className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg"
              style={{ backgroundColor: 'var(--surface-elevated)' }}
            >
              <AttachmentTypeThumb file={file} onByteSize={setLiveByteSize} />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-xs" style={{ color: 'var(--text-primary)' }}>
                {file.name}
              </span>
              {metaLine ? (
                <span className="truncate text-11" style={{ color: 'var(--text-secondary)' }}>
                  {metaLine}
                </span>
              ) : null}
            </span>
          </div>
        )}
      </button>

      {/* Remove button — visible on hover */}
      <button
        type="button"
        className={cn(
          'absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full text-10 text-white',
          'opacity-0 transition-opacity group-hover:opacity-100',
        )}
        style={{ backgroundColor: 'var(--file-remove-bg)' }}
        onClick={(e) => {
          e.stopPropagation();
          onRemove(file.id);
        }}
        aria-label={`Remove ${file.name}`}
      >
        &times;
      </button>

      {/* Hover preview / tooltip (F-FI-4) — rendered via portal to escape overflow clipping */}
      {file.category === 'image' && (file.url || file.base64) ? (
        <ImageHoverPreview
          open={isHovered}
          anchorRef={thumbRef}
          src={thumbSrc}
          alt={file.name}
          annotationStrokes={file.annotationStrokes}
        />
      ) : null}
      {isHovered &&
        popoverPos &&
        file.category !== 'image' &&
        createPortal(
          <div
            className="pointer-events-none fixed z-50 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs"
            style={{
              top: popoverPos.top - 10, // 10px gap above thumbnail
              left: popoverPos.left,
              transform: 'translate(-50%, -100%)',
              backgroundColor: 'var(--tooltip-bg)',
              color: 'var(--tooltip-text)',
            }}
          >
            {file.path}
          </div>,
          document.body,
        )}

      {/* attachment-thumb-click (2026-04-19): lightboxes mirroring UserMessage. */}
      {lightboxSrc && (
        <ImageLightbox
          src={lightboxSrc}
          onClose={() => setLightboxSrc(null)}
          // 托盘图片的标注编辑:惰性烧录只写回矢量笔迹,不再依赖会话缓存,
          // 缓存附件与草稿 base64 附件统一支持。
          annotationEdit={
            file.category === 'image' && (file.url || file.base64)
              ? {
                  initialStrokes: file.annotationStrokes,
                  onSave: (result) => applyAnnotationEdit(file, result, onUpdate),
                }
              : undefined
          }
        />
      )}
      {textLightboxOpen && (
        <TextLightbox
          filePath={file.path}
          fileName={file.name}
          onClose={() => setTextLightboxOpen(false)}
        />
      )}
    </div>
  );
}
