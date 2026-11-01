/**
 * 供应商组里一台电脑这个账号的剩余额度(docs/product-rules/provider-groups.md §10，2026-10-10 用户要求：
 * 组里展开看每台的用量)。与任务底部的用量条、供应商详情页底部的用量卡同一份数据：本机读本机账号，
 * 我的其他电脑经 device-link 查询那台的额度，OpenAI 优先原生查询。别人分享来的电脑不读：分享者的余量不对受邀者开放
 * (与任务底部用量条同一口径，见 lib/usageAccountLocation.ts)。只在展开时挂载，收起的行不读任何电脑。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useDeviceProviderSubscriptionCard } from '@/components/settings/useProviderSubscriptionCard';
import { QuotaHoverCard } from '@/components/status/QuotaHoverCard';
import { providerWeeklyQuotaSource } from '@/components/new-chat/useProviderWeeklyQuota';
import { useDeviceProviders } from '@/hooks/useDeviceProviders';
import { useProviders } from '@/hooks/useProviders';
import { useDeviceLinkDeviceList, useDeviceLinkDeviceListRequestState } from '@/features/device-link/useDeviceLinkDeviceList';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { cn } from '@/lib/utils';

import type { ProviderGroupMember } from '../../../shared/providerGroup';
import type { ProviderView } from '@cindy/model-providers';
import { isKimiCodingProviderView } from '../../../shared/kimiCodingUsage';

/** 这台电脑的额度从哪读。 */
export type GroupMemberQuotaTarget =
  | { kind: 'local'; providerId: string }
  | { kind: 'device'; deviceId: string; providerId: string }
  | { kind: 'share' };

/** 读了这么久还没有额度就不再写「正在读取」：那台可能较旧或这个账号暂时没有额度数据。 */
const LOADING_GRACE_MS = 8_000;
type QuotaRelayStatus = 'stopped' | 'connecting' | 'online';

