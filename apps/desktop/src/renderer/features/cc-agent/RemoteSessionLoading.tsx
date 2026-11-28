/**
 * RemoteSessionLoading —— 远程会话首屏「正在从被控端加载」覆盖层(控制端)。
 *
 * 仅在 device-link 远程会话内容尚未同步且超过防闪延迟时,由
 * CCAgentSessionView 覆盖在空消息区之上,让控制端明确「在等被控端」而非空会话。
 * 已有消息时交给标题的同步提示；无普通任务标题的面板使用顶部轻量提示。
 * 内容同步完成后撤掉。颜色走主题 token,不硬编码。
 */

import { useTranslation } from 'react-i18next';

import { Spinner } from '@/components/ui/spinner';

export function RemoteSessionLoading({
  compact = false,
  reserveCornerActions = false,
}: { compact?: boolean; reserveCornerActions?: boolean }) {
  const { t } = useTranslation();
  if (compact) {
    return (
      <div
        role="status"
        className="pointer-events-none flow-root shrink-0 px-4 pt-1 text-right text-12 text-[var(--text-secondary)]"
      >
        {/* MainLayout's floating buttons are one 28px row. Float their insets so
            the whole status moves underneath when it cannot fit alongside them. */}
        {reserveCornerActions && (
          <>
            <span
              aria-hidden="true"
              className="float-left h-[min(1.75rem,var(--content-top-left-actions-inset,0px))] w-[var(--content-top-left-actions-inset,0px)]"
            />
            <span
              aria-hidden="true"
              className="float-right h-[min(1.75rem,var(--content-top-right-actions-inset,0px))] w-[var(--content-top-right-actions-inset,0px)]"
            />
          </>
        )}
        <span className="inline-flex max-w-full items-center gap-2 pb-1 align-top">
          <Spinner size={14} />
          <span className="min-w-0 [overflow-wrap:anywhere]">{t('ccAgent.remoteSession.syncing')}</span>
        </span>
      </div>
    );
  }
  return (
    <div className="pointer-events-none absolute inset-0 z-raised flex items-center justify-center">
      <div role="status" className="flex items-center gap-2 text-13 text-[var(--text-secondary)]">
        <Spinner size={14} />
        <span>{t('ccAgent.remoteSession.loading')}</span>
      </div>
    </div>
  );
}
