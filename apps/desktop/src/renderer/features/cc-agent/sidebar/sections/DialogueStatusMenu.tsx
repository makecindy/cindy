/**
 * DialogueStatusMenu — 对话区可见的状态筛选入口。
 *
 * 全局 Status 仍由 SidebarFilterPopover 持有;本组件复用同一份
 * filter.status / setStatus,把「活跃 / 已归档 / 全部」放到恒在的范围标题
 * (MainListScopeHeader,覆盖未分组与空列表)、混排「对话」组头和折叠 rail
 * 对话面板上,避免入口只活在未挂载的 DialogueSection 里。
 *
 * 菜单本身只有状态选项。可访问名称仍走 `dialogueSettingsAria`,展开态与
 * 折叠 rail 各自传入真实 `sortByLabel`,避免状态文案填进 {{sortBy}}。
 */

import { Check, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { FilterStatus } from '../../hooks/useSidebarFilter';
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS } from '../menuStyles';

export const DIALOGUE_STATUS_OPTIONS: ReadonlyArray<{
  value: FilterStatus;
  labelKey: string;
}> = [
  { value: 'active', labelKey: 'ccAgent.sidebar.filterStatus.active' },
  { value: 'archived', labelKey: 'ccAgent.sidebar.filterStatus.archived' },
  { value: 'all', labelKey: 'ccAgent.sidebar.filterStatus.all' },
];

const STATUS_BUTTON_FOCUS =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';

export function DialogueStatusMenu({
  status,
  onStatusChange,
  sortByLabel,
  buttonClassName,
  iconSize = 14,
  stopRowToggle = false,
}: {
  status: FilterStatus;
  onStatusChange: (status: FilterStatus) => void;
  /** 与 i18n `dialogueSettingsAria` 的 {{sortBy}} 对齐;省略时复用状态文案。 */
  sortByLabel?: string;
  buttonClassName?: string;
  iconSize?: number;
  /** 组头整行可点折叠时,阻止菜单点击冒泡成收起/展开。 */
  stopRowToggle?: boolean;
}) {
  const { t } = useTranslation();
  const statusLabel = t(
    DIALOGUE_STATUS_OPTIONS.find((option) => option.value === status)?.labelKey ??
      'ccAgent.sidebar.filterStatus.active',
  );
  const stop = (event: { stopPropagation: () => void }) => {
    if (stopRowToggle) event.stopPropagation();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Tip text={t('ccAgent.sidebar.dialogueSettings')} side="bottom">
          <button
            type="button"
            aria-label={t('ccAgent.sidebar.dialogueSettingsAria', {
              status: statusLabel,
              sortBy: sortByLabel ?? statusLabel,
            })}
            onClick={stop}
            onPointerDown={stop}
            onKeyDown={stop}
            className={cn(
              'flex shrink-0 items-center justify-center rounded-full',
              'text-[var(--sidebar-list-muted)]',
              'transition-colors hover:text-[var(--sidebar-nav-text)]',
              STATUS_BUTTON_FOCUS,
              buttonClassName,
            )}
          >
            <SlidersHorizontal size={iconSize} strokeWidth={2} />
          </button>
        </Tip>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="end"
        sideOffset={8}
        className={cn(MENU_CONTENT_CLASS, 'w-[180px]')}
        onClick={stop}
        onPointerDown={stop}
      >
        <div className="px-2 py-1.5 text-xs font-medium text-[var(--cmd-palette-item-meta)]">
          {t('ccAgent.sidebar.filterStatusHeading')}
        </div>
        {DIALOGUE_STATUS_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => onStatusChange(option.value)}
            className={MENU_ITEM_CLASS}
          >
            <span className="truncate">{t(option.labelKey)}</span>
            {status === option.value && (
              <Check
                size={15}
                className="ml-auto shrink-0 text-[var(--msg-assistant-text)]"
              />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
