import { Check, Star, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PointerEvent as ReactPointerEvent } from 'react';

import type { ProviderView, UnifiedModelEntry } from '@cindy/model-providers';

import type { AgentKind } from '@/hooks/useAgentCapabilities';
import { cn } from '@/lib/utils';
import type { Effort } from '@/lib/userPreferences.types';

import { EFFORT_TIER_COLORS } from '@/themes/effortTierColors';

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
  discountLabel,
  defaultBadge,
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
  /** 已本地化的折扣 / 限免文案;**只在真有折扣时传**(没有就不渲染,别把每行都加宽)。 */
  discountLabel?: string;
  /** 已本地化的「默认」标识;仅默认小节的行传。 */
  defaultBadge?: string;
}) {
  const { t } = useTranslation();
  const provider = providers.find((item) => item.id === entry.providerId);
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
        <ModelIconMark
          {...(entry.icon !== undefined ? { icon: entry.icon } : {})}
          providerId={entry.providerId}
          {...(provider?.name !== undefined ? { name: provider.name } : {})}
          {...(provider?.routing !== undefined ? { routing: provider.routing } : {})}
          {...(provider?.logoKind !== undefined ? { logoKind: provider.logoKind } : {})}
          colorClass="text-[var(--text-secondary)]"
          withMargin={false}
          dense
        />
        <span
          // 超长模型名先撑宽面板、到上限才截断(规格 §1.2);截断后靠 title 给全名。
          title={entry.displayName}
          className={cn(
            'min-w-0 flex-1 truncate text-13 leading-5 text-[var(--model-item-text)]',
            selected ? 'font-medium' : 'font-normal',
          )}
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
        {discountLabel && (
          <span
            data-discount-badge
            title={discountLabel}
            // 折扣用淡染绿(与档位色表里的 low 同一支绿),不抢模型名的注意力,也不占
            // 固定宽度 —— 没折扣的行完全不渲染这个节点。
            className="inline-flex shrink-0 items-center rounded-full px-1.5 py-[1px] text-10 font-semibold"
            style={{
              color: EFFORT_TIER_COLORS.low,
              backgroundColor: `color-mix(in srgb, ${EFFORT_TIER_COLORS.low} 14%, transparent)`,
            }}
          >
            {discountLabel}
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
          <Star size={13} fill={isFavoriteRow || justFavorited ? 'currentColor' : 'none'} />
        </button>
        {/* 常驻三元组:引擎图标 + 推理强度 + ⚡。所有行同构,自定义行整组提亮一档。 */}
        <span
          title={tripleTitle}
          data-unified-triple
          className={cn(
            'flex max-w-[118px] shrink-0 items-center gap-1 truncate text-12',
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
        // 单行截断 + title 全文:英文长描述在窄面板下撑破布局是实测反馈的问题。
        <div
          title={entry.description}
          className="min-w-0 max-w-full truncate pl-[26px] pt-px text-12 text-[var(--text-tertiary)]"
        >
          {entry.description}
        </div>
      )}
    </div>
  );
}