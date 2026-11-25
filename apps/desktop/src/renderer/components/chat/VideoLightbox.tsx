import { AttachmentCollectionPreview, useOpeningCollection } from './AttachmentCollection';
/**
 * VideoLightbox
 * ---------------------------------------------------------------------------
 * Floating video player rendered via the shared `PreviewWindow`. Mirrors
 * ImageLightbox but adapted for <video>:
 *
 *   - Shell: non-modal floating window, 200ms fade, no scrim and no background
 *     scroll lock; the conversation behind stays usable.
 *   - Focus: the window moves focus to <video> on open and restores the opener
 *     on close, without trapping Tab (DESIGN.md §14.2).
 *   - Esc key closes (same gesture suppression as ImageLightbox for menu close)
 *   - A click on the panel's bare background or its backdrop button closes;
 *     clicks ON <video controls> do not close (seek / pause stay usable), and
 *     clicking the conversation behind never closes.
 *   - Right-click (xdt-video:// only): 复制视频 / 打开视频所在目录。复制走
 *     OS 原生文件剪贴板(Win/Mac),粘贴出来是文件本体而不是字节流。
 *   - <video controls autoPlay loop preload="auto"> — autoplay is fine because
 *     the user explicitly clicked the cover to open the lightbox. Audio
 *     previews do not loop, and leaving always pauses and releases the element:
 *     a paused element can keep its decoder and audio pipeline alive, so the
 *     source is detached before the player goes away.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { registerMedia } from '@/lib/mediaPlaybackBus';
import { useVideoContextMenu } from './useVideoContextMenu';
import { PreviewHeader, PreviewFooter } from './PreviewChrome';
import { PreviewWindow } from './PreviewWindow';
import { claimPreviewWindowEscape } from './previewWindowKeyOwnership';
import { previewSourceName } from '@cindy/maker-shared/attachment-preview';

interface VideoLightboxProps {
  src: string;
  filename?: string;
  kind?: 'video' | 'audio';
  initialTime?: number;
  onClose: (time?: number) => void;
}

export function VideoLightbox(props: VideoLightboxProps) {
  const items = useOpeningCollection(props.src);
  return items ? (
    <AttachmentCollectionPreview
      items={items}
      source={props.src}
      onClose={props.onClose}
      initial={<VideoLightboxContent {...props} />}
    />
  ) : (
    <VideoLightboxContent {...props} />
  );
}

/**
 * Drop the element's source instead of only pausing it.
 *
 * Pausing stops the clock but keeps the media resource attached, so Chromium may
 * keep decoding audio after the element leaves the DOM — the reported symptom on
 * Windows is sound that only the system mixer can stop. Detaching the source and
 * running the load algorithm releases the pipeline (the spec also resets
 * currentTime there, so callers that need the position must read it first).
 */
function releaseMediaElement(el: HTMLMediaElement | null): void {
  if (!el) return;
  try {
    el.pause();
  } catch {
    /* 元素已 detach — 静默 */
  }
  // The playback bus may have released this element first; a second load()
  // would only run the load algorithm again on an already-empty element.
  if (el.getAttribute('src') === null && el.srcObject === null) return;
  el.removeAttribute('src');
  el.load();
}

