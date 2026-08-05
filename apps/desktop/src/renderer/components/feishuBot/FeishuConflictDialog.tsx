/**
 * FeishuConflictDialog
 * ---------------------------------------------------------------------------
 * 通用弹窗：当 main 进程检测到当前 App ID 已被另一台设备使用时弹出。
 *
 * 触发方式：在 App.tsx 顶层 mount 一个 <FeishuConflictDialogHost />，host
 * 订阅 `window.electronAPI.feishuBot.onConflict` 事件，把 dialog open 状态
 * 注入这个组件。
 *
 * 视觉对标 UpdateNoticeDialog（Radix AlertDialog）。两个 action：
 *  - "创建我的 App"：跳到飞书开放平台新建独立 App
 *  - "忽略"：仅关闭，bot 状态保持 conflict
 */

import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

interface FeishuConflictDialogProps {
  open: boolean;
  appId: string | null;
  onDismiss: () => void;
  onCreateOwnApp: () => void;
}

export function FeishuConflictDialog({
  open,
  appId,
  onDismiss,
  onCreateOwnApp,
}: FeishuConflictDialogProps) {
  const { t } = useTranslation();
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !next && onDismiss()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay
          className={cn(
            'fixed inset-0 z-50',
            'bg-black/40 backdrop-blur-sm',
            'data-[state=open]:animate-confirm-overlay-in',
          )}
        />
        <AlertDialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
            // 与 ConfirmDialog 同款入场(250ms 淡入+缩放);keyframe 自带
            // translate(-50%,-50%) 居中,与上面的 -translate-x/y-1/2 终态一致。
            'data-[state=open]:animate-confirm-content-in',
            'w-[440px] max-w-[90vw]',
            'rounded-[14px] p-6',
            'bg-[var(--settings-input-bg)]',
            'border border-[var(--settings-badge-border)]',
            'shadow-2xl',
            'flex flex-col gap-4',
            'focus:outline-none',
          )}
        >
          {/* Header */}
          <div className="flex items-center gap-3">
            <div
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
              style={{ backgroundColor: 'var(--warning-bg-soft)' }}
            >
              <AlertTriangle size={20} style={{ color: 'var(--status-bar-accent)' }} />
            </div>
            <AlertDialog.Title className="text-16 font-medium text-[var(--settings-section-title)]">
              {t('imBot.conflictDialog.title')}
            </AlertDialog.Title>
          </div>

          {/* Body */}
          <AlertDialog.Description className="text-13 leading-[1.6] text-[var(--settings-section-desc)]">
            {t('imBot.conflictDialog.bodyPrefix')}
            {appId ? (
              <>
                {' '}
                <code className="rounded bg-[var(--msg-code-inline-bg)] px-1 py-0.5 text-12">
                  {appId}
                </code>{' '}
              </>
            ) : (
              ' '
            )}
            {t('imBot.conflictDialog.bodyMain')}
            <br />
            <br />
            {t('imBot.conflictDialog.suggestionsHeading')}
            <br />
            {t('imBot.conflictDialog.suggestion1')}
            <br />
            {t('imBot.conflictDialog.suggestion2')}
          </AlertDialog.Description>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                onClick={onDismiss}
                className={cn(
                  'h-[36px] rounded-full px-4',
                  'bg-[var(--settings-btn-secondary-bg)]',
                  'border border-[var(--settings-btn-secondary-border)]',
                  'text-13 font-medium text-[var(--settings-btn-secondary-text)]',
                  'hover:bg-[var(--settings-btn-secondary-hover-bg)]',
                  'transition-colors',
                )}
              >
                {t('imBot.conflictDialog.dismiss')}
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                type="button"
                onClick={onCreateOwnApp}
                className={cn(
                  'h-[36px] rounded-full px-4',
                  'bg-[var(--settings-btn-primary-bg)]',
                  'border border-[var(--settings-btn-primary-border)]',
                  'text-13 font-medium text-[var(--settings-btn-primary-text)]',
                  'hover:bg-[var(--settings-btn-primary-hover-bg)]',
                  'transition-colors',
                )}
              >
                {t('imBot.conflictDialog.createOwnApp')}
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
