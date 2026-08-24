/**
 * ShareSelectionBar — 分享选择模式的底部操作条。
 *
 * 选择模式下**替换 ChatInput** 占据输入区(CCAgentSessionView):正在挑消息时不该
 * 还能发消息,两者互斥比并存更清楚。
 *
 * 与页面同底、只用 1px hairline 与上方内容分隔(§2 layer rule:分隔靠边框不靠背景
 * 色差)。三个出口按钮走§4 的 pill 档:取消 / 下载到本地是 button/primary(灰 pill),
 * 复制为图片是 button/cta —— **不照抄参考图的品牌绿**,CTA 一律走 Cindy 自己的
 * --accent-cta-bg-pure。
 *
 * 键盘监听挂在 window 上而不是某个容器:用户此刻的焦点可能在消息流任意位置,
 * Esc / ⌘A 都应生效。本组件只在选择模式挂载,所以无需额外的 active 判断。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Spinner } from '@/components/ui/spinner';
import { blobToDataUrl } from '@/lib/annotationBurnIn';
import { isEditableKeyboardTarget } from '@/lib/editableKeyboardTarget';
import { createLogger } from '@/lib/logger';
import { copyPngBlobToClipboard } from '@/lib/rasterizeToImage';
import {
  buildShareImageBlob,
  queryShareableMessageIds,
  SHARE_EXCLUDE_ATTR,
  ShareImageSelectionNotMountedError,
  ShareImageTooLargeError,
} from '@/lib/shareConversationImage';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useBrandLogo } from '@/hooks/useBrandLogo';
import shareCharacterSrc from '@/assets/cindy-share-character.jpg';
import { shareSelectionStore, useShareSelectionCount } from './shareSelectionStore';

const log = createLogger('ShareSelectionBar');

interface ShareSelectionBarProps {
  sessionId: string;
  /** 按下导出时读取最新聊天内容宽度，保证光栅化换行与流里一致。 */
  getContentWidth: () => number;
  /** 操作条自身宽度，与 ChatInput 对齐。 */
  barWidth: CSSProperties['width'];
}

type BusyKind = 'copy' | 'download';

