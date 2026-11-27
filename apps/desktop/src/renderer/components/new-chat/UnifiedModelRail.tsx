import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { isDarkBackground } from '../../../shared/theme-import/color';
import { themeService } from '@/themes/theme-service';
import { isProviderShareAgentDeviceId } from '../../../shared/providerShare';
import { useProviderShareWeeklyQuota } from '@/features/provider-share/useProviderShareWeeklyQuota';
import { History, LayoutGrid, Share2, Sparkles, Star } from 'lucide-react';
import { PluginEngineIcon } from '@/components/icons/PluginEngineIcon';
import { useTranslation } from 'react-i18next';
import { ModelPickerAccountBoundary, useModelPickerAccount } from './ModelPickerAccount';
import { ModelPoolQuotaDetails, useModelPoolQuota, type ModelPoolQuota } from './ModelPoolQuota';

import type { ProviderView } from '@cindy/model-providers';

import { cn } from '@/lib/utils';
import { providerAccountLabel } from '@/lib/providerDisplayName';
import { stopWheelPropagation } from '@/lib/stopWheelPropagation';
import { Tip } from '@/components/ui/tooltip';

import {
  useProviderWeeklyQuota,
  useProviderUsageSnapshots,
  useWeeklyQuotaFromSnapshots,
  type ProviderGroupUsageOf,
  type ProviderUsageScope,
} from './useProviderWeeklyQuota';
import { formatQuotaResetCountdown } from '../status/usageCardModel';
import { agentOptionOf } from './agentOptions';
import { ProviderRailMark } from './UnifiedFlyoutHost';
import { RemoteSourceMark } from '@/components/icons/RemoteSourceMark';
import {
  engineOfAgentKind,
  railItemDeviceId,
  railItemKey,
  type DeviceModelGroupsRailTab,
  type PluginEngineRailTab,
  type UnifiedRailFilter,
  type UnifiedRailItem,
} from './unifiedModelSelection';
import { QUOTA_FILL_COLOR_CLASSES, quotaSeverity } from '../status/QuotaBar';
import { RouteSourceMark } from '@/components/icons/RouteSourceMark';
import { isSourceRouteProviderId } from '@/features/model-groups/sourceRouteProviders';
import { OWN_ROUTES_PROVIDER_ID } from '../../../shared/auxiliaryModelSettings';

/**
 * UnifiedModelRail —— 统一面板左侧的视图筛选栏(model-selector-unified §1.2 / §1.6)。
 *
 * 格位由数据派生(见 `buildUnifiedRail`),这里只负责画:
 *   最近 → ★收藏 → 同引擎(仅会话内,图标 = 当前会话引擎的品牌 mark)→ ──分隔── → 全部 → 各来源
 *   → (新任务草稿)──分隔── → 其他电脑上的供应商(带信号波纹的 Logo,每台电脑一段)。
 * rail 常驻(2026-08-13 裁决),分隔线与设计稿 .rail-sep 同构:「个人钉的」与
 * 「目录本身的视图」两段之间画一条 22px 细线。
 */
