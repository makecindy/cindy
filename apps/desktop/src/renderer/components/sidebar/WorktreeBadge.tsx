/**
 * WorktreeBadge — F6 sidebar 会话行右侧 worktree 标识。
 *
 * worktree-parallel-sessions 前端方案 M4：
 *   - 只有当 useWorktreeForSession(sid) 非 null 时渲染（按 Context map 判，
 *     不读 DB worktree_path 字段；ADR-WT-FE-4）
 *   - lucide GitBranch 图标 + Radix Tooltip 显示 path / branch
 *   - 点击调 worktreeReveal({ path }) 在系统文件管理器中打开
 *   - 与 SessionItem 内现有 ⋮ 按钮共存，常驻可见（无需 hover）
 *
 * 视觉同时覆盖 Light / Dark；颜色走 token，不硬编码。
 */

import { GitBranch } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';
import { useWorktreeForSession } from '@/contexts/WorktreeContext';
import { createLogger } from '@/lib/logger';

const log = createLogger('WorktreeBadge');

export interface WorktreeBadgeProps {
  sessionId: string;
  /** 默认 14px。SessionItem 用 ⋮ 16，徽标稍小 14 视觉更稳。 */
  size?: number;
  className?: string;
}

export function WorktreeBadge({
  sessionId,
  size = 14,
  className,
}: WorktreeBadgeProps) {
  const meta = useWorktreeForSession(sessionId);
  if (!meta) return null;

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          aria-label={`worktree: ${meta.branch}`}
          onClick={(e) => {
            // 防止冒泡触发 SessionItem 的导航/重命名
            e.stopPropagation();
            window.electronAPI
              .worktreeReveal({ path: meta.path })
              .catch((err) => {
                log.warn('reveal failed:', err);
              });
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className={cn(
            'shrink-0 inline-flex items-center justify-center rounded-lg',
            'size-5 text-sidebar-action-icon hover:text-foreground',
            'transition-colors focus:outline-none',
            className,
          )}
        >
          <GitBranch size={size} strokeWidth={1.5} />
        </button>
      </Tooltip.Trigger>
      <Tooltip.Content side="top" variant="mono">
        <div className="flex flex-col gap-0.5">
          <span>branch: {meta.branch}</span>
          <span>path: {meta.path}</span>
        </div>
      </Tooltip.Content>
    </Tooltip.Root>
  );
}
