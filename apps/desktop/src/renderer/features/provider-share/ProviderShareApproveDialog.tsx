/**
 * 分享者审批弹窗(设计稿场景 5)：只显示申请人的昵称和头像，以及同一个配对码供核对。
 * 右上角 × 与 Esc = 稍后处理，申请留在管理页「待处理」里(24 小时内有效)。
 * 分享在同账号另一台电脑上时(本机生成的链接)，同意 / 拒绝转交那台电脑执行。
 * 这个供应商建了组时，同意说明写「由供应商组选一台电脑运行 Agent」，不说在这台电脑上运行(供应商组 §8)。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { useLocalProviderGroupsState } from '@/features/provider-group/useLocalProviderGroups';
import { providerManagementErrorKey, providerShareManagementCommand } from '@/features/provider-group/providerManagement';
import { useDeviceProviders } from '@/hooks/useDeviceProviders';
import { useProviders } from '@/hooks/useProviders';
import { toast } from '@/lib/toast';
import { remoteProviderGroupOf } from '@/lib/remoteProviderGroups';
import { extractIpcError } from '@/utils/ipcError';

import {
  ProviderShareDialog,
  ProviderShareDialogFooter,
  ProviderShareDialogTitle,
  ProviderSharePairingCode,
} from './ProviderShareDialog';
import { sharesClaudeLoginEmail, type ProviderSharePendingRequest } from './providerShareFormat';
import { removeProviderSharePendingRequest } from './providerShareStore';
import { ShareAvatar } from './ShareAvatar';
import { useShareTimeFormat } from './useShareTimeFormat';

export function ProviderShareApproveDialog({
  item,
  onClose,
  returnFocusTo,
}: {
  item: ProviderSharePendingRequest;
  /** 处理完或稍后处理：关闭并显示队列里的下一条。 */
  onClose: () => void;
  returnFocusTo?: HTMLElement | null;
}) {
  const { t } = useTranslation();
  const time = useShareTimeFormat();
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const { request, share, hostDeviceId } = item;
  const name = request.displayName;
  const provider = share.providerLabel;
  const { providers } = useProviders();
  const remote = useDeviceProviders(hostDeviceId);
  const providerForApproval = (hostDeviceId ? remote.providers : providers).find((view) => view.id === share.providerId);
  const claudeEmail = sharesClaudeLoginEmail(providerForApproval);
  // 本机的组读本机组设置；另一台电脑上的分享读那台目录里带的组摘要。
  const localGroups = useLocalProviderGroupsState();
  const grouped = hostDeviceId
    ? providerForApproval !== undefined && remoteProviderGroupOf(providerForApproval) !== null
    : localGroups.groups[share.providerId] !== undefined;
  const calloutKey = grouped
    ? 'providerShare.approve.calloutGroup'
    : hostDeviceId ? 'providerShare.approve.calloutRemote' : 'providerShare.approve.callout';
  // 请求成功不代表目录里有目标供应商；找到它并确认类型、有没有组后才能同意，避免漏掉 Claude 邮箱告知或说错 Agent 在哪运行。
  const providerClassificationReady = providerForApproval !== undefined
    && (hostDeviceId
      ? !remote.loading && remote.error === null
      : localGroups.ready && !localGroups.loading && !localGroups.failed);

  const decide = async (action: 'approve' | 'reject') => {
    if (busy) return;
    setBusy(action);
    try {
      await providerShareManagementCommand({ action, requestId: request.requestId }, hostDeviceId);
      removeProviderSharePendingRequest(request.requestId);
      toast.success(
        action === 'approve'
          ? t('providerShare.toast.approved', { name, provider })
          : t('providerShare.toast.rejected', { name }),
      );
      onClose();
    } catch (error) {
      toast.error(t(providerManagementErrorKey(error, Boolean(hostDeviceId))));
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
      returnFocusTo={returnFocusTo}
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
        {!hostDeviceId && localGroups.failed
          ? <p role="status">{t('providerGroup.section.loadFailed')}</p>
          : <p>{t(calloutKey, { name, provider })}</p>}
        {claudeEmail ? <p>{t('providerShare.approve.calloutClaudeEmail', { name })}</p> : null}
        <p>{t('providerShare.approve.calloutUnknown')}</p>
      </div>
      <ProviderShareDialogFooter>
        <Button
          variant="cta"
          palette="confirmation"
          size="lg"
          loading={busy === 'approve'}
          disabled={busy !== null || !providerClassificationReady}
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
