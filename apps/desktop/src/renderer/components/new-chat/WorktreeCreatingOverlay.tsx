/**
 * WorktreeCreatingOverlay
 * ---------------------------------------------------------------------------
 * 替代 ChatInput 渲染 — 当一个新建 session 正在后台 createWorktree 期间, 不挂
 * ChatInput, 改挂这个 mask, 视觉与飞书接管 mask (TakeoverMask) 完全对齐:
 * 90px 容器 / 12px 圆角 / 1px sidebar-border / content-area 底色, 区别只在内容
 * 区 — 这里是"正在创建 worktree · 输入已禁用 / 目标分支 xxx · 完成后自动解锁"
 * + 旋转的 spinner, 没有右侧 action 按钮 (worktree 创建不可中途取消)。
 *
 * 视觉规格:
 *   - 容器: h-[90px] / rounded-[12px] / px-4 / bg --content-area / border 1px sidebar-border
 *   - 左侧 32x32 圆形 chip (bg sidebar-item-hover) + 共享 Spinner 16px (动画在 wrapper 上)
 *   - 文字主: 14 / 500 / msg-assistant-text "正在创建 worktree · 输入已禁用"
 *   - 文字副: 12 / 400 / workingdir-text "目标分支 {branch} · 完成后自动解锁"
 *   - 右侧无 action 按钮; 仍保留 justify-between 占位, 内部用 invisible spacer 撑开
 *     视觉对称 (与 TakeoverMask 的左中右分布同款)。
 */

import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';

interface WorktreeCreatingOverlayProps {
  /** 当前正在创建的目标分支名 (含 xdt/ 前缀)。 */
  branchName: string;
}

export function WorktreeCreatingOverlay({ branchName }: WorktreeCreatingOverlayProps) {
  const { t } = useTranslation();

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex w-full items-center justify-between gap-3',
        'h-[90px] rounded-[12px] px-4',
        'bg-[hsl(var(--content-area))]',
        'border border-[hsl(var(--sidebar-border))]',
      )}
    >
      <div className="flex items-center gap-[10px]">
        <div
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
            'bg-[hsl(var(--sidebar-item-hover))]',
          )}
        >
          <Spinner size={16} className="text-[var(--workingdir-icon)]" />
        </div>
        <div className="flex flex-col gap-[2px]">
          <div className="text-[14px] font-medium leading-tight text-[var(--msg-assistant-text)]">
            {t('newChat.worktreeCreatingOverlay.heading')}
          </div>
          <div className="text-[12px] font-normal leading-tight text-[var(--workingdir-text)]">
            {t('newChat.worktreeCreatingOverlay.subtitle', { branch: branchName })}
          </div>
        </div>
      </div>
      {/* 占位 spacer:保持与 TakeoverMask "左 icon+文 / 右 action button" 同款
          justify-between 视觉重心,避免左侧内容因为没有右侧元素就漂到正中,
          造成与 takeover mask 并排时的不一致感。 */}
      <div aria-hidden className="h-8 w-8 shrink-0" />
    </div>
  );
}
