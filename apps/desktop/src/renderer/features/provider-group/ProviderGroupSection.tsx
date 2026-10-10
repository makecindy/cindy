/**
 * 「远程与分享」页的供应商组一块(docs/product-rules/provider-groups.md §10、设计稿场景 2)：
 * 组内电脑列表(来源、状态、运行数与并发上限)、添加电脑、组策略与自动换电脑。
 *
 * 行结构对所有来源一致，右侧才能真正成列：上限(与按权重时的权重)下拉 → 参与分配开关 →
 * 行内更多操作。`paused` 是同一个布尔值(shared/providerGroup.ts)，本机与远程都用开关表达，
 * 不再按来源分叉成「开关 / 暂停分配按钮」两套控件；暂停的结果由状态行文字说明，不再弹 toast。
 * 「移出组」是罕用且不可逆的操作，收进 `···` 菜单(与 ProvidersSection 的供应商级菜单同模式)；
 * 本机不能移出(§3)，该位置留空占位以保持列宽。
 */
import { CircleMinus, Monitor, MoreHorizontal } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

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
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';

import {
  PROVIDER_GROUP_MAX_LIMIT,
  PROVIDER_GROUP_MAX_WEIGHT,
  PROVIDER_GROUP_STRATEGIES,
  type ProviderGroupConfig,
  type ProviderGroupMember,
  type ProviderGroupMemberStatus,
  type ProviderGroupStrategy,
} from '../../../shared/providerGroup';
import { ProviderGroupAddDialog } from './ProviderGroupAddDialog';
import { useProviderGroup } from './useProviderGroup';

const LIMIT_OPTIONS = Array.from({ length: PROVIDER_GROUP_MAX_LIMIT }, (_, i) => String(i + 1));
const WEIGHT_OPTIONS = ['1', '2', '3', '5', '10', '20', '50', String(PROVIDER_GROUP_MAX_WEIGHT)];

export function ProviderGroupSection({ providerId, providerName }: { providerId: string; providerName: string }) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const group = useProviderGroup(providerId, { live: true });
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const config = group.view?.config ?? null;
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
        toast.error(t(mapIpcErrorToI18nKey(error)));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [group, t],
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
      toast.error(t(mapIpcErrorToI18nKey(error)));
    } finally {
      setSaving(false);
    }
  }, [confirm, group, providerName, t]);

  return (
    <section className="mt-6 shrink-0" aria-labelledby="provider-group-title" data-testid="provider-group-section">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 id="provider-group-title" className="text-13 font-medium text-[var(--settings-section-title)]">
          {t('providerGroup.section.title')}
        </h3>
        {config && <span className="text-13 text-[var(--text-tertiary)]">{config.members.length}</span>}
        <span className="flex-1" />
        {config && (
          <Button variant="secondary" size="sm" compact tone="quiet" disabled={saving} onClick={() => void deleteGroup()}>
            {t('providerGroup.section.delete')}
          </Button>
        )}
        <Button variant="primary" size="sm" compact disabled={saving || group.loading} onClick={() => setAddOpen(true)}>
          {t('providerGroup.section.addComputer')}
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]">
        {!config ? (
          <p className="px-4 py-7 text-center text-13 leading-[1.5] text-[var(--text-secondary)]">
            {group.loading
              ? t('providerGroup.section.loading')
              : group.failed
                ? t('providerGroup.section.loadFailed')
                : t('providerGroup.section.empty', { provider: providerName })}
          </p>
        ) : (
          <>
            {config.members.map((member, index) => (
              <MemberRow
                key={member.key}
                member={member}
                status={statuses.get(member.key)}
                strategy={config.strategy}
                first={index === 0}
                disabled={saving}
                onChange={(patch) => updateMember(member.key, patch)}
                onRemove={(label) => void removeMember(member, label)}
              />
            ))}
            <div className="flex flex-wrap items-center gap-3 border-t border-[var(--settings-theme-card-border)] px-4 py-3">
              <span className="text-13 text-[var(--text-primary)]">{t('providerGroup.strategy.label')}</span>
              <SegmentedControl
                value={config.strategy}
                onValueChange={(strategy: ProviderGroupStrategy) => void save({ ...config, strategy })}
                aria-label={t('providerGroup.strategy.label')}
                options={PROVIDER_GROUP_STRATEGIES.map((value) => ({
                  value,
                  label: t(`providerGroup.strategy.${value}`),
                  disabled: saving,
                }))}
              />
              <span className="flex-1" />
              <span className="text-12 text-[var(--text-secondary)]">
                {t(`providerGroup.strategy.description.${config.strategy}`)}
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
                disabled={saving}
                aria-label={t('providerGroup.autoSwitch.label')}
                onCheckedChange={(autoSwitch) => void save({ ...config, autoSwitch })}
              />
            </div>
          </>
        )}
      </div>
      {config && (
        <p className="mt-2 text-12 leading-[1.5] text-[var(--text-tertiary)]">{t('providerGroup.section.note')}</p>
      )}

      {addOpen && (
        <ProviderGroupAddDialog
          providerId={providerId}
          providerName={providerName}
          config={config}
          onSave={(next, success) => save(next, success)}
          onClose={() => setAddOpen(false)}
        />
      )}
    </section>
  );
}

