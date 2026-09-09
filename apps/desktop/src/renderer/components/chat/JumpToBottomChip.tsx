/**
 * JumpToBottomChip
 * ---------------------------------------------------------------------------
 * 底部居中的"跳到底部" pill。对标 Claude Code CLI 的
 * "Jump to bottom (ctrl+End) ↓" 快捷提示。
 *
 * 触发逻辑(由 MessageStream 控制 visible 入参):
 *   - 用户向下滚动且未到底 → 显示
 *   - 滚动停止 2s → 隐藏
 *   - 用户改向上滚 / 到达底部 → 立即隐藏
 *   - 已有 NewMessageIndicator(未读>0)时让位 → 隐藏
 *
 * 视觉:与 NewMessageIndicator 完全同款规格(同一坐标位置 + 互斥共存,
 *   外观必须一致才不会有"切换抖一下尺寸"的视觉跳变):
 *   - h-8 / px-3 py-1.5 / rounded-full
 *   - text-12 font-medium
 *   - icon size=14,**放在文字前**(与 NewMessageIndicator 一致)
 *   - shadow-md / 同色 token (--content-area / --msg-tool-card-border / --msg-tool-text)
 *
 * 与 NewMessageIndicator 的关系:
 *   两者都在底部居中。NewMessageIndicator 是有未读时的"消息计数",信息密度
 *   更高,优先级更高。JumpToBottomChip 是无未读时的"快速跳底"快捷键,纯
 *   导航 affordance,优先级让出。MessageStream 用 visible 入参做互斥。
 */

import { ArrowDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

export interface JumpToBottomChipProps {
  /** 显隐开关 — MessageStream 按"下滑 + 未到底 + 2s 内有滚动 + 无未读"决定。 */
  visible: boolean;
  /** 点击回调 — MessageStream 复用 scrollToBottomSmooth。 */
  onClick: () => void;
  /** 距滚动容器底部的像素偏移,与 NewMessageIndicator 同根 token
   *  (bottomPadding + 12),保证两者出现时位置不打架。 */
  bottomOffset: number;
}

export function JumpToBottomChip({
  visible,
  onClick,
  bottomOffset,
}: JumpToBottomChipProps) {
  const { t } = useTranslation();
  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      style={{ bottom: bottomOffset }}
      className={cn(
        'absolute left-1/2 z-40 -translate-x-1/2',
        'transition-all duration-150 ease-out',
        visible
          ? 'pointer-events-auto translate-y-0 opacity-100'
          : 'pointer-events-none translate-y-2 opacity-0',
      )}
    >
      <button
        type="button"
        aria-label={t('chat.jumpToBottom')}
        onClick={onClick}
        className={cn(
          // 与 NewMessageIndicator 同款 pill 外形 (h-8 / px-3 py-1.5)
          'flex h-8 items-center gap-1.5 rounded-full px-3 py-1.5',
          'border border-[var(--msg-tool-card-border)]',
          'bg-[hsl(var(--content-area))] shadow-md',
          'text-12 font-medium leading-none text-[var(--msg-tool-text)]',
          'transition-colors duration-150 ease-out',
          // hover:用项目通用 list-item hover token(与 SlashCommandPalette /
          // ModelSelector 等同源)。不用 content-area + alpha,alpha 会让下方
          // 文字透过来。
          'hover:bg-[var(--cmd-palette-item-hover)] active:scale-[0.98]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]',
        )}
      >
        <ArrowDown size={14} className="shrink-0" />
        {/* translate-y-[0.5px]:leading-none + 中文字符相对 icon 视觉中心偏上,
            微调 0.5px 下移让"跳到底部"和向下箭头的视觉中线对齐。 */}
        <span className="translate-y-[0.5px]">{t('chat.jumpToBottom')}</span>
      </button>
    </div>
  );
}
