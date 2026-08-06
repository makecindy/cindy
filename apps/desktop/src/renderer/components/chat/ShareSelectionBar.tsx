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

import { useCallback, useEffect, useState } from 'react';
import { Minus } from 'lucide-react';
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
  shareSiteHostForRegion,
} from '@/lib/shareConversationImage';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useBrandLogo } from '@/hooks/useBrandLogo';
import shareCharacterSrc from '@/assets/cindy-share-character.jpg';
import { CURRENT_CINDY_REGION } from '../../../shared/brandRegion';
import { shareSelectionStore, useShareSelectionCount } from './shareSelectionStore';

const log = createLogger('ShareSelectionBar');

interface ShareSelectionBarProps {
  sessionId: string;
  /** 聊天内容宽度，透传给光栅化以保证换行与流里一致。 */
  contentWidth: number;
  /** 操作条自身宽度，与 ChatInput 对齐。 */
  barWidth: number;
}

type BusyKind = 'copy' | 'download';

export function ShareSelectionBar({ sessionId, contentWidth, barWidth }: ShareSelectionBarProps) {
  const { t } = useTranslation();
  const count = useShareSelectionCount();
  const [busy, setBusy] = useState<BusyKind | null>(null);
  // 页脚使用产品指定的 Cindy 主视觉；wordmark 仍跟随当前主题。
  const logoSrc = useBrandLogo();

  // 全选与产物顺序都以「已渲染的消息」为准(见 queryShareableMessageIds 注释:
  // render-window 外的消息克隆不到,按 messages 全集全选会静默丢内容)。
  // 每次动作时当场查 DOM —— 唯一事实源,不维护第二份可能过期的列表。
  const toggleAll = useCallback(() => {
    if (count > 0) shareSelectionStore.clearSelection();
    else shareSelectionStore.setSelection(queryShareableMessageIds(sessionId));
  }, [count, sessionId]);

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
      contentWidth,
      logoSrc,
      characterSrc: shareCharacterSrc,
      siteHost: shareSiteHostForRegion(CURRENT_CINDY_REGION),
    });
  }, [contentWidth, logoSrc, sessionId]);

  const run = useCallback(
    async (kind: BusyKind) => {
      if (busy || count === 0) return;
      setBusy(kind);
      try {
        const blob = await buildBlob();
        if (kind === 'copy') {
          await copyPngBlobToClipboard(blob);
          toast.success(t('chat.shareImage.copied'));
        } else {
          const res = await window.electronAPI.saveMediaAs({
            url: await blobToDataUrl(blob),
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
        toast.error(
          err instanceof ShareImageSelectionNotMountedError
            ? t('chat.shareImage.notMounted')
            : t('chat.shareImage.failed'),
        );
      } finally {
        setBusy(null);
      }
    },
    [buildBlob, busy, count, t],
  );

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isEditableKeyboardTarget(e.target)) return;
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
  }, [toggleAll]);

  const modifierLabel = window.electronAPI?.platform === 'darwin' ? '⌘A' : 'Ctrl+A';
  const disabled = count === 0 || busy !== null;

  return (
    <div
      {...{ [SHARE_EXCLUDE_ATTR]: '' }}
      style={{ width: barWidth }}
      className="flex items-center gap-3 border-t border-[var(--border-default)] pt-3"
    >
      {/* 两态即可,不需要「已全选」第三态:有选中 → 点一下清空(Minus),
          全空 → 点一下全选。这样也不必维护一个可能过期的 total。 */}
      <button
        type="button"
        role="checkbox"
        aria-checked={count > 0}
        aria-label={count > 0 ? t('chat.shareImage.clearAll') : t('chat.shareImage.selectAll')}
        onClick={toggleAll}
        className={cn(
          'flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors',
          'outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
          count > 0
            ? 'bg-[var(--accent-cta-bg-pure)] text-[var(--accent-pure-cta-fg)]'
            : 'border border-[var(--border-default)] bg-transparent hover:border-[var(--text-secondary)]',
        )}
      >
        {count > 0 ? <Minus size={12} strokeWidth={2.5} aria-hidden /> : null}
      </button>

      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium leading-tight text-[var(--text-primary)]">
          {t('chat.shareImage.title')}
        </div>
        <div className="mt-0.5 truncate text-[12px] leading-tight text-[var(--text-secondary)]">
          {t('chat.shareImage.subtitle', { count })}
        </div>
        <div className="mt-0.5 truncate text-[11px] leading-tight text-[var(--text-tertiary)]">
          {t('chat.shareImage.shortcutHint', { selectAll: modifierLabel })}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => shareSelectionStore.exit()}
          className={cn(
            'rounded-full px-6 py-2.5 text-[13px] font-medium transition-colors',
            'bg-[var(--surface-chip)] text-[var(--text-primary)]',
            'hover:bg-[var(--surface-hover)]',
            'outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
          )}
        >
          {t('chat.shareImage.cancel')}
        </button>
        <button
          type="button"
          onClick={() => void run('download')}
          disabled={disabled}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-6 py-2.5 text-[13px] font-medium transition-colors',
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
            'inline-flex items-center gap-1.5 rounded-full px-6 py-2.5 text-[13px] font-medium transition-opacity',
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
