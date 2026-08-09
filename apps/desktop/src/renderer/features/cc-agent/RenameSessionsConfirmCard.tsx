/**
 * RenameSessionsConfirmCard
 * ---------------------------------------------------------------------------
 * rename_sessions 工具的写入前确认卡片(kind='rename_sessions_confirm')。
 * agent 只能发起待改清单;用户在卡片上确认后 main 才继续写库。
 */

import { useCallback, useEffect } from 'react';
import { Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import type { PendingRenameSessionsConfirm } from '@/lib/makerChatStore';

interface RenameSessionsConfirmCardProps {
  pending: PendingRenameSessionsConfirm;
  onRespond: (result: { confirmed: true } | { confirmed: false }) => void;
}

export function RenameSessionsConfirmCard({
  pending,
  onRespond,
}: RenameSessionsConfirmCardProps) {
  const { t } = useTranslation();

  const handleSubmit = useCallback(() => {
    onRespond({ confirmed: true });
  }, [onRespond]);

  const handleCancel = useCallback(() => {
    onRespond({ confirmed: false });
  }, [onRespond]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSubmit, handleCancel]);

  return (
    <div
      className={cn(
        'w-full max-w-[914px] rounded-[12px] border p-4',
        'border-[var(--chat-input-border)] bg-[var(--chat-input-bg)]',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-15 font-semibold leading-tight text-[var(--chat-input-text)]">
            {t('renameSessions.confirm.title')}
          </p>
          <p className="mt-1 text-12 leading-relaxed text-[var(--status-bar-meta)]">
            {t('renameSessions.confirm.description', { count: pending.changes.length })}
          </p>
        </div>
        <span className="shrink-0 rounded-[6px] border border-[var(--chat-input-border)] px-2 py-1 text-12 font-medium text-[var(--status-bar-meta)]">
          {t('renameSessions.confirm.count', { count: pending.changes.length })}
        </span>
      </div>

      <div className="mt-3 max-h-[280px] overflow-y-auto rounded-[8px] border border-[var(--perm-code-border)] bg-[var(--perm-code-bg)]">
        {pending.changes.map((change) => (
          <div
            key={change.sessionId}
            className="border-b border-[var(--chat-input-border)] px-3 py-2 last:border-b-0"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-12 text-[var(--status-bar-meta)]">
                  {change.workingDir ?? t('renameSessions.confirm.noWorkingDir')}
                </p>
                <p className="mt-1 text-13 leading-snug text-[var(--chat-input-text)]">
                  <span className="text-[var(--status-bar-meta)]">
                    {t('renameSessions.confirm.from')}
                  </span>{' '}
                  <span className="break-words">
                    {change.currentTitle ?? t('renameSessions.confirm.untitled')}
                  </span>
                </p>
                <p className="mt-1 text-13 leading-snug text-[var(--chat-input-text)]">
                  <span className="text-[var(--status-bar-meta)]">
                    {t('renameSessions.confirm.to')}
                  </span>{' '}
                  <span className="break-words font-medium">{change.newTitle}</span>
                </p>
              </div>
              <time className="shrink-0 text-11 text-[var(--status-bar-meta)]">
                {formatTime(change.updatedAt)}
              </time>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={handleCancel}
          className={cn(
            'flex items-center gap-2 rounded-[8px] border px-3 py-[7px]',
            'border-[var(--chat-input-border)] bg-transparent',
            'text-13 font-medium text-[var(--chat-input-text)]',
            'transition-colors hover:bg-[var(--perm-code-bg)]',
          )}
        >
          <X className="size-4" />
          <span>{t('renameSessions.confirm.cancel')}</span>
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          className={cn(
            'flex items-center gap-2 rounded-[8px] border px-3 py-[7px]',
            'border-[var(--chat-input-border)]',
            'bg-[var(--perm-allow-btn-bg)] text-[var(--perm-allow-btn-text)]',
            'text-13 font-medium transition-colors hover:opacity-90',
          )}
        >
          <Check className="size-4" />
          <span>{t('renameSessions.confirm.apply')}</span>
          <kbd className="rounded-[4px] border border-[var(--perm-allow-kbd-border)] bg-[var(--perm-allow-kbd-bg)] px-1.5 py-[1px] text-11 font-normal text-[var(--perm-allow-btn-text)] opacity-70">
            {window.electronAPI?.platform === 'darwin' ? '⌘↵' : 'Ctrl+Enter'}
          </kbd>
        </button>
      </div>
    </div>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
