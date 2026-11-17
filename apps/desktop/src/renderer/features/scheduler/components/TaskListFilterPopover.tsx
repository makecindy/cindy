/**
 * TaskListFilterPopover — Automation 列表 status 筛选入口
 * ---------------------------------------------------------------------------
 * 替换原 "Sorted by last run" 标签，复刻 SidebarFilterPopover 的视觉风格，
 * 但只保留 Status section（Schedule 没有 vendor/project 维度的筛选需求）。
 *
 * Schedule 状态来源：packages/maker-scheduler/src/types.ts
 *   - active  : 调度中（含一次性 recurring=false 还没触发的）
 *   - paused  : 用户手动暂停 / auto-pause
 *   - expired : 一次性任务已触发 / 已过期 —— 视觉上折进 'Active' 桶，
 *               cell 自身用 "Once" tag 标识；不再单独作为 filter 选项。
 * 默认 'active'，普通使用者最关心当前还在跑的任务。
 */

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

import { STATUS_VALUES, type StatusFilter } from '../lib/statusFilter';

// 既有消费方(SchedulerPage / TaskListPane 等)继续从本组件 import 类型,
// 领域原语本体在 ../lib/statusFilter(避免 lib → component 反向依赖)。
export type { StatusFilter };

interface Props {
  value: StatusFilter;
  onChange: (v: StatusFilter) => void;
}

export function TaskListFilterPopover({ value, onChange }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const labelOf = (v: StatusFilter) => t(`scheduler.list.status.${v}`);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('scheduler.list.filterAria', { status: labelOf(value) })}
          className={cn(
            // 11px 与原 "Sorted by last run" 字号一致；hover 时点亮文字色提示可点击
            'inline-flex items-center gap-1 rounded-md text-11 font-medium leading-none',
            'text-[var(--cmd-palette-item-meta)] transition-colors hover:text-[var(--msg-assistant-text)]',
          )}
        >
          {labelOf(value)}
          <ChevronDown size={11} className="opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={8}
        className={cn(
          'w-[220px] rounded-xl border border-sidebar-border bg-popover p-0 text-popover-foreground',
          'shadow-[shadow:var(--shadow-menu)]',
        )}
      >
        {/* Status section — padding 12，3 个 chip 一行 */}
        <div className="flex flex-col gap-2 p-3">
          <div className="px-1 text-11 font-semibold uppercase tracking-[0.5px] text-sidebar-muted">
            {t('scheduler.list.filterStatusHeading')}
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {STATUS_VALUES.map((chipValue) => {
              const selected = value === chipValue;
              return (
                <button
                  key={chipValue}
                  type="button"
                  onClick={() => {
                    onChange(chipValue);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex h-6 items-center justify-center rounded-full px-2.5 text-xs font-medium transition-colors',
                    selected
                      ? cn(
                          'bg-[var(--lightbox-cta-bg)] text-[var(--lightbox-cta-fg)]',
                      )
                      : cn(
                          'border border-[var(--cmd-palette-border)] bg-transparent text-[var(--settings-btn-secondary-text)]',
                          'hover:border-[var(--settings-source-meta)]',
                        ),
                  )}
                >
                  {labelOf(chipValue)}
                </button>
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
