/**
 * ChatVideoView
 * ---------------------------------------------------------------------------
 * 聊天流里视频渲染的统一组件,与 ChatImageView 对位:art video tools
 * (seedance / 未来 kling/luma) 的产物视频都走这里。封面 + 点击播放,大图
 * 走 VideoLightbox。
 *
 * 行为契约:
 *   - 默认显示首帧封面(<video preload="metadata">,chromium 自取首帧),
 *     上盖一个半透明大 Play 按钮;<video> 本身**不挂 controls**——
 *     原位永远是封面而不是迷你播放器。
 *   - 点击 → 打开 VideoLightbox 全屏播放(controls + autoPlay + loop)。
 *   - 失败降级 → ImageMissingPlaceholder 同款样式,文案换"视频不可用"。
 *   - 右键(仅 xdt-video://):复制视频 / 打开视频所在目录。复制走 OS 原生
 *     文件剪贴板(Win/Mac),粘贴出来是文件本体,不是字节流。
 *
 * variant 的尺寸 / 边框沿用与 image 同款,以后调样式只用动一处。
 */

import { useState } from 'react';
import { Play, FolderOpen, VideoOff, Copy } from 'lucide-react';
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
import { VideoLightbox } from './VideoLightbox';
import { useRemoteMediaUrl } from '@/hooks/useRemoteMediaUrl';

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
    className:
      'rounded-[12px] border border-[var(--msg-tool-card-border)] object-contain',
  },
};

export function ChatVideoView({ src, filename, variant, sessionId }: ChatVideoViewProps) {
  const { t } = useTranslation();
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [errored, setErrored] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  // 远程会话改写到 cindy-remote-media://(OSS range 流式);本地原样。下游统一用 displaySrc。
  const displaySrc = useRemoteMediaUrl(src, sessionId);

  if (errored) {
    return <VideoMissingPlaceholder filename={filename} />;
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
      {/* 容器 wraps <video> 以叠加 Play 按钮,本身就是点击区。
          <video> preload=metadata 让 chromium 自动渲染首帧作为封面,
          NOT 挂 controls — 用户一点就走 lightbox 大图播放。 */}
      <div
        // self-start 与 ChatImageView tool-output 同理:防止 MessageStream 的
        // flex-col 包裹层把容器拉宽到超过 <video> 实际宽度(点击区/边框错位)。
        className="relative inline-block self-start cursor-pointer hover:opacity-90 transition-opacity"
        style={{ maxWidth: style.maxWidth, maxHeight: style.maxHeight }}
        onClick={() => setLightboxOpen(true)}
        onContextMenu={(e) => {
          if (!canRevealInFolder) return;
          e.preventDefault();
          e.stopPropagation();
          setMenuPos({ x: e.clientX, y: e.clientY });
        }}
      >
        <video
          src={displaySrc}
          // 关键:preload metadata 让 chromium 拉够元信息+首帧,但不预加载整段。
          preload="metadata"
          // muted 让浏览器允许在更多策略下自动取首帧(部分自动播放策略
          // 与 muted 强相关;我们这里没 autoplay,但 muted 让首帧抽取更稳)。
          muted
          // playsInline 防止部分场景下被吞成全屏播放器。
          playsInline
          style={style}
          className={cn(className, 'block pointer-events-none')}
          // 不挂 controls — 原位是封面状态。
          onError={() => setErrored(true)}
        />
        {/* 大 Play 按钮浮层 — 居中半透明圆 + lucide play 图标。
            点击落到外层 div,不需要这层自己处理 click。 */}
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
          aria-hidden
        >
          <div
            className={cn(
              'flex items-center justify-center',
              'w-14 h-14 rounded-full',
              'bg-black/55 backdrop-blur-sm',
              'shadow-[var(--shadow-menu)]',
            )}
          >
            <Play className="w-7 h-7 text-white fill-white" />
          </div>
        </div>
      </div>
      {canRevealInFolder ? (
        <DropdownMenu
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
          <DropdownMenuContent align="start" sideOffset={2}>
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
      {lightboxOpen && (
        <VideoLightbox src={displaySrc} onClose={() => setLightboxOpen(false)} />
      )}
    </>
  );
}

interface VideoMissingPlaceholderProps {
  filename: string;
}

function VideoMissingPlaceholder({ filename }: VideoMissingPlaceholderProps) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2',
        'rounded-[12px] border border-dashed',
        'border-[var(--border)] bg-[var(--muted)]',
        'p-4 text-[var(--muted-foreground)]',
      )}
      style={{ maxWidth: 280, minHeight: 140 }}
    >
      <VideoOff className="h-8 w-8 opacity-60" aria-hidden="true" />
      <div className="text-xs font-medium">{t('chat.media.videoUnavailable')}</div>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <div className="max-w-full truncate text-11 opacity-75">
            {filename}
          </div>
        </Tooltip.Trigger>
        <Tooltip.Content variant="mono">{filename}</Tooltip.Content>
      </Tooltip.Root>
    </div>
  );
}
