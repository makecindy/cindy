import type { ReactNode } from 'react';
import { LayoutGrid, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ProviderView } from '@cindy/model-providers';

import { cn } from '@/lib/utils';
import { providerAccountLabel } from '@/lib/providerDisplayName';
import { Tip } from '@/components/ui/tooltip';

import { useProviderWeeklyQuota } from './useProviderWeeklyQuota';
import { formatQuotaResetCountdown } from '../status/usageCardModel';
import { agentOptionOf } from './agentOptions';
import { ProviderRailMark } from './UnifiedFlyoutHost';
import {
  engineOfAgentKind,
  railItemKey,
  type UnifiedRailFilter,
  type UnifiedRailItem,
} from './unifiedModelSelection';

/**
 * UnifiedModelRail —— 统一面板左侧的视图筛选栏(model-selector-unified §1.2 / §1.6)。
 *
 * 格位由数据派生(见 `buildUnifiedRail`),这里只负责画:
 *   ★收藏 → 同引擎(仅会话内,图标 = 当前会话引擎的品牌 mark)→ ──分隔── → 全部 → 各来源。
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
  localProviderUsage = false,
}: {
  items: readonly UnifiedRailItem[];
  active: UnifiedRailFilter;
  onSelect: (item: UnifiedRailItem) => void;
  providers: readonly ProviderView[];
  providerLabel: (providerId: string) => string;
  interactionDisabled?: boolean;
  localProviderUsage?: boolean;
}) {
  const { t } = useTranslation();
  // rail 常驻,不做「项数少就整条隐藏」——设计稿的分类栏在单来源时也在(★/全部/来源),
  // 隐藏会让收藏与快速切换不可发现(Chris 2026-08-13 实测反馈)。
  const activeKey = railItemKey(active);
  return (
    // 设计稿 .rail:宽 48(含 6px 侧距 + 1px 右分隔线)、纵向 8px、格间 2px。
    <div className="flex min-h-0 w-12 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-[var(--model-dropdown-border)] px-1.5 py-2">
      {items.map((item) => {
        const key = railItemKey(item);
        const isActive = activeKey === key;
        // 设计稿 .rail-sep:「★/同引擎」与「全部/来源」两段之间的 22px 细线。
        const separatorBefore = item.kind === 'all';
        const engineOption =
          item.kind === 'engine' ? agentOptionOf(engineOfAgentKind(item.agent)) : null;
        const provider =
          item.kind === 'provider'
            ? providers.find((entry) => entry.id === item.providerId)
            : undefined;
        const accountIdentity =
          provider?.openAiAccount?.identity?.trim() ||
          provider?.subscriptionAccount?.identity?.trim();
        const label =
          item.kind === 'favorites'
            ? t('newChat.modelSelector.unified.railFavorites')
            : item.kind === 'engine'
              ? t('newChat.modelSelector.unified.railSameEngine', {
                  agent: engineOption?.label ?? '',
                })
              : item.kind === 'all'
                ? t('newChat.modelSelector.unified.railAll')
                : providerLabel(item.providerId);
        return (
          <div key={key} className="contents">
            {separatorBefore && (
              <div
                aria-hidden
                className="my-[3px] w-[22px] border-t border-[var(--model-dropdown-border)]"
              />
            )}
            <RailButton
              label={label}
              accountIdentity={accountIdentity}
              isActive={isActive}
              itemKey={key}
              onClick={() => onSelect(item)}
              disabled={interactionDisabled}
              provider={localProviderUsage ? provider : undefined}
            >
              {item.kind === 'favorites' ? (
                // ☆ 未激活与其它格同灰(hover 提亮)—— 常亮金色会在没进收藏视图时也
                // 抢视线(2026-08-14 实机自查);激活时整格反色 + 实心星跟随 currentColor。
                <Star size={16} fill={isActive ? 'currentColor' : 'none'} />
              ) : item.kind === 'engine' && engineOption ? (
                // 同引擎格用**当前会话引擎自己的品牌 mark**(规格 §1.6),用户一眼知道
                // 这个过滤器是按什么筛的。
                <engineOption.Mark size={14} className="shrink-0" />
              ) : item.kind === 'all' ? (
                <LayoutGrid size={16} />
              ) : item.kind === 'provider' ? (
                <ProviderRailMark providerId={item.providerId} providers={providers} />
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
  isActive: boolean;
  itemKey: string;
  onClick: () => void;
  disabled: boolean;
  provider?: ProviderView;
  children: ReactNode;
}

function RailButton(props: RailButtonProps) {
  // Remote directories must never borrow this desktop's account quota.
  return props.provider ? (
    <ProviderQuotaButton {...props} provider={props.provider} />
  ) : (
    <RailButtonView {...props} />
  );
}

function ProviderQuotaButton(props: RailButtonProps & { provider: ProviderView }) {
  const quota = useProviderWeeklyQuota(props.provider);
  return <RailButtonView {...props} quota={quota} />;
}

function RailButtonView({
  label,
  accountIdentity,
  isActive,
  itemKey,
  onClick,
  disabled,
  children,
  quota,
}: RailButtonProps & {
  quota?: ReturnType<typeof useProviderWeeklyQuota>;
}) {
  const { t } = useTranslation();
  const remaining = quota ? Math.round(100 - quota.usedPercent) : null;
  const quotaLabel =
    remaining === null
      ? null
      : `${t('quotaCard.weeklyLabel')} · ${t('quotaCard.remainingPercent', { percent: remaining })}`;
  const reset = formatQuotaResetCountdown(quota?.resetsAt, Date.now(), t);
  const displayLabel = providerAccountLabel(label, accountIdentity);
  const tooltip = quotaLabel ? (
    <>
      <div>{displayLabel}</div>
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
        aria-description={quotaLabel ?? undefined}
        aria-pressed={isActive}
        data-rail-item={itemKey}
        className={cn(
          'relative flex h-[38px] w-[34px] shrink-0 flex-col items-center justify-center rounded-[9px] transition-colors',
          isActive
            ? 'bg-[var(--accent-cta-bg)] text-[var(--accent-pure-cta-fg)] shadow-[var(--shadow-menu)]'
            : 'text-[var(--text-tertiary)] hover:bg-[var(--model-item-hover)] hover:text-[var(--text-secondary)]',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        <span className="flex h-[24px] items-center justify-center">{children}</span>
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
                quota.usedPercent >= 90
                  ? 'bg-[var(--quota-bar-crit)]'
                  : quota.usedPercent > 70
                    ? 'bg-[var(--quota-bar-warn)]'
                    : 'bg-current',
              )}
              style={{ width: `${100 - quota.usedPercent}%` }}
            />
          </span>
        )}
      </button>
    </Tip>
  );
}
