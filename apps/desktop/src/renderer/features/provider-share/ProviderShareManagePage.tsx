import { RemoteAgentLimitsSection } from './RemoteAgentLimitsSection';
/**
 * 「{供应商} · 远程与分享」页(供应商分享 §7.2；供应商组 §10)。从设置 → 模型供应商「允许被远程调用」一行的
 * 「远程与分享」入口进入，可返回。本机或同账号组所在电脑共用这一页，设置、分享与用量始终读取管理对象所在电脑。
 *
 * 打开期间每次 OWNED_CHANGED 都重读(main 因此保持快速拉取，申请能尽快出现)；
 * 关闭、恢复、删除、同意、拒绝都立即生效，结果以 toast 说明。用量读管理对象所在电脑的按天明细，
 * 时间段、人与电脑由「用量」块自己筛选；打开、分享变化时与每分钟各读一次。
 *
 * 分享的人不再单列「已分享的人」：状态与关闭、删除并进「用量」块里这个人的那一行(2026-10-16 用户要求)。
 * 同日用户反馈页面底部的「生成分享链接」太难找：它放到标题右侧，待处理紧跟标题，不再单设「分享」块；
 * 分享前要知道的(Agent 在哪运行、用量算谁的)由申请弹窗的同意说明在审批时讲清。
 */
import { ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderView } from '@cindy/model-providers';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { useDeviceProviders } from '@/hooks/useDeviceProviders';
import { useProviders } from '@/hooks/useProviders';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { ProviderGroupSection } from '@/features/provider-group/ProviderGroupSection';
import {
  isProviderManagementOutdated,
  providerManagementErrorKey,
  providerShareManagementCommand,
} from '@/features/provider-group/providerManagement';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { ProviderGroupConfig } from '../../../shared/providerGroup';

import type {
  ProviderOwnUsageView,
  ProviderShareMemberView,
  ProviderShareOwnerState,
  ProviderShareReshareView,
  ProviderUsageHistoryView,
} from '../../../shared/providerShare';
import { ProviderShareLinkDialog } from './ProviderShareLinkDialog';
import { pendingResharesFromOwned, sharesClaudeLoginEmail, type ProviderShareGate, type ProviderSharePendingRequest } from './providerShareFormat';
import { ProviderUsageSection, type ProviderUsageStatus } from './ProviderUsageSection';
import { presentProviderShareApproval, publishProviderShareOwnerState, removeProviderSharePendingRequest } from './providerShareStore';
import { ShareAvatar } from './ShareAvatar';
import type { ProviderShareMemberActions } from './ShareMemberControls';
import { useShareTimeFormat } from './useShareTimeFormat';

export type { ProviderShareGate };

