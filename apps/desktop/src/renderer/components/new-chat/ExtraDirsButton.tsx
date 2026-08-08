import type { ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { MorphPopover } from '@/components/ui/morph-popover';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export type CollabWorkerKind = 'cc' | 'codex' | 'pi';

export interface CollaborationMenuConfig {
  enabled: boolean;
  worker: CollabWorkerKind;
  onChange: (next: { enabled: boolean; worker: CollabWorkerKind }) => void;
  /** 关闭态优先打开完整 Worker 配置；未提供时直接沿用当前 worker 开启。 */
  onOpenDetails?: () => void;
  /** 策略暂不可用时允许从菜单项触发刷新。 */
  onDisabledActivate?: () => void;
  disabled?: boolean;
  disabledReason?: string;
}

export interface ExtraDirsButtonProps {
  extraDirsCount: number;
  hasReferenceDirs: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  panel: ReactNode;
  autoFocusTarget?: () => HTMLElement | null;
  disabled?: boolean;
  dense?: boolean;
  visualVariant?: 'default' | 'create-agent';
}

/**
 * Composer 的「+」只保留触发器与既定 MorphPopover 容器；列表内容与输入 `@`
 * 共用 AtMentionPanel，避免再次维护独立菜单实现。
 */
export function ExtraDirsButton({
  extraDirsCount,
  hasReferenceDirs,
  open,
  onOpenChange,
  panel,
  autoFocusTarget,
  disabled,
  dense = false,
  visualVariant = 'default',
}: ExtraDirsButtonProps) {
  const { t } = useTranslation();
  const count = extraDirsCount;
  const isCreateAgentVariant = visualVariant === 'create-agent';

  return (
    <MorphPopover
      open={open}
      onOpenChange={onOpenChange}
      panelWidth={480}
      panelClassName="p-0"
      panelAriaLabel={t('extraDirs.menuAria')}
      endBg="var(--cmd-palette-bg)"
      endBorderColor="var(--cmd-palette-border)"
      wrapperClassName="shrink-0"
      autoFocusTarget={autoFocusTarget}
      trigger={
        <Tip
          text={count === 0 ? t('extraDirs.tooltipEmpty') : t('extraDirs.tooltipCount', { count })}
          side="top"
        >
          <button
            type="button"
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onOpenChange(!open)}
            aria-expanded={open}
            aria-pressed={open}
            data-composer-suggestion-trigger
            className={cn(
              'flex h-[30px] shrink-0 items-center rounded-full border border-transparent',
              'bg-transparent text-[var(--composer-pill-icon,#3C3F43)]',
              'transition-colors dark:text-[var(--composer-pill-icon,#D9D9D9)]',
              'hover:border-[var(--border-default)] hover:bg-[var(--composer-pill-bg,#FCFCFC)]',
              'dark:hover:bg-[var(--composer-pill-bg,#393838)]',
              'disabled:cursor-not-allowed disabled:opacity-50',
              open &&
                'border-[var(--border-default)] bg-[var(--composer-pill-bg,#FCFCFC)] dark:bg-[var(--composer-pill-bg,#393838)]',
              count > 0 && hasReferenceDirs
                ? 'min-w-max justify-center gap-1 px-2.5'
                : 'w-[30px] justify-center p-0',
            )}
            aria-label={t('extraDirs.menuAria')}
          >
            <Plus size={isCreateAgentVariant ? 11 : dense ? 14 : 14} className="shrink-0" />
            {count > 0 && hasReferenceDirs && (
              <span
                className={cn(
                  'font-normal tabular-nums',
                  dense ? 'text-12' : 'text-13',
                )}
              >
                ×{count}
              </span>
            )}
          </button>
        </Tip>
      }
    >
      {panel}
    </MorphPopover>
  );
}
