/**
 * 「远程与分享」页的「用量」块(供应商组 §7、§10)：与设置 → 用量同一套版式(2026-10-17 用户确认原型)——
 * 右上筛选(使用方、组内电脑、时间范围与日期)，下面依次是概览、按人、近 30 天每日 token、活跃热力图、
 * 按电脑、按模型。默认是所有人、所有组内电脑的合计；选某个人或某台电脑后整块跟着变，点表格里的一行也一样。
 *
 * 数据是管理对象所在电脑的按天明细(usage-history)：你自己 = 本机与你其他电脑的合计，分享的人按人，经另一台
 * 电脑转来的看不到具体的人、按那台电脑一行。没有组的供应商当成只有本机一台的组(2026-10-12)，只是不出现组内
 * 电脑的筛选与「按电脑」(只有一台)。那台电脑是旧版本、不认识按天明细时只有所有时间的合计：时间固定为所有时间，
 * 不显示两张图。
 *
 * 分享的人那一行同时管分享本身(2026-10-16 用户要求：原来下方单列的「已分享的人」并进来，同一个人只占一行)：
 * 名字旁是分享状态，第二行带上加入时间与最近使用，行尾 `···` 关闭／恢复或删除，下方列出经他的组转给别人用的人。
 */
import '@/components/settings/usage/usageCharts.css';

