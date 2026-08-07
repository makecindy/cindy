/**
 * ShareMessageCheckbox — 分享选择模式下挂在消息左侧的圆形选择框。
 *
 * 位置:绝对定位到消息行左外侧,落在 MessageStream 选择模式下让出的那条左缩进
 * 空白里(见 MessageStream 的 SHARE_SELECTION_INDENT_CLASS)。
 *
 * 只订阅自己那一条的选中态(useIsMessageSelected):勾选是高频动作,细粒度订阅让
 * 一次点击只重渲染这一个按钮,而不是整条消息流(见 shareSelectionStore 文件头)。
 *
 * 圆形不违反§5 三档圆角 —— 它是 pill 档(9999px)。自带 `data-share-exclude`,
 * 光栅化时会被清洗掉,不会出现在产物图片里。
 */

import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { SHARE_EXCLUDE_ATTR } from '@/lib/shareConversationImage';
import { shareSelectionStore, useIsMessageSelected } from './shareSelectionStore';

export function ShareMessageCheckbox({ clientId }: { clientId: string }) {
  const { t } = useTranslation();
  const selected = useIsMessageSelected(clientId);

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      aria-label={t('chat.shareImage.checkboxLabel')}
      {...{ [SHARE_EXCLUDE_ATTR]: '' }}
      onClick={(e) => {
        e.stopPropagation();
        shareSelectionStore.toggle(clientId);
      }}
      className={cn(
        // 落在 MessageStream 让出的 40px 缩进里(左 8px / 右 12px,20px 框居中偏左);
        // top 微调让圆心对齐消息首行的视觉中线。
        'absolute -left-8 top-[2px] z-10 flex h-5 w-5 shrink-0 items-center justify-center',
        'rounded-full transition-colors cursor-pointer',
        'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] outline-none',
        selected
          ? 'bg-[var(--accent-cta-bg-pure)] text-[var(--accent-pure-cta-fg)]'
          : cn(
              'border border-[var(--border-default)] bg-transparent',
              'hover:border-[var(--text-secondary)]',
            ),
      )}
    >
      {selected ? <Check size={12} strokeWidth={2.5} aria-hidden /> : null}
    </button>
  );
}
