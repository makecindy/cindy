import { usePreviewFocusReturn } from './PreviewChrome';
import { AttachmentCollectionPreview, useOpeningCollection } from './AttachmentCollection';
/**
 * VideoLightbox
 * ---------------------------------------------------------------------------
 * Full-screen video player rendered via React Portal. Mirrors ImageLightbox
 * but adapted for <video>:
 *
 *   - Overlay: rgba(0,0,0,0.85), 200ms fade, scroll lock on data-scroll-container
 *   - Focus: FocusScope moves focus to <video> on open, traps Tab inside the
 *     overlay, and returns focus to the pre-open element on unmount.
 *   - Esc key closes (same gesture suppression as ImageLightbox for menu close)
 *   - Background click closes; click ON the <video controls> region does NOT
 *     close (users need to drag the seek bar / hit pause without dismissing).
 *   - Right-click (xdt-video:// only): 复制视频 / 打开视频所在目录。复制走
 *     OS 原生文件剪贴板(Win/Mac),粘贴出来是文件本体而不是字节流。
 *   - <video controls autoPlay loop preload="auto"> — autoplay is fine because
 *     the user explicitly clicked the cover to open the lightbox. Audio
 *     previews do not loop, and leaving always pauses and releases the element:
 *     a paused element can keep its decoder and audio pipeline alive, so the
 *     source is detached before the player goes away.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FocusScope } from '@radix-ui/react-focus-scope';
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
import { PREVIEW_PANEL_CLASS, PREVIEW_PANEL_STYLE, PreviewHeader, PreviewFooter, PreviewScrim } from './PreviewChrome';
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
  el.removeAttribute('src');
  el.load();
}

function VideoLightboxContent({
  src,
  filename,
  kind = 'video',
  initialTime = 0, onClose }: VideoLightboxProps) {
  const restorePreviewFocus = usePreviewFocusReturn();
  const { t } = useTranslation();
  const Media = kind === 'audio' ? 'audio' : 'video';
  const [isVisible, setIsVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const isClosingRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { menuPos, setMenuPos, portalContainer, restoreVideoFocus } = useVideoContextMenu(videoRef, src);
  const lastMenuCloseAt = useRef(0);
  // Effect 重放时要补回被摘掉的源,而重放的 effect 不该跟着 src 重新订阅。
  const srcRef = useRef(src);
  srcRef.current = src;

  const handleClose = useCallback(() => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    // load() 会把 currentTime 归零,续播位置必须先取。
    const time = videoRef.current?.currentTime;
    releaseMediaElement(videoRef.current);
    setIsVisible(false);
    setTimeout(() => onClose(time), 200);
  }, [onClose]);

  // 全局媒体互斥:lightbox autoPlay 起播时 bus 会自动 pause 其它正在
  // 播放的 audio/video;反过来,其它媒体起播时也会 pause 这里的视频。
  // 合集预览关闭或切换时会直接卸载本组件而不经过 handleClose,卸载时
  // 同样要释放源,否则脱离 DOM 的媒体会在后台继续发声。
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    // Effect replay (StrictMode in dev, Vite Fast Refresh in the app) runs the
    // cleanup above on this same DOM node: the release detaches the source, and
    // React does not write the unchanged JSX `src` back, so the still-open
    // preview would sit there empty. Restore it during setup, as WallpaperVideo
    // does for its playback loop.
    if (el.getAttribute('src') === null) el.setAttribute('src', srcRef.current);
    const unregister = registerMedia(el);
    return () => {
      unregister();
      releaseMediaElement(el);
    };
  }, []);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setIsVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key !== 'Escape' || document.fullscreenElement) return;
      if (performance.now() - lastMenuCloseAt.current < 150) return;
      handleClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleClose]);

  useEffect(() => {
    const container = document.querySelector(
      '[data-scroll-container]',
    ) as HTMLElement | null;
    if (container) container.style.overflowY = 'hidden';
    return () => {
      if (container) container.style.overflowY = '';
    };
  }, []);

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
    // FocusScope(trapped+loop):键盘打开后焦点必须进入弹窗并圈禁在内——
    // 否则焦点留在 z-index 9999 遮罩背后的预览触发器上,Tab 会穿过被遮挡
    // 的聊天控件,视频 controls 也够不着。挂载时焦点直接给 <video>(Space
    // 暂停 / 方向键 seek 立即可用);卸载时 FocusScope 默认把焦点还给打开
    // 前的元素(ChatVideoView 键盘路径 = 预览触发器,与 onClose 里的显式
    // 恢复指向同一元素)。
    <>
    <PreviewScrim
      onClose={() => {
        if (performance.now() - lastMenuCloseAt.current < 150) return;
        handleClose();
      }}
    />
    <FocusScope
      onUnmountAutoFocus={restorePreviewFocus}
      asChild
      trapped
      loop
      onMountAutoFocus={(event) => {
        event.preventDefault();
        videoRef.current?.focus();
      }}
    >
    <div
      className={PREVIEW_PANEL_CLASS}
      style={{
        ...PREVIEW_PANEL_STYLE,
        zIndex: 9999,
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
        src={src}
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
            align="start" sideOffset={2} className="z-[10000]"
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
    </div>
    </FocusScope>
    </>
  );

  return createPortal(overlay, document.body);
}
