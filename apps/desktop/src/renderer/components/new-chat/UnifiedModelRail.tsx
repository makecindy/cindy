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
  if (items.length <= 2) return null;
  const activeKey = railItemKey(active);
  return (
    <div className="flex w-11 shrink-0 flex-col items-center gap-0.5 border-r border-[var(--model-dropdown-border)] py-1 pr-1.5">
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
              'flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px] transition-colors',
              isActive
                ? 'bg-[var(--surface-chip)] text-[var(--model-item-text)]'
                : 'text-[var(--text-tertiary)] hover:bg-[var(--model-item-hover)]',
              item.kind === 'favorites' && isActive && 'text-[var(--favorite-star)]',
              interactionDisabled && 'cursor-not-allowed opacity-50',
            )}
          >
            {item.kind === 'favorites' ? (
              <Star size={15} fill={isActive ? 'currentColor' : 'none'} />
            ) : item.kind === 'engine' && engineOption ? (
              // 同引擎格用**当前会话引擎自己的品牌 mark**(规格 §1.6),用户一眼知道
              // 这个过滤器是按什么筛的。
              <engineOption.Mark size={14} className="shrink-0" />
            ) : item.kind === 'all' ? (
              <LayoutGrid size={15} />
            ) : item.kind === 'provider' ? (
              <ProviderRailMark providerId={item.providerId} providers={providers} />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
