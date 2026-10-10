/**
 * 设置 → 模型供应商里「分享给我的」(受邀者)。别人分享给我的供应商与自己的供应商同在左栏，
 * 单独成组(没有分享时整组不显示)、用分享者头像标明来自谁；点开后右栏显示状态、可用的模型
 * 与「退出」。输入分享链接的入口在页面右上角(ProviderSharePasteButton)。
 *
 * 模型清单读分享者电脑上分享给我的那份目录(`share:<id>`)，只读：开关与排序由分享者决定。
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { readProviderShareGroupSize, type ProviderShareReceived } from '@cindy/device-link';

import { hasProviderLogo, ProviderLogoMark } from '@/components/icons/ProviderLogoMark';
import {
  ReadOnlyProviderModelSection,
  readOnlyProviderModels,
} from '@/components/settings/ReadOnlyProviderModels';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Tip } from '@/components/ui/tooltip';
import { useDeviceProviders } from '@/hooks/useDeviceProviders';
import { providerMonogram } from '@/lib/providerModels';
import { refreshRemoteCatalogSnapshot } from '@/lib/remoteCatalogSnapshot';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { extractIpcError, mapIpcErrorToI18nKey } from '@/utils/ipcError';

import { providerShareAgentDeviceId } from './providerShareFormat';
import { providerShareDisplayNames } from './providerShareNames';
import { useProviderShareReceived } from './providerShareStore';
import { ShareAvatar } from './ShareAvatar';

type ReceivedStatus = 'active' | 'paused' | 'offline' | 'needs-update';

function receivedStatus(share: ProviderShareReceived): ReceivedStatus {
  if (share.status !== 'active') return 'paused';
  if (!share.hostOnline) return 'offline';
  return share.hostCapable ? 'active' : 'needs-update';
}

const STATUS_LABEL_KEY: Record<ReceivedStatus, string> = {
  active: 'providerShare.received.statusActive',
  paused: 'providerShare.received.statusPaused',
  offline: 'providerShare.received.hostOffline',
  'needs-update': 'providerShare.received.hostUnavailable',
};

function StatusDot({ status }: { status: ReceivedStatus }) {
  return (
    <span
      aria-hidden="true"
      className="h-1.5 w-1.5 shrink-0 rounded-full"
      style={{
        backgroundColor: status === 'active' ? 'var(--remote-status-ready)' : 'var(--border-default)',
      }}
    />
  );
}

/**
 * 左栏的「分享给我的供应商」一组；没有分享时整组不显示。被我另一台电脑的供应商组收进去的分享
 * 不再单独列出(provider-groups.md §3、§10)，正在查看的那一项保留。
 */
export function ProviderShareReceivedRailGroup({
  selectedShareId,
  onSelect,
  hiddenShareIds,
}: {
  selectedShareId: string | null;
  onSelect: (shareId: string) => void;
  hiddenShareIds?: ReadonlySet<string>;
}) {
  const { t } = useTranslation();
  const { received: all } = useProviderShareReceived();
  const received = hiddenShareIds?.size
    ? all.filter((share) => share.shareId === selectedShareId || !hiddenShareIds.has(share.shareId))
    : all;
  // 按全部分享编号，收起一部分后序号也不变。
  const names = providerShareDisplayNames(all, t);
  if (received.length === 0) return null;

  return (
    <div data-testid="provider-share-received" className="flex flex-col gap-0.5">
      <span
        className="truncate px-2.5 pb-1 pt-3 text-11 font-medium"
        style={{ color: 'var(--text-tertiary)' }}
      >
        {t('providerShare.received.title')}
      </span>
      {received.map((share) => {
        const status = receivedStatus(share);
        // 只写来自谁，不写分享者的电脑名(provider-sharing.md §6)。
        const owner = names.get(share.shareId) ?? '';
        const selected = selectedShareId === share.shareId;
        return (
          <Tip
            key={share.shareId}
            text={owner}
            side="right"
            contentClassName="max-w-[360px] break-words"
          >
            <button
              type="button"
              data-testid="provider-share-received-row"
              aria-current={selected}
              aria-label={`${share.providerLabel} · ${owner} · ${t(STATUS_LABEL_KEY[status])}`}
              onClick={() => onSelect(share.shareId)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg py-2 pl-3 pr-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring-soft)]',
                selected
                  ? 'bg-[var(--settings-menu-bg-selected)]'
                  : 'hover:bg-[var(--settings-menu-bg-hover)]',
              )}
            >
              <ShareAvatar displayName={share.owner.displayName} avatarUrl={share.owner.avatarUrl} size="sm" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span
                  className="truncate text-13 font-medium"
                  style={{
                    color: status === 'active' ? 'var(--settings-section-title)' : 'var(--text-tertiary)',
                  }}
                >
                  {share.providerLabel}
                </span>
                <span className="truncate text-11" style={{ color: 'var(--text-tertiary)' }}>
                  {owner}
                </span>
              </span>
              <StatusDot status={status} />
            </button>
          </Tip>
        );
      })}
    </div>
  );
}