export function UnifiedModelRail({
  items,
  active,
  onSelect,
  providers,
  providerLabel,
  interactionDisabled = false,
  providerUsage = null,
  providerGroupUsage,
  remoteSources,
  pluginEngineTabs,
  modelGroupDeviceTabs,
  routeUsageMember,
}: {
  /** 合并整个供应商的路由那一格显示谁的额度；缺省时那一格不显示额度。 */
  routeUsageMember?: (providerId: string) => { provider: ProviderView; agentDeviceId: string | null } | null;
  /** 插件引擎格的名字与图标，按 providerId (与所在电脑)对应 `plugin-engine` 格。 */
  pluginEngineTabs?: readonly PluginEngineRailTab[];
  /** 另一台电脑的「模型组」格的名字(悬停与读屏)。 */
  modelGroupDeviceTabs?: readonly DeviceModelGroupsRailTab[];
  items: readonly UnifiedRailItem[];
  active: UnifiedRailFilter;
  onSelect: (item: UnifiedRailItem) => void;
  providers: readonly ProviderView[];
  providerLabel: (providerId: string) => string;
  interactionDisabled?: boolean;
  /** Whose account usage the directory may show; null hides it. */
  providerUsage?: ProviderUsageScope | null;
  /** 供应商组那一格的用量读谁(provider-groups.md §10);缺省 = 都按格所在目录读。 */
  providerGroupUsage?: ProviderGroupUsageOf;
  /**
   * 可选远程 Agent 的供应商格。localProviders 属于任务所在电脑，远控时未必是控制端本机；
   * 图标 / 名字 / 用量都跟随该电脑，不随面板正在浏览的目录切换。
   */
  remoteSources?: {
    localProviders: readonly ProviderView[];
    /** localProviders 所在电脑；null / 缺省 = 控制端本机。 */
    localUsageDeviceId?: string | null;
    localProviderLabel: (providerId: string) => string;
    providersOf: (deviceId: string) => readonly ProviderView[];
    labelOf: (deviceId: string, providerId: string) => string;
  };
}) {
  const { t } = useTranslation();
  // rail 常驻,不做「项数少就整条隐藏」——设计稿的分类栏在单来源时也在(★/全部/来源),
  // 隐藏会让收藏与快速切换不可发现(Chris 2026-08-13 实测反馈)。
  const activeKey = railItemKey(active);
  return (
    // 设计稿 .rail:宽 48(含 6px 侧距 + 1px 右分隔线)、纵向 8px、格间 2px。
    // 与侧栏窄图标栏一致：滚动条不占宽度，避免挤压按钮并触发横向溢出。
    // onWheel:模态对话框里 react-remove-scroll 会拦下浮层的滚轮,rail 又藏着
    // 滚动条,不放行的话供应商一多就完全滚不到(stopWheelPropagation 注释有全景)。
    <div
      className="flex min-h-0 w-12 shrink-0 flex-col items-center gap-0.5 overflow-x-hidden overflow-y-auto scrollbar-hide border-r border-[var(--model-dropdown-border)] px-1.5 py-2"
      onWheel={stopWheelPropagation}
    >
      {items.map((item, index) => {
        const key = railItemKey(item);
        const isActive = activeKey === key;
        // 设计稿 .rail-sep:「★/同引擎」与「全部/来源」两段之间的 22px 细线;
        // 远程供应商每台电脑一段,段首同样一条细线。
        const previous = index > 0 ? items[index - 1] : undefined;
        // 另一台电脑上的插件引擎格与那台的供应商格同属一段。
        const itemDeviceId = railItemDeviceId(item);
        // 路由一组(「智能路由」那一格 + 合并了整个供应商的路由)与后面的普通供应商之间也画一条：
        // 混在一排品牌图标里分不出哪些是路由(2026-11-25 用户反馈)。
        const routeItem = (candidate: UnifiedRailItem | undefined) => !!candidate && (
          (candidate.kind === 'model-groups' && !candidate.deviceId)
          || (candidate.kind === 'provider' && isSourceRouteProviderId(candidate.providerId)));
        const separatorBefore =
          item.kind === 'all' ||
          (itemDeviceId !== null && (!previous || railItemDeviceId(previous) !== itemDeviceId)) ||
          (itemDeviceId === null && routeItem(previous) && !routeItem(item));
        const engineTab = item.kind === 'plugin-engine'
          ? pluginEngineTabs?.find((tab) => tab.providerId === item.providerId && (tab.deviceId ?? null) === (item.deviceId ?? null))
          : undefined;
        const engineOption =
          item.kind === 'engine' ? agentOptionOf(engineOfAgentKind(item.agent)) : null;
        const railProviders =
          item.kind === 'remote-provider'
            ? (remoteSources?.providersOf(item.deviceId) ?? [])
            : (remoteSources?.localProviders ?? providers);
        const provider =
          item.kind === 'provider' || item.kind === 'remote-provider'
            ? railProviders.find((entry) => entry.id === item.providerId)
            : undefined;
        // 普通格读任务所在电脑，远程格读指定电脑；两者都不借用当前浏览目录的归属。
        const usageDeviceId =
          item.kind === 'remote-provider'
            ? item.deviceId
            : remoteSources
              ? (remoteSources.localUsageDeviceId ?? null)
              : (providerUsage?.deviceId ?? null);
        // 供应商组那一格代表组里的几台电脑：任务正经组在某台运行时读那台的账号(与输入框下方的用量
        // 一致)，还没分到电脑时不显示某一台的配额；悬停多写一句说明是哪台。
        const groupUsage =
          provider && (item.kind === 'provider' || item.kind === 'remote-provider')
            ? (providerGroupUsage?.(
                item.kind === 'remote-provider' ? item.deviceId : null,
                item.providerId,
              ) ?? null)
            : null;
        const usageProvider = groupUsage
          ? groupUsage.kind === 'running'
            ? groupUsage.usage?.provider
            : undefined
          : provider;
        const accountIdentity =
          usageProvider?.openAiAccount?.identity?.trim() ||
          usageProvider?.subscriptionAccount?.identity?.trim();
        const groupNote = groupUsage
          ? groupUsage.kind !== 'running'
            ? t('newChat.modelSelector.unified.providerGroupUnassigned')
            : groupUsage.deviceName === null
              ? t('newChat.modelSelector.unified.providerGroupRunningHere')
              : t('newChat.modelSelector.unified.providerGroupRunningOn', {
                  device: groupUsage.deviceName,
                })
          : undefined;
        // 合并整个供应商的路由：额度按排在最前、没停用的那个成员显示，悬停写明是谁的(它自己没有账号)。
        const routeMember = item.kind === 'provider' && isSourceRouteProviderId(item.providerId)
          ? routeUsageMember?.(item.providerId) ?? null : null;
        const routeMemberShare = routeMember && isProviderShareAgentDeviceId(routeMember.agentDeviceId) ? routeMember.agentDeviceId : null;
        const routeMemberName = routeMember
          ? (routeMember.agentDeviceId ? remoteSources?.labelOf(routeMember.agentDeviceId, routeMember.provider.id) : undefined)
            ?? routeMember.provider.name
          : null;
        const label =
          item.kind === 'recent'
            ? t('newChat.modelSelector.unified.railRecent')
            : item.kind === 'favorites'
              ? t('newChat.modelSelector.unified.railFavorites')
              : item.kind === 'engine'
                ? t('newChat.modelSelector.unified.railSameEngine', {
                    agent: engineOption?.label ?? '',
                  })
                : item.kind === 'all'
                  ? t('newChat.modelSelector.unified.railAll')
                  : item.kind === 'model-groups' && item.deviceId
                    ? t('modelGroups.picker.deviceTitle', {
                        device: modelGroupDeviceTabs?.find((tab) => tab.deviceId === item.deviceId)?.name ?? '',
                      })
                  : item.kind === 'model-groups'
                    ? t('modelGroups.title')
                  : item.kind === 'plugin-engine'
                    ? (engineTab?.name ?? t('newChat.pluginEngines.genericName'))
                  : item.kind === 'remote-provider'
                    ? (remoteSources?.labelOf(item.deviceId, item.providerId) ?? item.providerId)
                    : (remoteSources?.localProviderLabel ?? providerLabel)(item.providerId);
        return (
          <div key={key} className="contents">
            {separatorBefore && (
              <div
                aria-hidden
                className="my-[3px] w-[22px] border-t border-[var(--model-dropdown-border)]"
              />
            )}
            <RailButton
              shareDeviceId={
                routeMember
                  ? routeMemberShare
                  : (item.kind === 'provider' || item.kind === 'remote-provider') &&
                      isProviderShareAgentDeviceId(usageDeviceId)
                    ? usageDeviceId
                    : null
              }
              label={label}
              accountIdentity={routeMember ? undefined : accountIdentity}
              {...(routeMemberName
                ? { groupNote: t('modelGroups.picker.quotaOf', { name: routeMemberName }) }
                : groupNote ? { groupNote } : {})}
              selectedUpload={isActive && !!provider?.customIcon}
              isActive={isActive}
              itemKey={key}
              onClick={() => onSelect(item)}
              disabled={interactionDisabled}
              provider={providerUsage ? (routeMember ? (routeMemberShare ? undefined : routeMember.provider) : usageProvider) : undefined}
              usageDeviceId={
                routeMember
                  ? routeMember.agentDeviceId ?? usageDeviceId
                  : groupUsage?.kind === 'running' && groupUsage.usage
                    ? groupUsage.usage.scope.deviceId
                    : usageDeviceId
              }
            >
              {item.kind === 'recent' ? (
                // 最近格用 History(时钟 + 回拨箭头)表达「用过的时间序」,与 ★ 的「钉住」
                // 语义区分;与其它非激活格同灰,hover 提亮,不抢视线。
                <History size={16} />
              ) : item.kind === 'favorites' ? (
                // ☆ 未激活与其它格同灰(hover 提亮)—— 常亮金色会在没进收藏视图时也
                // 抢视线(2026-08-14 实机自查);激活时整格反色 + 实心星跟随 currentColor。
                <Star size={16} fill={isActive ? 'currentColor' : 'none'} />
              ) : item.kind === 'engine' && engineOption ? (
                // 同引擎格用**当前会话引擎自己的品牌 mark**(规格 §1.6),用户一眼知道
                // 这个过滤器是按什么筛的。
                <engineOption.Mark size={14} className="shrink-0" />
              ) : item.kind === 'all' ? (
                <LayoutGrid size={16} />
              ) : item.kind === 'model-groups' && item.deviceId ? (
                // 另一台电脑的模式：与远程供应商格同一个信号波纹。
                <RemoteSourceMark markSize={16}>
                  <Sparkles size={16} />
                </RemoteSourceMark>
              ) : item.kind === 'model-groups' ? (
                <Sparkles size={16} />
              ) : item.kind === 'plugin-engine' && item.deviceId ? (
                // 另一台电脑上的引擎：与远程供应商格同一个信号波纹。
                <RemoteSourceMark markSize={16}>
                  <PluginEngineIcon size={16} iconDataUrl={engineTab?.iconDataUrl} className="" />
                </RemoteSourceMark>
              ) : item.kind === 'plugin-engine' ? (
                // 和供应商格一样画来源自己的标：提供引擎的插件图标(没有时画通用拼图，跟随格的前景色)。
                <PluginEngineIcon
                  size={16}
                  iconDataUrl={engineTab?.iconDataUrl}
                  className=""
                />
              ) : item.kind === 'provider' && item.providerId === OWN_ROUTES_PROVIDER_ID ? (
                // 自己排的路由合在一格(辅助模型)：与「智能路由」格同一个图形，不叠合并供应商的角标。
                <Sparkles size={16} />
              ) : item.kind === 'provider' && isSourceRouteProviderId(item.providerId) ? (
                // 合并了整个供应商的路由：品牌图形 + 路由角标，不与普通供应商混淆。
                <RouteSourceMark markSize={16}>
                  <ProviderRailMark providerId={item.providerId} providers={railProviders} />
                </RouteSourceMark>
              ) : item.kind === 'provider' ? (
                <ProviderRailMark providerId={item.providerId} providers={railProviders} />
              ) : item.kind === 'remote-provider' ? (
                !item.providerId && isProviderShareAgentDeviceId(item.deviceId) ? <Share2 size={16} /> : (
                  <RemoteSourceMark>
                    <ProviderRailMark providerId={item.providerId} providers={railProviders} />
                  </RemoteSourceMark>
                )
              ) : null}
            </RailButton>
          </div>
        );
      })}
    </div>
  );
}

