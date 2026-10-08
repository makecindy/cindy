/**
 * 「分享 {供应商}」管理页(设计稿场景 2；产品规则 §7.2)。从设置 → 模型供应商的「管理分享」
 * 进入，可返回。只列**这台电脑**上的分享：待审批申请、已分享的人与按模型的用量。
 *
 * 打开期间每次 OWNED_CHANGED 都按当前时间段重读(main 因此保持快速拉取，申请能尽快出现)；
 * 关闭、恢复、删除、同意、拒绝都立即生效，结果以 toast 说明。
 */
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Tip } from '@/components/ui/tooltip';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { toast } from '@/lib/toast';
import { formatModelShort } from '@/lib/usageFormat';
import { cn } from '@/lib/utils';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';

import type {
  ProviderShareMemberView,
  ProviderShareOwnerState,
  ProviderShareUsageRange,
} from '../../../shared/providerShare';
import { ProviderShareLinkDialog } from './ProviderShareLinkDialog';
import {
  formatShareMoney,
  formatShareTokens,
  summarizeShareUsage,
  type ProviderShareGate,
  type ProviderSharePendingRequest,
} from './providerShareFormat';
import { publishProviderShareOwnerState, removeProviderSharePendingRequest } from './providerShareStore';
import { ShareAvatar } from './ShareAvatar';
import { useShareTimeFormat } from './useShareTimeFormat';

export type { ProviderShareGate };

const RANGES: readonly ProviderShareUsageRange[] = ['7d', 'month', 'all'];