/** 右栏：一条分享给我的供应商。 */
export function ProviderShareReceivedDetail({ share }: { share: ProviderShareReceived }) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [leaving, setLeaving] = useState(false);
  const status = receivedStatus(share);
  const catalogDeviceId = providerShareAgentDeviceId(share.shareId);
  const catalog = useDeviceProviders(status === 'active' ? catalogDeviceId : undefined);
  const provider = catalog.providers.find((entry) => entry.id === share.providerId) ?? catalog.providers[0] ?? null;

  const models = useMemo(
    () => readOnlyProviderModels(provider, catalog.modelVisibilityOverrides),
    [provider, catalog.modelVisibilityOverrides],
  );

  const leave = async () => {
    const ok = await confirm({
      presentation: 'standard',
      title: t('providerShare.received.leaveConfirm.title', {
        name: share.owner.displayName,
        provider: share.providerLabel,
      }),
      description: t('providerShare.received.leaveConfirm.description'),
      confirmText: t('providerShare.received.leaveConfirm.confirm'),
      confirmVariant: 'destructive',
    });
    if (!ok) return;
    setLeaving(true);
    try {
      await window.electronAPI.providerShare.command({ action: 'leave', memberId: share.memberId });
      toast.success(
        t('providerShare.received.left', { name: share.owner.displayName, provider: share.providerLabel }),
      );
    } catch (error) {
      toast.error(t(mapIpcErrorToI18nKey(error)));
    } finally {
      setLeaving(false);
    }
  };

  // 只写来自谁；分享者建了供应商组时补一句组里有几台，不写是哪几台(provider-sharing.md §6)。
  const { received: allReceived } = useProviderShareReceived();
  const groupSize = readProviderShareGroupSize(provider);
  const ownerName = providerShareDisplayNames(allReceived, t).get(share.shareId)
    ?? t('providerShare.received.fromOwner', { name: share.owner.displayName });
  const owner = groupSize !== null
    ? `${ownerName} · ${t('settings.providers.remote.groupBadge', { count: groupSize })}`
    : ownerName;
  let body: string | null = null;
  if (status === 'paused') body = t('providerShare.received.pausedNote');
  else if (status === 'offline') body = t('providerShare.received.offlineNote');
  else if (status === 'needs-update') body = t('providerShare.received.needsUpdateNote');
  else if (catalog.error) {
    // 分享者电脑拒绝(关了远程控制 / 允许被远程调用，或那边还没加载好分享)与连不上要分开说；
    // 其余错误带上错误代码，截图就能看出卡在哪一步。
    const code = extractIpcError(new Error(catalog.error))?.code ?? null;
    body = code === 'REMOTE_AGENT_SHARE_UNAVAILABLE'
      ? t('providerShare.received.modelsRefused')
      : t('providerShare.received.modelsFailedWithCode', { code: code ?? 'UNKNOWN' });
  }
  else if (catalog.loading) body = t('providerShare.received.modelsLoading');
  else if (models.length === 0) body = t('providerShare.received.modelsEmpty');

  return (
    <div data-testid="provider-share-received-detail" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-5 py-4">
        <div className="flex flex-wrap items-center gap-3 gap-y-2">
          <div className="flex min-w-0 flex-auto basis-[220px] items-center gap-3">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
              style={{
                backgroundColor: 'var(--settings-integration-avatar-bg)',
                border: '1px solid var(--settings-integration-avatar-border)',
                color: 'var(--settings-integration-avatar-icon)',
              }}
            >
              {provider && hasProviderLogo(provider.id, provider.routing) ? (
                <ProviderLogoMark providerId={provider.id} routing={provider.routing} size={18} />
              ) : (
                <span className="text-15 font-medium leading-none">{providerMonogram(share.providerLabel)}</span>
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span
                className="min-w-0 truncate text-14 font-medium leading-tight"
                style={{ color: 'var(--settings-section-title)' }}
              >
                {share.providerLabel}
              </span>
              <span
                className="truncate text-13 leading-tight"
                style={{ color: 'var(--settings-integration-subtitle)' }}
              >
                {owner}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2.5">
            <span role="status" className="inline-flex items-center gap-1.5 text-12 text-[var(--text-secondary)]">
              <StatusDot status={status} />
              {t(STATUS_LABEL_KEY[status])}
            </span>
            <Button
              variant="secondary"
              size="md"
              loading={leaving}
              aria-label={t('providerShare.received.leaveAria', {
                name: share.owner.displayName,
                provider: share.providerLabel,
              })}
              onClick={() => void leave()}
            >
              {t('providerShare.received.leave')}
            </Button>
          </div>
        </div>
      </div>

      <div
        className="flex shrink-0 items-start gap-3 border-t px-5 py-3"
        style={{ borderColor: 'var(--settings-theme-card-border)' }}
      >
        <ShareAvatar displayName={share.owner.displayName} avatarUrl={share.owner.avatarUrl} size="sm" />
        <p className="min-w-0 flex-1 text-13 leading-[1.5]" style={{ color: 'var(--settings-section-desc)' }}>
          {t('providerShare.received.detailNote', { name: share.owner.displayName })}
        </p>
      </div>

      <ReadOnlyProviderModelSection
        title={t('providerShare.received.modelsTitle')}
        models={models}
        note={body}
        action={
          status === 'active' && catalog.error ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void refreshRemoteCatalogSnapshot(catalogDeviceId).catch(() => undefined)}
            >
              {t('providerShare.received.retryModels')}
            </Button>
          ) : null
        }
        testId="provider-share-received-models"
      />
    </div>
  );
}