export function GroupMemberQuota({
  id,
  target,
  offline,
  inset = 'pl-11',
}: {
  id: string;
  target: GroupMemberQuotaTarget;
  /** 组里缓存的离线状态；远端须核验设备证据，本机直接使用当前本地账号。 */
  offline: boolean;
  /** 左侧缩进，让卡片内容与行里的电脑名对齐(卡片自带 16px 内边距)。 */
  inset?: string;
}) {
  const { t } = useTranslation();
  // Keep observing presence while offline, independently of quota/provider hooks.
  // The group's cached status can lag a reconnect; the shared device list lets
  // quota reads recover without waiting for that cache and the next group poll.
  const devices = useDeviceLinkDeviceList();
  const directoryRequest = useDeviceLinkDeviceListRequestState();
  const directoryRef = useRef(devices);
  const directoryStatusRef = useRef(directoryRequest.status);
  const targetDeviceId = target.kind === 'device' ? target.deviceId : null;
  const remoteTarget = target.kind === 'device';
  const owner = getDataOwnerGeneration();
  const confirmedDirectory = useRef<{ owner: typeof owner; deviceId: string } | null>(null);
  const confirmedControl = useRef<{ owner: typeof owner; deviceId: string } | null>(null);
  const previousGroupStatus = useRef({ owner, deviceId: targetDeviceId, offline });
  const offlineRecovery = useRef<{ owner: typeof owner; deviceId: string | null; directory: typeof devices } | null>(null);
  const groupWentOffline = previousGroupStatus.current.owner === owner &&
    previousGroupStatus.current.deviceId === targetDeviceId && !previousGroupStatus.current.offline && offline;
  const [relay, setRelay] = useState<{
    owner: typeof owner;
    status: QuotaRelayStatus;
    recovery: { directory: typeof devices } | null;
  } | null>(null);
  const relayRef = useRef<typeof relay>(null);
  useLayoutEffect(() => {
    directoryRef.current = devices;
    directoryStatusRef.current = directoryRequest.status;
    const current = relayRef.current;
    if (current?.owner === owner && current.status === 'online' && current.recovery &&
      devices !== current.recovery.directory && directoryRequest.status === 'ready') {
      // A successful new-generation directory remains valid through later
      // transient refresh failures, until the next relay interruption.
      relayRef.current = { ...current, recovery: null };
      setRelay(relayRef.current);
    }
  }, [devices, directoryRequest.status, owner, relay]);
  const [control, setControl] = useState<{ owner: typeof owner; disabledDeviceIds: string[] } | null>(null);
  const [presence, setPresence] = useState<{
    deviceId: string;
    directory: typeof devices;
    owner: typeof owner;
    online: boolean;
    remoteControlEnabled: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    // A newly offline group poll is newer than previously confirmed directory
    // or presence evidence. Initial cached offline state still permits recovery.
    if (groupWentOffline) {
      confirmedDirectory.current = null;
      setPresence(null);
      offlineRecovery.current = { owner, deviceId: targetDeviceId, directory: devices };
    } else if (!offline || offlineRecovery.current?.owner !== owner || offlineRecovery.current.deviceId !== targetDeviceId) {
      offlineRecovery.current = null;
    }
    previousGroupStatus.current = { owner, deviceId: targetDeviceId, offline };
  }, [owner, targetDeviceId, offline, groupWentOffline, devices]);
  useEffect(() => {
    const deviceLink = window.electronAPI?.deviceLink;
    if (!deviceLink) return;
    let disposed = false;
    let revision = 0;
    let controlRevision = 0;
    const applyControl = (disabledDeviceIds: string[]) => {
      if (!disposed && isDataOwnerGenerationCurrent(owner)) setControl({ owner, disabledDeviceIds });
    };
    // This local preference push is authoritative even if listDevices fails;
    // target presence cannot restore a permission revoked on this computer.
    const offControl = deviceLink.onControlTargetChanged?.(({ disabledControlDeviceIds }) => {
      controlRevision++;
      applyControl(disabledControlDeviceIds);
    });
    const apply = (status: QuotaRelayStatus) => {
      if (disposed || !isDataOwnerGenerationCurrent(owner)) return;
      const previous = relayRef.current?.owner === owner ? relayRef.current : null;
      const needsEvidence = previous ? previous.status !== 'online' : directoryStatusRef.current !== 'ready';
      const recovery = status === 'online' && needsEvidence
        ? { directory: directoryRef.current }
        : previous?.recovery ?? null;
      relayRef.current = { owner, status, recovery };
      setRelay(relayRef.current);
      if (status !== 'online') {
        confirmedDirectory.current = null;
        setPresence(null);
      }
    };
    // Subscribe before reading: a newer push must beat a delayed initial reply.
    const offStatus = deviceLink.onStatusChanged?.(({ status }) => {
      revision++;
      apply(status);
    });
    if (remoteTarget) {
      void deviceLink.getState?.().then(state => {
        if (revision === 0) apply(state.linkStatus);
        if (controlRevision === 0 && Array.isArray(state.disabledControlDeviceIds)) {
          applyControl(state.disabledControlDeviceIds);
        }
      }).catch(() => undefined);
    }
    return () => { disposed = true; offStatus?.(); offControl?.(); };
  }, [owner, remoteTarget]);
  useEffect(() => {
    setPresence(null);
    const deviceLink = window.electronAPI?.deviceLink;
    if (!deviceLink) return;
    const offPresence = targetDeviceId ? deviceLink.onPresenceChanged?.((snapshot) => {
      const currentRelay = relayRef.current;
      if (
        snapshot.deviceId !== targetDeviceId || !isDataOwnerGenerationCurrent(owner) ||
        (currentRelay && isDataOwnerGenerationCurrent(currentRelay.owner) && currentRelay.status !== 'online')
      ) return;
      if (!snapshot.online || !snapshot.remoteControlEnabled) confirmedDirectory.current = null;
      setPresence({
        deviceId: targetDeviceId, directory: devices, owner,
        online: snapshot.online, remoteControlEnabled: snapshot.remoteControlEnabled,
      });
    }) : undefined;
    return () => { offPresence?.(); };
  }, [targetDeviceId, devices, owner]);
  // listDevices preserves its old array after a failed refresh. A target push
  // remains fresher until the directory changes; local control permission comes
  // from the local preference snapshot, falling back to directory data only when
  // that snapshot is unavailable and this mount has current directory evidence,
  // never from a remote online announcement.
  const currentPresence = !groupWentOffline && presence?.deviceId === targetDeviceId && presence.directory === devices &&
    isDataOwnerGenerationCurrent(presence.owner) ? presence : null;
  const device = target.kind === 'device' ? devices?.find((entry) => entry.deviceId === target.deviceId) : undefined;
  // A stopped relay clears the shared directory to null. Keep the stop signal
  // across that update instead of falling back to a stale online group row.
  const relayStatus = relay && isDataOwnerGenerationCurrent(relay.owner) ? relay.status : null;
  // A relay reconnect does not prove that its peers returned. Accept only a
  // target push or a ready directory published after this relay generation.
  const awaitingPeer = relay?.owner === owner && relay.recovery &&
    (devices === relay.recovery.directory || directoryRequest.status !== 'ready') && currentPresence?.online !== true;
  // A new offline group poll also invalidates an old ready/online directory.
  // Keep that snapshot fenced until a subsequent successful list or target push.
  const recovery = groupWentOffline ? { directory: devices } : offline &&
    offlineRecovery.current?.owner === owner && offlineRecovery.current.deviceId === targetDeviceId
      ? offlineRecovery.current : null;
  const awaitingGroupPeer = recovery && (devices === recovery.directory || directoryRequest.status !== 'ready') &&
    currentPresence?.online !== true;
  // Keep this target's successful directory evidence through unrelated refresh
  // loading/errors. It belongs to this owner/target/relay generation, and explicit
  // target offline/remote-control evidence invalidates it immediately.
  const directoryConfirmed = !groupWentOffline && confirmedDirectory.current?.owner === owner &&
    confirmedDirectory.current.deviceId === targetDeviceId;
  useLayoutEffect(() => {
    if (relayStatus !== 'online' || !targetDeviceId || !device || !device.online || !device.remoteControlEnabled ||
      currentPresence?.online === false || currentPresence?.remoteControlEnabled === false) {
      confirmedDirectory.current = null;
    } else if (directoryRequest.status === 'ready' && !awaitingPeer && !awaitingGroupPeer) {
      confirmedDirectory.current = { owner, deviceId: targetDeviceId };
    }
    if (!awaitingGroupPeer) offlineRecovery.current = null;
  }, [owner, targetDeviceId, device, directoryRequest.status, relayStatus, awaitingPeer, awaitingGroupPeer,
    currentPresence?.online, currentPresence?.remoteControlEnabled]);
  useLayoutEffect(() => {
    if (!targetDeviceId || !device?.controlEnabled) confirmedControl.current = null;
    else if (directoryRequest.status === 'ready') confirmedControl.current = { owner, deviceId: targetDeviceId };
  }, [owner, targetDeviceId, device, directoryRequest.status]);
  // A local grant confirmed while mounted survives unrelated list failures and
  // remote liveness changes. A new mount cannot inherit an unconfirmed old grant.
  const hasDirectoryControl = directoryRequest.status === 'ready' ||
    (confirmedControl.current?.owner === owner && confirmedControl.current.deviceId === targetDeviceId);
  const controlEnabled = targetDeviceId !== null && control?.owner === owner
    ? !control.disabledDeviceIds.includes(targetDeviceId)
    : hasDirectoryControl && device?.controlEnabled;
  // A group row or remote presence cannot supply a local control grant.
  // A matching directory row is still required for provider and quota reads.
  // During an unknown/failed directory refresh, an offline group row also wins
  // over unconfirmed retained online data until this target sends fresh evidence.
  const quotaOffline = remoteTarget
    ? (relayStatus !== null && relayStatus !== 'online') || !device || awaitingPeer || awaitingGroupPeer ||
      (offline && directoryRequest.status !== 'ready' && !directoryConfirmed && currentPresence?.online !== true) ||
      !(currentPresence?.online ?? device.online) ||
      !(currentPresence?.remoteControlEnabled ?? device.remoteControlEnabled) || !controlEnabled
    : target.kind === 'local' ? false : offline;
  // Unknown initial state cannot authorize a remote read from a cached group row.
  const remoteDeviceId = target.kind === 'device' && relayStatus === 'online' && !quotaOffline ? target.deviceId : null;
  const { providers: localProviders } = useProviders();
  const deviceCatalog = useDeviceProviders(remoteDeviceId ?? undefined);
  const provider =
    quotaOffline
      ? undefined
      : target.kind === 'local'
        ? localProviders.find((entry) => entry.id === target.providerId)
        : target.kind === 'device' && remoteDeviceId
          ? deviceCatalog.providers.find((entry) => entry.id === target.providerId)
          : undefined;
  // A liveness gate pauses Kimi observation without replacing an already
  // authorized query identity. Provider-list reads still stop while offline.
  // Retain through catalog recovery loading/errors, then use its fresh
  // identity (or removal). Explicit permission revocation cancels retention.
  const retainedKimi = useRef<{ owner: typeof owner; deviceId: string; provider: ProviderView } | null>(null);
  const controlDenied = targetDeviceId !== null && (
    (control?.owner === owner ? control.disabledDeviceIds.includes(targetDeviceId)
      : directoryRequest.status === 'ready' && device?.controlEnabled === false) ||
    (currentPresence?.remoteControlEnabled ?? device?.remoteControlEnabled) === false ||
    (directoryRequest.status === 'ready' && devices !== null && !device)
  );
  const pausedKimi = target.kind === 'device' && !controlDenied && !provider &&
    (quotaOffline || deviceCatalog.loading || deviceCatalog.error) && retainedKimi.current?.owner === owner &&
    retainedKimi.current.deviceId === target.deviceId && retainedKimi.current.provider.id === target.providerId
      ? retainedKimi.current : null;
  useLayoutEffect(() => {
    if (target.kind === 'device' && provider && isKimiCodingProviderView(provider) &&
      provider.connected && !provider.removed && !provider.suspended) {
      retainedKimi.current = { owner, deviceId: target.deviceId, provider };
    } else if (!pausedKimi) retainedKimi.current = null;
  }, [owner, target, provider, pausedKimi]);
  const card = useDeviceProviderSubscriptionCard(
    provider ?? pausedKimi?.provider,
    pausedKimi?.deviceId ?? remoteDeviceId,
    { live: true, active: !quotaOffline && !!provider },
  );
  const [waitedOut, setWaitedOut] = useState(false);
  const waitKey = target.kind === 'share' ? '' : `${remoteDeviceId ?? ''}\n${target.providerId}`;
  useEffect(() => {
    setWaitedOut(false);
    const timer = window.setTimeout(() => setWaitedOut(true), LOADING_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [waitKey]);

  let note: string | null = null;
  if (target.kind === 'share') note = t('providerGroup.member.quota.share');
  else if (quotaOffline) note = t('providerGroup.member.quota.offline');
  else if (!card) {
    if (provider && !providerWeeklyQuotaSource({ ...provider, suspended: false })) {
      note = t('providerGroup.member.quota.none');
    } else if (waitedOut || (target.kind === 'device' && deviceCatalog.error)) {
      note = t('providerGroup.member.quota.unavailable');
    } else {
      note = t('providerGroup.member.quota.loading');
    }
  }

  return (
    // 紧贴在电脑这一行下面：行本身已说明是哪台电脑，卡片不再出「Claude · 套餐」标题行。
    <div id={id} data-testid="provider-group-member-quota" className={cn('-mt-1', inset)}>
      {card ? (
        <QuotaHoverCard variant="embedded" hideIdentity account={card} />
      ) : (
        <p className="px-4 pb-3 text-12 leading-[1.5] text-[var(--text-tertiary)]">{note}</p>
      )}
    </div>
  );
}

/**
 * 组内一台电脑的额度从哪读。`ownerDeviceId` 是组所在电脑(null = 本机的组)，`selfDeviceId` 是本机：
 * 组里的「组所在电脑自己」读组所在电脑，组员就是本机时读本机账号。
 */
export function groupMemberQuotaTarget(
  member: Pick<ProviderGroupMember, 'kind' | 'agentDeviceId' | 'providerId'>,
  ownerDeviceId: string | null,
  selfDeviceId: string | null,
): GroupMemberQuotaTarget {
  if (member.kind === 'share') return { kind: 'share' };
  const deviceId = member.kind === 'local' ? ownerDeviceId : member.agentDeviceId;
  if (!deviceId || deviceId === selfDeviceId) return { kind: 'local', providerId: member.providerId };
  return { kind: 'device', deviceId, providerId: member.providerId };
}
