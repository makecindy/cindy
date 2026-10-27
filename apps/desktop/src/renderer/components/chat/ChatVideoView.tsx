/** Chat-stream video player. Keep the browser controls, including native video
 * fullscreen, so its icon, position, keyboard handling and playback stay native. */

import { CHAT_FOCUS_CLASS } from './chatChrome';
import { useEffect, useRef, useState } from 'react';
import { FolderOpen, VideoOff, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { useRemoteMediaUrl } from '@/hooks/useRemoteMediaUrl';
import { registerMedia } from '@/lib/mediaPlaybackBus';
import { useVideoContextMenu } from './useVideoContextMenu';

export type ChatVideoVariant = 'tool-output';

interface ChatVideoViewProps {
  src: string;
  filename: string;
  variant: ChatVideoVariant;
  /** 远程(device-link)会话:把 src 改写成 cindy-remote-media:// 经 OSS 流式取;本地 / 不传 → 原样。 */
  sessionId?: string;
}

const VARIANT_STYLES: Record<
  ChatVideoVariant,
  {
    style: React.CSSProperties;
    className: string;
  }
> = {
  'tool-output': {
    // 与 ChatImageView 'tool-output' 完全一致,确保混合 image/video 列表
    // 视觉对齐。
    // maxWidth 的 100% 档:消息列被右侧栏等压窄时跟随列宽缩,防溢出
    // (50vw/40vh 相对窗口,列宽约束只有这档提供);maxHeight 收紧到
    // min(40vh, 420px) 防竖版视频占半屏。与 ChatImageView 保持一致。
    style: { maxWidth: 'min(100%, 50vw, 480px)', maxHeight: 'min(40vh, 420px)', height: 'auto' },
    className: 'rounded-xl border border-[var(--msg-tool-card-border)] object-contain',
  },
};

export function ChatVideoView({ src, filename, variant, sessionId }: ChatVideoViewProps) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  // 远程会话改写到 cindy-remote-media://(OSS range 流式);本地原样。下游统一用 displaySrc。
  const displaySrc = useRemoteMediaUrl(src, sessionId);
  const { menuPos, setMenuPos, portalContainer, restoreVideoFocus } = useVideoContextMenu(
    videoRef,
    displaySrc,
  );
  useEffect(() => {
    setFailedSrc(null);
  }, [displaySrc]);

  // Navigation and hidden/recycled rows must not leave an invisible player running.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const unregister = registerMedia(video);
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting && document.fullscreenElement !== video) video.pause();
    });
    let wasFullscreen = document.fullscreenElement === video;
    const onFullscreenChange = () => {
      const isFullscreen = document.fullscreenElement === video;
      if (wasFullscreen && !isFullscreen) {
        // A hidden notification ignored during fullscreen may not repeat on
        // exit. Resubscribe for a fresh sample of the restored inline bounds.
        observer.unobserve(video);
        observer.observe(video);
      }
      wasFullscreen = isFullscreen;
    };
    const onVisibility = () => {
      if (document.hidden) video.pause();
    };
    observer.observe(video);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      unregister();
      observer.disconnect();
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('visibilitychange', onVisibility);
      video.pause();
    };
  }, [displaySrc, failedSrc]);

  // A transient failure should recover when the window/network becomes available;
  // source patches also get a fresh player instead of inheriting an old failure.
  useEffect(() => {
    if (failedSrc !== displaySrc) return;
    const retry = () => setFailedSrc(null);
    window.addEventListener('online', retry);
    window.addEventListener('focus', retry);
    return () => {
      window.removeEventListener('online', retry);
      window.removeEventListener('focus', retry);
    };
  }, [displaySrc, failedSrc]);

  if (failedSrc === displaySrc) {
    return <VideoUnavailablePlaceholder filename={filename} onRetry={() => setFailedSrc(null)} />;
  }

  const { style, className } = VARIANT_STYLES[variant];
  const canRevealInFolder =
    displaySrc.startsWith('xdt-video://') || displaySrc.startsWith('cindy-media://');

  async function handleRevealInFolder(): Promise<void> {
    const res = await window.electronAPI.showItemInFolder({ url: displaySrc });
    if (!res.success) {
      toast.error(res.error ?? t('chat.media.openFolderFailed'));
    }
    setMenuPos(null);
  }

  async function handleCopyVideo(): Promise<void> {
    const res = await window.electronAPI.copyMediaToClipboard({ url: displaySrc });
    if (res.success) {
      toast.success(t('chat.media.videoCopied'));
    } else {
      toast.error(res.error ?? t('chat.media.copyFailed'));
    }
    setMenuPos(null);
  }

  return (
    <>
      <div
        className="relative inline-block self-start min-w-0 rounded-xl"
        style={{ maxWidth: style.maxWidth, maxHeight: style.maxHeight }}
        onContextMenu={(e) => {
          if (!canRevealInFolder) return;
          e.preventDefault();
          e.stopPropagation();
          setMenuPos({ x: e.clientX, y: e.clientY });
        }}
      >
        <video
          key={displaySrc}
          ref={videoRef}
          src={displaySrc}
          aria-label={filename}
          tabIndex={0}
          preload="metadata"
          controls
          playsInline
          style={style}
          className={cn(className, 'block', CHAT_FOCUS_CLASS)}
          onError={() => setFailedSrc(displaySrc)}
        />
      </div>
      {canRevealInFolder ? (
        <DropdownMenu
          modal={!portalContainer}
          open={menuPos !== null}
          onOpenChange={(open) => {
            if (!open) setMenuPos(null);
          }}
        >
          <DropdownMenuTrigger asChild>
            <span
              aria-hidden
              data-fixed-menu-anchor
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
            align="start"
            sideOffset={2}
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
    </>
  );
}

interface VideoUnavailablePlaceholderProps {
  filename: string;
  onRetry: () => void;
}

function VideoUnavailablePlaceholder({ filename, onRetry }: VideoUnavailablePlaceholderProps) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2',
        'rounded-xl border border-dashed',
        // These tokens are HSL channels: `var(--border)` alone is invalid CSS and drew a black border.
        'border-border bg-muted',
        'p-4 text-muted-foreground',
      )}
      style={{ maxWidth: 280, minHeight: 140 }}
    >
      <VideoOff className="h-8 w-8 text-[var(--text-tertiary)]" aria-hidden="true" />
      <div className="text-xs font-medium">{t('chat.media.videoUnavailable')}</div>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <div className="max-w-full truncate text-11 text-[var(--text-tertiary)]">{filename}</div>
        </Tooltip.Trigger>
        <Tooltip.Content variant="mono">{filename}</Tooltip.Content>
      </Tooltip.Root>
      <Button variant="secondary" size="sm" compact onClick={onRetry}>
        {t('chat.errorBanner.retry')}
      </Button>
    </div>
  );
}
