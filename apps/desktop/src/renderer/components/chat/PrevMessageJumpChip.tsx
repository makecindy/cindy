/**
 * PrevMessageJumpChip
 * ---------------------------------------------------------------------------
 * 滚动时落在右上角 chip 栈里的"跳到上一条提问"悬浮按钮。
 *
 * 视觉要求(用户反馈对齐):
 *   - 纯 icon 按钮(向上箭头)。文本气泡会和真实 user 气泡视觉混在一起,
 *     icon 更轻不打扰。
 *   - 不再写绝对坐标 —— 由 `TopRightChipStack` 统一定位,本组件作为栈
 *     的一行。多个 chip(目前是 DiffPanelToggle)同时存在时,栈用 flex
 *     纵向排列,本组件落在 DiffPanelToggle 下面一行。
 *   - 预览原文降级为 `title` / `aria-label`,hover 仍能看到要跳到的提问。
 */

import { ArrowUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

export interface PrevMessageJumpChipProps {
  /** 上一条提问的预览文案,父组件已经过 firstNonEmptyLine 处理。 */
  preview: string;
  /** 点击回调 — 父组件 scrollIntoView。 */
  onClick: () => void;
}

/**
 * 取原文首行非空内容,去掉前后空白。多行 user 消息只预览第一行 — 长度上限
 * 交给 CSS `truncate`,这样不同字号 / 容器宽度都自然适配,不需要在 JS 里
 * 估算字符数。
 */
export function firstNonEmptyLine(raw: string): string {
  return raw.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
}

export function PrevMessageJumpChip({
  preview,
  onClick,
}: PrevMessageJumpChipProps) {
  const { t } = useTranslation();
  // 显隐由调用方决定:不需要时不挂载本组件。chip 在 TopRightChipStack 的
  // flex 栈里占一行,所以不能像旧 absolute 定位那样靠 opacity 隐身,否则
  // 会在 DiffToggle 下留一个空 28px 槽位。出场动画用 tailwindcss-animate
  // 的 mount-only 动画,符合"出现就动一下、消失瞬时"的预期。
  const label = t('chat.prevMessageJump', { preview });

  return (
    <button
      type="button"
      aria-label={label}
      title={preview}
      onClick={onClick}
      className={cn(
        // 定位由外层 TopRightChipStack 负责,这里只描述按钮自身样式;
        // 与 DiffPanelToggle 共用同一套色 token,栈里多个 chip 视觉一致。
        // 栈容器 pointer-events-none,chip 自己开 pointer-events-auto 才能点。
        'pointer-events-auto',
        'flex items-center justify-center',
        'h-7 w-7 rounded-full',
        // 圆底浮起(用户要求这两个 chip 保留原来的圆底,与裸图标的
        // RightSidebarToggle 区分)。
        'bg-popover text-popover-foreground',
        'border border-border shadow-sm',
        'transition-colors',
        // hover:项目通用 list-item hover token(与 SlashCommandPalette /
        // ModelSelector 等同源)
        'hover:bg-[var(--cmd-palette-item-hover)]',
        'focus-visible:outline-none',
        // mount-only 入场动画(淡入 + 轻缩放);消失时由 unmount 直接
        // 抹掉,2 个 chip 体量没必要做 exit 动画。
        'animate-float-in',
      )}
    >
      <ArrowUp size={15} className="shrink-0" aria-hidden="true" />
    </button>
  );
}
