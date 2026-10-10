/**
 * 另一台电脑上的供应商组，只读(docs/product-rules/provider-groups.md §10)：设置页里同账号另一台电脑的
 * 供应商被建成了组时，详情里列出组内电脑与它们的状态(在线、正在运行几个任务、冷却到何时)。
 * 组的设置只能在组所在电脑上改。状态没有推送，打开期间定时重读。
 */
import { Monitor } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

import type {
  ProviderGroupConfig,
  ProviderGroupMember,
  ProviderGroupMemberStatus,
  ProviderGroupView,
} from '../../../shared/providerGroup';
import { providerShareComputerName, useProviderShareOwnerNameOf } from '../provider-share/providerShareNames';
import { memberStatusText } from './ProviderGroupSection';

const REFRESH_INTERVAL_MS = 15_000;

function useRemoteProviderGroupView(deviceId: string, providerId: string) {
  const [view, setView] = useState<ProviderGroupView | null>(null);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const current = ++seq.current;
    try {
      const next = await window.electronAPI.providerGroup.command({ action: 'remote-view', deviceId, providerId });
      if (current !== seq.current) return;
      setView(next);
      setFailed(false);
    } catch {
      if (current !== seq.current) return;
      setFailed(true);
    }
  }, [deviceId, providerId]);

  useEffect(() => {
    setView(null);
    setFailed(false);
    void reload();
    const timer = window.setInterval(() => void reload(), REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      seq.current += 1;
    };
  }, [reload]);

  return { view, failed };
}

export function RemoteProviderGroupMembers({
  deviceId,
  providerId,
  config,
}: {
  deviceId: string;
  providerId: string;
  /** 目录里带的组设置：状态还没读到时先按它列出组内电脑。 */
  config: ProviderGroupConfig;
}) {
  const { t } = useTranslation();
  const { view, failed } = useRemoteProviderGroupView(deviceId, providerId);
  const members = view?.config?.members ?? config.members;
  return (
    <section
      data-testid="remote-provider-group-members"
      className="shrink-0 border-t px-5 py-3"
      style={{ borderColor: 'var(--settings-theme-card-border)' }}
    >
      <h3 className="pb-2 text-13 font-medium" style={{ color: 'var(--settings-section-title)' }}>
        {t('settings.providers.remote.groupMembersTitle')}
      </h3>
      <div className="overflow-hidden rounded-lg border border-[var(--settings-theme-card-border)]">
        {members.map((member, index) => (
          <MemberRow
            key={member.key}
            member={member}
            status={view?.members.find((m) => m.key === member.key)}
            first={index === 0}
          />
        ))}
      </div>
      {failed && (
        <p className="mt-2 text-12 leading-[1.5] text-[var(--text-tertiary)]">
          {t('settings.providers.remote.groupMembersFailed')}
        </p>
      )}
    </section>
  );
}

function MemberRow({
  member,
  status,
  first,
}: {
  member: ProviderGroupMember;
  status: ProviderGroupMemberStatus | undefined;
  first: boolean;
}) {
  const { t, i18n } = useTranslation();
  const ownerNameOf = useProviderShareOwnerNameOf();
  // 分享来的电脑只用分享者的昵称称呼，不用电脑名(provider-sharing.md §6)。
  const ownerName = member.kind === 'share' ? (status?.ownerName ?? ownerNameOf(member.agentDeviceId)) : null;
  const label = member.kind === 'share'
    ? providerShareComputerName(t, ownerName)
    : (status?.label ?? member.label ?? member.key);
  const source = member.kind === 'local'
    ? t('providerGroup.member.sourceGroupOwner')
    : member.kind === 'device'
      ? t('providerGroup.member.sourceDevice')
      : t('providerGroup.member.sourceShare', { name: ownerName ?? '' });
  const ready = status?.state === 'available' || status?.state === 'full';
  const running = status?.running ?? 0;
  const appendRunning = running > 0 && status != null && status.state !== 'available' && status.state !== 'full';
  return (
    <div
      data-testid="remote-provider-group-member"
      data-member-state={status?.state ?? 'loading'}
      className={cn(
        'flex items-center gap-3 px-3 py-2.5',
        !first && 'border-t border-[var(--settings-theme-card-border)]',
      )}
    >
      <span
        aria-hidden="true"
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-secondary)]"
      >
        <Monitor size={14} />
      </span>
      <div className={cn('flex min-w-0 flex-1 flex-col gap-0.5', member.paused && 'opacity-60')}>
        <div className="flex min-w-0 flex-wrap items-baseline gap-2 text-13">
          <span className="truncate font-medium text-[var(--text-primary)]">{label}</span>
          <span className="text-12 text-[var(--text-secondary)]">{source}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-12 text-[var(--text-secondary)]">
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: ready ? 'var(--remote-status-ready)' : 'var(--remote-status-disconnected)' }}
          />
          <span>{memberStatusText(t, status, i18n.language)}</span>
          {appendRunning && (
            <>
              <span aria-hidden="true">·</span>
              <span className="[font-variant-numeric:tabular-nums]">
                {t('providerGroup.member.runningCount', { count: running })}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
