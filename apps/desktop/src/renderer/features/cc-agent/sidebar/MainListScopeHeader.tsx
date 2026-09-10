/**
 * MainListScopeHeader — 主列表范围标题行。
 * ---------------------------------------------------------------------------
 * 范围标题必须恒在(2026-08-13 定稿 + 第 4 轮 review P1):空账户、只剩置顶、
 * 远程目录 / 任务全屏 loading/error、所选设备连接中,都不能把「全部任务 ▾」
 * 和两项设置入口摘掉。ProjectsSection 有内容时画完整段头(含折叠按钮);
 * 无内容或父级占位分支只画这一行。
 */
import { useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import { MachineSwitcherMenu } from './MachineSwitcherMenu';
import { SidebarFilterPopover } from './SidebarFilterPopover';
import type { ProjectNode as ProjectNodeData } from '../lib/projectGrouping';
import type { UseSidebarFilterReturn } from '../hooks/useSidebarFilter';

const HEADER_HOVER_ACTION_CLASS = cn(
  'pointer-events-none opacity-0 transition-opacity duration-150',
  'group-hover/sidebar-header:pointer-events-auto group-hover/sidebar-header:opacity-100',
  // Pointer click focus must not pin these hover-only actions after the mouse leaves.
  // Keyboard focus-visible still reveals them for tab navigation.
  'has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100',
  // 段头内任一菜单(范围下拉 / 侧边栏显示设置)展开时(其 trigger 带 data-state=open),
  // 整排 action 保持可见——鼠标移进展开的菜单、段头不再 hover 时,其它按钮不该消失。
  'group-has-[[data-state=open]]/sidebar-header:pointer-events-auto group-has-[[data-state=open]]/sidebar-header:opacity-100',
);

const HEADER_ACTIONS_CLASS = cn('flex items-center gap-0.5 -mt-px', HEADER_HOVER_ACTION_CLASS);

export function MainListScopeHeader({
  filter,
  allKnownProjects,
  dialogueCount = 0,
  hasRemoteDevices,
  fold = null,
}: {
  filter: UseSidebarFilterReturn;
  allKnownProjects: ProjectNodeData[];
  dialogueCount?: number;
  hasRemoteDevices: boolean;
  fold?: {
    label: string;
    Icon: LucideIcon;
    onClick: () => void;
    disabled: boolean;
  } | null;
}): ReactNode {
  const [displaySettingsOpen, setDisplaySettingsOpen] = useState(false);
  return (
    <div className="group/sidebar-header flex h-6 items-center justify-between pr-0 pl-6">
      <div className="flex min-w-0 items-center gap-1">
        <MachineSwitcherMenu onOpenDisplaySettings={() => setDisplaySettingsOpen(true)} />
      </div>
      <div className="flex items-center gap-0.5 -mt-px">
        <div className={HEADER_ACTIONS_CLASS}>
          {fold ? (
            <Tip text={fold.label} side="bottom">
              <button
                type="button"
                onClick={fold.onClick}
                disabled={fold.disabled}
                aria-label={fold.label}
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-md',
                  'text-[var(--sidebar-list-muted)]',
                  'transition-colors hover:text-[var(--sidebar-nav-text)]',
                  'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent',
                )}
              >
                <fold.Icon size={14} strokeWidth={2} />
              </button>
            </Tip>
          ) : null}
          <SidebarFilterPopover
            filter={filter}
            allKnownProjects={allKnownProjects}
            dialogueCount={dialogueCount}
            hasRemoteDevices={hasRemoteDevices}
            open={displaySettingsOpen}
            onOpenChange={setDisplaySettingsOpen}
          />
        </div>
      </div>
    </div>
  );
}
