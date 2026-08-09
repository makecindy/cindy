/**
 * ChatAudioCard
 * ---------------------------------------------------------------------------
 * 聊天流里 mivo Suno 音乐结果的渲染卡片。和 ChatImageView / ChatVideoView
 * 同位:`extractToolResultMedia` 返回的 audio 类 ToolMediaItem 在
 * MessageStream 的 tool_media 分支会按一行一张地渲染本组件。
 *
 * Single Track 分别适配 Light / Dark。Dual Track 在 chat 流里通过
 * "两条相邻的 ToolMediaItem" 自然形成,我们不在组件层组合。
 *
 * 行为契约:
 *   - cover URL 存在 → 渲染 `<img>`(走 xdt-image:// 协议);失败 / 缺失
 *     → 渐变占位 + Music 图标
 *   - 标题:title (fallback "未命名");tags 多行,line-clamp 行内省略
 *   - 复制按钮:复制完整 tags 描述到剪贴板(.pen 设计里右上角原本是
 *     download + star,简化为单个 copy)
 *   - 播放器:本地 <audio>,自己管 play/pause + currentTime + duration
 *     更新;原生 controls 不挂(自定义 progress bar 风格一致),只挂
 *     metadata preload + range request 让 xdt-audio:// 协议正常工作
 *   - 进度条点击:跳转到对应时刻(scrubbing)
 *
 * 设计 token:沿用 `--msg-tool-card-bg/border/text/chevron`,自动跟 Light/
 * Dark 主题切换,无需在这里硬编码颜色。
 *
 * 不挂 actions strip:audio 不像 MJ 那样有再加工按钮链(目前 Suno 也不
 * 提供 button-action 机制),所以组件签名只接 track,不接 actions。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, FolderOpen, Music, Pause, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Tip } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { registerMedia } from '@/lib/mediaPlaybackBus';
import { useRemoteMediaUrl } from '@/hooks/useRemoteMediaUrl';
import { isRemoteFileOrigin } from '@/lib/sessionFileOrigin';
import { useSessionFileOrigin } from './ChatSessionFileContext';
import type { ToolAudioTrack } from './AgentActionRow';

interface ChatAudioCardProps {
  track: ToolAudioTrack;
  /** 远程(device-link)会话:把 audio/cover URL 改写成 cindy-remote-media://;本地 / 不传 → 原样。 */
  sessionId?: string;
}

// `175.96` → `2:55`。负值 / NaN / Infinity 都返回 `0:00`,让 UI 在 metadata
// 还没加载时也有合理占位。
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getLocalAudioPath(audioUrl: string): string | null {
  try {
    const url = new URL(audioUrl);
    if (url.protocol !== 'xdt-audio:' || url.host !== 'local') return null;
    const filePath = url.searchParams.get('path');
    return filePath && filePath.length > 0 ? filePath : null;
  } catch {
    return null;
  }
}