interface RailButtonProps {
  label: string;
  accountIdentity?: string;
  /** 供应商组那一格:用量读的是哪台(或还没分到电脑),账号名跟在这一句后面。 */
  groupNote?: string;
  selectedUpload: boolean;
  isActive: boolean;
  itemKey: string;
  onClick: () => void;
  disabled: boolean;
  provider?: ProviderView;
  usageDeviceId: string | null;
  shareDeviceId?: string | null;
  children: ReactNode;
}

function RailButton(props: RailButtonProps) {
  // Quota follows the directory's owner: remote directories read that device's mirrors
  // and must never borrow this desktop's account quota.
  if (props.shareDeviceId) {
    return <SharedProviderQuotaButton {...props} shareDeviceId={props.shareDeviceId} />;
  }
  // Groups already resolve an executing member. Keep that member's runtime
  // mirror, rather than previewing a new allocation on the same computer.
  if (props.provider && props.groupNote)
    return <ProviderQuotaButton {...props} provider={props.provider} />;
  return props.provider ? (
    <ModelPickerAccountBoundary
      providerId={props.provider.auth?.method === 'oauth' ? props.provider.id : ''}
      subscriptionPool={!!props.provider.subscriptionPool || !!props.provider.subscriptionAccountPool}
      deviceId={props.usageDeviceId}
    >
      <ProviderQuotaButton {...props} provider={props.provider} />
    </ModelPickerAccountBoundary>
  ) : (
    <RailButtonView {...props} />
  );
}