function VideoLightboxContent({
  src,
  filename,
  kind = 'video',
  initialTime = 0, onClose }: VideoLightboxProps) {
  const { t } = useTranslation();
  const Media = kind === 'audio' ? 'audio' : 'video';
  const [isVisible, setIsVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const isClosingRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const { menuPos, setMenuPos, portalContainer, restoreVideoFocus } = useVideoContextMenu(videoRef, src);
  const lastMenuCloseAt = useRef(0);

  const handleClose = useCallback(() => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    // load() 会把 currentTime 归零,续播位置必须先取。
    const time = videoRef.current?.currentTime;
    releaseMediaElement(videoRef.current);
    setIsVisible(false);
    setTimeout(() => onClose(time), 200);
  }, [onClose]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || isClosingRef.current) return;
    // Chromium can autoplay a detached element. Attach the source only after
    // React commits the preview, so a discarded render cannot start playback.
    const unregister = registerMedia(el);
    el.setAttribute('src', src);
    return () => {
      unregister();
      releaseMediaElement(el);
    };
  }, [kind, src]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setIsVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.fullscreenElement) return;
      if (performance.now() - lastMenuCloseAt.current < 150) return;
      // Multiple non-modal previews can be open; only the foreground one closes.
      if (!claimPreviewWindowEscape(e, panelRef.current)) return;
      handleClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleClose]);

  const canRevealInFolder = src.startsWith('xdt-video://') || src.startsWith('cindy-media://');

  async function handleRevealInFolder(): Promise<void> {
    const res = await window.electronAPI.showItemInFolder({ url: src });
    if (!res.success) {
      toast.error(res.error ?? t('chat.media.openFolderFailed'));
    }
    setMenuPos(null);
  }

  async function handleCopyVideo(): Promise<void> {
    const res = await window.electronAPI.copyMediaToClipboard({ url: src });
    if (res.success) {
      toast.success(t('chat.media.videoCopied'));
    } else {
      toast.error(res.error ?? t('chat.media.copyFailed'));
    }
    setMenuPos(null);
  }

  const overlay = (
    <PreviewWindow
      ariaLabel={filename ?? previewSourceName(src, t('attachmentPreview.video'))}
      initialFocusRef={videoRef}
      panelRef={panelRef}
      onBackgroundClick={() => {
        if (performance.now() - lastMenuCloseAt.current < 150) return;
        handleClose();
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'opacity 200ms ease',
        opacity: isVisible ? 1 : 0,
        cursor: 'default',
      }}
    >
      <button
        type="button"
          tabIndex={-1}
          aria-hidden="true"
          style={{
          position: 'absolute',
          inset: 0,
          border: 0,
          padding: 0,
          background: 'transparent',
          cursor: 'default',
        }}
        onClick={() => {
          if (performance.now() - lastMenuCloseAt.current < 150) return;
          handleClose();
        }}
      />
        <PreviewHeader
          name={filename ?? previewSourceName(src, t('attachmentPreview.video'))}
          onClose={handleClose}
          onMenuClose={() => {
            lastMenuCloseAt.current = performance.now();
          }}
          onSave={
            /^(https?|cindy-remote-media|cindy-media|xdt-video|xdt-file|xdt-audio):/.test(src)
              ? () => {
                  void window.electronAPI
                    .saveMediaAs({ url: src.replace('xdt-audio:', 'xdt-file:') })
                    .catch(() => toast.error(t('chat.userMessage.attachmentSaveFailed')));
                }
              : undefined
          }
          menu={
            canRevealInFolder ? (
              <>
                <DropdownMenuItem onClick={handleCopyVideo}>
                  <Copy className="mr-2 h-4 w-4" />
                  {t('chat.media.copyVideo')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleRevealInFolder}>
                  <FolderOpen className="mr-2 h-4 w-4" />
                  {t('chat.media.revealVideo')}
                </DropdownMenuItem>
              </>
            ) : undefined
          }
        />
        {/* biome-ignore lint/a11y/useMediaCaption: user-provided local videos do not include caption tracks. */}
      <Media
          ref={videoRef}
        controls
        autoPlay
        loop={kind !== 'audio'}
        preload="metadata"
          playsInline
          onLoadedMetadata={() => {
            if (videoRef.current) videoRef.current.currentTime = initialTime;
          }}
          // controls 视频在 Chromium 本就在 Tab 序里;显式写出是为了 jsdom 单测
        // (jsdom 只认带 tabindex 的元素可聚焦,焦点进入 lightbox 的断言依赖它)。
        tabIndex={0}
        style={{
            width: kind === 'audio' ? 'min(640px, calc(var(--preview-width) - 80px))' : 'calc(var(--preview-width) - 80px)',
            maxWidth: 'calc(var(--preview-width) - 80px)',
          maxHeight: 'calc(var(--preview-height) - 160px)',
          objectFit: 'contain',
          cursor: 'default',
          position: 'relative',
          zIndex: 1,
        }}
        // 关键：视频层位于 backdrop button 之上，controls 的拖拽/点击
        // 只应该作用在 video 自身，不能触发任何父层关闭逻辑。
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          if (!canRevealInFolder) return;
          e.preventDefault();
          e.stopPropagation();
          setMenuPos({ x: e.clientX, y: e.clientY });
        }}
        onError={() => {
          // Playback errors also include blocked sources, offline devices and
          // unsupported codecs; they do not prove that a file was deleted.
            setFailed(true);
        }}
      />
        {failed ? (
          <PreviewFooter>
            <span className="text-sm text-[var(--text-secondary)]">
              {t('chat.media.videoUnavailable')}
            </span>
            <button
              type="button"
              className="rounded-full border border-[var(--border-default)] px-4 py-2 text-sm"
              onClick={() => {
                setFailed(false);
                videoRef.current?.load();
              }}
            >
              {t('attachmentPreview.retry')}
            </button>
          </PreviewFooter>
        ) : (
          <PreviewFooter collectionOnly />
        )}
        {canRevealInFolder ? (
        <DropdownMenu
          modal={!portalContainer}
          open={menuPos !== null}
          onOpenChange={(open) => {
            if (!open) {
              setMenuPos(null);
              lastMenuCloseAt.current = performance.now();
            }
          }}
        >
          <DropdownMenuTrigger asChild>
            <span
              aria-hidden
              style={{
                position: 'fixed',
                left: menuPos?.x ?? 0,
                top: menuPos?.y ?? 0,
                width: 0,
                height: 0,
                pointerEvents: 'none',
              }}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start" sideOffset={2}
            portalContainer={portalContainer}
            style={portalContainer ? { pointerEvents: 'auto' } : undefined}
            onCloseAutoFocus={restoreVideoFocus}
          >
            <DropdownMenuItem onClick={handleCopyVideo}>
              <Copy className="mr-2 h-4 w-4" />
              {t('chat.media.copyVideo')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleRevealInFolder}>
              <FolderOpen className="mr-2 h-4 w-4" />
              {t('chat.media.revealVideo')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </PreviewWindow>
  );

  return overlay;
}