export function ChatAudioCard({ track, sessionId }: ChatAudioCardProps) {
  const { t } = useTranslation();
  // 远程会话改写音频/封面 URL 到 cindy-remote-media://;本地原样。reveal 从改写后的 URL
  // 取本地路径 → 远程自然取不到、菜单消失。
  const displayAudioUrl = useRemoteMediaUrl(track.audioUrl, sessionId);
  const displayCoverUrl = useRemoteMediaUrl(track.coverUrl ?? '', sessionId);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const progressTrackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [coverFailed, setCoverFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  // duration 优先用 <audio>.duration(以 metadata 为准),fallback 到
  // server 给的 track.durationSeconds(card 第一次挂载时 metadata 还没回,
  // 没 fallback 进度条总长会是 0,scrub 失效)。
  const [duration, setDuration] = useState(track.durationSeconds || 0);

  // <audio> 事件监听:挂在 ref 上,避免 React inline handler 在每次 re-render
  // 时反复 add/removeEventListener。
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = (): void => setCurrentTime(el.currentTime);
    const onMeta = (): void => {
      if (Number.isFinite(el.duration) && el.duration > 0) setDuration(el.duration);
    };
    const onPlay = (): void => setPlaying(true);
    const onPause = (): void => setPlaying(false);
    const onEnded = (): void => {
      setPlaying(false);
      setCurrentTime(0);
    };
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('ended', onEnded);
    return (): void => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ended', onEnded);
    };
  }, []);

  // 注册到全局媒体互斥总线:本卡片 play 时,bus 自动 pause 其它正在
  // 播放的 audio/video;切 session 时 MessageStream 顶层会调
  // stopAllMedia() 兜底停掉。
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    return registerMedia(el);
  }, []);

  const title = track.title || t('chat.media.audioUntitled');
  // remote 会话:即便 URL 未被改写(ssh workdir 外),也绝不把远端路径当本机
  // 路径去定位/打开——直接判 null 隐藏对应菜单项。
  const audioRemote = isRemoteFileOrigin(useSessionFileOrigin());
  const localAudioPath = useMemo(
    () => (audioRemote ? null : getLocalAudioPath(displayAudioUrl)),
    [audioRemote, displayAudioUrl],
  );
  // cindy-media:// 是本机媒体总仓(意识产物,字节永远在本机),main 侧
  // showItemInFolder 认 url 形态直接解析定位(与 ChatVideoView 同款);
  // device-link 远程会话下 URL 已被改写成 cindy-remote-media:// → 自然不命中。
  const canReveal = localAudioPath !== null || displayAudioUrl.startsWith('cindy-media://');
  const durationLabel = useMemo(() => formatDuration(duration), [duration]);
  const currentLabel = useMemo(() => formatDuration(currentTime), [currentTime]);
  const progressPct = useMemo(() => {
    if (!duration) return 0;
    return Math.min(100, Math.max(0, (currentTime / duration) * 100));
  }, [currentTime, duration]);

  function handleTogglePlay(): void {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      // chromium 偶发返回 rejected promise(同一页同时有多个 <audio>
      // 自动播放冲突),不处理直接吞掉避免 unhandled rejection,UI 状态
      // 由后续 play / pause 事件自动校正。
      void el.play().catch(() => undefined);
    } else {
      el.pause();
    }
  }

  // scrub 核心:把 clientX 折算成 currentTime,被 click + pointer drag 复用。
  function seekToClientX(clientX: number): void {
    const el = audioRef.current;
    const trackEl = progressTrackRef.current;
    if (!el || !trackEl || !duration) return;
    const rect = trackEl.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    el.currentTime = ratio * duration;
    setCurrentTime(el.currentTime);
  }

  function handlePointerDown(evt: React.PointerEvent<HTMLDivElement>): void {
    if (!duration) return;
    // setPointerCapture 让后续 pointermove / pointerup 即使指针移出 track
    // 也仍然派发到 track 元素上,拖出去再放手不会丢事件。
    evt.currentTarget.setPointerCapture(evt.pointerId);
    draggingRef.current = true;
    seekToClientX(evt.clientX);
  }

  function handlePointerMove(evt: React.PointerEvent<HTMLDivElement>): void {
    if (!draggingRef.current) return;
    seekToClientX(evt.clientX);
  }

  function handlePointerUp(evt: React.PointerEvent<HTMLDivElement>): void {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (evt.currentTarget.hasPointerCapture(evt.pointerId)) {
      evt.currentTarget.releasePointerCapture(evt.pointerId);
    }
  }

  async function handleCopyDescription(): Promise<void> {
    const text = track.tags?.trim();
    if (!text) {
      // 没有描述时直接 toast 已复制(空串)反而误导,静默 no-op。
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('chat.media.audioDescriptionCopied'));
    } catch {
      toast.error(t('chat.media.copyFailed'));
    }
  }

  async function handleRevealInFolder(): Promise<void> {
    if (!canReveal) return;
    const res = localAudioPath
      ? await window.electronAPI.showItemInFolder({ filePath: localAudioPath })
      : await window.electronAPI.showItemInFolder({ url: displayAudioUrl });
    if (!res.success) {
      toast.error(res.error ?? t('chat.media.openFolderFailed'));
    }
    setMenuPos(null);
  }

  return (
    <div
      className={cn(
        'flex items-center gap-4 rounded-[12px] p-4',
        'border bg-[var(--msg-tool-card-bg)] border-[var(--msg-tool-card-border)]',
      )}
      // 跟 ChatImageView/ChatVideoView 的 tool-output 视觉宽度同步,确保
      // 多类媒体混排时左对齐 + 视觉密度一致。
      style={{ maxWidth: 'min(50vw, 640px)', width: '100%' }}
      onContextMenu={(e) => {
        if (!canReveal) return;
        e.preventDefault();
        e.stopPropagation();
        setMenuPos({ x: e.clientX, y: e.clientY });
      }}
    >
      {/* Cover (96×96 — 与 .pen 设计稿尺寸一致) */}
      <div
        className="relative shrink-0 overflow-hidden rounded-[8px]"
        style={{ width: 96, height: 96 }}
      >
        {track.coverUrl && !coverFailed ? (
          <img
            src={displayCoverUrl}
            alt={title}
            className="h-full w-full object-cover"
            draggable={false}
            onError={() => setCoverFailed(true)}
          />
        ) : (
          // Fallback: 暗灰渐变 + Music icon,匹配 .pen 设计里没有 cover
          // 时的占位形态。
          <div
            className="flex h-full w-full items-center justify-center"
            style={{
              background:
                'linear-gradient(135deg, var(--msg-tool-card-chevron) 0%, var(--msg-tool-card-text) 100%)',
              opacity: 0.4,
            }}
          >
            <Music className="text-[var(--msg-tool-card-bg)]" size={32} />
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {/* Top row: title + copy */}
        <div className="flex items-start gap-3">
          <div
            className="min-w-0 flex-1 truncate text-15 font-semibold text-[var(--msg-tool-card-text)]"
            title={title}
          >
            {title}
          </div>
          {track.tags ? (
            <Tip text={t('chat.media.audioCopyDescription')}>
              <button
                type="button"
                onClick={handleCopyDescription}
                aria-label={t('chat.media.audioCopyDescription')}
                className={cn(
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px]',
                  'text-[var(--msg-tool-card-chevron)] hover:bg-[var(--msg-code-inline-bg)]',
                  'transition-colors',
                )}
              >
                <Copy size={16} />
              </button>
            </Tip>
          ) : null}
        </div>

        {/* Tags description — 多行截断 (line-clamp-2) 保持卡片高度稳定 */}
        {track.tags ? (
          <div
            className={cn(
              'overflow-hidden text-12 leading-[1.45] text-[var(--msg-tool-card-chevron)]',
            )}
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
            }}
          >
            {track.tags}
          </div>
        ) : null}

        {/* Player row: play btn + currentTime + progress + duration */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleTogglePlay}
            aria-label={playing ? 'Pause' : 'Play'}
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
              'bg-[var(--msg-tool-card-text)] text-[var(--msg-tool-card-bg)]',
              'transition-opacity hover:opacity-90',
            )}
          >
            {playing ? (
              <Pause size={14} fill="currentColor" />
            ) : (
              // 把 play 三角往右挪 1px 视觉居中(三角自身重心偏左)
              <Play size={14} fill="currentColor" style={{ marginLeft: 1 }} />
            )}
          </button>

          <span className="shrink-0 text-11 font-medium tabular-nums text-[var(--msg-tool-card-chevron)]">
            {currentLabel}
          </span>

          {/* Progress track — 点击 / 拖动 scrub。dot 跟着 fill 末端走。
              用 pointer events 统一处理 mouse + pen + touch;pointerdown
              里 setPointerCapture 锁定指针,move 过程中持续 seek。 */}
          <div
            ref={progressTrackRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            className={cn(
              'relative h-1 flex-1 cursor-pointer rounded-full',
              'bg-[var(--msg-tool-card-border)]',
              // 避免拖出 track 外触发浏览器原生 drag/选择
              'touch-none select-none',
            )}
          >
            <div
              className="absolute left-0 top-0 h-full rounded-full bg-[var(--msg-tool-card-text)]"
              style={{ width: `${progressPct}%` }}
            />
            <div
              className="absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-[var(--msg-tool-card-text)]"
              style={{
                // 微调 4px 让圆点视觉上压在 fill 末端(否则 dot 中心
                // 会比 fill 末端再凸出半个圆点宽)
                left: `calc(${progressPct}% - 5px)`,
              }}
            />
          </div>

          <span className="shrink-0 text-11 font-medium tabular-nums text-[var(--msg-tool-card-chevron)]">
            {durationLabel}
          </span>
        </div>
      </div>

      {/* 真实 <audio> — 不挂 controls(我们自己画播放器),preload metadata
          让 chromium 拉 duration 但不下整段。xdt-audio:// 协议在 main 进程
          的 audioFileProtocol.ts 处理 Range,seek 才能工作。 */}
      {canReveal ? (
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
            <DropdownMenuItem onClick={handleRevealInFolder}>
              <FolderOpen className="mr-2 h-4 w-4" />
              {t('chat.media.revealAudio')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <audio
        ref={audioRef}
        src={displayAudioUrl}
        preload="metadata"
        className="hidden"
      />
    </div>
  );
}
