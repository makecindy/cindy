import { localizedModelDescription } from '@/lib/modelDescriptions';
import { localizedModelName } from '@/lib/modelDisplayNames';
import { Lock, SlidersHorizontal, Star, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';

import type { ProviderView, UnifiedModelEntry } from '@cindy/model-providers';

import type { AgentKind } from '@/hooks/useAgentCapabilities';
import { cn } from '@/lib/utils';
import type { Effort } from '@/lib/userPreferences.types';

import { PriceFreeBadge, PriceTierMarks, type UnifiedRowPriceDisplay } from './priceTierMarks';

import { agentOptionOf } from './agentOptions';
// 图标规则(模型条目 icon 优先、缺省回落来源供应商标)只有一份实现,复用它而不是抄一份。
import { ModelIconMark } from './ModelSelector';
import { anchorKey, type UnifiedAnchor, type UnifiedRowConfig } from './unifiedModelSelection';

/**
 * 行内价格展示(设计稿 v4 定稿的 F 样式)的类型与档串组件已抽到 `./priceTierMarks`,
 * 与设置页 → 模型列表共用一份实现。这里 re-export 供既有 import 路径继续可用。
 */
export type { UnifiedRowPriceDisplay } from './priceTierMarks';

/** 整格点亮(classic,Chris 2026-08-14 第二版):亮几格 = round(实付比例 × 格数),至少 1 格。 */
const litWholeMarks = (paidPct: number, tier: 1 | 2 | 3): number =>
  Math.min(tier, Math.max(1, Math.round((paidPct / 100) * tier)));
/** 单行(双行布局):L1 图标 · 名称 · ☆ · 三元组 · 勾;L2 一句描述。 */
export function UnifiedModelRow({
  entry,
  anchor,
  config,
  selected,
  active,
  isFavoriteRow,
  justFavorited,
  interactionDisabled,
  effortLabelOf,
  providers,
  onReveal,
  onSelect,
  onStar,
  onRevealForKeyboard,
  priceDisplay,
  configurationEnabled = true,
  paymentRequired = false,
  paymentRequiredLabel,
  paymentRequiredUnlockLabel,
  onPaymentRequired,
}: {
  entry: UnifiedModelEntry;
  anchor: UnifiedAnchor;
  config: UnifiedRowConfig;
  selected: boolean;
  active: boolean;
  isFavoriteRow: boolean;
  justFavorited: boolean;
  interactionDisabled: boolean;
  effortLabelOf: (agent: AgentKind, effort: Effort) => string;
  providers: readonly ProviderView[];
  onReveal: (anchor: UnifiedAnchor, element: HTMLElement, toggle?: boolean) => void;
  onSelect: () => void;
  onStar: () => void;
  /** Keyboard opening also moves focus into the configuration. */
  onRevealForKeyboard: (anchor: UnifiedAnchor, element: HTMLElement) => void;
  /** 行内价格展示;不传 = 无报价。字段语义见 `UnifiedRowPriceDisplay`。 */
  priceDisplay?: UnifiedRowPriceDisplay;
  configurationEnabled?: boolean;
  /** 付费锁定行保留在原位置，可聚焦但不能选中、收藏或打开配置。 */
  paymentRequired?: boolean;
  paymentRequiredLabel?: string;
  paymentRequiredUnlockLabel?: string;
  onPaymentRequired?: () => void;
}) {
  const { t } = useTranslation();
  const displayName = localizedModelName(entry.displayName, t);
  const description = localizedModelDescription({ id: entry.modelId, group: entry.group }, t);
  const provider = providers.find((item) => item.id === entry.providerId);
  const priceSymbol = priceDisplay?.symbol ?? '$';
  const engineOption = agentOptionOf(config.engine);
  const openConfig = (element: HTMLElement, toggle = false) => {
    if (!paymentRequired) onReveal(anchor, element, toggle);
  };
  const tripleTitle = `${engineOption.label}${
    configurationEnabled && config.effort ? ` · ${effortLabelOf(config.agent, config.effort)}` : ''
  }${configurationEnabled && config.fast ? ' · Fast' : ''}`;
  const paymentRequiredActionLabel = paymentRequired
    ? [displayName, paymentRequiredUnlockLabel ?? paymentRequiredLabel]
        .filter(Boolean)
        .join(' · ')
    : undefined;

  // 行根节点统一处理选中、浮层与键盘，内嵌按钮阻止事件冒泡。
  const rowRootProps = {
    role: 'option' as const,
    'aria-selected': selected,
    // 付费行不能被选为模型，但它本身是“查看付费说明”的可执行入口；只有真正
    // 阻断全部交互的状态才声明 disabled，避免读屏软件抑制 Enter / Space 激活。
    'aria-disabled': interactionDisabled ? true : undefined,
    'aria-label': paymentRequiredActionLabel,
    // ← 开配置浮层是这一行唯一的键盘入口,不声明就只有摸索得到(读屏用户尤甚)。
    'aria-keyshortcuts': paymentRequired ? undefined : 'ArrowLeft',
    tabIndex: interactionDisabled ? -1 : 0,
    'data-model-selected': selected ? ('true' as const) : undefined,
    'data-unified-anchor': anchorKey(anchor),
    onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => {
      if (interactionDisabled || paymentRequired) return;
      event.preventDefault();
      openConfig(event.currentTarget);
    },
    onClick: () => {
      if (interactionDisabled) return;
      if (paymentRequired) onPaymentRequired?.();
      else onSelect();
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget || interactionDisabled) return;
      if (paymentRequired) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onPaymentRequired?.();
        }
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        onRevealForKeyboard(anchor, event.currentTarget);
        return;
      }
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onSelect();
    },
  };

  const starButton = (
    <button
      type="button"
      disabled={interactionDisabled || paymentRequired}
      onClick={(event) => {
        event.stopPropagation();
        onStar();
      }}
      title={
        isFavoriteRow
          ? t('newChat.modelSelector.unified.removeFavorite')
          : t('newChat.modelSelector.unified.addFavorite')
      }
      aria-label={
        isFavoriteRow
          ? t('newChat.modelSelector.unified.removeFavorite')
          : t('newChat.modelSelector.unified.addFavorite')
      }
      className={cn(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] transition-opacity',
        isFavoriteRow || justFavorited
          ? 'text-[var(--favorite-star)] opacity-100'
          : 'text-[var(--text-tertiary)] opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-[var(--favorite-star)]',
      )}
    >
      <Star size={14} fill={isFavoriteRow || justFavorited ? 'currentColor' : 'none'} />
    </button>
  );
  const customizeButton = (
    <button
      type="button"
      data-row-customize
      aria-expanded={active}
      aria-haspopup="dialog"
      disabled={interactionDisabled || paymentRequired}
      onClick={(event) => {
        event.stopPropagation();
        const row = event.currentTarget.closest('[data-unified-anchor]');
        if (row instanceof HTMLElement) openConfig(row, true);
      }}
      title={t('newChat.modelSelector.unified.customize')}
      aria-label={t('newChat.modelSelector.unified.customize')}
      className={cn(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] transition-opacity',
        active
          ? 'text-[var(--text-secondary)] opacity-100'
          : 'text-[var(--text-tertiary)] opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-[var(--text-secondary)]',
      )}
    >
      <SlidersHorizontal size={14} />
    </button>
  );
  const paymentRequiredBadge =
    paymentRequired && paymentRequiredLabel ? (
      <span
        data-payment-required-badge
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--surface-chip)] px-2 py-[1px] text-10 font-normal leading-[1.45] text-[var(--text-secondary)]"
      >
        <Lock size={10} />
        {paymentRequiredLabel}
      </span>
    ) : null;
  const paymentRequiredUnlock =
    paymentRequired && paymentRequiredUnlockLabel ? (
      <span
        data-payment-required-unlock
        className="invisible shrink-0 select-none text-11 font-medium text-[var(--text-secondary)] group-hover/row:visible group-focus-within/row:visible"
      >
        {paymentRequiredUnlockLabel}
      </span>
    ) : null;

  return (
    <div
      {...rowRootProps}
      className={cn(
        'group/row flex w-full cursor-pointer flex-col rounded-[10px] px-2.5 py-2 transition-colors duration-100',
        'hover:bg-[var(--model-item-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        (selected || active) && 'bg-[var(--model-item-hover)]',
        (interactionDisabled || paymentRequired) && 'cursor-not-allowed opacity-50',
      )}
    >
      <div className="flex items-center gap-2">
        {/* 设计稿 .mark:18×18 定位盒(图标本体 13-17px 居中)。没有这个盒,名字起点
            随图标实际宽度浮动,第二行描述的 26px 缩进(18+8)就对不上第一行的名字。 */}
        <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
          <ModelIconMark
            {...(entry.icon !== undefined ? { icon: entry.icon } : {})}
            providerId={entry.providerId}
            {...(provider?.name !== undefined ? { name: provider.name } : {})}
            {...(provider?.routing !== undefined ? { routing: provider.routing } : {})}
            {...(provider?.logoKind !== undefined ? { logoKind: provider.logoKind } : {})}
            colorClass="text-[var(--text-secondary)]"
            withMargin={false}
          />
        </span>
        <span
          // 布局同设计稿 .m-name:内容宽、不 grow —— 徽标/钱串紧贴模型名左排,
          // 右侧三元组由 ml-auto 推到最右;空间不足时名字先收缩截断,title 给全名。
          // 字号/字重**不跟设计稿的 13.5px/normal**,按旧选择器恢复(text-14 + medium):
          // Chris 2026-08-13 实测裁决 —— 名字变小去粗后与描述行难以区分。
          title={displayName}
          className="min-w-0 truncate text-14 font-medium leading-5 text-[var(--model-item-text)]"
        >
          {displayName}
        </span>
        {priceDisplay?.kind === 'free' && (
          <PriceFreeBadge label={t('newChat.modelSelector.pricing.free')} />
        )}
        {priceDisplay?.kind === 'tier' && priceDisplay.tier !== undefined && (
          <PriceTierMarks
            litOf={litWholeMarks}
            formatClipPct={String}
            exposeLit={false}
            priceDisplay={priceDisplay}
            symbol={priceSymbol}
            tier={priceDisplay.tier}
          />
        )}
        {starButton}
        {configurationEnabled && customizeButton}
        {/* 常驻三元组:引擎图标 + 推理强度 + ⚡。所有行同构,自定义行整组提亮一档。
            设计稿 .l1-right:margin-left auto 把右侧簇推到最右,左侧簇贴名字排。 */}
        <span data-model-row-meta className="ml-auto flex shrink-0 items-center gap-2">
          <span
            title={tripleTitle}
            data-unified-triple
            // 颜色恒定,不随「已自定义」提亮(Chris 2026-08-16 裁决,所有行一致)。
            className="flex max-w-[118px] shrink-0 items-center gap-1 truncate text-12 text-[var(--text-tertiary)]"
          >
            <engineOption.Mark size={12} className="shrink-0" />
            {configurationEnabled && config.effort && (
              <span className="truncate">{effortLabelOf(config.agent, config.effort)}</span>
            )}
            {configurationEnabled && config.fast && (
              <Zap
                size={11}
                fill="currentColor"
                className="shrink-0"
                aria-label={t('newChat.modelSelector.meta.fastBadge')}
              />
            )}
          </span>
          {paymentRequiredUnlock}
          {paymentRequiredBadge}
        </span>
        {/* 行尾不放 ✅(Chris 2026-08-13 裁决:选中已有整行底色,再加勾是重复信号,
            还平白吃掉一列宽度);选中态语义由 aria-selected 承载。 */}
      </div>
      {description && (
        // 单行截断 + title 全文;宽度上限收紧到约等于最长模型名的量级(~30ch)——
        // 描述是辅助信息,不该比模型名更长地占据视线(2026-08-13 实测反馈)。
        // 颜色按旧选择器恢复用 --text-secondary(同日裁决:tertiary 太淡看不清;
        // 与名字的区分靠名字的 14px/medium,不靠把描述压淡)。
        <div
          title={description}
          className="min-w-0 max-w-[30ch] truncate pl-[26px] pt-px text-12 leading-[1.4] text-[var(--text-secondary)]"
        >
          {description}
        </div>
      )}
    </div>
  );
}
