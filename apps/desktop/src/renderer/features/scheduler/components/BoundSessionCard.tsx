/**
 * BoundSessionCard — 任务编辑表单里"持续会话已绑定"形态的展示卡片。
 *
 * 仅用于 persistent 已绑(runner 回写 targetSessionId):该形态没有会话选择器,
 * 需要卡片承载绑定信息。bound(手绑)形态由 ThreadPickerInline 单行选择器
 * 承担,不用本卡片。内容:会话标题 + vendor 图标 + 打开会话 + 解除绑定 +
 * "归档后自动重建续绑"说明。
 *
 * 标题与生命周期由 main 层批量解析。project 自动化模式不传 onUnbind
 * (loader 的 update input 不含 targetSessionId key,解绑无法落库,提供按钮只会
 * 制造静默失败)。
 */

import { ExternalLink, Unlink } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { VendorIcon, agentKindToVendor } from '@/components/sidebar/VendorIcon';
import type { SessionReference } from '../../../../shared/sessionReference';

export interface BoundSessionCardProps {
  sessionId: string;
  /** 不传 = 不显示解绑按钮(project 自动化模式)。 */
  onUnbind?: () => void;
  /** 点击"打开会话":调用方负责 navigate + 关闭 dialog。 */
  onOpen: () => void;
  /** main 层解析的软删除 / 缺失状态；undefined 表示仍在查询。 */
  reference?: SessionReference;
}

export function BoundSessionCard({ sessionId, onUnbind, onOpen, reference }: BoundSessionCardProps) {
  const { t } = useTranslation();
  const unavailable = reference?.state === 'deleted' || reference?.state === 'missing';
  const title =
    (unavailable ? t('scheduler.editor.runSession.card.deleted') : reference?.title?.trim()) ||
    t('scheduler.editor.runSession.card.fallbackTitle', { id: sessionId.slice(0, 8) });

  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-[10px] px-3 py-2',
        'border border-[var(--cmd-palette-border)] bg-[var(--chat-input-chip-bg)]',
      )}
    >
      <VendorIcon vendor={agentKindToVendor(reference?.agentKind)} size={13} />
      <span className="min-w-0 flex-1 truncate text-13 font-medium text-[var(--msg-assistant-text)]" title={title}>
        {title}
      </span>
      <span className="hidden min-w-0 shrink-[2] truncate text-xs text-[var(--cmd-palette-item-meta)] sm:inline">
        {t(
          unavailable
            ? 'scheduler.editor.runSession.card.deletedPersistentNote'
            : 'scheduler.editor.runSession.card.persistentNote',
        )}
      </span>
      {!unavailable && (
        <button
          type="button"
          onClick={onOpen}
          title={t('scheduler.editor.runSession.card.open')}
          className={cn(
            'inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium',
            'text-[var(--settings-btn-secondary-text)] hover:bg-[var(--surface-hover)]',
            'transition-colors focus:outline-none',
          )}
        >
          <ExternalLink size={12} strokeWidth={1.75} aria-hidden />
          {t('scheduler.editor.runSession.card.open')}
        </button>
      )}
      {onUnbind && (
        <button
          type="button"
          onClick={onUnbind}
          title={t('scheduler.editor.runSession.card.unbind')}
          className={cn(
            'inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium',
            'text-[var(--settings-btn-secondary-text)] hover:bg-[var(--surface-hover)]',
            'transition-colors focus:outline-none',
          )}
        >
          <Unlink size={12} strokeWidth={1.75} aria-hidden />
          {t('scheduler.editor.runSession.card.unbind')}
        </button>
      )}
    </div>
  );
}
