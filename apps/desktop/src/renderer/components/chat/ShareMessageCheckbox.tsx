/**
 * ShareMessageCheckbox — 分享选择模式下挂在消息左侧的圆形选择框。
 *
 * 位置:绝对定位到消息行左外侧,落在 MessageStream 选择模式下让出的那条左缩进
 * 空白里(见 MessageStream 的 SHARE_SELECTION_INDENT_CLASS)。
 *
 * 只订阅自己那一条的选中态(useIsMessageSelected):勾选是高频动作,细粒度订阅让
 * 一次点击只重渲染这一个按钮,而不是整条消息流(见 shareSelectionStore 文件头)。
 *
 * 用共享 Checkbox 的 20px 圆形样式(DESIGN.md §4,主人裁决 2026-11-25),圆形属于 pill 档。
 * 自带 `data-share-exclude`,光栅化时会被清洗掉,不会出现在产物图片里。
 */

import { useTranslation } from 'react-i18next';

import { Checkbox } from '@/components/ui/checkbox';
import { SHARE_EXCLUDE_ATTR } from '@/lib/shareConversationImage';
import { shareSelectionStore, useIsMessageSelected } from './shareSelectionStore';

export function ShareMessageCheckbox({ clientId }: { clientId: string }) {
  const { t } = useTranslation();
  const selected = useIsMessageSelected(clientId);

  return (
    // 落在 MessageStream 让出的 40px 缩进里(左 8px / 右 12px,20px 框居中偏左);
    // top 微调让圆心对齐消息首行的视觉中线。点击区只拦截冒泡,勾选由原生 input 处理。
    <label
      {...{ [SHARE_EXCLUDE_ATTR]: '' }}
      onClick={(e) => e.stopPropagation()}
      className="absolute -left-8 top-[2px] z-raised flex size-5 shrink-0 cursor-pointer items-center justify-center"
    >
      <Checkbox
        shape="circle"
        size={20}
        checked={selected}
        aria-label={t('chat.shareImage.checkboxLabel')}
        onChange={() => shareSelectionStore.toggle(clientId)}
      />
    </label>
  );
}
