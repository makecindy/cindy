/**
 * 「远程与分享」页的供应商组一块(docs/product-rules/provider-groups.md §10、设计稿场景 2)：
 * 组内电脑列表(来源、状态、运行数与并发上限)、添加电脑、组策略与自动换电脑。
 *
 * 行结构对所有来源一致，右侧才能真正成列：上限(与按权重时的权重)下拉 → 参与分配开关 →
 * 行内更多操作。`paused` 是同一个布尔值(shared/providerGroup.ts)，本机与远程都用开关表达，
 * 不再按来源分叉成「开关 / 暂停分配按钮」两套控件；暂停的结果由状态行文字说明，不再弹 toast。
 * 「移出组」是罕用且不可逆的操作，收进 `···` 菜单(与 ProvidersSection 的供应商级菜单同模式)；
 * 本机不能移出(§3)，该位置留空占位以保持列宽。
 *
 * 列表按电脑聚合(providerGroupPresentation.ts)：一台电脑只有一个账号时就是一行；有几个账号时先列电脑，
 * 账号收在它下面，上限、开关、移出与额度仍按账号各管各的。
 */
import { ChevronRight, CircleMinus, Monitor, MoreHorizontal } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { ProviderView } from '@cindy/model-providers';
import { useTranslation } from 'react-i18next';

import { formatQuotaResetAt } from '@/components/status/usageCardModel';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tip } from '@/components/ui/tooltip';
import { useOptionalAuthDeviceId } from '@/contexts/AuthContext';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

import {
  PROVIDER_GROUP_MAX_LIMIT,
  PROVIDER_GROUP_MAX_WEIGHT,
  PROVIDER_GROUP_STRATEGIES,
  providerGroupDeviceCount,
  type ProviderGroupConfig,
  type ProviderGroupMember,
  type ProviderGroupMemberStatus,
  type ProviderGroupStrategy,
} from '../../../shared/providerGroup';
import { providerShareComputerName, useProviderShareOwnerNameOf } from '../provider-share/providerShareNames';
import { GroupMemberQuota, groupMemberQuotaTarget } from './GroupMemberQuota';
import { GroupMemberReshare, reshareSummaryText } from './GroupMemberReshare';
import { GroupMemberDetailsButton, GroupMemberVersion } from './GroupMemberVersion';
import { ProviderGroupAddDialog } from './ProviderGroupAddDialog';
import {
  groupProviderGroupItems,
  providerGroupAccountName,
  providerGroupDeviceVersion,
} from './providerGroupPresentation';
import { useProviderGroup } from './useProviderGroup';
import { providerManagementErrorKey } from './providerManagement';

/**
 * Claude 订阅的配额排序已对所有组策略生效(provider-groups.md §5，2026-10-15)，不再单列「用量均衡」；
 * 旧组存的 `usage` 与最少占用挑法相同，按最少占用显示，用户改选时才写回新值。
 */
const SELECTABLE_STRATEGIES = PROVIDER_GROUP_STRATEGIES.filter((value) => value !== 'usage');
const selectableStrategy = (strategy: ProviderGroupStrategy): ProviderGroupStrategy =>
  strategy === 'usage' ? 'least' : strategy;
const LIMIT_OPTIONS = Array.from({ length: PROVIDER_GROUP_MAX_LIMIT }, (_, i) => String(i + 1));
const WEIGHT_OPTIONS = ['1', '2', '3', '5', '10', '20', '50', String(PROVIDER_GROUP_MAX_WEIGHT)];

