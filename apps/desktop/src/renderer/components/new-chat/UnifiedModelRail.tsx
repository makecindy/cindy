import { LayoutGrid, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ProviderView } from '@cindy/model-providers';

import { cn } from '@/lib/utils';

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
 *   ★收藏 → 同引擎(仅会话内,图标 = 当前会话引擎的品牌 mark)→ 全部 → 各来源供应商。
 *
 * 只有 2 格(全部 + 单一供应商)时整条 rail 不渲染 —— 一个永远只有一个可选项的筛选器
 * 是纯噪音。
 */
export function UnifiedModelRail({
  items,
  active,
  onSelect,
  providers,
  providerLabel,
  interactionDisabled = false,
}: {
  items: readonly UnifiedRailItem[];
  active: UnifiedRailFilter;
  onSelect: (item: UnifiedRailItem) => void;
  providers: readonly ProviderView[];
  providerLabel: (providerId: string) => string;
  interactionDisabled?: boolean;
}) {
  const { t } = useTranslation();
  // rail 常驻,不做「项数少就整条隐藏」——设计稿的分类栏在单来源时也在(★/全部/来源),
  // 隐藏会让收藏与快速切换不可发现(Chris 2026-08-13 实测反馈)。
  const activeKey = railItemKey(active);
  return (
    // 设计稿 .rail:宽 48(含 6px 侧距 + 1px 右分隔线)、纵向 8px、格间 2px。
    <div className="flex w-12 shrink-0 flex-col items-center gap-0.5 border-r border-[var(--model-dropdown-border)] px-1.5 py-2">
      {items.map((item) => {
        const key = railItemKey(item);
        const isActive = activeKey === key;
        const engineOption =
          item.kind === 'engine' ? agentOptionOf(engineOfAgentKind(item.agent)) : null;
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
          <button
            key={key}
            type="button"
            disabled={interactionDisabled}
            onClick={() => onSelect(item)}
            title={label}
            aria-label={label}
            aria-pressed={isActive}
            data-rail-item={key}
            className={cn(
              // 设计稿 .rail-btn:34×34、圆角 9。
              'flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] transition-colors',
              // 选中态用**反色实心块**(与浮层里的选中分段同一套表达):
              // 原先的 --surface-chip 在两种主题下都只比底色深一点点,用户看不出当前
              // 停在哪个视图 —— 会话内「同引擎过滤开着没开着」正是靠这一格判断的
              // (2026-08-13 实测反馈)。
              isActive
                ? 'bg-[var(--accent-cta-bg)] text-[var(--accent-pure-cta-fg)] shadow-[var(--shadow-menu)]'
                : 'text-[var(--text-tertiary)] hover:bg-[var(--model-item-hover)] hover:text-[var(--text-secondary)]',
              interactionDisabled && 'cursor-not-allowed opacity-50',
            )}
          >
            {item.kind === 'favorites' ? (
              // 未选中时 ☆ 用金色描边点出「这是收藏」;选中时整格已反色,跟随 currentColor。
              <Star
                size={16}
                fill={isActive ? 'currentColor' : 'none'}
                className={isActive ? undefined : 'text-[var(--favorite-star)]'}
              />
            ) : item.kind === 'engine' && engineOption ? (
              // 同引擎格用**当前会话引擎自己的品牌 mark**(规格 §1.6),用户一眼知道
              // 这个过滤器是按什么筛的。
              <engineOption.Mark size={14} className="shrink-0" />
            ) : item.kind === 'all' ? (
              <LayoutGrid size={16} />
            ) : item.kind === 'provider' ? (
              <ProviderRailMark providerId={item.providerId} providers={providers} />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