function SharedProviderQuotaButton(props: RailButtonProps & { shareDeviceId: string }) {
  const quota = useProviderShareWeeklyQuota(props.shareDeviceId);
  return <RailButtonView {...props} quota={quota} />;
}

function ProviderQuotaButton(props: RailButtonProps & { provider: ProviderView }) {
  const { t } = useTranslation();
  const pickerAccount = useModelPickerAccount(props.provider.id, props.usageDeviceId);
  const usage = useProviderUsageSnapshots(props.provider, { deviceId: props.usageDeviceId ?? null });
  const quota = useWeeklyQuotaFromSnapshots(usage);
  const pool = useModelPoolQuota(props.provider.id, props.usageDeviceId, usage);
  const identity = pool?.isPool
    ? t('providerGroup.member.accountCount', { count: pool.members.length })
    : pool && pickerAccount ? pool.members[0].identity
    : pickerAccount
      ? pickerAccount.identity
      : props.accountIdentity;
  const displayedQuota = pool
    ? pool.average === null
      ? null
      : {
          usedPercent: 100 - pool.average,
          resetsAt: pool.isPool ? null : pool.members[0]?.resetsAt ?? null,
        }
    : quota;
  return (
    <RailButtonView {...props} accountIdentity={identity} quota={displayedQuota} pool={pool} />
  );
}