export function ProviderGroupSection({ providerId, providerName, deviceId, deviceName, initialConfig, remoteProvider, fastPolicySupported, onConfigChange }: {
  providerId: string;
  providerName: string;
  deviceId?: string;
  deviceName?: string;
  initialConfig?: ProviderGroupConfig | null;
  remoteProvider?: ProviderView;
  fastPolicySupported?: boolean;
  onConfigChange?: (config: ProviderGroupConfig | null) => void;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const group = useProviderGroup(providerId, { live: true, deviceId, initialConfig });
  // 远程页面仍传入供应商详情供上层复用；组策略展示由主干统一采用配额优先规则。
  void remoteProvider;
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const config = group.view?.config ?? null;
  const blocked = saving || group.loading || group.failed;
  useEffect(() => {
    if (group.view) onConfigChange?.(group.view.config);
  }, [group.view, onConfigChange]);
  const statuses = useMemo(
    () => new Map((group.view?.members ?? []).map((status) => [status.key, status])),
    [group.view],
  );

  const save = useCallback(
    async (next: ProviderGroupConfig, success?: string): Promise<boolean> => {
      setSaving(true);
      try {
        await group.save(next);
        if (success) toast.success(success);
        return true;
      } catch (error) {
        toast.error(t(providerManagementErrorKey(error, Boolean(deviceId))));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [group, deviceId, t],
  );

  const updateMember = useCallback(
    (key: string, patch: Partial<ProviderGroupMember>) => {
      if (!config) return;
      void save({ ...config, members: config.members.map((m) => (m.key === key ? { ...m, ...patch } : m)) });
    },
    [config, save],
  );

  const removeMember = useCallback(
    async (member: ProviderGroupMember, label: string) => {
      if (!config) return;
      const last = config.members.length === 1;
      const ok = await confirm({
        presentation: 'standard',
        title: t('providerGroup.member.removeConfirm.title', { name: label }),
        description: last
          ? t('providerGroup.member.removeConfirm.lastDescription', { provider: providerName })
          : t('providerGroup.member.removeConfirm.description'),
        confirmText: t('providerGroup.member.removeConfirm.confirm'),
        confirmVariant: 'destructive',
      });
      if (!ok) return;
      void save(
        { ...config, members: config.members.filter((m) => m.key !== member.key) },
        t('providerGroup.toast.removed', { name: label }),
      );
    },
    [config, confirm, providerName, save, t],
  );

  const deleteGroup = useCallback(async () => {
    const ok = await confirm({
      presentation: 'standard',
      title: t('providerGroup.deleteConfirm.title', { provider: providerName }),
      description: t('providerGroup.deleteConfirm.description'),
      confirmText: t('providerGroup.deleteConfirm.confirm'),
      confirmVariant: 'destructive',
    });
    if (!ok) return;
    setSaving(true);
    try {
      await group.remove();
      toast.success(t('providerGroup.toast.deleted', { provider: providerName }));
    } catch (error) {
      toast.error(t(providerManagementErrorKey(error, Boolean(deviceId))));
    } finally {
      setSaving(false);
    }
  }, [confirm, group, providerName, deviceId, t]);

  return (
    <section className="mt-6 shrink-0" aria-labelledby="provider-group-title" data-testid="provider-group-section">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 id="provider-group-title" className="text-13 font-medium text-[var(--settings-section-title)]">
          {t('providerGroup.section.title')}
        </h3>
        {/* 台数按电脑算：一台电脑上的几个账号算一台(与入口的「N 台电脑」一致)。 */}
        {config && <span className="text-13 text-[var(--text-tertiary)]">{providerGroupDeviceCount(config.members)}</span>}
        <span className="flex-1" />
        {config && (
          <Button variant="secondary" size="sm" compact tone="quiet" disabled={blocked} onClick={() => void deleteGroup()}>
            {t('providerGroup.section.delete')}
          </Button>
        )}
        <Button variant="primary" size="sm" compact disabled={blocked} onClick={() => setAddOpen(true)}>
          {t('providerGroup.section.addComputer')}
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]">
        {!config ? (
          <p className="px-4 py-7 text-center text-13 leading-[1.5] text-[var(--text-secondary)]">
            {group.loading
              ? t('providerGroup.section.loading')
              : group.failed
                ? t(group.errorKey ?? 'providerGroup.section.loadFailed')
                : t('providerGroup.section.empty', { provider: providerName })}
          </p>
        ) : (
          <>
            {groupProviderGroupItems(config.members).map((device, index) => {
              const row = (member: ProviderGroupMember, account?: number) => (
                <MemberRow
                  key={member.key}
                  member={member}
                  status={statuses.get(member.key)}
                  strategy={config.strategy}
                  first={index === 0}
                  account={account}
                  disabled={blocked}
                  ownerDeviceId={deviceId ?? null}
                  ownerDeviceName={deviceName}
                  onChange={(patch) => updateMember(member.key, patch)}
                  onRemove={(label) => void removeMember(member, label)}
                />
              );
              if (device.items.length === 1) return row(device.items[0]);
              return (
                <div
                  key={device.key}
                  data-testid="provider-group-device"
                  className={cn(index > 0 && 'border-t border-[var(--settings-theme-card-border)]')}
                >
                  <MemberDeviceHeader
                    members={device.items}
                    statuses={device.items.map((m) => statuses.get(m.key))}
                    ownerDeviceId={deviceId ?? null}
                    ownerDeviceName={deviceName}
                  />
                  {device.items.map((member, accountIndex) => row(member, accountIndex + 1))}
                </div>
              );
            })}
            <div className="flex flex-col gap-1.5 border-t border-[var(--settings-theme-card-border)] px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-13 text-[var(--text-primary)]">{t('providerGroup.strategy.label')}</span>
                <SegmentedControl
                  value={selectableStrategy(config.strategy)}
                  onValueChange={(strategy: ProviderGroupStrategy) => void save({ ...config, strategy })}
                  aria-label={t('providerGroup.strategy.label')}
                  options={SELECTABLE_STRATEGIES.map((value) => ({
                    value,
                    label: t(`providerGroup.strategy.${value}`),
                    disabled: blocked,
                  }))}
                />
                <span className="flex-1" />
                <span className="text-12 text-[var(--text-secondary)]">
                  {t(`providerGroup.strategy.description.${selectableStrategy(config.strategy)}`)}
                </span>
              </div>
              <span className="text-12 leading-[1.4] text-[var(--text-tertiary)]">
                {t('providerGroup.strategy.quotaFirst')}
              </span>
            </div>
            <div className="flex items-start justify-between gap-3 border-t border-[var(--settings-theme-card-border)] px-4 py-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-13 text-[var(--text-primary)]">{t('providerGroup.autoSwitch.label')}</span>
                <span className="text-12 leading-[1.4] text-[var(--text-tertiary)]">
                  {t('providerGroup.autoSwitch.description')}
                </span>
              </div>
              <Switch
                checked={config.autoSwitch}
                disabled={blocked}
                aria-label={t('providerGroup.autoSwitch.label')}
                onCheckedChange={(autoSwitch) => void save({ ...config, autoSwitch })}
              />
            </div>
            {fastPolicySupported && (
              <div className="flex items-start justify-between gap-3 border-t border-[var(--settings-theme-card-border)] px-4 py-4">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-13 font-medium text-[var(--text-primary)]">{t('subscriptionFastPolicy.label')}</span>
                  <span className="text-12 leading-[1.4] text-[var(--text-secondary)]">{t('subscriptionFastPolicy.groupHint')}</span>
                  {group.view?.fastPolicyPending && <span role="status" className="text-12 leading-[1.4] text-[var(--text-secondary)]">{t('subscriptionFastPolicy.pending')}</span>}
                </div>
                <Switch checked={config.allowFast !== false} disabled={blocked} aria-label={t('subscriptionFastPolicy.label')}
                  onCheckedChange={allowFast => void save({ ...config, allowFast })} />
              </div>
            )}
          </>
        )}
      </div>
      {config && group.failed && (
        <p role="status" className="mt-2 text-12 leading-[1.5] text-[var(--text-secondary)]">
          {t(group.errorKey ?? 'providerGroup.section.loadFailed')}
        </p>
      )}
      {config && (
        <p className="mt-2 text-12 leading-[1.5] text-[var(--text-tertiary)]">{t('providerGroup.section.note')}</p>
      )}

      {addOpen && (
        <ProviderGroupAddDialog
          providerId={providerId}
          providerName={providerName}
          deviceId={deviceId}
          config={config}
          onSave={(next, success) => save(next, success)}
          onClose={() => setAddOpen(false)}
        />
      )}
    </section>
  );
}

/** 组内电脑的称呼与来源；只有一个账号的电脑行与多个账号时的电脑这一层共用。 */
function useMemberNames(
  member: ProviderGroupMember,
  status: ProviderGroupMemberStatus | undefined,
  ownerDeviceId: string | null = null,
  ownerDeviceName?: string,
) {
  const { t } = useTranslation();
  const ownerNameOf = useProviderShareOwnerNameOf();
  // 分享来的电脑只用分享者的昵称称呼，不用电脑名(provider-sharing.md §6)。
  const ownerName = member.kind === 'share' ? (status?.ownerName ?? ownerNameOf(member.agentDeviceId)) : null;
  const label = member.kind === 'local'
    ? ownerDeviceId ? (ownerDeviceName ?? status?.label ?? member.key) : t('providerGroup.member.local')
    : member.kind === 'share'
      ? providerShareComputerName(t, ownerName)
      : (status?.label ?? member.label ?? member.key);
  const source = member.kind === 'local'
    ? ownerDeviceId ? t('providerGroup.member.sourceDevice') : status?.label
    : member.kind === 'device'
      ? t('providerGroup.member.sourceDevice')
      : t('providerGroup.member.sourceShare', { name: ownerName ?? '' });
  return { ownerName, label, source };
}

/** 一台电脑上有几个账号时，电脑这一层：只说是哪台、来源与版本，设置都在下面每个账号上。 */
function MemberDeviceHeader({
  members,
  statuses,
  ownerDeviceId,
  ownerDeviceName,
}: {
  members: readonly ProviderGroupMember[];
  statuses: readonly (ProviderGroupMemberStatus | undefined)[];
  ownerDeviceId: string | null;
  ownerDeviceName?: string;
}) {
  const { t } = useTranslation();
  const { label, source } = useMemberNames(members[0], statuses.find((status) => status != null), ownerDeviceId, ownerDeviceName);
  return (
    <div data-testid="provider-group-device-header" className="flex items-center gap-3 px-4 py-3">
      <span
        aria-hidden="true"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-secondary)]"
      >
        <Monitor size={16} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-baseline gap-2 text-13">
          <span className="font-medium text-[var(--text-primary)]">{label}</span>
          <GroupMemberVersion status={providerGroupDeviceVersion(statuses)} />
          {source && <span className="text-12 text-[var(--text-secondary)]">{source}</span>}
        </span>
        <span className="text-12 text-[var(--text-secondary)]">
          {t('providerGroup.member.accountCount', { count: members.length })}
        </span>
      </span>
    </div>
  );
}