import { History, Monitor, RefreshCw } from 'lucide-react';
import { Fragment, useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { UsageHeatmap } from '@/components/new-chat/UsageHeatmap';
import { FIRST_COL_CLASS, ShareCell, Swatch, TD_CLASS, TH_CLASS } from '@/components/settings/usage/UsageBreakdownTables';
import { UsageFilterSelect, type UsageFilterOption } from '@/components/settings/usage/UsageFilterSelect';
import { UsageSeriesBars } from '@/components/settings/usage/UsageTokenBars';
import { formatUsagePercent } from '@/components/settings/usage/formatUsagePercent';
import { usageHistoryModelColor } from '@/components/settings/usage/usageHistoryColors';
import { isUsageHistorySingleDay, usageRangeDay, type UsageHistoryRange } from '@/components/settings/usage/usageHistoryStats';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { useOptionalAuthUser } from '@/contexts/AuthContext';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { useLocalProviderGroups } from '@/features/provider-group/useLocalProviderGroups';
import { formatModelShort } from '@/lib/usageFormat';
import { cn } from '@/lib/utils';

import { providerGroupPhysicalDeviceKey, PROVIDER_GROUP_LOCAL_MEMBER_KEY, type ProviderGroupConfig } from '../../../shared/providerGroup';
import type {
  ProviderOwnUsageView,
  ProviderShareMemberView,
  ProviderUsageHistoryView,
} from '../../../shared/providerShare';
import { DEFAULT_USAGE_CURRENCY, type RegionalMoney } from '../../../shared/regionalMoney';
import { formatShareMoney, formatShareTokens } from './providerShareFormat';
import { providerShareComputerName, useProviderShareOwnerNameOf } from './providerShareNames';
import { deviceIdOfMemberKey, shareAgentDeviceIdOfMemberKey } from './providerUsageBreakdown';
import {
  computerOrder,
  filterUsageRows,
  groupUsageRows,
  keysByTokens,
  memberParty,
  modelKeyOf,
  relayParty,
  rowsFromHistory,
  rowsFromLegacy,
  SELF_PARTY,
  summarizeUsageRows,
  usageRowsByDay,
  type ProviderUsageFilter,
  type ProviderUsageRow,
} from './providerUsageStats';
import { ShareAvatar } from './ShareAvatar';
import {
  ShareMemberMenu,
  ShareMemberReshares,
  ShareMemberStatus,
  type ProviderShareMemberActions,
} from './ShareMemberControls';
import type { ShareTimeFormat } from './useShareTimeFormat';

/** 读取状态：legacy = 那台电脑是旧版本，只有所有时间的合计。 */
export type ProviderUsageStatus = 'loading' | 'ready' | 'failed' | 'legacy';

type StackBy = 'party' | 'computer' | 'model';

/** 热力图与「设置 → 用量」共用；这里只按 token 着色，金额占位不显示。 */
const HEATMAP_WINDOW_DAYS = 140;
const ZERO_MONEY: RegionalMoney = { amount: 0, currency: DEFAULT_USAGE_CURRENCY, approximate: false, kind: 'actual-cost' };
/** 「更早的记录」(当时没有区分电脑)在柱图里的分段键。 */
const UNATTRIBUTED = '\u0000unattributed';
const NONE = '—';

interface UsageParty {
  key: string;
  name: string;
  tag: string;
  /** 人用头像；经另一台电脑转来的(看不到具体的人)用设备图标。 */
  person?: { displayName: string; avatarUrl?: string | null };
  /** 分享的人：这一行同时显示分享状态与操作。 */
  member?: ProviderShareMemberView;
  lastUsedAt: number | null;
}

interface ComputerLabel {
  name: string;
  source: string | null;
}

export function ProviderUsageSection({
  providerId,
  history,
  status,
  legacyOwn,
  members,
  memberActions,
  selfDeviceName,
  ownerDeviceId,
  groupConfig,
  time,
}: {
  providerId: string;
  /** 按天明细；还没读到、读失败或旧版本时为 null。 */
  history: ProviderUsageHistoryView | null;
  status: ProviderUsageStatus;
  /** 旧版本电脑：你自己所有时间的合计(own-usage)。 */
  legacyOwn: ProviderOwnUsageView | null;
  members: readonly ProviderShareMemberView[];
  memberActions: ProviderShareMemberActions;
  selfDeviceName: string | null;
  ownerDeviceId?: string;
  /** 远程管理时由页面传入建组电脑上的组；不传时读本机组设置。 */
  groupConfig?: ProviderGroupConfig | null;
  time: ShareTimeFormat;
}) {
  const { t, i18n } = useTranslation();
  const user = useOptionalAuthUser();
  const devices = useDeviceLinkDeviceList();
  const ownerNameOf = useProviderShareOwnerNameOf();
  const localGroups = useLocalProviderGroups();
  const group = groupConfig === undefined ? localGroups[providerId] ?? null : groupConfig;
  const memberKeys = useMemo(
    () => group ? [...new Set(group.members.map(providerGroupPhysicalDeviceKey))] : [PROVIDER_GROUP_LOCAL_MEMBER_KEY],
    [group],
  );
  const aliases = useMemo(
    () => group ? new Map(group.members.map((member) => [member.key, providerGroupPhysicalDeviceKey(member)])) : undefined,
    [group],
  );

  // 旧版本电脑读到合计后，后续刷新失败仍保留这份合计，并继续锁定为「所有时间」。
  const legacy = status === 'legacy' || (status === 'failed' && history === null && legacyOwn !== null);
  const [rangeChoice, setRange] = useState<UsageHistoryRange>('30d');
  // 旧版本电脑没有按天的数据：只能看所有时间。
  const range: UsageHistoryRange = legacy ? 'all' : rangeChoice;
  const [partyChoice, setParty] = useState('all');
  const [computerChoice, setComputer] = useState('all');
  const [stackChoice, setStack] = useState<StackBy>('party');
  const stack: StackBy = !group && stackChoice === 'computer' ? 'party' : stackChoice;
  const [heatmapWeeks, setHeatmapWeeks] = useState(20);
  const todayKey = history?.todayKey ?? '';

  const rows = useMemo<ProviderUsageRow[]>(() => {
    if (history) {
      // owned 刷新比按日历史快；成员删除后先从旧快照排除，避免总量和页面上的成员行短暂不一致。
      const activeMemberIds = new Set(members.map((member) => member.memberId));
      return rowsFromHistory({
        ...history,
        members: history.members.filter((member) => activeMemberIds.has(member.memberId)),
      }, aliases);
    }
    if (legacy) return rowsFromLegacy(legacyOwn, members, aliases);
    return [];
  }, [aliases, history, legacy, legacyOwn, members]);

  const parties = useMemo<UsageParty[]>(() => {
    const selfName = user?.name?.trim() || t('settings.userProfile.local.name');
    const legacySelfLast = [legacyOwn?.local, ...(legacyOwn?.devices ?? [])]
      .reduce<number | null>((latest, part) => (part ? Math.max(latest ?? 0, part.lastUsedAt) : latest), null);
    // 你自己一行总在，没用过也写出来：本机与你其他电脑的合计，和分享的人同样按人显示。
    const list: UsageParty[] = [{
      key: SELF_PARTY,
      name: selfName,
      tag: t('providerGroup.usage.selfTag'),
      person: { displayName: selfName, avatarUrl: user?.avatar ?? null },
      lastUsedAt: history ? history.self.lastUsedAt : legacySelfLast,
    }];
    for (const member of members) {
      const usage = history?.members.find((item) => item.memberId === member.memberId);
      list.push({
        key: memberParty(member.memberId),
        name: member.displayName,
        tag: t('providerGroup.usage.shareSource'),
        person: { displayName: member.displayName, avatarUrl: member.avatarUrl },
        member,
        lastUsedAt: usage?.lastUsedAt ?? member.lastUsedAt,
      });
    }
    // 同账号的组所在电脑替它的受邀者转来的：这台电脑看不到具体的人，按那台电脑一行。
    const relays = history?.relays ?? (legacyOwn?.relays ?? []).flatMap((relay) => relay.deviceId
      ? [{ deviceId: relay.deviceId, deviceName: relay.deviceName, lastUsedAt: relay.lastUsedAt }]
      : []);
    for (const relay of relays) {
      const device = devices?.find((item) => item.deviceId === relay.deviceId)?.name
        || relay.deviceName
        || t('providerGroup.usage.unknownDevice');
      list.push({
        key: relayParty(relay.deviceId),
        name: t('providerGroup.usage.relayName', { device }),
        tag: t('providerGroup.usage.shareSource'),
        lastUsedAt: relay.lastUsedAt,
      });
    }
    return list;
  }, [devices, history, legacyOwn, members, t, user?.avatar, user?.name]);

  const computerLabel = useCallback(
    (key: string | null): ComputerLabel => {
      if (key === null) return { name: t('providerGroup.usage.unattributed'), source: t('providerGroup.usage.unattributedSource') };
      const removed = memberKeys.includes(key) ? null : t('providerGroup.usage.removedMember');
      if (key === PROVIDER_GROUP_LOCAL_MEMBER_KEY) {
        return {
          name: ownerDeviceId ? selfDeviceName ?? t('providerGroup.usage.unknownDevice') : t('providerGroup.member.local'),
          source: removed ?? (ownerDeviceId ? null : selfDeviceName),
        };
      }
      const member = group?.members.find((item) => item.key === key)
        ?? group?.members.find((item) => providerGroupPhysicalDeviceKey(item) === key);
      const deviceId = member?.kind === 'device' ? member.agentDeviceId : deviceIdOfMemberKey(key);
      if (deviceId) {
        return {
          name: devices?.find((device) => device.deviceId === deviceId)?.name || member?.label || t('providerGroup.usage.unknownDevice'),
          source: removed ?? t('providerGroup.member.sourceDevice'),
        };
      }
      // 分享来的电脑只用分享者的昵称称呼，不用电脑名(provider-sharing.md §6)。
      const shareDevice = member?.kind === 'share' ? member.agentDeviceId : shareAgentDeviceIdOfMemberKey(key);
      const owner = shareDevice ? ownerNameOf(shareDevice) : null;
      return {
        name: shareDevice ? providerShareComputerName(t, owner) : t('providerGroup.usage.unknownDevice'),
        source: removed ?? (owner ? t('providerGroup.member.sourceShare', { name: owner }) : null),
      };
    },
    [devices, group, memberKeys, ownerDeviceId, ownerNameOf, selfDeviceName, t],
  );

  const computers = useMemo(() => computerOrder(memberKeys, rows), [memberKeys, rows]);
  const modelOrder = useMemo(() => keysByTokens(rows, modelKeyOf), [rows]);
  const modelNames = useMemo(() => new Map(rows.map((row) => [modelKeyOf(row), row.model])), [rows]);

  // 选中的人被删除、选中的电脑移出组后回到全部，不停在一个不存在的选项上。
  const party = parties.some((item) => item.key === partyChoice) ? partyChoice : 'all';
  const computer = group && computers.includes(computerChoice) ? computerChoice : 'all';
  const filter: ProviderUsageFilter = { range, todayKey, party, computer };
  const selectedDay = usageRangeDay(range, todayKey || undefined);
  const singleDay = isUsageHistorySingleDay(range);
  const showToday = !legacy && !singleDay;

  const rangeLabel = useMemo(() => {
    if (selectedDay) {
      return new Intl.DateTimeFormat(i18n.language, { year: 'numeric', month: 'short', day: 'numeric' })
        .format(new Date(`${selectedDay}T12:00:00`));
    }
    return t(`usageHistory.range.${range}`);
  }, [i18n.language, range, selectedDay, t]);

  const partyColor = (key: string) => usageHistoryModelColor(parties.findIndex((item) => item.key === key), parties.length);
  const computerColor = (key: string | null) => usageHistoryModelColor(computers.indexOf(key), computers.length);
  const modelColor = (key: string) => usageHistoryModelColor(modelOrder.indexOf(key), modelOrder.length);

  const inRange = filterUsageRows(rows, filter);
  const summary = summarizeUsageRows(inRange);
  const todayFilter: ProviderUsageFilter = { ...filter, range: 'today' };
  const todayTokens = showToday ? summarizeUsageRows(filterUsageRows(rows, todayFilter)).tokens : 0;
  const tokensOf = (list: readonly ProviderUsageRow[]) => summarizeUsageRows(list).tokens;
  const usedParties = [...groupUsageRows(inRange, (row) => row.party).values()].filter((list) => tokensOf(list) > 0).length;
  const usedComputers = [...groupUsageRows(inRange, (row) => row.computer).entries()]
    .filter(([key, list]) => key !== null && tokensOf(list) > 0).length;
  const usedModels = new Set(inRange.map(modelKeyOf)).size;

  const toggleParty = (key: string) => setParty((current) => (current === key ? 'all' : key));
  const toggleComputer = (key: string) => setComputer((current) => (current === key ? 'all' : key));
  const handleDayClick = (day: string) => setRange(`day:${day}` as UsageHistoryRange);

  const partyOptions: UsageFilterOption[] = [
    { value: 'all', label: t('providerGroup.usage.filter.allParties') },
    ...parties.map((item) => ({
      value: item.key,
      label: item.name,
      detail: item.key === SELF_PARTY
        ? t('providerGroup.usage.filter.selfDetail')
        : item.member
          ? item.member.status === 'paused'
            ? `${item.tag} · ${t('providerShare.manage.members.statusPaused')}`
            : item.tag
          : t('providerGroup.usage.filter.relayDetail'),
    })),
  ];
  const computerOptions: UsageFilterOption[] = [
    { value: 'all', label: t('providerGroup.usage.filter.allComputers') },
    ...computers.flatMap((key) => {
      if (key === null) return [];
      const label = computerLabel(key);
      return [{ value: key, label: label.name, detail: label.source }];
    }),
  ];
  const rangeOptions: UsageFilterOption[] = [
    ...(['all', '30d', '7d', 'today'] as const).map((value) => ({ value, label: t(`usageHistory.range.${value}`) })),
    ...(range.startsWith('day:') ? [{ value: range, label: rangeLabel }] : []),
  ];

  // 两张图：按使用方与组内电脑筛，不按时间段(固定窗口，与设置 → 用量相同)。
  const chartRows = useMemo(
    () => filterUsageRows(rows, { range: 'all', todayKey: '', party, computer }, { range: true }),
    [computer, party, rows],
  );
  const series = useMemo(() => chartRows.flatMap((row) => row.day === null ? [] : [{
    day: row.day,
    key: stack === 'party' ? row.party : stack === 'computer' ? row.computer ?? UNATTRIBUTED : modelKeyOf(row),
    tokens: row.inputTokens + row.outputTokens,
  }]), [chartRows, stack]);
  const seriesOrder = useMemo(() => stack === 'party'
    ? parties.map((item) => item.key)
    : stack === 'computer'
      ? computers.map((key) => key ?? UNATTRIBUTED)
      : modelOrder, [computers, modelOrder, parties, stack]);
  const seriesLabel = useCallback(
    (key: string) => stack === 'party'
      ? parties.find((item) => item.key === key)?.name ?? key
      : stack === 'computer'
        ? computerLabel(key === UNATTRIBUTED ? null : key).name
        : formatModelShort(modelNames.get(key) ?? key),
    [computerLabel, modelNames, parties, stack],
  );
  const heatDays = useMemo(() => usageRowsByDay(chartRows).map((day) => ({ ...day, money: ZERO_MONEY })), [chartRows]);

  const charts = Boolean(history) && rows.length > 0;
  const stackOptions = [
    { value: 'party' as const, label: t('providerGroup.usage.stack.party') },
    ...(group ? [{ value: 'computer' as const, label: t('providerGroup.usage.stack.computer') }] : []),
    { value: 'model' as const, label: t('providerGroup.usage.stack.model') },
  ];

  return (
    <section className="usage-history-charts mt-8 shrink-0" aria-labelledby="provider-usage-title">
      {/* 标题在左、筛选在右；放不下时筛选整组换到下一行、靠左。下拉本身写着「所有人」「所有组内电脑」，不另加说明文字。 */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h3 id="provider-usage-title" className="text-13 font-medium text-[var(--settings-section-title)]">
          {t('providerGroup.usage.title')}
        </h3>
        <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="provider-usage-filters">
          <UsageFilterSelect
            value={party}
            options={partyOptions}
            onValueChange={setParty}
            ariaLabel={t('providerGroup.usage.filter.partyAria')}
            className="w-[168px]"
          />
          {group && (
            <UsageFilterSelect
              value={computer}
              options={computerOptions}
              onValueChange={setComputer}
              ariaLabel={t('providerGroup.usage.filter.computerAria')}
              className="w-[168px]"
            />
          )}
          {/* 旧版本电脑只有所有时间的合计：选不了时间，就不摆出时间与日期。 */}
          {!legacy && (
            <>
              <UsageFilterSelect
                value={range}
                options={rangeOptions}
                onValueChange={(value) => setRange(value as UsageHistoryRange)}
                ariaLabel={t('usageHistory.range.ariaLabel')}
                className="w-[148px]"
              />
              <Input
                type="date"
                size="md"
                aria-label={t('usageHistory.range.date')}
                className="w-[148px] max-w-full"
                value={selectedDay ?? ''}
                max={todayKey || undefined}
                disabled={!todayKey}
                onChange={(day) => {
                  if (!todayKey) return;
                  if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day <= todayKey) handleDayClick(day);
                  else if (!day) setRange('30d');
                }}
              />
            </>
          )}
        </div>
      </div>

      {status === 'loading' && !history ? (
        <p role="status" className="-mt-1 mb-3 inline-flex items-center gap-1.5 text-12 text-[var(--text-tertiary)]">
          <Spinner icon={RefreshCw} size={11} className="opacity-70" />
          {t('providerShare.manage.loading')}
        </p>
      ) : status === 'failed' && !history ? (
        <p role="alert" className="-mt-1 mb-3 text-12 text-[var(--error-fg)]">{t('providerGroup.usage.loadFailed')}</p>
      ) : legacy ? (
        <p role="status" className="-mt-1 mb-3 text-12 text-[var(--text-tertiary)]">
          {t('providerGroup.usage.legacyNote', { device: selfDeviceName ?? t('providerGroup.usage.unknownDevice') })}
        </p>
      ) : history?.coverageStart ? (
        <p className="-mt-1 mb-3 text-12 text-[var(--text-tertiary)]">
          {t('providerGroup.usage.coverage', { date: time.date(Date.parse(`${history.coverageStart}T12:00:00`)) })}
        </p>
      ) : null}

      <UsageCard title={t('usageHistory.summary.title')}>
        <div className="flex flex-wrap gap-2" data-testid="provider-usage-summary">
          {showToday && (
            <StatCell value={todayTokens > 0 ? formatShareTokens(todayTokens) : NONE} label={t('usageHistory.stats.todayTokens')} />
          )}
          <StatCell
            value={summary.tokens > 0 ? formatShareTokens(summary.tokens) : NONE}
            label={t('usageHistory.stats.totalTokensInRange', { range: rangeLabel })}
          />
          <StatCell value={summary.amount ? formatShareMoney(summary.amount) : NONE} label={t('providerGroup.usage.summary.amount')} />
          <StatCell value={usedParties > 0 ? String(usedParties) : NONE} label={t('providerGroup.usage.summary.people')} />
          {group && (
            <StatCell value={usedComputers > 0 ? String(usedComputers) : NONE} label={t('providerGroup.usage.summary.computers')} />
          )}
          <StatCell value={usedModels > 0 ? String(usedModels) : NONE} label={t('usageHistory.stats.models')} />
        </div>
      </UsageCard>

      <PartyTable
        parties={parties}
        rows={rows}
        filter={filter}
        rangeLabel={rangeLabel}
        showToday={showToday}
        showComputers={Boolean(group)}
        colorOf={partyColor}
        selected={party}
        onToggle={toggleParty}
        memberActions={memberActions}
        time={time}
        subtitle={computer === 'all' ? rangeLabel : `${rangeLabel} · ${computerLabel(computer).name}`}
      />

      {history && rows.length === 0 && (
        <p className="mb-3.5 text-center text-13 text-[var(--text-tertiary)]">{t('usageHistory.empty')}</p>
      )}

      {charts && (
        <>
          {/* 分色由右侧的切换说明，不再写「按人堆叠」之类的副标题。 */}
          <UsageCard
            title={t('usageHistory.daily.title')}
            right={(
              <SegmentedControl
                value={stack}
                onValueChange={setStack}
                aria-label={t('providerGroup.usage.stack.aria')}
                options={stackOptions}
                height={28}
                optionHeight={24}
              />
            )}
          >
            <UsageSeriesBars
              daily={series}
              order={seriesOrder}
              labelOf={seriesLabel}
              todayKey={todayKey}
              selectedDay={selectedDay}
              highlightRecentWeek={range === '7d'}
              onDayClick={handleDayClick}
            />
          </UsageCard>

          <UsageCard title={t('usageHistory.heatmap.title')} subtitle={t('usageHistory.heatmap.subtitle', { count: heatmapWeeks })}>
            <UsageHeatmap
              days={heatDays}
              todayKey={todayKey}
              windowDays={HEATMAP_WINDOW_DAYS}
              metric="tokens"
              selectedDay={selectedDay}
              onDayClick={handleDayClick}
              onVisibleWeeksChange={setHeatmapWeeks}
            />
          </UsageCard>
        </>
      )}

      {group && rows.length > 0 && (
        <ComputerTable
          computers={computers}
          groupKeys={memberKeys}
          rows={rows}
          filter={filter}
          rangeLabel={rangeLabel}
          showToday={showToday}
          labelOf={computerLabel}
          colorOf={computerColor}
          selected={computer}
          onToggle={toggleComputer}
          subtitle={party === 'all' ? rangeLabel : `${rangeLabel} · ${parties.find((item) => item.key === party)?.name ?? ''}`}
        />
      )}

      {rows.length > 0 && (
        <UsageCard title={t('usageHistory.byModel.title')} subtitle={rangeLabel}>
          <ModelTable rows={inRange} order={modelOrder} colorOf={modelColor} rangeLabel={rangeLabel} />
          <p className="mt-2 text-12 text-[var(--text-tertiary)]">{t('providerShare.manage.members.estimateNote')}</p>
        </UsageCard>
      )}
    </section>
  );
}

function UsageCard({
  title,
  subtitle,
  right,
  children,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mb-3.5 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4">
      <div className="mb-3 flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-14 font-medium text-[var(--text-primary)]">{title}</span>
        {subtitle ? <span className="text-12 text-[var(--text-tertiary)]">{subtitle}</span> : null}
        {right ? <div className="ml-auto">{right}</div> : null}
      </div>
      {children}
    </div>
  );
}

function StatCell({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex min-w-[96px] flex-1 flex-col gap-0.5 rounded-lg bg-[var(--surface-chip)] px-3 py-2">
      <span className="break-words text-16 font-medium leading-[1.4] tabular-nums text-[var(--text-primary)]">{value}</span>
      <span className="mt-auto break-words text-12 leading-[1.5] text-[var(--text-secondary)]">{label}</span>
    </div>
  );
}

/** 表格顶部的占比条：与各行色块同色、同顺序。 */
function ShareStrip({ items }: { items: Array<{ key: string; tokens: number; color: string }> }) {
  const total = items.reduce((sum, item) => sum + item.tokens, 0);
  if (!(total > 0)) return null;
  return (
    <div aria-hidden="true" className="mb-3 flex h-2 overflow-hidden rounded-[2px]">
      {items.filter((item) => item.tokens > 0).map((item) => (
        <div key={item.key} style={{ width: `${(item.tokens / total) * 100}%`, backgroundColor: item.color }} />
      ))}
    </div>
  );
}

const ROW_CLASS = 'cursor-pointer transition-colors motion-reduce:transition-none hover:bg-[var(--surface-hover)]';
const NAME_BUTTON_CLASS =
  'min-w-0 truncate rounded-sm text-left font-medium text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';

/** 按人：你自己、分享的人(带分享状态与操作)、经另一台电脑转来的。点一行只看这个人，再点回到所有人。 */
function PartyTable({
  parties,
  rows,
  filter,
  rangeLabel,
  showToday,
  showComputers,
  colorOf,
  selected,
  onToggle,
  memberActions,
  time,
  subtitle,
}: {
  parties: readonly UsageParty[];
  rows: readonly ProviderUsageRow[];
  filter: ProviderUsageFilter;
  rangeLabel: string;
  showToday: boolean;
  showComputers: boolean;
  colorOf: (key: string) => string;
  selected: string;
  onToggle: (key: string) => void;
  memberActions: ProviderShareMemberActions;
  time: ShareTimeFormat;
  subtitle: string;
}) {
  const { t } = useTranslation();
  const byParty = groupUsageRows(filterUsageRows(rows, filter, { party: true }), (row) => row.party);
  const todayByParty = groupUsageRows(filterUsageRows(rows, { ...filter, range: 'today' }, { party: true }), (row) => row.party);
  const items = parties.map((party) => {
    const list = byParty.get(party.key) ?? [];
    return {
      party,
      list,
      totals: summarizeUsageRows(list),
      today: summarizeUsageRows(todayByParty.get(party.key) ?? []).tokens,
      computers: new Set(list.filter((row) => row.computer !== null && row.inputTokens + row.outputTokens > 0).map((row) => row.computer)).size,
      color: colorOf(party.key),
    };
  });
  const total = items.reduce((sum, item) => sum + item.totals.tokens, 0);
  const actionColumn = parties.some((party) => party.member);
  const columns = 4 + (showToday ? 1 : 0) + (showComputers ? 1 : 0) + (actionColumn ? 1 : 0);
  return (
    <UsageCard title={t('providerGroup.usage.byParty.title')} subtitle={subtitle}>
      <ShareStrip items={items.map((item) => ({ key: item.party.key, tokens: item.totals.tokens, color: item.color }))} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[600px] border-collapse">
          <thead>
            <tr>
              <th className={cn(TH_CLASS, FIRST_COL_CLASS, 'text-left')}>{t('providerGroup.usage.byParty.col.party')}</th>
              <th className={TH_CLASS}>{t('usageHistory.byAgent.col.totalInRange', { range: rangeLabel })}</th>
              <th className={TH_CLASS}>{t('usageHistory.byAgent.col.share')}</th>
              {showToday && <th className={TH_CLASS}>{t('usageHistory.byAgent.col.today')}</th>}
              <th className={TH_CLASS}>{t('providerShare.manage.members.table.amount')}</th>
              {showComputers && <th className={TH_CLASS}>{t('providerGroup.usage.byParty.col.computers')}</th>}
              {actionColumn && <th className={cn(TH_CLASS, 'w-10')} aria-label={t('providerGroup.usage.byParty.col.actions')} />}
            </tr>
          </thead>
          <tbody>
            {items.map(({ party, totals, today, computers, color }) => {
              const { member } = party;
              const paused = member?.status === 'paused';
              const used = totals.tokens > 0;
              const isSelected = selected === party.key;
              const hasReshares = (member?.reshares ?? []).some((reshare) => reshare.state !== 'pending');
              const lastUsed = party.lastUsedAt
                ? t('providerShare.manage.members.lastUsed', { time: time.relative(party.lastUsedAt) })
                : t('providerShare.manage.members.neverUsed');
              const toggleLabel = isSelected
                ? t('providerGroup.usage.focus.clear')
                : t('providerGroup.usage.focus.only', { name: party.name });
              const tdClass = cn(TD_CLASS, hasReshares && 'border-b-0');
              return (
                <Fragment key={party.key}>
                  <tr
                    data-testid="provider-usage-row"
                    data-usage-party={party.key}
                    data-selected={isSelected || undefined}
                    className={cn(ROW_CLASS, isSelected && 'bg-[var(--surface-chip)]')}
                    onClick={() => onToggle(party.key)}
                  >
                    <td className={cn(tdClass, FIRST_COL_CLASS, 'text-left')}>
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Swatch color={color} />
                        {party.person ? (
                          <ShareAvatar
                            displayName={party.person.displayName}
                            avatarUrl={party.person.avatarUrl}
                            size="sm"
                            className={cn(paused && 'opacity-70')}
                          />
                        ) : (
                          <span
                            aria-hidden="true"
                            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-secondary)]"
                          >
                            <Monitor size={14} />
                          </span>
                        )}
                        <div className={cn('flex min-w-0 flex-col gap-0.5', paused && 'opacity-70')}>
                          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                            <Tip text={toggleLabel}>
                              <button
                                type="button"
                                aria-pressed={isSelected}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onToggle(party.key);
                                }}
                                className={NAME_BUTTON_CLASS}
                              >
                                {party.name}
                              </button>
                            </Tip>
                            <span className="text-12 text-[var(--text-secondary)]">{party.tag}</span>
                            {member && <ShareMemberStatus member={member} />}
                          </div>
                          <span className="truncate text-12 text-[var(--text-secondary)]">
                            {member
                              ? `${t('providerShare.manage.members.joined', { date: time.date(Date.parse(member.joinedAt)) })} · ${lastUsed}`
                              : lastUsed}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className={cn(tdClass, used && 'text-[var(--text-primary)]')}>{used ? formatShareTokens(totals.tokens) : NONE}</td>
                    {used && total > 0 ? <ShareCell share={totals.tokens / total} color={color} /> : <td className={tdClass}>{NONE}</td>}
                    {showToday && (
                      <td className={cn(tdClass, 'text-[var(--text-tertiary)]')}>{today > 0 ? formatShareTokens(today) : NONE}</td>
                    )}
                    <td className={cn(tdClass, used && 'text-[var(--text-primary)]')}>
                      {used && totals.amount ? formatShareMoney(totals.amount) : NONE}
                    </td>
                    {showComputers && (
                      <td className={cn(tdClass, 'text-[var(--text-tertiary)]')}>{computers > 0 ? computers : NONE}</td>
                    )}
                    {actionColumn && (
                      // 行尾菜单的点击(含 portal 里的菜单项)不当成「只看这个人」。
                      <td className={cn(tdClass, 'w-10 pl-1')} onClick={(event) => event.stopPropagation()}>
                        {member && (
                          <ShareMemberMenu
                            member={member}
                            disabled={memberActions.busy(member.memberId)}
                            onTogglePause={() => memberActions.onTogglePause(member)}
                            onRemove={() => memberActions.onRemove(member)}
                          />
                        )}
                      </td>
                    )}
                  </tr>
                  {member && hasReshares && (
                    <tr data-usage-party-extra={party.key}>
                      {/* 与昵称一列左对齐：色块 8 + gap 10 + 头像 28 + gap 10 = 56px。 */}
                      <td colSpan={columns} className="border-b border-[var(--border-default)] pb-3 pl-14 pr-3">
                        <ShareMemberReshares member={member} actions={memberActions} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </UsageCard>
  );
}

/** 按电脑：组里每台(按组里的顺序，这段时间没用过的变淡)，已移出组的，以及更早没有区分电脑的记录。 */
function ComputerTable({
  computers,
  groupKeys,
  rows,
  filter,
  rangeLabel,
  showToday,
  labelOf,
  colorOf,
  selected,
  onToggle,
  subtitle,
}: {
  computers: ReadonlyArray<string | null>;
  /** 现在还在组里的电脑：这段时间没用过也列出。 */
  groupKeys: readonly string[];
  rows: readonly ProviderUsageRow[];
  filter: ProviderUsageFilter;
  rangeLabel: string;
  showToday: boolean;
  labelOf: (key: string | null) => ComputerLabel;
  colorOf: (key: string | null) => string;
  selected: string;
  onToggle: (key: string) => void;
  subtitle: string;
}) {
  const { t } = useTranslation();
  const byComputer = groupUsageRows(filterUsageRows(rows, filter, { computer: true }), (row) => row.computer);
  const todayByComputer = groupUsageRows(filterUsageRows(rows, { ...filter, range: 'today' }, { computer: true }), (row) => row.computer);
  const items = computers
    .map((key) => {
      const list = byComputer.get(key) ?? [];
      return {
        key,
        totals: summarizeUsageRows(list),
        today: summarizeUsageRows(todayByComputer.get(key) ?? []).tokens,
        parties: new Set(list.filter((row) => row.inputTokens + row.outputTokens > 0).map((row) => row.party)).size,
        color: colorOf(key),
      };
    })
    // 组里的电脑都列；移出组的与更早的记录只在这段时间用过时列。
    .filter((item) => item.totals.tokens > 0 || (item.key !== null && groupKeys.includes(item.key)));
  const total = items.reduce((sum, item) => sum + item.totals.tokens, 0);
  return (
    <UsageCard title={t('providerGroup.usage.byComputer.title')} subtitle={subtitle}>
      <ShareStrip items={items.map((item) => ({ key: item.key ?? UNATTRIBUTED, tokens: item.totals.tokens, color: item.color }))} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse">
          <thead>
            <tr>
              <th className={cn(TH_CLASS, FIRST_COL_CLASS, 'text-left')}>{t('providerGroup.usage.byComputer.col.computer')}</th>
              <th className={TH_CLASS}>{t('usageHistory.byAgent.col.totalInRange', { range: rangeLabel })}</th>
              <th className={TH_CLASS}>{t('usageHistory.byAgent.col.share')}</th>
              {showToday && <th className={TH_CLASS}>{t('usageHistory.byAgent.col.today')}</th>}
              <th className={TH_CLASS}>{t('providerShare.manage.members.table.amount')}</th>
              <th className={TH_CLASS}>{t('providerGroup.usage.byComputer.col.parties')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map(({ key, totals, today, parties, color }) => {
              const label = labelOf(key);
              const used = totals.tokens > 0;
              const isSelected = key !== null && selected === key;
              const Icon = key === null ? History : Monitor;
              return (
                <tr
                  key={key ?? UNATTRIBUTED}
                  data-testid="provider-usage-computer"
                  data-computer-key={key ?? ''}
                  data-selected={isSelected || undefined}
                  className={cn(
                    key !== null && ROW_CLASS,
                    isSelected && 'bg-[var(--surface-chip)]',
                    !used && 'text-[var(--text-tertiary)]',
                  )}
                  onClick={key === null ? undefined : () => onToggle(key)}
                >
                  <td className={cn(TD_CLASS, FIRST_COL_CLASS, 'text-left')}>
                    <span className="flex min-w-0 items-center gap-2">
                      <Swatch color={color} />
                      <Icon size={14} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />
                      {key === null ? (
                        <span className="truncate">{label.name}</span>
                      ) : (
                        <Tip text={isSelected ? t('providerGroup.usage.focus.clear') : t('providerGroup.usage.focus.only', { name: label.name })}>
                          <button
                            type="button"
                            aria-pressed={isSelected}
                            onClick={(event) => {
                              event.stopPropagation();
                              onToggle(key);
                            }}
                            className={cn(NAME_BUTTON_CLASS, !used && 'font-normal text-[var(--text-tertiary)]')}
                          >
                            {label.name}
                          </button>
                        </Tip>
                      )}
                      {label.source && <span className="shrink-0 text-12 text-[var(--text-secondary)]">{label.source}</span>}
                    </span>
                  </td>
                  <td className={cn(TD_CLASS, used && 'text-[var(--text-primary)]')}>{used ? formatShareTokens(totals.tokens) : NONE}</td>
                  {used && total > 0 ? <ShareCell share={totals.tokens / total} color={color} /> : <td className={TD_CLASS}>{NONE}</td>}
                  {showToday && (
                    <td className={cn(TD_CLASS, 'text-[var(--text-tertiary)]')}>{today > 0 ? formatShareTokens(today) : NONE}</td>
                  )}
                  <td className={cn(TD_CLASS, used && 'text-[var(--text-primary)]')}>
                    {used && totals.amount ? formatShareMoney(totals.amount) : NONE}
                  </td>
                  <td className={cn(TD_CLASS, 'text-[var(--text-tertiary)]')}>{used ? parties : NONE}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </UsageCard>
  );
}

/** 按模型：与设置 → 用量的按模型表同一套列，另加估算金额。 */
function ModelTable({
  rows,
  order,
  colorOf,
  rangeLabel,
}: {
  rows: readonly ProviderUsageRow[];
  order: readonly string[];
  colorOf: (key: string) => string;
  rangeLabel: string;
}) {
  const { t } = useTranslation();
  const items = [...groupUsageRows(rows, modelKeyOf).entries()]
    .map(([key, list]) => ({ key, kind: list[0]!.kind, model: list[0]!.model, totals: summarizeUsageRows(list) }))
    .filter((item) => item.totals.tokens > 0 || item.totals.turns > 0)
    .sort((a, b) => b.totals.tokens - a.totals.tokens || order.indexOf(a.key) - order.indexOf(b.key));
  const total = items.reduce((sum, item) => sum + item.totals.tokens, 0);
  if (items.length === 0) {
    return <p className="py-5 text-center text-13 text-[var(--text-tertiary)]">{t('providerGroup.usage.emptyRange')}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse">
        <thead>
          <tr>
            <th className={cn(TH_CLASS, FIRST_COL_CLASS, 'text-left')}>{t('usageHistory.byModel.col.model')}</th>
            <th className={TH_CLASS}>{t('usageHistory.byModel.col.totalInRange', { range: rangeLabel })}</th>
            <th className={TH_CLASS}>{t('usageHistory.byModel.col.share')}</th>
            <th className={TH_CLASS}>{t('usageHistory.byModel.col.input')}</th>
            <th className={TH_CLASS}>{t('usageHistory.byModel.col.output')}</th>
            <th className={TH_CLASS}>{t('usageHistory.byModel.col.cacheRead')}</th>
            <th className={TH_CLASS}>{t('usageHistory.byModel.col.cacheCreate')}</th>
            <th className={TH_CLASS} title={t('usageHistory.cacheHitTooltip')}>{t('usageHistory.byModel.col.hitRate')}</th>
            <th className={TH_CLASS}>{t('providerShare.manage.members.table.amount')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map(({ key, kind, model, totals }) => {
            const color = colorOf(key);
            return (
              <tr key={key} data-testid="provider-usage-model">
                <td className={cn(TD_CLASS, FIRST_COL_CLASS, 'text-left')}>
                  <span className="flex min-w-0 items-center gap-2">
                    <Swatch color={color} />
                    <span className="truncate font-medium" title={model}>{formatModelShort(model)}</span>
                    <span className="shrink-0 rounded border border-[var(--border-default)] px-1 py-px text-11 leading-[1.4] text-[var(--text-tertiary)]">
                      {kind}
                    </span>
                  </span>
                </td>
                <td className={TD_CLASS}>{formatShareTokens(totals.tokens)}</td>
                <ShareCell share={total > 0 ? totals.tokens / total : 0} color={color} />
                <td className={TD_CLASS}>{formatShareTokens(totals.inputTokens)}</td>
                <td className={TD_CLASS}>{formatShareTokens(totals.outputTokens)}</td>
                <td className={TD_CLASS}>{formatShareTokens(totals.cacheReadTokens)}</td>
                <td className={TD_CLASS}>{formatShareTokens(totals.cacheCreateTokens)}</td>
                <td className={TD_CLASS}>{totals.cacheHitRate === null ? NONE : formatUsagePercent(totals.cacheHitRate)}</td>
                <td className={TD_CLASS}>{totals.amount ? formatShareMoney(totals.amount) : NONE}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
