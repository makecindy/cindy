/**
 * 分享者审批弹窗(设计稿场景 5)：只显示申请人的昵称和头像，以及同一个配对码供核对。
 * 右上角 × 与 Esc = 稍后处理，申请留在管理页「待处理」里(24 小时内有效)。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import { extractIpcError, mapIpcErrorToI18nKey } from '@/utils/ipcError';

import {
  ProviderShareDialog,
  ProviderShareDialogFooter,
  ProviderShareDialogTitle,
  ProviderSharePairingCode,
} from './ProviderShareDialog';
import type { ProviderSharePendingRequest } from './providerShareFormat';
import { removeProviderSharePendingRequest } from './providerShareStore';
import { ShareAvatar } from './ShareAvatar';
import { useShareTimeFormat } from './useShareTimeFormat';

export function ProviderShareApproveDialog({
  item,
  onClose,
}: {
  item: ProviderSharePendingRequest;
  /** 处理完或稍后处理：关闭并显示队列里的下一条。 */
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const time = useShareTimeFormat();
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const { request, share } = item;
  const name = request.displayName;
  const provider = share.providerLabel;

  const decide = async (action: 'approve' | 'reject') => {
    if (busy) return;
    setBusy(action);
    try {
      await window.electronAPI.providerShare.command({ action, requestId: request.requestId });
      removeProviderSharePendingRequest(request.requestId);
      toast.success(
        action === 'approve'
          ? t('providerShare.toast.approved', { name, provider })
          : t('providerShare.toast.rejected', { name }),
      );
      onClose();
    } catch (error) {
      toast.error(t(mapIpcErrorToI18nKey(error)));
      // 申请已不在(被撤回、过期或在别处处理)：不再停留在这条上。
      if (extractIpcError(error)?.code === 'NOT_FOUND') {
        removeProviderSharePendingRequest(request.requestId);
        onClose();
        return;
      }
      setBusy(null);
    }
  };

  return (
    <ProviderShareDialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      closeLabel={t('providerShare.approve.later')}
      busy={busy !== null}
      testId="provider-share-approve-dialog"
    >
      <ProviderShareDialogTitle className="pr-9">
        {t('providerShare.approve.title', { name, provider })}
      </ProviderShareDialogTitle>
      <div className="mt-3.5 flex items-center gap-3 rounded-xl border border-[var(--border-default)] p-3">
        <ShareAvatar displayName={name} avatarUrl={request.avatarUrl} size="lg" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-14 font-medium text-[var(--text-primary)]">{name}</span>
          <span className="text-12 text-[var(--text-secondary)]">
            {t('providerShare.approve.requestedAt', { time: time.relative(Date.parse(request.createdAt)) })}
          </span>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3.5">
        <ProviderSharePairingCode
          code={request.pairingCode}
          label={t('providerShare.pairing.label')}
          ariaLabel={t('providerShare.pairing.ariaLabel', { digits: request.pairingCode.split('').join(' ') })}
        />
        <p className="min-w-[180px] flex-1 text-12 leading-[1.5] text-[var(--text-secondary)]">
          {t('providerShare.approve.pairingHint')}
        </p>
      </div>
      <div className="mt-3.5 flex flex-col gap-1 rounded-lg bg-[var(--surface)] px-3 py-2.5 text-12 leading-[1.5] text-[var(--text-secondary)]">
        <p>{t('providerShare.approve.callout', { name, provider })}</p>
        <p>{t('providerShare.approve.calloutUnknown')}</p>
      </div>
      <ProviderShareDialogFooter>
        <Button
          variant="cta"
          palette="confirmation"
          size="lg"
          loading={busy === 'approve'}
          disabled={busy !== null}
          onClick={() => void decide('approve')}
        >
          {t('providerShare.approve.approve')}
        </Button>
        <Button
          variant="secondary"
          palette="confirmation"
          size="lg"
          loading={busy === 'reject'}
          disabled={busy !== null}
          onClick={() => void decide('reject')}
        >
          {t('providerShare.approve.reject')}
        </Button>
      </ProviderShareDialogFooter>
    </ProviderShareDialog>
  );
}
