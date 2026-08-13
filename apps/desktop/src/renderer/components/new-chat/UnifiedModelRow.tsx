import { Check, Star, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PointerEvent as ReactPointerEvent } from 'react';

import type { ProviderView, UnifiedModelEntry } from '@cindy/model-providers';

import type { AgentKind } from '@/hooks/useAgentCapabilities';
import { cn } from '@/lib/utils';
import type { Effort } from '@/lib/userPreferences.types';

import { EFFORT_TIER_COLORS, PRICE_TIER_COLORS } from '@/themes/effortTierColors';

import { agentOptionOf } from './agentOptions';
// 图标规则(模型条目 icon 优先、缺省回落来源供应商标)只有一份实现,复用它而不是抄一份。
import { ModelIconMark } from './ModelSelector';
import { anchorKey, type UnifiedAnchor, type UnifiedRowConfig } from './unifiedModelSelection';

/** 单行(双行布局):L1 图标 · 名称 · ☆ · 三元组 · 勾;L2 一句描述。 */
export function UnifiedModelRow({
  entry,
  anchor,
  config,
  selected,
  active,
  isFavoriteRow,
  emphasizeTriple,
  justFavorited,
  interactionDisabled,
  effortLabelOf,
  providers,
  onReveal,
  onLeave,
  onBlurAway,
  onSelect,
  onStar,
  onRevealForKeyboard,
  priceDisplay,
  defaultBadge,
  subscriptionLabel,
}: {
  entry: UnifiedModelEntry;
  anchor: UnifiedAnchor;
  config: UnifiedRowConfig;
  selected: boolean;
  active: boolean;
  isFavoriteRow: boolean;
  emphasizeTriple: boolean;
  justFavorited: boolean;
  interactionDisabled: boolean;
  effortLabelOf: (agent: AgentKind, effort: Effort) => string;
  providers: readonly ProviderView[];
  onReveal: (anchor: UnifiedAnchor, element: HTMLElement) => void;
  /** pointerleave —— 带事件:调用方按「往哪边走」决定 grace 长短(去浮层的路上要更宽容)。 */
  onLeave: (event: ReactPointerEvent<HTMLDivElement>) => void;
  /** 焦点离开本行:调用方按「新焦点是否落在浮层里」决定收不收(← 键进浮层不能被收掉)。 */
  onBlurAway: (related: EventTarget | null) => void;
  onSelect: () => void;
  onStar: () => void;
  /** ← 键:打开该行的配置浮层并把焦点送进去(键盘用户的浮层入口,与既有面板同键位)。 */
  onRevealForKeyboard: (anchor: UnifiedAnchor, element: HTMLElement) => void;
  /**
   * 行内价格展示(设计稿 v4 定稿的 F 样式):
   *   - `free` → 「限时免费」淡染小徽标;
   *   - `tier` → $ 档串($×1-3,档位色);**有折扣时** $ 串双层互补裁切 —— 亮段(绿)
   *     宽度 = 折后价比例(`paidPct`),灰段是省掉的部分,尾随「↓X%」淡染小字。
   * 不传 = 无报价,行内不渲染任何价格节点(别把每行都加宽)。
   */
  priceDisplay?: {
    kind: 'free' | 'tier';
    tier?: 1 | 2 | 3;
    /**
     * 档串用的货币符号,按**该行报价的币种**取(CNY → ¥、USD → $)。设计稿里中文报价
     * 是 ¥¥¥,写死 $ 会让国内用户看到一串对不上账单的美元号。
     */
    symbol?: string;
    /** 折扣行:折后价占比(0-100,亮段宽度);无折扣不传。 */
    paidPct?: number;
    /** 折扣行:↓X% 的 X。 */
    discountPct?: number;
    /** 已本地化的悬停说明(折扣幅度全文)。 */
    title?: string;
  };
  /** 已本地化的「默认」标识;仅默认小节的行传。 */
  defaultBadge?: string;
  /**
   * 已本地化的「订阅」小签(设计稿 `.badge.sub`)。仅**订阅接入且无按量报价**的行传 ——
   * 那类模型走套餐额度,行内画 $ 档串会误导成按量计费。
   */
  subscriptionLabel?: string;
}) {
  const { t } = useTranslation();
  const provider = providers.find((item) => item.id === entry.providerId);
  const priceSymbol = priceDisplay?.symbol ?? '$';
  const engineOption = agentOptionOf(config.engine);
  const reveal = (event: ReactPointerEvent<HTMLDivElement>) => onReveal(anchor, event.currentTarget);
  const tripleTitle = `${engineOption.label}${
    config.effort ? ` · ${effortLabelOf(config.agent, config.effort)}` : ''
  }${config.fast ? ' · Fast' : ''}`;

  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={interactionDisabled ? -1 : 0}
      data-model-selected={selected ? 'true' : undefined}
      data-unified-anchor={anchorKey(anchor)}
      onPointerEnter={reveal}
      onPointerMove={reveal}
      onPointerLeave={onLeave}
      onFocus={(event) => onReveal(anchor, event.currentTarget)}
      onBlur={(event) => onBlurAway(event.relatedTarget)}
      onClick={onSelect}
      onKeyDown={(event) => {
        // 只处理落在**行本身**上的按键:滑杆(← / →)与 ☆ 都在浮层 / 行内子元素上,
        // 它们的键位不能被这里劫持(event.target !== currentTarget 时直接放行)。
        if (event.target !== event.currentTarget || interactionDisabled) return;
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          onRevealForKeyboard(anchor, event.currentTarget);
          return;
        }
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelect();
      }}
      className={cn(
        'group/row flex w-full cursor-pointer flex-col rounded-[10px] px-2.5 py-2 transition-colors duration-100',
        'hover:bg-[var(--model-item-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        (selected || active) && 'bg-[var(--model-item-hover)]',
        interactionDisabled && 'cursor-not-allowed opacity-50',
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
          title={entry.displayName}
          className="min-w-0 truncate text-14 font-medium leading-5 text-[var(--model-item-text)]"
        >
          {entry.displayName}
        </span>
        {defaultBadge && (
          <span
            data-default-badge
            className="inline-flex shrink-0 items-center rounded-full bg-[var(--surface-chip)] px-1.5 py-[1px] text-10 font-medium text-[var(--text-secondary)]"
          >
            {defaultBadge}
          </span>
        )}
        {subscriptionLabel && (
          <span
            data-subscription-badge
            className="inline-flex shrink-0 items-center rounded-full bg-[var(--surface-chip)] px-2 py-[1px] text-10 font-normal leading-[1.45] text-[var(--text-secondary)]"
          >
            {subscriptionLabel}
          </span>
        )}
        {priceDisplay?.kind === 'free' && (
          <span
            data-price-free
            className="inline-flex shrink-0 items-center rounded-full px-2 py-[1px] text-10 font-medium leading-[1.45]"
            style={{
              color: EFFORT_TIER_COLORS.low,
              backgroundColor: `color-mix(in srgb, ${EFFORT_TIER_COLORS.low} 14%, transparent)`,
            }}
          >
            {t('newChat.modelSelector.pricing.free')}
          </span>
        )}
        {priceDisplay?.kind === 'tier' && priceDisplay.tier !== undefined && (
          <span
            data-price-tier
            className="flex shrink-0 items-center gap-1"
            {...(priceDisplay.title ? { title: priceDisplay.title } : {})}
          >
            {priceDisplay.paidPct !== undefined && priceDisplay.discountPct !== undefined ? (
              <>
                {/* 折扣画在钱上(设计稿 F):$ 串双层同文互补裁切 —— 亮段(绿)宽度 =
                    折后价比例,灰段是省掉的部分,分界可以落在字形中间。 */}
                <span
                  aria-hidden
                  className="relative inline-block text-11 font-semibold leading-none tracking-[0.5px]"
                >
                  <span className="invisible">{priceSymbol.repeat(priceDisplay.tier)}</span>
                  <span className="absolute inset-0 text-[var(--text-tertiary)] opacity-55">
                    {priceSymbol.repeat(priceDisplay.tier)}
                  </span>
                  <span
                    className="absolute inset-0"
                    style={{
                      color: PRICE_TIER_COLORS.t1,
                      clipPath: `inset(0 ${100 - priceDisplay.paidPct}% 0 0)`,
                    }}
                  >
                    {priceSymbol.repeat(priceDisplay.tier)}
                  </span>
                </span>
                <span
                  data-discount-badge
                  // 设计稿 `.badge.save-tint`:淡染胶囊(14% 底 + 同色字),不是裸绿字 ——
                  // 裸字在长模型名旁边会被读成名字的一部分。
                  className="inline-flex shrink-0 items-center rounded-full px-2 py-[1px] text-10 font-medium leading-[1.45]"
                  style={{
                    color: EFFORT_TIER_COLORS.low,
                    backgroundColor: `color-mix(in srgb, ${EFFORT_TIER_COLORS.low} 14%, transparent)`,
                  }}
                >
                  {`↓${priceDisplay.discountPct}%`}
                </span>
              </>
            ) : (
              // 无折扣:$ 串按档位色(便宜绿 / 中档琥珀 / 高价红)。
              <span
                className="text-11 font-semibold leading-none tracking-[0.5px]"
                style={{ color: PRICE_TIER_COLORS[`t${priceDisplay.tier}`] }}
              >
                {priceSymbol.repeat(priceDisplay.tier)}
              </span>
            )}
          </span>
        )}
        <button
          type="button"
          disabled={interactionDisabled}
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
        {/* 常驻三元组:引擎图标 + 推理强度 + ⚡。所有行同构,自定义行整组提亮一档。
            设计稿 .l1-right:margin-left auto 把右侧簇推到最右,左侧簇贴名字排。 */}
        <span
          title={tripleTitle}
          data-unified-triple
          className={cn(
            'ml-auto flex max-w-[118px] shrink-0 items-center gap-1 truncate text-12',
            emphasizeTriple ? 'text-[var(--text-secondary)]' : 'text-[var(--text-tertiary)]',
          )}
        >
          <engineOption.Mark size={12} className="shrink-0" />
          {config.effort && <span className="truncate">{effortLabelOf(config.agent, config.effort)}</span>}
          {config.fast && (
            <Zap
              size={11}
              fill="currentColor"
              className="shrink-0"
              aria-label={t('newChat.modelSelector.meta.fastBadge')}
            />
          )}
        </span>
        <Check
          size={15}
          className={cn(
            'shrink-0 text-[var(--model-item-check)]',
            selected ? 'visible' : 'invisible',
          )}
        />
      </div>
      {entry.description && (
        // 单行截断 + title 全文;宽度上限收紧到约等于最长模型名的量级(~30ch)——
        // 描述是辅助信息,不该比模型名更长地占据视线(2026-08-13 实测反馈)。
        // 颜色按旧选择器恢复用 --text-secondary(同日裁决:tertiary 太淡看不清;
        // 与名字的区分靠名字的 14px/medium,不靠把描述压淡)。
        <div
          title={entry.description}
          className="min-w-0 max-w-[30ch] truncate pl-[26px] pt-px text-12 leading-[1.4] text-[var(--text-secondary)]"
        >
          {entry.description}
        </div>
      )}
    </div>
  );
}
