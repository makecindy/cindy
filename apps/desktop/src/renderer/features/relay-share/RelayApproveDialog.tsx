/**
 * 有人用分享链接申请加入中转时的审批弹窗,结构同供应商分享的审批:申请方、配对码核对、同意后会怎样。
 * 右上角 × 与 Esc = 稍后处理,申请留在中转那一行里(中转上 10 分钟内有效)。
 * 配对证明对不上这台电脑给出的链接时只能拒绝。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Monitor, Smartphone, UserRound } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import { toast } from '@/lib/toast';
import {
  ProviderShareDialog,
  ProviderShareDialogFooter,
  ProviderShareDialogTitle,
  ProviderSharePairingCode,
} from '@/features/provider-share/ProviderShareDialog';
import { useShareTimeFormat } from '@/features/provider-share/useShareTimeFormat';

import type { SelfHostedRelayPairRequestView } from '../../../shared/selfHostedRelay';

const K = 'settings.remoteControl.relay.approve';

const isPhone = (platform: string | null) => platform === 'ios' || platform === 'android';

export function RelayApproveDialog({
  request,
  relayName,
  onClose,
  returnFocusTo,
}: {
  request: SelfHostedRelayPairRequestView;
  relayName: string;
  /** 处理完或稍后处理:关闭并显示队列里的下一条。 */
  onClose: () => void;
  returnFocusTo?: HTMLElement | null;
}) {
  const { t } = useTranslation();
  const time = useShareTimeFormat();
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const device = request.deviceName;
  const requestedAt = request.requestedAt ? Date.parse(request.requestedAt) : NaN;
  // 其他账号的申请:同意的是「让这个账号在中转上有自己的线路」,不是让设备加入你的设备。
  const account = request.accountName ?? null;

  const decide = async (approve: boolean) => {
    const api = window.electronAPI?.selfHostedRelay;
    if (busy || !api) return;
    setBusy(approve ? 'approve' : 'reject');
    try {
      const result = await api.command({ type: 'decide', requestId: request.requestId, approve });
      if (result.error) {
        toast.error(t(`settings.remoteControl.relay.errors.${result.error}`));
        // 申请已不在(过期、被撤回或在别处处理了):不再停在这条上。
        if (!result.state.pendingRequests.some((item) => item.requestId === request.requestId)) onClose();
        else setBusy(null);
        return;
      }
      toast.success(
        account
          ? t(approve ? `${K}.toastApprovedAccount` : `${K}.toastRejectedAccount`, { account, relay: relayName })
          : t(approve ? `${K}.toastApproved` : `${K}.toastRejected`, { device, relay: relayName }),
      );
      onClose();
    } catch {
      toast.error(t('settings.remoteControl.relay.errors.FAILED'));
      setBusy(null);
    }
  };

  const Icon = account ? UserRound : isPhone(request.platform) ? Smartphone : Monitor;

  return (
    <ProviderShareDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      closeLabel={t(`${K}.later`)}
      busy={busy !== null}
      returnFocusTo={returnFocusTo}
      testId="relay-approve-dialog"
    >
      <ProviderShareDialogTitle className="pr-9">
        {account ? t(`${K}.titleAccount`, { account, relay: relayName }) : t(`${K}.title`, { device, relay: relayName })}
      </ProviderShareDialogTitle>
      <div className="mt-3.5 flex items-center gap-3 rounded-xl border border-[var(--border-default)] p-3">
        <span
          aria-hidden
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--border-default)] text-[var(--text-secondary)]"
        >
          <Icon size={18} />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-14 font-medium text-[var(--text-primary)]">{account ?? device}</span>
          <span className="text-12 text-[var(--text-secondary)]">
            {account ? `${t(`${K}.otherAccountDevice`, { device })} · ` : null}
            {Number.isFinite(requestedAt)
              ? t(`${K}.requestedAt`, { time: time.relative(requestedAt) })
              : t(`${K}.requestedViaLink`)}
          </span>
        </div>
      </div>
      {request.verified ? (
        <div className="mt-3 flex flex-wrap items-center gap-3.5">
          <ProviderSharePairingCode
            code={request.verifyCode}
            label={t('providerShare.pairing.label')}
            ariaLabel={t('providerShare.pairing.ariaLabel', { digits: request.verifyCode.split('').join(' ') })}
          />
          <p className="min-w-[180px] flex-1 text-12 leading-[1.5] text-[var(--text-secondary)]">{t(`${K}.pairingHint`)}</p>
        </div>
      ) : (
        <ErrorNotice role="alert" className="mt-3" message={t(`${K}.unverified`)} />
      )}
      <div className="mt-3.5 flex flex-col gap-1 rounded-lg bg-[var(--surface)] px-3 py-2.5 text-12 leading-[1.5] text-[var(--text-secondary)]">
        {account ? (
          <>
            <p>{t(`${K}.calloutAccount`, { relay: relayName })}</p>
            <p>{t(`${K}.calloutAccountRevoke`)}</p>
            <p>{t(`${K}.calloutUnknownAccount`)}</p>
          </>
        ) : (
          <>
            <p>{t(`${K}.callout`, { relay: relayName })}</p>
            {request.replacesExisting ? <p>{t(`${K}.replaces`)}</p> : null}
            <p>{t(`${K}.calloutUnknown`)}</p>
          </>
        )}
      </div>
      <ProviderShareDialogFooter>
        <Button
          variant="cta"
          palette="confirmation"
          size="lg"
          loading={busy === 'approve'}
          disabled={busy !== null || !request.verified}
          onClick={() => void decide(true)}
        >
          {t(`${K}.approve`)}
        </Button>
        <Button
          variant="secondary"
          palette="confirmation"
          size="lg"
          loading={busy === 'reject'}
          disabled={busy !== null}
          onClick={() => void decide(false)}
        >
          {t(`${K}.reject`)}
        </Button>
      </ProviderShareDialogFooter>
    </ProviderShareDialog>
  );
}
