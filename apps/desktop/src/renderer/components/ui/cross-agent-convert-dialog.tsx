import { Button } from '@/components/ui/button';
/**
 * CrossAgentConvertDialog — 跨 Agent 工作区互转弹窗（步骤列表样式）。
 *
 * 视觉规格 1:1 复刻 ConfirmDialog（共享 --confirm-* CSS 变量），但有 3 态状态机：
 *   - 'asking'  ：列出待迁移项 + 两按钮 [不要 / 转换]
 *   - 'running' ：列表里逐项展示 pending/running/success/skipped/failed；按钮锁死、ESC 失效
 *   - 'closed'  ：父组件控制
 *
 * 由父 hook (useCrossAgentMigrationOnSend) 提供 items + stepMap + 状态机回调。
 */

import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Check, CircleSlash, Minus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';

export interface CrossAgentConvertDialogProps {
  open: boolean;
  /** 'asking' | 'running' | 'closed' */
  phase: 'asking' | 'running' | 'closed';
  items: CrossAgentMigrationItem[];
  stepMap: Record<string, { status: CrossAgentStepStatus; detail?: string }>;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function CrossAgentConvertDialog({
  open,
  phase,
  items,
  stepMap,
  onOpenChange,
  onConfirm,
  onCancel,
}: CrossAgentConvertDialogProps) {
  const { t } = useTranslation();
  const isRunning = phase === 'running';
  const phaseKey = phase === 'closed' ? 'asking' : phase;
  const direction = items[0]?.direction;
  const sourceAgent = direction === 'to-codex' ? 'Claude Code' : 'Codex';
  const targetAgent = direction === 'to-codex' ? 'Codex' : 'Claude Code';
  const phaseText = {
    title: t(`commonUi.crossAgentConvert.${phaseKey}.title`, { sourceAgent, targetAgent }),
    description: t(`commonUi.crossAgentConvert.${phaseKey}.description`, { sourceAgent, targetAgent }),
    primary: t(`commonUi.crossAgentConvert.${phaseKey}.primary`),
    cancel: t(`commonUi.crossAgentConvert.${phaseKey}.cancel`),
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay
          className={cn(
            'fixed inset-0 z-[10000]',
            'bg-neutral-900/40 dark:bg-neutral-950/60',
            'data-[state=open]:animate-confirm-overlay-in',
            'data-[state=closed]:animate-confirm-overlay-out',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
        <AlertDialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[10000] -translate-x-1/2 -translate-y-1/2',
            'w-full max-w-[440px] rounded-xl p-4',
            'bg-[var(--confirm-bg)] shadow-[var(--confirm-shadow)]',
            'data-[state=open]:animate-confirm-content-in',
            'data-[state=closed]:animate-confirm-content-out',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onEscapeKeyDown={(e) => {
            if (isRunning) e.preventDefault();
          }}
        >
          <AlertDialog.Title
            className={cn(
              'text-lg font-medium text-[var(--confirm-title)]',
              isRunning && 'flex items-center gap-2',
            )}
          >
            {isRunning && <Spinner size={18} />}
            {phaseText.title}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-base text-[var(--confirm-desc)]">
            {phaseText.description}
          </AlertDialog.Description>

          {/* 步骤列表 */}
          <ul className="mt-4 space-y-1.5">
            {items.map((item) => {
              const s = stepMap[item.id]?.status ?? 'pending';
              const detail = stepMap[item.id]?.detail;
              return (
                <li
                  key={item.id}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-13',
                    'text-[var(--confirm-title)]',
                  )}
                >
                  <StepIcon status={s} />
                  <span className="flex-1 truncate">{item.label}</span>
                  {detail && (
                    <span className="text-12 text-[var(--confirm-desc)]">{detail}</span>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="mt-6 flex justify-end gap-2.5">
            <Button
              variant="secondary"
              palette="confirmation"
              size="lg"
              type="button"
              disabled={isRunning}
              onClick={onCancel}
            >
              {phaseText.cancel}
            </Button>
            <Button
              variant="cta"
              palette="confirmation"
              size="lg"
              loading={isRunning}
              type="button"
              disabled={isRunning}
              onClick={onConfirm}
            >
              {phaseText.primary}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function StepIcon({ status }: { status: CrossAgentStepStatus }) {
  switch (status) {
    case 'pending':
      return <Minus className="h-4 w-4 shrink-0 text-[var(--confirm-desc)]" />;
    case 'running':
      return <Spinner size={16} className="text-[var(--confirm-title)]" />;
    case 'success':
      return <Check className="h-4 w-4 shrink-0 text-emerald-500" />;
    case 'skipped':
      return <CircleSlash className="h-4 w-4 shrink-0 text-[var(--confirm-desc)]" />;
    case 'failed':
      return <X className="h-4 w-4 shrink-0 text-red-500" />;
    default:
      return null;
  }
}