export function ProviderShareManagePage({
  providerId,
  providerName,
  providerIcon,
  gate,
  deviceId,
  deviceName,
  initialGroup,
  remoteProvider,
  onBack,
}: {
  providerId: string;
  providerName: string;
  providerIcon: ReactNode;
  gate: ProviderShareGate;
  deviceId?: string;
  deviceName?: string;
  initialGroup?: ProviderGroupConfig;
  remoteProvider?: ProviderView;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const time = useShareTimeFormat();
  const devices = useDeviceLinkDeviceList();
  const { providers } = useProviders();
  const remoteCatalog = useDeviceProviders(deviceId);
  const selfDeviceName = deviceId ? deviceName ?? devices?.find((device) => device.deviceId === deviceId)?.name ?? null
    : devices?.find((device) => device.isSelf)?.name ?? null;
  const [remoteGroup, setRemoteGroup] = useState<ProviderGroupConfig | null>(initialGroup ?? null);
  const [state, setState] = useState<ProviderShareOwnerState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadErrorKey, setLoadErrorKey] = useState<string | null>(null);
  const [history, setHistory] = useState<ProviderUsageHistoryView | null>(null);
  const [usageStatus, setUsageStatus] = useState<ProviderUsageStatus>('loading');
  const [legacyOwn, setLegacyOwn] = useState<ProviderOwnUsageView | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [approvalRequestId, setApprovalRequestId] = useState<string | null>(null);
  const approvalTriggerRef = useRef<HTMLElement | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const loadSeq = useRef(0);
  const remoteLoading = useRef(false);
  const historySeq = useRef(0);
  const historyLoading = useRef(false);

  const load = useCallback(async () => {
    if (deviceId && remoteLoading.current) return;
    remoteLoading.current = true;
    const seq = ++loadSeq.current;
    const owner = getDataOwnerGeneration();
    // 成员的用量由「用量」块从按天明细里取；这里按所有时间读，只在那台电脑是旧版本时当作合计用。
    const owned = await providerShareManagementCommand({ action: 'owned', range: 'all' }, deviceId)
      .then((value) => ({ ok: true as const, value }), (reason: unknown) => ({ ok: false as const, reason }));
    if (seq !== loadSeq.current) return;
    remoteLoading.current = false;
    if (!isDataOwnerGenerationCurrent(owner)) return;
    if (owned.ok) {
      setState(owned.value);
      setLoadFailed(false);
      setLoadErrorKey(null);
      publishProviderShareOwnerState(owned.value, deviceId ? { hostDeviceId: deviceId } : undefined);
    } else {
      setLoadFailed(true);
      setLoadErrorKey(providerManagementErrorKey(owned.reason, Boolean(deviceId)));
    }
  }, [deviceId]);

  /**
   * 用量的按天明细(你自己、转来的与分享的人)。读不到时保留上次读到的；那台电脑是旧版本、不认识这个命令时
   * 退回所有时间的合计(你自己读 own-usage，分享的人用 owned 里的成员用量)。
   */
  const loadHistory = useCallback(async () => {
    if (historyLoading.current) return;
    historyLoading.current = true;
    const seq = ++historySeq.current;
    const owner = getDataOwnerGeneration();
    const current = () => seq === historySeq.current && isDataOwnerGenerationCurrent(owner);
    try {
      const result = await providerShareManagementCommand({ action: 'usage-history', providerId }, deviceId);
      if (!current()) return;
      setHistory(result);
      setLegacyOwn(null);
      setUsageStatus('ready');
    } catch (error) {
      if (!current()) return;
      if (deviceId && isProviderManagementOutdated(error)) {
        const legacy = await providerShareManagementCommand({ action: 'own-usage', providerId, range: 'all' }, deviceId)
          .catch(() => null);
        if (!current()) return;
        if (legacy) {
          setHistory(null);
          setLegacyOwn(legacy);
          setUsageStatus('legacy');
          return;
        }
      }
      setUsageStatus('failed');
    } finally {
      if (seq === historySeq.current) historyLoading.current = false;
    }
  }, [providerId, deviceId]);

  useEffect(() => {
    void load();
    void loadHistory();
  }, [load, loadHistory]);

  useEffect(() => {
    const off = window.electronAPI.providerShare.onOwnedChanged(() => {
      void load();
      void loadHistory();
    });
    return () => {
      off();
      // 作废在途的读取；它们回来后不再写状态，也不再挡住下一次读取。
      loadSeq.current += 1;
      historySeq.current += 1;
      remoteLoading.current = false;
      historyLoading.current = false;
    };
  }, [load, loadHistory]);

  // 远程管理时 5 秒读一次分享(申请尽快出现)；用量每分钟读一次，本机与远程相同。
  useEffect(() => {
    if (!deviceId) return;
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void load(); }, 5_000);
    return () => window.clearInterval(timer);
  }, [deviceId, load]);

  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void loadHistory(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [loadHistory]);

  // 同一个供应商在这台电脑上只应有一条分享；稳妥起见合并同供应商的全部记录。
  const { members, requests, reshares } = useMemo(() => {
    const shares = state?.ready ? state.shares.filter((share) => share.providerId === providerId) : [];
    const pending: ProviderSharePendingRequest[] = [];
    for (const share of shares) {
      for (const request of share.requests) {
        pending.push({
          request,
          share: { shareId: share.shareId, providerId: share.providerId, providerLabel: share.providerLabel },
          hostDeviceId: deviceId,
        });
      }
    }
    pending.sort((a, b) => Date.parse(a.request.createdAt) - Date.parse(b.request.createdAt));
    return {
      members: shares.flatMap((share) => share.members),
      requests: pending,
      // 转分享请求(provider-sharing.md §4.3)：成员想经自己的供应商组把这里分享的供应商转给别人用。
      reshares: pendingResharesFromOwned(shares),
    };
  }, [deviceId, providerId, state]);

  const approvalItem = requests.find((item) => item.request.requestId === approvalRequestId);
  const closeApproval = useCallback(() => {
    setApprovalRequestId(null);
    void load();
  }, [load]);
  useEffect(() => {
    if (!approvalItem) {
      setApprovalRequestId(null);
      return;
    }
    return presentProviderShareApproval(approvalItem, closeApproval, approvalTriggerRef.current);
  }, [approvalItem, closeApproval]);

  const withBusy = useCallback(async (key: string, run: () => Promise<void>) => {
    setBusy((current) => new Set(current).add(key));
    try {
      await run();
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const decide = useCallback(
    (item: ProviderSharePendingRequest, action: 'approve' | 'reject') =>
      withBusy(item.request.requestId, async () => {
        try {
          await providerShareManagementCommand({ action, requestId: item.request.requestId }, deviceId);
          // 远程管理时，本机生成链接带来的申请也在待审批里(由本机弹窗)，一并移除。
          removeProviderSharePendingRequest(item.request.requestId);
          toast.success(
            action === 'approve'
              ? t('providerShare.toast.approved', { name: item.request.displayName, provider: providerName })
              : t('providerShare.toast.rejected', { name: item.request.displayName }),
          );
        } catch (error) {
          toast.error(t(providerManagementErrorKey(error, Boolean(deviceId))));
        }
        void load();
      }),
    [load, providerName, deviceId, t, withBusy],
  );

  const setMember = useCallback(
    (member: ProviderShareMemberView, status: 'pause' | 'resume' | 'remove') =>
      withBusy(member.memberId, async () => {
        try {
          await providerShareManagementCommand({ action: 'set-member', memberId: member.memberId, status }, deviceId);
          toast.success(
            t(
              status === 'pause'
                ? 'providerShare.toast.paused'
                : status === 'resume'
                  ? 'providerShare.toast.resumed'
                  : 'providerShare.toast.removed',
              { name: member.displayName },
            ),
          );
        } catch (error) {
          toast.error(t(providerManagementErrorKey(error, Boolean(deviceId))));
        }
        void load();
      }),
    [load, deviceId, t, withBusy],
  );

  /** 转分享：同意、拒绝，或撤回已同意的；记录与运行中的任务都由供应商所在电脑处理。 */
  const decideReshare = useCallback(
    (reshare: ProviderShareReshareView, owner: string, decision: 'approve' | 'reject') =>
      withBusy(reshare.id, async () => {
        try {
          await providerShareManagementCommand({ action: 'reshare-decide', id: reshare.id, decision }, deviceId);
          toast.success(
            decision === 'approve'
              ? t('providerShare.manage.reshare.toastApproved', { name: reshare.name, owner, provider: providerName })
              : reshare.state === 'approved'
                ? t('providerShare.manage.reshare.toastRevoked', { name: reshare.name })
                : t('providerShare.manage.reshare.toastRejected', { name: reshare.name }),
          );
        } catch (error) {
          toast.error(t(providerManagementErrorKey(error, Boolean(deviceId))));
        }
        void load();
      }),
    [load, providerName, deviceId, t, withBusy],
  );

  const removeMember = useCallback(
    async (member: ProviderShareMemberView) => {
      const ok = await confirm({
        presentation: 'standard',
        title: t('providerShare.manage.removeConfirm.title', { name: member.displayName }),
        description: t('providerShare.manage.removeConfirm.description', {
          name: member.displayName,
          provider: providerName,
        }),
        confirmText: t('providerShare.manage.removeConfirm.confirm'),
        confirmVariant: 'destructive',
      });
      if (ok) await setMember(member, 'remove');
    },
    [confirm, providerName, setMember, t],
  );

  const ready = state?.ready === true;
  const canCreateLink = gate === 'on' && ready && !loadFailed;
  const providerForApproval = (deviceId ? remoteCatalog.providers : providers).find((provider) => provider.id === providerId);
  const sharesClaudeEmail = sharesClaudeLoginEmail(providerForApproval);
  // 审批只用当前目录中的目标供应商分类；进入管理页时的旧投影不能证明它仍然存在。
  const providerClassificationReady = providerForApproval !== undefined
    && (!deviceId || (!remoteCatalog.loading && remoteCatalog.error === null));
  const memberActions = useMemo<ProviderShareMemberActions>(() => ({
    busy: (id) => loadFailed || busy.has(id),
    canApproveReshare: providerClassificationReady,
    onTogglePause: (member) => void setMember(member, member.status === 'paused' ? 'resume' : 'pause'),
    onRemove: (member) => void removeMember(member),
    onReshare: (member, reshare, decision) => void decideReshare(reshare, member.displayName, decision),
  }), [busy, decideReshare, loadFailed, providerClassificationReady, removeMember, setMember]);

  return (
    // 这一页自己滚动(设置页外层在「模型供应商」分区不滚)。始终预留滚动条槽位：展开组内电脑的配额、
    // 加载出已分享的人等让内容超过一屏时，滚动条出现不再把整页挤窄 12px(2026-10-11 用户反馈宽度跳变)。
    // 槽位用 -mr-3 挪进外层右侧留白，内容宽度与「模型供应商」卡片保持一致。
    <div
      className="-mr-3 flex h-full min-h-0 flex-col overflow-y-auto pb-8 [scrollbar-gutter:stable]"
      data-testid="provider-share-manage"
    >
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex h-8 shrink-0 items-center gap-2 self-start rounded-full px-2 text-13 font-medium text-[var(--settings-section-sublabel)] transition-colors hover:bg-sidebar-item-hover hover:text-[var(--settings-section-title)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      >
        <ArrowLeft size={16} aria-hidden />
        {t('settings.providers.title')}
      </button>

      {/* 标题已经说明这页是什么；这台电脑的名字由组里本机那一行承载，不在这里重复一遍。 */}
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <div
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--settings-integration-avatar-border)] bg-[var(--settings-integration-avatar-bg)] text-[var(--settings-integration-avatar-icon)]"
        >
          {providerIcon}
        </div>
        <h2 className="min-w-0 flex-1 text-16 font-medium leading-[1.3] text-[var(--settings-section-title)]">
          {t('providerGroup.page.title', { provider: providerName })}
        </h2>
        <Button variant="cta" size="md" disabled={!canCreateLink} onClick={() => setLinkOpen(true)}>
          {t('providerShare.manage.createLink')}
        </Button>
      </div>

      {deviceId && (
        <p className="mt-2 text-12 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('providerGroup.management.note', { device: selfDeviceName ?? deviceId })}
        </p>
      )}

      {(gate !== 'on' || (state && !ready) || loadFailed) && (
        <p
          role="status"
          className="mt-4 shrink-0 rounded-lg bg-[var(--surface-chip)] px-3 py-2.5 text-12 leading-[1.5] text-[var(--text-secondary)]"
        >
          {gate === 'remote-off'
            ? t('providerShare.manage.gateRemoteControl')
            : gate === 'invocation-off'
              ? t('providerShare.manage.gateInvocation')
              : loadFailed
                ? t(deviceId && loadErrorKey ? loadErrorKey : 'providerShare.manage.loadFailed')
                : t('providerShare.manage.notReady')}
        </p>
      )}

      {(requests.length > 0 || reshares.length > 0) && (
        <section className="mt-6 shrink-0" aria-labelledby="provider-share-pending-title">
          <h3 id="provider-share-pending-title" className="mb-2 text-13 font-medium text-[var(--settings-section-title)]">
            {t('providerShare.manage.pending.title')}
          </h3>
          <div className="overflow-hidden rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]">
            {requests.map((item, index) => (
              <div
                key={item.request.requestId}
                data-testid="provider-share-pending-row"
                className={cn(
                  'flex flex-wrap items-center gap-3 px-4 py-3',
                  index > 0 && 'border-t border-[var(--settings-theme-card-border)]',
                )}
              >
                <ShareAvatar displayName={item.request.displayName} avatarUrl={item.request.avatarUrl} />
                <div className="flex min-w-[200px] flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-baseline gap-2 text-13">
                    <span className="font-medium text-[var(--text-primary)]">{item.request.displayName}</span>
                    <span className="text-12 text-[var(--text-secondary)]">{t('providerShare.manage.pending.applying')}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-12 text-[var(--text-secondary)]">
                    <span>
                      {t('providerShare.pairing.label')}{' '}
                      <span className="select-text font-medium tracking-[0.06em] text-[var(--text-primary)] [font-variant-numeric:tabular-nums]">
                        {item.request.pairingCode}
                      </span>
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{t('providerShare.manage.pending.requestedAt', { time: time.relative(Date.parse(item.request.createdAt)) })}</span>
                    <span aria-hidden="true">·</span>
                    <span>{t('providerShare.manage.pending.expiresHint')}</span>
                  </div>
                  {sharesClaudeEmail && (
                    <p data-testid="provider-share-claude-email-callout" className="text-12 leading-[1.5] text-[var(--text-secondary)]">
                      {t('providerShare.approve.calloutClaudeEmail', { name: item.request.displayName })}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    compact
                    disabled={loadFailed || busy.has(item.request.requestId)}
                    onClick={() => void decide(item, 'reject')}
                  >
                    {t('providerShare.approve.reject')}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    compact
                    disabled={loadFailed || !providerClassificationReady || busy.has(item.request.requestId)}
                    onClick={(event) => {
                      approvalTriggerRef.current = event.currentTarget;
                      setApprovalRequestId(item.request.requestId);
                    }}
                  >
                    {t('providerShare.approve.approve')}
                  </Button>
                </div>
              </div>
            ))}
            {reshares.map((item, index) => (
              <div
                key={item.reshare.id}
                data-testid="provider-share-reshare-row"
                className={cn(
                  'flex flex-wrap items-center gap-3 px-4 py-3',
                  (requests.length > 0 || index > 0) && 'border-t border-[var(--settings-theme-card-border)]',
                )}
              >
                <ShareAvatar displayName={item.reshare.name} avatarUrl={item.reshare.avatarUrl} />
                <div className="flex min-w-[200px] flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-baseline gap-2 text-13">
                    <span className="font-medium text-[var(--text-primary)]">{item.reshare.name}</span>
                    <span className="text-12 text-[var(--text-secondary)]">
                      {t('providerShare.manage.reshare.applying', { owner: item.owner.displayName })}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-12 text-[var(--text-secondary)]">
                    <span>{t('providerShare.manage.reshare.requestedAt', { time: time.relative(item.reshare.requestedAt) })}</span>
                    <span aria-hidden="true">·</span>
                    <span>{t('providerShare.manage.reshare.usageHint', { name: item.reshare.name, owner: item.owner.displayName })}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    compact
                    disabled={loadFailed || busy.has(item.reshare.id)}
                    onClick={() => void decideReshare(item.reshare, item.owner.displayName, 'reject')}
                  >
                    {t('providerShare.manage.reshare.reject')}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    compact
                    disabled={loadFailed || !providerClassificationReady || busy.has(item.reshare.id)}
                    onClick={() => void decideReshare(item.reshare, item.owner.displayName, 'approve')}
                  >
                    {t('providerShare.manage.reshare.approve')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <ProviderGroupSection
        providerId={providerId} providerName={providerName} deviceId={deviceId} deviceName={deviceName}
        initialConfig={initialGroup} remoteProvider={remoteProvider} onConfigChange={setRemoteGroup}
      />

      <RemoteAgentLimitsSection key={deviceId ?? 'local'} deviceId={deviceId} />

      <ProviderUsageSection
        providerId={providerId}
        history={history}
        status={usageStatus}
        legacyOwn={legacyOwn}
        members={members}
        memberActions={memberActions}
        selfDeviceName={selfDeviceName}
        ownerDeviceId={deviceId}
        groupConfig={deviceId ? remoteGroup : undefined}
        time={time}
      />

      {linkOpen && (
        <ProviderShareLinkDialog
          deviceId={deviceId}
          providerId={providerId}
          providerLabel={providerName}
          onClose={() => setLinkOpen(false)}
        />
      )}
    </div>
  );
}
