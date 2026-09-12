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
 *     the user explicitly clicked the cover to open the lightbox.
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

interface VideoLightboxProps {
  src: string;
  onClose: () => void;
}

export function VideoLightbox({ src, onClose }: VideoLightboxProps) {
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(false);
  const isClosingRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const lastMenuCloseAt = useRef(0);

  const handleClose = useCallback(() => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    setIsVisible(false);
    setTimeout(() => onClose(), 200);
  }, [onClose]);

  // 全局媒体互斥:lightbox autoPlay 起播时 bus 会自动 pause 其它正在
  // 播放的 audio/video;反过来,其它媒体起播时也会 pause 这里的视频。
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    return registerMedia(el);
  }, []);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setIsVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
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
    <FocusScope
      asChild
      trapped
      loop
      onMountAutoFocus={(event) => {
        event.preventDefault();
        videoRef.current?.focus();
      }}
    >
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'var(--overlay-lightbox)',
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
        aria-label={t('chat.lightbox.close')}
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
      {/* biome-ignore lint/a11y/useMediaCaption: user-provided local videos do not include caption tracks. */}
      <video
        ref={videoRef}
        src={src}
        controls
        autoPlay
        loop
        preload="auto"
        // controls 视频在 Chromium 本就在 Tab 序里;显式写出是为了 jsdom 单测
        // (jsdom 只认带 tabindex 的元素可聚焦,焦点进入 lightbox 的断言依赖它)。
        tabIndex={0}
        style={{
          maxWidth: 'calc(100vw - 80px)',
          maxHeight: 'calc(100vh - 80px)',
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
          toast.warning(t('chat.media.videoMissing'));
          handleClose();
        }}
      />
      {canRevealInFolder ? (
        <DropdownMenu
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
          <DropdownMenuContent align="start" sideOffset={2} className="z-[10000]">
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
  );

  return createPortal(overlay, document.body);
}
