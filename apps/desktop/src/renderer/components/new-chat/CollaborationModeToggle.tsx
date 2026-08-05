/**
 * CollaborationModeToggle —— ChatInput 底部工具行的"协同模式"开关 pill。
 *
 * 两态:
 *   - OFF: 灰描边 pill,点击弹 Popover 选 Worker agent → 点 "开启协同" 确认
 *   - ON:  橙描边 pill,点击直接触发 onChange({ enabled: false }),由 parent
 *          决定是否要弹确认对话框
 *
 * 该组件不持有任何业务状态:enabled / worker / onChange 全部由 parent 传入。
 * 内部仅有 popover 的开合状态 + 选择 Worker 的草稿值。
 *
 * 视觉状态固定为 OFF / Popover / ON 三态。
 */
import { useState, type KeyboardEvent, type ReactElement } from 'react';
import { UsersRound, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tooltip';
import { CodexMark } from '@/components/icons/CodexMark';
import { ClaudeMark } from '@/components/icons/ClaudeMark';

export type CollabWorkerKind = 'cc' | 'codex';

interface Props {
  enabled: boolean;
  worker: CollabWorkerKind;
  onChange: (next: { enabled: boolean; worker: CollabWorkerKind }) => void;
  onOpenDetails?: () => void;
  onDisabledActivate?: () => void;
  disabled?: boolean;
  disabledReason?: string;
  /** 窄容器下把 pill 字号压一档,默认 false。 */
  dense?: boolean;
  /** 只渲染 UsersRound 图标,不渲染 "协同" 文案,默认 false。 */
  iconOnly?: boolean;
}

const WORKER_OPTIONS: ReadonlyArray<{
  kind: CollabWorkerKind;
  label: string;
  renderMark: (size: number) => ReactElement;
}> = [
  {
    kind: 'codex',
    label: 'Codex',
    renderMark: (size) => <CodexMark size={size} className="shrink-0" />,
  },
  {
    kind: 'cc',
    label: 'Claude',
    renderMark: (size) => <ClaudeMark size={size} className="shrink-0" />,
  },
];

export function CollaborationModeToggle({
  enabled,
  worker,
  onChange,
  onOpenDetails,
  onDisabledActivate,
  disabled,
  disabledReason,
  dense = false,
  iconOnly = false,
}: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [draftWorker, setDraftWorker] = useState<CollabWorkerKind>(worker);

  // iconOnly 时 pill 退化成 30px 圆形图标按钮,与同行其它 trigger
  // (PermissionSelector / ExtraDirsButton / VoiceInputButton) 同尺寸同底同描边。
  const pillSizeCn = iconOnly
    ? 'h-[30px] w-[30px] justify-center px-0'
    : cn('h-[30px] px-2.5', dense ? 'text-[11.5px]' : 'text-[12px]');
  const iconSize = iconOnly ? 14 : 11;
  const effectiveDisabledReason = disabled ? disabledReason : undefined;
  const blockDisabledKeyboardActivation = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (!event.repeat) onDisabledActivate?.();
  };
  const disabledWrapperProps = (label: string) =>
    disabled
      ? {
          role: 'button' as const,
          tabIndex: 0,
          'aria-disabled': onDisabledActivate ? undefined : true,
          'aria-label': disabledReason ?? label,
          onClick: onDisabledActivate,
          onKeyDown: blockDisabledKeyboardActivation,
        }
      : {};

  const handleOpenChange = (next: boolean) => {
    if (next) setDraftWorker(worker);
    setOpen(next);
  };

  const handleConfirm = () => {
    onChange({ enabled: true, worker: draftWorker });
    setOpen(false);
  };

  // ON 态:pill 本身就是"停止协同"的触发器
  if (enabled) {
    return (
      <Tip text={effectiveDisabledReason ?? t('newChat.collaboration.stopHint')} side="top">
        <span
          {...disabledWrapperProps(t('newChat.collaboration.toggleOnAria'))}
          className={cn('inline-flex', onDisabledActivate && 'cursor-pointer')}
        >
          <button
            type="button"
            disabled={disabled}
            // 与 VendorSegmentedSwitcher / FastModeToggle 一致:阻 mousedown 抢焦点
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange({ enabled: false, worker })}
            aria-label={t('newChat.collaboration.toggleOnAria')}
            aria-hidden={disabled || undefined}
            aria-pressed
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-full font-medium transition-colors',
              'bg-[var(--composer-pill-bg,#FCFCFC)] dark:bg-[var(--composer-pill-bg,#393838)] text-[var(--warning-accent)]' /* ON 态恢复橙(用户改稿 2026-07-20,覆盖 07-17 去橙中性);OFF 态仍中性 */,
              'border border-[var(--border-default)]',
              'hover:bg-[var(--model-trigger-hover)]',
              pillSizeCn,
              disabled && 'cursor-not-allowed opacity-50',
              disabled && onDisabledActivate && 'pointer-events-none',
            )}
          >
            <UsersRound size={iconSize} className="shrink-0" />
            {!iconOnly && <span>{t('newChat.collaboration.pillLabel')}</span>}
          </button>
        </span>
      </Tip>
    );
  }

  // OFF 态:点击弹 Popover 选 Worker
  if (onOpenDetails) {
    return (
      <Tip
        text={effectiveDisabledReason ?? (iconOnly ? t('newChat.collaboration.pillLabel') : null)}
        side="top"
      >
        <span
          {...disabledWrapperProps(t('newChat.collaboration.toggleOffAria'))}
          className={cn('inline-flex', onDisabledActivate && 'cursor-pointer')}
        >
          <button
            type="button"
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onOpenDetails}
            aria-label={t('newChat.collaboration.toggleOffAria')}
            aria-hidden={disabled || undefined}
            aria-pressed={false}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-full font-medium transition-colors',
              'bg-[var(--composer-pill-bg,#FCFCFC)] dark:bg-[var(--composer-pill-bg,#393838)] text-[var(--text-primary)]' /* spec 2026-07-17, token by 一哥 */,
              'border border-[var(--border-default)]',
              'hover:bg-[var(--model-trigger-hover)]',
              pillSizeCn,
              disabled && 'cursor-not-allowed opacity-50',
              disabled && onDisabledActivate && 'pointer-events-none',
            )}
          >
            <UsersRound size={iconSize} className="shrink-0" />
            {!iconOnly && <span>{t('newChat.collaboration.pillLabel')}</span>}
          </button>
        </span>
      </Tip>
    );
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Tip
          text={effectiveDisabledReason ?? (iconOnly ? t('newChat.collaboration.pillLabel') : null)}
          side="top"
        >
          <span
            {...disabledWrapperProps(t('newChat.collaboration.toggleOffAria'))}
            className={cn('inline-flex', onDisabledActivate && 'cursor-pointer')}
          >
            <button
              type="button"
              disabled={disabled}
              onMouseDown={(e) => e.preventDefault()}
              aria-label={t('newChat.collaboration.toggleOffAria')}
              aria-hidden={disabled || undefined}
              aria-pressed={false}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-full font-medium transition-colors',
                'bg-[var(--composer-pill-bg,#FCFCFC)] dark:bg-[var(--composer-pill-bg,#393838)] text-[var(--text-primary)]' /* spec 2026-07-17, token by 一哥 */,
                'border border-[var(--border-default)]',
                'hover:bg-[var(--model-trigger-hover)]',
                pillSizeCn,
                disabled && 'cursor-not-allowed opacity-50',
                disabled && onDisabledActivate && 'pointer-events-none',
              )}
            >
              <UsersRound size={iconSize} className="shrink-0" />
              {!iconOnly && <span>{t('newChat.collaboration.pillLabel')}</span>}
            </button>
          </span>
        </Tip>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={8}
        className={cn(
          'w-[260px] rounded-[12px] p-3',
          // 复用 ModelSelector 的 popover token,保证视觉一致
          'bg-[var(--model-dropdown-bg)]',
          'border border-[var(--model-dropdown-border)]',
        )}
      >
        <div className="flex flex-col gap-3">
          <div className="text-[13px] font-medium text-foreground">
            {t('newChat.collaboration.popoverTitle')}
          </div>
          <div className="flex flex-col gap-[2px]" role="listbox" aria-label="Worker agent">
            {WORKER_OPTIONS.map((opt) => {
              const isSelected = opt.kind === draftWorker;
              return (
                <button
                  key={opt.kind}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => setDraftWorker(opt.kind)}
                  className={cn(
                    'flex w-full items-center justify-between rounded-[8px] px-3 py-2',
                    'transition-colors',
                    'hover:bg-[var(--model-item-hover)]',
                    isSelected && 'bg-[var(--model-item-hover)]',
                  )}
                >
                  <span className="flex items-center gap-2 text-[14px] font-medium text-[var(--model-item-text)]">
                    {opt.renderMark(14)}
                    <span>{opt.label}</span>
                  </span>
                  {isSelected && (
                    <Check size={14} className="shrink-0 text-[var(--model-item-check)]" />
                  )}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={handleConfirm}
            className={cn(
              'flex h-8 items-center justify-center rounded-full text-[12px] font-medium transition-colors',
              'bg-[var(--send-btn-bg)] text-[var(--send-btn-icon)] hover:bg-[var(--confirm-btn-primary-hover)]',
            )}
          >
            {t('newChat.collaboration.startButton')}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
