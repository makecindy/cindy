/**
 * NewMessageIndicator
 * ---------------------------------------------------------------------------
 * F1 / new-message-indicator
 *
 * 纯呈现按钮组件——cc-agent 聊天流底部的"↓ N 条新消息"小药丸。
 *
 *   - height 32px / rounded-full / padding 0 12px / gap 6px
 *   - Inter 12px / weight 500
 *   - ArrowDown lucide size=14
 *
 * 样式约束（由规格锁定，不自由发挥）:
 *   - 颜色 token 仅使用 `--content-area` / `--msg-tool-card-border` /
 *     `--msg-tool-text` / `--ring`，不引入新色值。
 *   - 过渡 150ms ease-out，进入/退出对称。
 *   - z-index = 40（高于 MessageStream 默认层、低于 drop-overlay 的 z-50）。
 *   - 对标 Claude Desktop "new message pill"，严格复刻。
 *
 * 可访问性:
 *   - 原生 `<button type="button">`，Enter / Space 原生支持。
 *   - aria-label 动态反映未读数。
 *   - 外层定位容器承担 aria-live="polite"，让屏幕阅读器在 count 变化时
 *     播报（button 自身的内容变化不会被 aria-live 识别）。
 */

import { ArrowDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

export interface NewMessageIndicatorProps {
  /** 显隐开关——由父组件根据 `!isNearBottom && unreadCount > 0` 决定。 */
  visible: boolean;
  /** 未读消息条数。count <= 0 时按钮内容仍然渲染但父组件会传 visible=false。 */
  count: number;
  /** 点击回调——父组件 `scrollToBottomSmooth`。 */
  onClick: () => void;
  /** 距离滚动容器底部的像素偏移（父组件传 `bottomPadding + 12`）。 */
  bottomOffset: number;
}

export function NewMessageIndicator({
  visible,
  count,
  onClick,
  bottomOffset,
}: NewMessageIndicatorProps) {
  const { t } = useTranslation();
  const label = t('chat.newMessageIndicator.aria', { count });

  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      style={{ bottom: bottomOffset }}
      className={cn(
        // 定位容器：absolute + 水平居中 + 底部偏移由 style 控制
        'absolute left-1/2 z-40 -translate-x-1/2',
        // 过渡 + 显隐两态（挂外层，button 自身只管样式交互）
        'transition-all duration-150 ease-out',
        visible
          ? 'pointer-events-auto translate-y-0 opacity-100'
          : 'pointer-events-none translate-y-2 opacity-0',
      )}
    >
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={cn(
          // 布局：pill 外形 + 32px 高 + 图标/文字水平排列
          'flex h-8 items-center gap-1.5 rounded-full px-3 py-1.5',
          // 皮肤：content-area 填充 + msg-tool-card-border 细边 + 轻阴影
          'border border-[var(--msg-tool-card-border)]',
          'bg-[hsl(var(--content-area))] shadow-md',
          // 文字：12px / 500 / 使用 msg-tool-text
          'text-12 font-medium leading-none text-[var(--msg-tool-text)]',
          // hover / active:用项目通用的 list-item hover token,与
          // SlashCommandPalette / ModelSelector / FolderPicker 等保持一致。
          // 不用 content-area + alpha — alpha 会让下方文字透过来。
          'transition-colors duration-150 ease-out',
          'hover:bg-[var(--cmd-palette-item-hover)] active:scale-[0.98]',
          // focus：ring 走 --ring token
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]',
        )}
      >
        <ArrowDown size={14} className="shrink-0" />
        {/* translate-y-[0.5px]:同 JumpToBottomChip,leading-none + 中文相对
            icon 视觉中心偏上,微调让文字与箭头中线对齐。两个 chip 共用同款 pill,
            必须同时修。 */}
        <span className="translate-y-[0.5px]">
          {t('chat.newMessageIndicator.label', { count })}
        </span>
      </button>
    </div>
  );
}