function MemberRow({
  member,
  status,
  strategy,
  first,
  disabled,
  onChange,
  onRemove,
}: {
  member: ProviderGroupMember;
  status: ProviderGroupMemberStatus | undefined;
  strategy: ProviderGroupStrategy;
  first: boolean;
  disabled: boolean;
  onChange: (patch: Partial<ProviderGroupMember>) => void;
  onRemove: (label: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const label = member.kind === 'local' ? t('providerGroup.member.local') : (status?.label ?? member.label ?? member.key);
  const source = member.kind === 'local'
    ? status?.label
    : member.kind === 'device'
      ? t('providerGroup.member.sourceDevice')
      : t('providerGroup.member.sourceShare', { name: status?.ownerName ?? '' });
  const ready = status?.state === 'available' || status?.state === 'full';
  const running = status?.running ?? 0;
  // 能用的时候状态词本身就报负载(「空闲」/「N 个任务运行中」)，所以每行永远看得出这台现在跑了几个；
  // 「已满」等于跑满上限，上限就在旁边的下拉里，不必再报一遍数。其余状态(冷却、不在线、已暂停)
  // 上面可能还有在跑的任务，补一段运行数。
  const appendRunning = running > 0 && status != null && status.state !== 'available' && status.state !== 'full';
  return (
    <div
      data-testid="provider-group-member"
      data-member-state={status?.state ?? 'loading'}
      className={cn(
        'flex flex-wrap items-center gap-3 px-4 py-3',
        !first && 'border-t border-[var(--settings-theme-card-border)]',
      )}
    >
      {/* 组内电脑用设备图标；人像头像留给下方「分享」块里真实的人。 */}
      <span
        aria-hidden="true"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-secondary)]"
      >
        <Monitor size={16} />
      </span>
      <div className={cn('flex min-w-[200px] flex-1 flex-col gap-0.5', member.paused && 'opacity-60')}>
        <div className="flex flex-wrap items-baseline gap-2 text-13">
          <span className="font-medium text-[var(--text-primary)]">{label}</span>
          {source && <span className="text-12 text-[var(--text-secondary)]">{source}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-12 text-[var(--text-secondary)]">
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: ready ? 'var(--remote-status-ready)' : 'var(--remote-status-disconnected)' }}
          />
          {/* 运行数是状态，上限是设置：各说一次，不再出现「0 / 10」与下拉里重复同一个上限。 */}
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
          aria-label={t('providerGroup.member.assignAria', { name: label })}
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
  );
}

/** 组内电脑的状态词(本机的组与另一台电脑上的组的只读列表共用)。 */
export function memberStatusText(
  t: ReturnType<typeof useTranslation>['t'],
  status: ProviderGroupMemberStatus | undefined,
  locale: string,
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
    case 'cooling':
      return status.coolingUntil
        ? t('providerGroup.member.status.coolingUntil', {
            time: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(status.coolingUntil),
          })
        : t('providerGroup.member.status.cooling');
    case 'offline':
      return t('providerGroup.member.status.offline');
    case 'unavailable':
    default:
      return t(`providerGroup.member.status.unavailable.${status.reason ?? 'disconnected'}`);
  }
}