export function ProviderShareManagePage({
  providerId,
  providerName,
  providerIcon,
  gate,
  onBack,
}: {
  providerId: string;
  providerName: string;
  providerIcon: ReactNode;
  gate: ProviderShareGate;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const time = useShareTimeFormat();
  const selfDeviceName = useDeviceLinkDeviceList()?.find((device) => device.isSelf)?.name ?? null;
  const [range, setRange] = useState<ProviderShareUsageRange>('month');
  const [state, setState] = useState<ProviderShareOwnerState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const loadSeq = useRef(0);
  const rangeRef = useRef(range);
  rangeRef.current = range;

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const next = await window.electronAPI.providerShare.command({ action: 'owned', range: rangeRef.current });
      if (seq !== loadSeq.current) return;
      setState(next);
      setLoadFailed(false);
      publishProviderShareOwnerState(next);
    } catch {
      if (seq !== loadSeq.current) return;
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, range]);

  useEffect(() => {
    const off = window.electronAPI.providerShare.onOwnedChanged(() => void load());
    return () => {
      off();
      loadSeq.current += 1;
    };
  }, [load]);

  // 同一个供应商在这台电脑上只应有一条分享；稳妥起见合并同供应商的全部记录。
  const { members, requests } = useMemo(() => {
    const shares = state?.ready ? state.shares.filter((share) => share.providerId === providerId) : [];
    const pending: ProviderSharePendingRequest[] = [];
    for (const share of shares) {
      for (const request of share.requests) {
        pending.push({
          request,
          share: { shareId: share.shareId, providerId: share.providerId, providerLabel: share.providerLabel },
        });
      }
    }
    pending.sort((a, b) => Date.parse(a.request.createdAt) - Date.parse(b.request.createdAt));
    return { members: shares.flatMap((share) => share.members), requests: pending };
  }, [providerId, state]);

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
          await window.electronAPI.providerShare.command({ action, requestId: item.request.requestId });
          removeProviderSharePendingRequest(item.request.requestId);
          toast.success(
            action === 'approve'
              ? t('providerShare.toast.approved', { name: item.request.displayName, provider: providerName })
              : t('providerShare.toast.rejected', { name: item.request.displayName }),
          );
        } catch (error) {
          toast.error(t(mapIpcErrorToI18nKey(error)));
        }
        void load();
      }),
    [load, providerName, t, withBusy],
  );

  const setMember = useCallback(
    (member: ProviderShareMemberView, status: 'pause' | 'resume' | 'remove') =>
      withBusy(member.memberId, async () => {
        try {
          await window.electronAPI.providerShare.command({ action: 'set-member', memberId: member.memberId, status });
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
          toast.error(t(mapIpcErrorToI18nKey(error)));
        }
        void load();
      }),
    [load, t, withBusy],
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
  const canCreateLink = gate === 'on' && ready;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto pb-8" data-testid="provider-share-manage">
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex h-8 shrink-0 items-center gap-2 self-start rounded-full px-2 text-13 font-medium text-[var(--settings-section-sublabel)] transition-colors hover:bg-sidebar-item-hover hover:text-[var(--settings-section-title)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      >
        <ArrowLeft size={16} aria-hidden />
        {t('settings.providers.title')}
      </button>

      <div className="flex shrink-0 flex-wrap items-start gap-3">
        <div
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--settings-integration-avatar-border)] bg-[var(--settings-integration-avatar-bg)] text-[var(--settings-integration-avatar-icon)]"
        >
          {providerIcon}
        </div>
        <div className="flex min-w-[240px] flex-1 flex-col gap-1">
          <h2 className="text-16 font-medium leading-[1.3] text-[var(--settings-section-title)]">
            {t('providerShare.manage.title', { provider: providerName })}
          </h2>
          <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
            {selfDeviceName
              ? t('providerShare.manage.descriptionWithDevice', { provider: providerName, device: selfDeviceName })
              : t('providerShare.manage.description', { provider: providerName })}
          </p>
        </div>
        <Button variant="cta" size="md" disabled={!canCreateLink} onClick={() => setLinkOpen(true)}>
          {t('providerShare.manage.createLink')}
        </Button>
      </div>

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
                ? t('providerShare.manage.loadFailed')
                : t('providerShare.manage.notReady')}
        </p>
      )}

      {requests.length > 0 && (
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
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    compact
                    disabled={busy.has(item.request.requestId)}
                    onClick={() => void decide(item, 'reject')}
                  >
                    {t('providerShare.approve.reject')}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    compact
                    disabled={busy.has(item.request.requestId)}
                    onClick={() => void decide(item, 'approve')}
                  >
                    {t('providerShare.approve.approve')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mt-6 shrink-0" aria-labelledby="provider-share-members-title">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 id="provider-share-members-title" className="text-13 font-medium text-[var(--settings-section-title)]">
            {t('providerShare.manage.members.title')}
          </h3>
          {members.length > 0 && <span className="text-13 text-[var(--text-tertiary)]">{members.length}</span>}
          <span className="flex-1" />
          <SegmentedControl
            value={range}
            onValueChange={setRange}
            aria-label={t('providerShare.manage.members.rangeAria')}
            options={RANGES.map((value) => ({ value, label: t(`providerShare.manage.members.range.${value}`) }))}
          />
        </div>
        <div className="overflow-hidden rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]">
          {members.length === 0 ? (
            <p className="px-4 py-7 text-center text-13 leading-[1.5] text-[var(--text-secondary)]">
              {/* 分享服务未就绪时列表为空不代表没分享给任何人：上方提示已说明原因。 */}
              {state?.ready
                ? t('providerShare.manage.members.empty')
                : state || loadFailed
                  ? '—'
                  : t('providerShare.manage.loading')}
            </p>
          ) : (
            members.map((member, index) => (
              <MemberRow
                key={member.memberId}
                member={member}
                first={index === 0}
                open={expanded.has(member.memberId)}
                busy={busy.has(member.memberId)}
                time={time}
                onToggle={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(member.memberId)) next.delete(member.memberId);
                    else next.add(member.memberId);
                    return next;
                  })
                }
                onPause={() => void setMember(member, member.status === 'paused' ? 'resume' : 'pause')}
                onRemove={() => void removeMember(member)}
              />
            ))
          )}
        </div>
      </section>

      {linkOpen && (
        <ProviderShareLinkDialog
          providerId={providerId}
          providerLabel={providerName}
          onClose={() => setLinkOpen(false)}
        />
      )}
    </div>
  );
}