function RailButtonView({
  label,
  accountIdentity,
  groupNote,
  isActive,
  itemKey,
  onClick,
  disabled,
  children,
  selectedUpload,
  quota,
  pool,
}: RailButtonProps & {
  quota?: ReturnType<typeof useProviderWeeklyQuota>;
  pool?: ModelPoolQuota | null;
}) {
  const { t } = useTranslation();
  const mark = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = mark.current;
    if (!el || !selectedUpload) return;
    const applyPalette = () => {
      // Read the destination token, not an intermediate frame of the button transition.
      // Chromium resolves CSS color expressions and composites translucent theme colors.
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      canvas.hidden = true;
      canvas.style.backgroundColor = 'var(--accent-cta-bg)';
      const button = el.parentElement!;
      button.append(canvas);
      const layers = [getComputedStyle(canvas).backgroundColor];
      // A translucent button shows the rail and panel surfaces underneath.
      for (let parent = button.parentElement; parent && !layers[0].startsWith('rgb('); parent = parent.parentElement) {
        layers.unshift(getComputedStyle(parent).backgroundColor);
      }
      if (!layers[0].startsWith('rgb(')) {
        canvas.style.backgroundColor = 'Canvas';
        layers.unshift(getComputedStyle(canvas).backgroundColor);
      }
      canvas.remove();
      for (const color of layers) {
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
      }
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      el.style.colorScheme = isDarkBackground({ r, g, b }) ? 'dark' : 'light';
    };
    applyPalette();
    const unsubscribe = themeService.onDidChangeTheme(applyPalette);
    return () => {
      unsubscribe();
      el.style.removeProperty('color-scheme');
    };
  }, [selectedUpload]);
  const remaining = quota ? Math.round(100 - quota.usedPercent) : null;
  const quotaLabel = pool?.hasAccountDetails
    ? pool.label
    : remaining === null
      ? null
      : `${t('quotaCard.weeklyLabel')} · ${t('quotaCard.remainingPercent', { percent: remaining })}`;
  const reset = formatQuotaResetCountdown(quota?.resetsAt, Date.now(), t);
  // 供应商组：组名不带某一台的账号，账号跟在「当前在 {电脑} 上运行」后面。
  const displayLabel = groupNote ? label : providerAccountLabel(label, accountIdentity);
  const note = groupNote ? providerAccountLabel(groupNote, accountIdentity) : null;
  const accountLines = pool?.hasAccountDetails ? pool.members.map((member) =>
    [
      member.identity,
      member.remaining === null
        ? '—'
        : `${t('quotaCard.weeklyLabel')} · ${t('quotaCard.remainingPercent', { percent: member.remaining })}`,
      member.fiveHourLabel,
      member.recovery,
      member.reset,
      member.resetSoon ? t('subscriptionAccounts.quotaResetSoon') : null,
    ]
      .filter(Boolean)
      .join(' · '),
  ) : undefined;
  const description = [note, quotaLabel, ...(!pool?.hasAccountDetails ? [pool?.warningLabel] : []), ...(accountLines ?? [])].filter(Boolean).join(' · ');
  const tooltip = pool && (pool.hasAccountDetails || pool.warning) ? (
    <>
      <div>{displayLabel}</div>
      {/* 标题已含完整账号时明细不再重复；供应商组标题不带账号、生成名截断到 50 字时只有半个账号，照常列出。 */}
      <ModelPoolQuotaDetails pool={pool} accountInTitle={!groupNote && !!accountIdentity && displayLabel.includes(accountIdentity)} />
    </>
  ) : quotaLabel || note ? (
    <>
      <div>{displayLabel}</div>
      {note && <div>{note}</div>}
      {quotaLabel && <div>{quotaLabel}</div>}
      {reset && <div>{reset}</div>}
    </>
  ) : (
    displayLabel
  );
  return (
    <Tip
      text={tooltip}
      side="right"
      contentClassName="max-w-[360px] break-words"
      disabled={disabled}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        aria-label={displayLabel}
        aria-description={description || undefined}
        aria-pressed={isActive}
        data-rail-item={itemKey}
        className={cn(
          'relative flex h-[38px] w-[34px] shrink-0 flex-col items-center justify-center rounded-lg transition-colors',
          isActive
            ? 'bg-[var(--accent-cta-bg)] text-[var(--accent-pure-cta-fg)]'
            : 'text-[var(--text-tertiary)] hover:bg-[var(--model-item-hover)] hover:text-[var(--text-secondary)]',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        <span ref={mark} className="flex h-[24px] items-center justify-center">{children}</span>
        {(pool?.warning || !!pool?.resetSoonCount) && (
          <span
            aria-hidden
            data-pool-reset-soon={pool?.resetSoonCount ? '' : undefined}
            data-quota-warning={pool?.warning?.kind}
            className={cn('pointer-events-none absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full',
              pool?.warning?.kind === 'limited' ? 'bg-[var(--quota-bar-crit)]' : 'bg-[var(--warning-fg)]')}
          />
        )}
        {quota && (
          <span
            aria-hidden="true"
            data-weekly-remaining={remaining}
            className="absolute bottom-[3px] h-[3px] w-[22px] overflow-hidden rounded-full"
            style={{
              color: isActive
                ? undefined
                : 'color-mix(in srgb, var(--text-primary) 40%, var(--text-secondary))',
              backgroundColor: 'color-mix(in srgb, currentColor 18%, transparent)',
            }}
          >
            <span
              className={cn(
                'block h-full rounded-full',
                quotaSeverity(quota.usedPercent) === 'normal'
                  ? 'bg-current'
                  : QUOTA_FILL_COLOR_CLASSES[quotaSeverity(quota.usedPercent)],
              )}
              style={{ width: `${100 - quota.usedPercent}%` }}
            />
          </span>
        )}
      </button>
    </Tip>
  );
}