function MemberRow({
  member,
  status,
  strategy,
  first,
  account,
  disabled,
  ownerDeviceId,
  ownerDeviceName,
  onChange,
  onRemove,
}: {
  member: ProviderGroupMember;
  status: ProviderGroupMemberStatus | undefined;
  strategy: ProviderGroupStrategy;
  first: boolean;
  /** 同一台电脑上有几个账号时，这是第几个(从 1 起)：行收在电脑下面，只写账号；不传就是一台电脑一行。 */
  account?: number;
  disabled: boolean;
  ownerDeviceId: string | null;
  ownerDeviceName?: string;
  onChange: (patch: Partial<ProviderGroupMember>) => void;
  onRemove: (label: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { ownerName, label: computer, source } = useMemberNames(member, status, ownerDeviceId, ownerDeviceName);
  const accountName = account === undefined
    ? null
    : providerGroupAccountName(member, status) ?? t('providerGroup.member.accountFallback', { index: account });
  // 无障碍标签与移出确认用：账号行带上电脑名，同一台电脑的几个账号不会重名。
  const label = accountName === null ? computer : `${computer} · ${accountName}`;
  const ready = status?.state === 'available' || status?.state === 'full';
  const running = status?.running ?? 0;
  // 能用的时候状态词本身就报负载(「空闲」/「N 个任务运行中」)，所以每行永远看得出这台现在跑了几个；
  // 「已满」等于跑满上限，上限就在旁边的下拉里，不必再报一遍数。其余状态(冷却、不在线、已暂停)
  // 上面可能还有在跑的任务，补一段运行数。
  const appendRunning = running > 0 && status != null && status.state !== 'available' && status.state !== 'full';
  const reshare = member.kind === 'share' ? status?.reshare : undefined;
  // 点名称一侧展开这台的剩余额度(2026-10-10 用户要求)；收起时不读。
  const [quotaOpen, setQuotaOpen] = useState(false);
  const quotaId = useId();
  const selfDeviceId = useOptionalAuthDeviceId();
  return (
    <div
      data-testid="provider-group-member"
      data-member-state={status?.state ?? 'loading'}
      className={cn(accountName === null && !first && 'border-t border-[var(--settings-theme-card-border)]')}
    >
      <div className={cn('flex', accountName !== null && 'pl-4')}>
        {/* 收在电脑下面的账号：空出图标那一列，分隔线从账号名起，看得出这几个账号在同一台电脑上。 */}
        {accountName !== null && <span aria-hidden="true" className="w-8 shrink-0" />}
        <div
          className={cn(
            'flex min-w-0 flex-1 flex-wrap items-center gap-3 py-3',
            accountName === null ? 'px-4' : 'ml-3 border-t border-[var(--settings-theme-card-border)] pr-4',
          )}
        >
          <GroupMemberDetailsButton
            status={status}
            type="button"
            aria-expanded={quotaOpen}
            aria-controls={quotaOpen ? quotaId : undefined}
            onClick={() => setQuotaOpen((open) => !open)}
            className="group -m-1 flex min-w-[200px] flex-1 items-center gap-3 rounded-lg p-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            {/* 组内电脑用设备图标；人像头像留给下方「用量」里真实的人。账号行的图标在电脑那一层。 */}
            {accountName === null && (
              <span
                aria-hidden="true"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-secondary)]"
              >
                <Monitor size={16} />
              </span>
            )}
            <span className={cn('flex min-w-0 flex-1 flex-col gap-0.5', member.paused && 'opacity-60')}>
              <span className="flex flex-wrap items-baseline gap-2 text-13">
                <span className="font-medium text-[var(--text-primary)]">{accountName ?? computer}</span>
                {/* 版本与来源属于电脑：账号行不重复，写在电脑那一层。 */}
                {accountName === null && <GroupMemberVersion status={status} />}
                {accountName === null && source && <span className="text-12 text-[var(--text-secondary)]">{source}</span>}
                <ChevronRight
                  aria-hidden="true"
                  size={14}
                  className={cn(
                    'shrink-0 self-center text-[var(--text-tertiary)] transition-transform group-hover:text-[var(--text-secondary)]',
                    quotaOpen && 'rotate-90',
                  )}
                />
              </span>
              <span className="flex flex-wrap items-center gap-1.5 text-12 text-[var(--text-secondary)]">
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: ready ? 'var(--remote-status-ready)' : 'var(--remote-status-disconnected)' }}
                />
                {/* 运行数是状态，上限是设置：各说一次，不再出现「0 / 10」与下拉里重复同一个上限。 */}
                <span>{member.kind === 'local' && status?.state === 'paused'
                  ? t('providerGroup.member.status.pausedLocal')
                  : memberStatusText(t, status, i18n.language)}</span>
                {appendRunning && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="[font-variant-numeric:tabular-nums]">
                      {t('providerGroup.member.runningCount', { count: running })}
                    </span>
                  </>
                )}
                {/* 分享来的电脑：它的主人是否同意给本机分享的人用(provider-sharing.md §4.3)，展开看每个人。 */}
                {reshare && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span data-testid="provider-group-member-reshare-summary">
                      {reshareSummaryText(t, reshare, ownerName ?? '')}
                    </span>
                  </>
                )}
              </span>
            </span>
          </GroupMemberDetailsButton>
          <div className="flex shrink-0 items-center gap-1.5">
            <Select
              label={t('providerGroup.member.limitAria', { name: label })}
              value={String(member.limit)}
              options={LIMIT_OPTIONS.map((value) => ({ value, label: t('providerGroup.member.limitOption', { count: Number(value) }) }))}
              onValueChange={(value) => onChange({ limit: Number(value) })}
              disabled={disabled}
              className="w-[104px]"
            />
            {strategy === 'weight' && (
              <Select
                label={t('providerGroup.member.weightAria', { name: label })}
                value={String(member.weight)}
                options={WEIGHT_OPTIONS.map((value) => ({ value, label: t('providerGroup.member.weightOption', { weight: value }) }))}
                onValueChange={(value) => onChange({ weight: Number(value) })}
                disabled={disabled}
                /* 权重最大 100，各语言的「权重 100」都比「上限 16」长：按内容定宽，避免 trigger 自己截断。 */
                className="w-[120px]"
              />
            )}
            <Switch
              checked={!member.paused}
              disabled={disabled}
              aria-label={t(member.kind === 'local' && !ownerDeviceId
                ? 'providerGroup.member.assignLocalAria'
                : 'providerGroup.member.assignAria', { name: label })}
              onCheckedChange={(on) => onChange({ paused: !on })}
            />
            {member.kind === 'local' ? (
              <span aria-hidden="true" className="h-8 w-8 shrink-0" />
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Tip text={t('providerGroup.member.moreAria', { name: label })}>
                    <button
                      type="button"
                      aria-label={t('providerGroup.member.moreAria', { name: label })}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                    >
                      <MoreHorizontal size={18} />
                    </button>
                  </Tip>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem variant="danger" disabled={disabled} onClick={() => onRemove(label)}>
                    <CircleMinus size={18} className="mr-2.5" />
                    {t('providerGroup.member.remove')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </div>
      {quotaOpen && (
        <GroupMemberQuota
          id={quotaId}
          target={groupMemberQuotaTarget(member, ownerDeviceId, selfDeviceId)}
          offline={status?.state === 'offline'}
        />
      )}
      {quotaOpen && reshare && <GroupMemberReshare summary={reshare} owner={ownerName ?? ''} />}
    </div>
  );
}

/** 组内电脑的状态词(本机的组与另一台电脑上的组的只读列表共用)。 */
export function memberStatusText(
  t: ReturnType<typeof useTranslation>['t'],
  status: ProviderGroupMemberStatus | undefined,
  locale: string,
  nowMs: number = Date.now(),
): string {
  if (!status) return t('providerGroup.member.status.checking');
  switch (status.state) {
    case 'available':
      // 「可用」不报负载，整列空着时就看不出每台跑了几个；状态词直接承载运行数。
      return status.running > 0
        ? t('providerGroup.member.runningCount', { count: status.running })
        : t('providerGroup.member.status.idle');
    case 'full':
      return t('providerGroup.member.status.full');
    case 'paused':
      return t('providerGroup.member.status.paused');
    case 'cooling': {
      // 不在今天恢复的(周上限等)带上日期，不让「约 16:00 恢复」看起来像今天就能用。
      const time = status.coolingUntil ? formatQuotaResetAt(status.coolingUntil / 1000, nowMs, locale) : null;
      return time
        ? t('providerGroup.member.status.coolingUntil', { time })
        : t('providerGroup.member.status.cooling');
    }
    case 'offline':
      return t('providerGroup.member.status.offline');
    case 'unavailable':
    default:
      return t(`providerGroup.member.status.unavailable.${status.reason ?? 'disconnected'}`);
  }
}