function MemberRow({
  member,
  first,
  open,
  busy,
  time,
  onToggle,
  onPause,
  onRemove,
}: {
  member: ProviderShareMemberView;
  first: boolean;
  open: boolean;
  busy: boolean;
  time: ReturnType<typeof useShareTimeFormat>;
  onToggle: () => void;
  onPause: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const paused = member.status === 'paused';
  const totals = summarizeShareUsage(member.models);
  const breakdownId = `provider-share-usage-${member.memberId}`;
  const statusText = paused
    ? t('providerShare.manage.members.statusPaused')
    : member.runningTasks > 0
      ? t('providerShare.manage.members.statusRunning', { count: member.runningTasks })
      : t('providerShare.manage.members.statusActive');
  const toggleLabel = t(open ? 'providerShare.manage.members.collapseAria' : 'providerShare.manage.members.expandAria', {
    name: member.displayName,
  });
  return (
    <div
      data-testid="provider-share-member-row"
      className={cn(!first && 'border-t border-[var(--settings-theme-card-border)]')}
    >
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <Tip text={toggleLabel}>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={breakdownId}
            aria-label={toggleLabel}
            className="-ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            <ChevronRight
              size={14}
              aria-hidden
              className={cn('transition-transform duration-150 motion-reduce:transition-none', open && 'rotate-90')}
            />
          </button>
        </Tip>
        <ShareAvatar
          displayName={member.displayName}
          avatarUrl={member.avatarUrl}
          className={cn(paused && 'opacity-70')}
        />
        <div className={cn('flex min-w-[180px] flex-1 flex-col gap-0.5', paused && 'opacity-70')}>
          <div className="flex flex-wrap items-center gap-2 text-13">
            <span className="font-medium text-[var(--text-primary)]">{member.displayName}</span>
            <span className="inline-flex items-center gap-1.5 text-12 text-[var(--text-secondary)]">
              <span
                aria-hidden="true"
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  paused ? 'bg-[var(--remote-status-disconnected)]' : 'bg-[var(--remote-status-ready)]',
                )}
              />
              {statusText}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5 text-12 text-[var(--text-secondary)]">
            <span>{t('providerShare.manage.members.joined', { date: time.date(Date.parse(member.joinedAt)) })}</span>
            <span aria-hidden="true">·</span>
            <span>
              {member.lastUsedAt
                ? t('providerShare.manage.members.lastUsed', { time: time.relative(member.lastUsedAt) })
                : t('providerShare.manage.members.neverUsed')}
            </span>
          </div>
        </div>
        <div className={cn('flex shrink-0 flex-col items-end text-12 text-[var(--text-secondary)]', paused && 'opacity-70')}>
          <span className="text-13 font-medium text-[var(--text-primary)] [font-variant-numeric:tabular-nums]">
            {t('providerShare.manage.members.tokens', { tokens: formatShareTokens(totals.tokens) })}
          </span>
          {totals.amount && (
            <span className="[font-variant-numeric:tabular-nums]">
              {t('providerShare.manage.members.amount', { amount: formatShareMoney(totals.amount) })}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="secondary" size="sm" compact disabled={busy} onClick={onPause}>
            {t(paused ? 'providerShare.manage.members.resume' : 'providerShare.manage.members.pause')}
          </Button>
          <Button
            variant="secondary"
            tone="danger"
            size="sm"
            compact
            disabled={busy}
            aria-label={t('providerShare.manage.members.removeAria', { name: member.displayName })}
            onClick={onRemove}
          >
            {t('providerShare.manage.members.remove')}
          </Button>
        </div>
      </div>
      {/* 明细表与头像左缘对齐：px-4 + 展开按钮(24 - 4) + gap-3 = 48px。 */}
      {open && (
        <div id={breakdownId} className="px-4 pb-3.5 sm:pl-12">
          <table className="w-full border-collapse text-12">
            <thead>
              <tr className="border-b border-[var(--border-default)] text-left text-[var(--text-secondary)]">
                <th scope="col" className="py-1.5 pr-3 font-medium">{t('providerShare.manage.members.table.model')}</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t('providerShare.manage.members.table.turns')}</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t('providerShare.manage.members.table.input')}</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t('providerShare.manage.members.table.output')}</th>
                <th scope="col" className="py-1.5 text-right font-medium">{t('providerShare.manage.members.table.amount')}</th>
              </tr>
            </thead>
            <tbody className="text-[var(--text-primary)] [font-variant-numeric:tabular-nums]">
              {member.models.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-2 text-[var(--text-secondary)]">
                    {t('providerShare.manage.members.noUsage')}
                  </td>
                </tr>
              ) : (
                member.models.map((model) => (
                  <tr
                    key={`${model.kind}:${model.providerId ?? ''}:${model.model}`}
                    className="border-b border-[var(--border-default)] last:border-b-0"
                  >
                    <td className="py-1.5 pr-3">{formatModelShort(model.model)}</td>
                    <td className="py-1.5 pr-3 text-right">{model.turns}</td>
                    <td className="py-1.5 pr-3 text-right">{formatShareTokens(model.inputTokens)}</td>
                    <td className="py-1.5 pr-3 text-right">{formatShareTokens(model.outputTokens)}</td>
                    <td className="py-1.5 text-right">{model.amount ? formatShareMoney(model.amount) : '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <p className="mt-2 text-12 text-[var(--text-tertiary)]">{t('providerShare.manage.members.estimateNote')}</p>
        </div>
      )}
    </div>
  );
}