export function ShareSelectionBar({
  sessionId,
  getContentWidth,
  barWidth,
}: ShareSelectionBarProps) {
  const { t } = useTranslation();
  const count = useShareSelectionCount();
  const [busy, setBusy] = useState<BusyKind | null>(null);
  const [compactLayout, setCompactLayout] = useState(false);
  const barRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(true);
  const selectionBeforeSelectAllRef = useRef<string[] | null>(null);
  // 页脚使用产品指定的 Cindy 主视觉；wordmark 仍跟随当前主题。
  const logoSrc = useBrandLogo();
  // 不缓存:render-window 会随滚动变化,缓存会让按钮状态与当前可选消息错位;
  // 导出 / 全选动作仍会当场复查 DOM,这里仅派生当前复选框显示状态。
  const shareableMessageIds = queryShareableMessageIds(sessionId);
  const selectedVisibleCount =
    shareSelectionStore.getSelectedIdsInOrder(shareableMessageIds).length;
  const allSelected =
    shareableMessageIds.length > 0 &&
    selectedVisibleCount === shareableMessageIds.length &&
    selectedVisibleCount === count;
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const update = () => {
      const nextCompact = bar.getBoundingClientRect().width < 640;
      setCompactLayout((current) => (current === nextCompact ? current : nextCompact));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  // 全选与产物顺序都以「已渲染的消息」为准(见 queryShareableMessageIds 注释:
  // render-window 外的消息克隆不到,按 messages 全集全选会静默丢内容)。
  // 每次动作时当场查 DOM —— 唯一事实源,不维护第二份可能过期的列表。
  const toggleAll = useCallback(() => {
    const messageIds = queryShareableMessageIds(sessionId);
    const selectedCount = shareSelectionStore.getSelectedIdsInOrder(messageIds).length;
    const isAllSelected =
      messageIds.length > 0 &&
      selectedCount === messageIds.length &&
      selectedCount === shareSelectionStore.count();
    if (isAllSelected) {
      shareSelectionStore.setSelection(selectionBeforeSelectAllRef.current ?? []);
      selectionBeforeSelectAllRef.current = null;
      return;
    }
    selectionBeforeSelectAllRef.current = shareSelectionStore.getSelectedIds();
    shareSelectionStore.setSelection(messageIds);
  }, [sessionId]);

  const buildBlob = useCallback(async () => {
    const orderedSelectedIds = shareSelectionStore.getSelectedIdsInOrder(
      queryShareableMessageIds(sessionId),
    );
    if (orderedSelectedIds.length !== shareSelectionStore.count()) {
      throw new ShareImageSelectionNotMountedError();
    }
    return buildShareImageBlob({
      sessionId,
      orderedSelectedIds,
      contentWidth: getContentWidth() || 880,
      logoSrc,
      characterSrc: shareCharacterSrc,
    });
  }, [getContentWidth, logoSrc, sessionId]);

  const run = useCallback(
    async (kind: BusyKind) => {
      if (busy || count === 0) return;
      setBusy(kind);
      try {
        const blob = await buildBlob();
        if (kind === 'copy') {
          if (!shareSelectionStore.isActive(sessionId)) return;
          await copyPngBlobToClipboard(blob);
          toast.success(t('chat.shareImage.copied'));
        } else {
          const url = await blobToDataUrl(blob);
          if (!shareSelectionStore.isActive(sessionId)) return;
          const res = await window.electronAPI.saveMediaAs({
            url,
          });
          // 用户在原生对话框里取消:不是失败,不 toast、不退出选择模式。
          if (res.canceled) return;
          toast.success(t('chat.shareImage.saved'));
        }
        shareSelectionStore.exit();
      } catch (err) {
        log.warn('share image failed', {
          kind,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!shareSelectionStore.isActive(sessionId)) return;
        toast.error(
          err instanceof ShareImageSelectionNotMountedError
            ? t('chat.shareImage.notMounted')
            : err instanceof ShareImageTooLargeError
              ? t('chat.shareImage.tooLarge')
              : t('chat.shareImage.failed'),
        );
      } finally {
        if (mountedRef.current) setBusy(null);
      }
    },
    [buildBlob, busy, count, sessionId, t],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      if (isEditableKeyboardTarget(e.target)) return;
      if (busy) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        shareSelectionStore.exit();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        toggleAll();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, toggleAll]);

  const disabled = count === 0 || busy !== null;

  return (
    <div
      ref={barRef}
      {...{ [SHARE_EXCLUDE_ATTR]: '' }}
      style={{ width: barWidth }}
      className={cn(
        'border-t border-[var(--border-default)] pt-3',
        compactLayout
          ? 'grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2'
          : 'flex items-center gap-3',
      )}
    >
      {/* 部分勾选不等于全选:按钮仍显示未选中,点击后临时补齐全部；只有当前
          可选项全部勾上时才显示选中态,再次点击恢复全选前的用户选择。 */}
      <button
        type="button"
        role="checkbox"
        aria-checked={allSelected}
        aria-label={t('chat.shareImage.selectAll')}
        onClick={toggleAll}
        disabled={busy !== null || shareableMessageIds.length === 0}
        className={cn(
          'inline-flex h-8 shrink-0 items-center gap-2 rounded-full border px-3 text-13 font-medium transition-colors',
          'outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
          'border-[var(--border-default)] bg-[var(--surface-chip)] text-[var(--text-primary)]',
          'hover:bg-[var(--surface-hover)] disabled:cursor-default disabled:opacity-50',
        )}
      >
        <span
          className={cn(
            'flex h-4 w-4 items-center justify-center rounded-full border transition-colors',
            allSelected
              ? 'border-[var(--accent-cta-bg-pure)] bg-[var(--accent-cta-bg-pure)] text-[var(--accent-pure-cta-fg)]'
              : 'border-[var(--text-tertiary)] bg-transparent',
          )}
        >
          {allSelected ? <Check size={11} strokeWidth={2.5} aria-hidden /> : null}
        </span>
        <span>{t('chat.shareImage.selectAll')}</span>
      </button>

      <div className="min-w-0 flex-1">
        <div className="text-14 font-medium leading-tight text-[var(--text-primary)]">
          {t('chat.shareImage.title')}
        </div>
        <div className="mt-0.5 truncate text-12 leading-tight text-[var(--text-secondary)]">
          {t('chat.shareImage.subtitle', { count })}
        </div>
      </div>

      <div
        className={cn(
          'flex items-center gap-2',
          compactLayout ? 'col-span-2 flex-wrap justify-end' : 'shrink-0',
        )}
      >
        <button
          type="button"
          onClick={() => shareSelectionStore.exit()}
          disabled={busy !== null}
          className={cn(
            'rounded-full px-6 py-2.5 text-13 font-medium transition-colors',
            'bg-[var(--surface-chip)] text-[var(--text-primary)]',
            'hover:bg-[var(--surface-hover)]',
            'outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            busy && 'cursor-default opacity-50 hover:bg-[var(--surface-chip)]',
          )}
        >
          {t('chat.shareImage.cancel')}
        </button>
        <button
          type="button"
          onClick={() => void run('download')}
          disabled={disabled}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-6 py-2.5 text-13 font-medium transition-colors',
            'bg-[var(--surface-chip)] text-[var(--text-primary)]',
            'hover:bg-[var(--surface-hover)]',
            'outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            disabled && 'cursor-default opacity-50 hover:bg-[var(--surface-chip)]',
          )}
        >
          {busy === 'download' ? (
            <>
              <Spinner size={13} strokeWidth={2} />
              {t('chat.shareImage.generating')}
            </>
          ) : (
            t('chat.shareImage.download')
          )}
        </button>
        <button
          type="button"
          onClick={() => void run('copy')}
          disabled={disabled}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-6 py-2.5 text-13 font-medium transition-opacity',
            'bg-[var(--accent-cta-bg-pure)] text-[var(--accent-pure-cta-fg)]',
            'outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            disabled ? 'cursor-default opacity-50' : 'hover:opacity-90',
          )}
        >
          {busy === 'copy' ? (
            <>
              <Spinner size={13} strokeWidth={2} />
              {t('chat.shareImage.generating')}
            </>
          ) : (
            t('chat.shareImage.copy')
          )}
        </button>
      </div>
    </div>
  );
}
