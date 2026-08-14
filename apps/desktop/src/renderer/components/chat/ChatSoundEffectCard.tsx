/**
 * ChatSoundEffectCard
 * ---------------------------------------------------------------------------
 * 聊天流里 mivo ElevenLabs 音效结果的渲染卡片。和 ChatAudioCard 并列:
 * MessageStream 的 tool_media 分支按 `track.kind` 分发,kind === 'sound_effect'
 * 走本组件。
 *
 * 与 ChatAudioCard 的差异:
 *   - **没有封面图**(ElevenLabs 永远返空 cover,占位也不渲染 — 整张卡的视觉
 *     重心是"声音本身",图像区会喧宾夺主)
 *   - **没有 tags / lyrics**(音效本就没有这些元数据,服务端也不传)
 *   - 单行布局: 左侧 play button → title → 进度 → 时长
 *   - 卡片高度更小,与 ChatAudioCard 共用最大宽度(多个音效成组时与音乐
 *     混排视觉密度一致)
 *
 * 共用的能力(直接对齐 ChatAudioCard):
 *   - registerMedia 全局媒体互斥总线
 *   - xdt-audio:// 自定义协议解析 + 右键"打开音频所在目录"
 *   - 自定义进度条 + scrub 跳转 + duration metadata fallback
 *
 * 设计 token: 沿用 `--msg-tool-card-bg/border/text/chevron`,跟 ChatAudioCard /
 * ChatVideoView 同一套黑白反色规范。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, Pause, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { registerMedia } from '@/lib/mediaPlaybackBus';
import type { ToolAudioTrack } from './AgentActionRow';
import { useRemoteMediaUrl } from '@/hooks/useRemoteMediaUrl';
import { isRemoteFileOrigin } from '@/lib/sessionFileOrigin';
import { useSessionFileOrigin } from './ChatSessionFileContext';

interface ChatSoundEffectCardProps {
  track: ToolAudioTrack;
  /** 远程(device-link)会话:把 audio URL 改写成 cindy-remote-media://;本地 / 不传 → 原样。 */
  sessionId?: string;
}

// `12.5` → `0:12`。负值 / NaN / Infinity 都返回 `0:00`。
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

export function ChatSoundEffectCard({ track, sessionId }: ChatSoundEffectCardProps) {
  const { t } = useTranslation();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const progressTrackRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  // 音效服务端 metadata 不带 duration_seconds,只能等 <audio> loadedmetadata
  // 回填;首次 mount 期间进度条总长 = 0,scrub 失效但播放/暂停照常工作。
  const [duration, setDuration] = useState(track.durationSeconds || 0);

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

  // 共享 ChatAudioCard 的全局媒体互斥:本卡片 play 时 bus 自动 pause 其它
  // 正在播的 audio/video。
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    return registerMedia(el);
  }, []);

  const title = track.title || t('chat.media.soundEffectUntitled');
  // 远程会话改写音频 URL;reveal 从改写后 URL 取本地路径 → 远程取不到、菜单消失。
  const displayAudioUrl = useRemoteMediaUrl(track.audioUrl, sessionId);
  // remote 会话同 ChatAudioCard:不把远端路径当本机路径。
  const audioRemote = isRemoteFileOrigin(useSessionFileOrigin());
  const localAudioPath = useMemo(
    () => (audioRemote ? null : getLocalAudioPath(displayAudioUrl)),
    [audioRemote, displayAudioUrl],
  );
  // cindy-media:// 本机媒体总仓(意识产物):main 侧 showItemInFolder 认 url 形态
  // 直接解析定位(同 ChatAudioCard);device-link 远程会话 URL 已改写 → 不命中。
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
      void el.play().catch(() => undefined);
    } else {
      el.pause();
    }
  }

  function handleScrub(evt: React.MouseEvent<HTMLDivElement>): void {
    const el = audioRef.current;
    const trackEl = progressTrackRef.current;
    if (!el || !trackEl || !duration) return;
    const rect = trackEl.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (evt.clientX - rect.left) / rect.width));
    el.currentTime = ratio * duration;
    setCurrentTime(el.currentTime);
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
        'flex items-center gap-3 rounded-[12px] px-4 py-3',
        'border bg-[var(--msg-tool-card-bg)] border-[var(--msg-tool-card-border)]',
      )}
      // 跟 ChatAudioCard 同款最大宽度 — 与音乐卡混排时左对齐 + 视觉密度一致。
      style={{ maxWidth: 'min(50vw, 640px)', width: '100%' }}
      onContextMenu={(e) => {
        if (!canReveal) return;
        e.preventDefault();
        e.stopPropagation();
        setMenuPos({ x: e.clientX, y: e.clientY });
      }}
    >
      {/* Play button — 与 ChatAudioCard 同尺寸 (28px) 同色,保持 affordance 一致 */}
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
          <Play size={14} fill="currentColor" style={{ marginLeft: 1 }} />
        )}
      </button>

      {/* Title — 单行截断,留给进度条主要宽度 */}
      <div
        className="min-w-0 shrink-0 max-w-[40%] truncate text-14 font-medium text-[var(--msg-tool-card-text)]"
        title={title}
      >
        {title}
      </div>

      {/* Current time */}
      <span className="shrink-0 text-11 font-medium tabular-nums text-[var(--msg-tool-card-chevron)]">
        {currentLabel}
      </span>

      {/* Progress track — 占满剩余空间 */}
      <div
        ref={progressTrackRef}
        onClick={handleScrub}
        className={cn(
          'relative h-1 flex-1 cursor-pointer rounded-full',
          'bg-[var(--msg-tool-card-border)]',
        )}
      >
        <div
          className="absolute left-0 top-0 h-full rounded-full bg-[var(--msg-tool-card-text)]"
          style={{ width: `${progressPct}%` }}
        />
        <div
          className="absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-[var(--msg-tool-card-text)]"
          style={{ left: `calc(${progressPct}% - 5px)` }}
        />
      </div>

      {/* Duration */}
      <span className="shrink-0 text-11 font-medium tabular-nums text-[var(--msg-tool-card-chevron)]">
        {durationLabel}
      </span>

      {/* 右键菜单(打开音效所在目录),与 ChatAudioCard 复用同一套 DropdownMenu */}
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
              {t('chat.media.revealSoundEffect')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {/* 真实 <audio> — preload metadata 让 chromium 拉 duration(音效本就短,
          整段 prefetch 也没什么成本,但保持与 ChatAudioCard 一致策略)。 */}
      <audio
        ref={audioRef}
        src={displayAudioUrl}
        preload="metadata"
        className="hidden"
      />
    </div>
  );
}
