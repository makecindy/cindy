import { Check, Star, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { formatContextWindow, type UnifiedModelEntry } from '@cindy/model-providers';

import { cn } from '@/lib/utils';
import {
  modelPriceDetailRows,
  modelPriceDiscountLabelValues,
  type ModelPricePresentation,
} from '@/lib/modelPriceFormat';
import type { Effort } from '@/lib/userPreferences.types';
import { EFFORT_TIER_COLORS } from '@/themes/effortTierColors';
import type { AgentKind } from '@/hooks/useAgentCapabilities';

import { agentOptionOf } from './agentOptions';
import { EffortSlider } from './EffortSlider';
import {
  engineOfAgentKind,
  type UnifiedEngine,
  type UnifiedRowConfig,
} from './unifiedModelSelection';

/** 底栏三态(等高,切态不改变浮层高度 —— 规格 §1.3「高度恒定」)。 */
export type ModelConfigFlyoutState = 'recommended' | 'customized' | 'favorite';

export interface ModelConfigFlyoutProps {
  entry: UnifiedModelEntry;
  /** 该锚点当前生效的配置(模型行 = 默认⊕override⊕记忆;收藏行 = 该条收藏本身)。 */
  config: UnifiedRowConfig;
  state: ModelConfigFlyoutState;
  /** 来源供应商展示名。 */
  sourceLabel: string;
  price: ModelPricePresentation | null;
  /** 档位 → 显示文案(按当前选中引擎取,i18n)。 */
  effortLabelOf: (agent: AgentKind, effort: Effort) => string;
  /** 刚刚点过 ☆ 的 0.7s 反馈态(规格 §1.5)。 */
  justFavorited?: boolean;
  disabled?: boolean;
  onEngineChange: (engine: UnifiedEngine) => void;
  onEffortChange: (effort: Effort) => void;
  onFastChange: (enabled: boolean) => void;
  onResetToRecommended: () => void;
  onAddFavorite: () => void;
  onRemoveFavorite: () => void;
}

/**
 * ModelConfigFlyout —— 模型行的**配置浮层**(model-selector-unified §1.3 / §1.5)。
 *
 * 自上而下:标题(+☆) → 来源 · 上下文 → 推理强度滑杆(+⚡) → 引擎胶囊 → 价格 → 状态底栏。
 * 无字段标题,组件自表达。
 *
 * 两条「不做假按钮」的硬边界:
 *   - 滑杆只在该 (模型, 引擎) 真实支持 ≥2 个档位时出现;1 档或 0 档 = 不可调,整块不画。
 *   - ⚡ 只在该 (模型, 引擎) 的 `supportsFastMode` × agent 运行时能力都为真时出现。
 * 引擎胶囊只列**候选引擎**(M1 已按生效来源解析);单候选时是静态块,不可点。
 *
 * 切引擎后价格 / 上下文 / 档位集合会立刻变 —— 它们全部由调用方按新引擎现查后传下来
 * (同一模型跨引擎的上下文窗口真的不同,如 gpt-5.5 在 cc 1M / codex 272K)。
 */
export function ModelConfigFlyout({
  entry,
  config,
  state,
  sourceLabel,
  price,
  effortLabelOf,
  justFavorited = false,
  disabled = false,
  onEngineChange,
  onEffortChange,
  onFastChange,
  onResetToRecommended,
  onAddFavorite,
  onRemoveFavorite,
}: ModelConfigFlyoutProps) {
  const { t } = useTranslation();
  const recommendedEngine = engineOfAgentKind(entry.recommended);
  const candidates = entry.candidates.map(engineOfAgentKind);
  const multiEngine = candidates.length > 1;
  const showSlider = config.efforts.length > 1;
  const contextWindow = config.capability?.contextWindow ?? 0;
  const starred = state === 'favorite' || justFavorited;

  const discount = price?.kind === 'priced' ? price.discount : undefined;
  const priceRows = price?.kind === 'priced' ? modelPriceDetailRows(price.current, price.original) : [];
  // 折后价那一行的 hover 全文:逐项「标准价 X」;没有原价对比时不挂 title。
  const priceDetailTitle =
    priceRows.some((row) => row.originalValue)
      ? priceRows
          .filter((row) => row.originalValue)
          .map(
            (row) =>
              `${t(`newChat.modelSelector.pricing.${row.kind}`)} ${row.value} ← ${row.originalValue}`,
          )
          .join(' · ')
      : null;
  const priceFootnote =
    price?.kind === 'priced'
      ? price.current.source === 'subscription-reference'
        ? t('newChat.modelSelector.pricing.subscriptionEstimate')
        : price.current.approximate
          ? t('newChat.modelSelector.pricing.fixedFx')
          : null
      : null;

  return (
    <div
      role="group"
      aria-label={`${entry.displayName} ${t('newChat.modelSelector.options')}`}
      className="flex flex-col"
    >
      <div className="flex items-start gap-2">
        <span
          title={entry.displayName}
          className="line-clamp-2 min-w-0 flex-1 text-14 font-semibold leading-[1.35] text-[var(--model-item-text)]"
        >
          {entry.displayName}
        </span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => (state === 'favorite' ? onRemoveFavorite() : onAddFavorite())}
          title={
            state === 'favorite'
              ? t('newChat.modelSelector.unified.removeFavorite')
              : t('newChat.modelSelector.unified.addFavorite')
          }
          aria-label={
            state === 'favorite'
              ? t('newChat.modelSelector.unified.removeFavorite')
              : t('newChat.modelSelector.unified.addFavorite')
          }
          className={cn(
            'mt-[1px] flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] transition-colors',
            starred
              ? 'text-[var(--favorite-star)]'
              : 'text-[var(--text-tertiary)] hover:text-[var(--favorite-star)]',
            disabled && 'cursor-not-allowed opacity-50',
          )}
        >
          <Star size={14} fill={starred ? 'currentColor' : 'none'} />
        </button>
      </div>

      <div className="truncate border-b border-[var(--model-dropdown-border)] pb-2.5 pt-[3px] text-12 text-[var(--text-tertiary)]">
        {sourceLabel}
        {contextWindow > 0 && (
          <>
            {' · '}
            {t('newChat.modelSelector.meta.context', {
              value: formatContextWindow(contextWindow),
            })}
          </>
        )}
      </div>

      {(showSlider || config.fastCapable) && (
        // 设计稿 .fly-ctrl:first-of-type:第一个控件行上距 14px。
        <div className="flex items-center gap-2 pt-3.5">
          {showSlider && config.effort && (
            <EffortSlider
              stops={config.efforts}
              value={config.effort}
              recommended={config.capability?.defaultEffort ?? null}
              labelOf={(effort) => effortLabelOf(config.agent, effort)}
              onChange={onEffortChange}
              disabled={disabled}
            />
          )}
          {config.fastCapable && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onFastChange(!config.fast)}
              aria-pressed={config.fast}
              title={t('newChat.modelSelector.unified.fastTip')}
              aria-label={t('newChat.modelSelector.unified.fastTip')}
              data-fast-toggle
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors',
                config.fast
                  ? 'border-transparent'
                  : 'border-[var(--model-dropdown-border)] text-[var(--text-tertiary)] hover:bg-[var(--model-item-hover)]',
                disabled && 'cursor-not-allowed opacity-50',
              )}
              style={
                config.fast
                  ? {
                      // Fast 开启态的蓝**只在浮层内**(外侧闪电保持中性色,规格 §1.3)。
                      // 走语义 token(themes/colors.ts 的 `fast-accent`,light / dark 双值已注册),
                      // 底色由同一个 var 经 color-mix 派生 —— 组件里不再持有第二份 hex。
                      color: 'var(--fast-accent)',
                      backgroundColor: 'color-mix(in srgb, var(--fast-accent) 16%, transparent)',
                    }
                  : undefined
              }
            >
              <Zap size={14} fill="currentColor" />
            </button>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-[3px] pt-1.5">
        {candidates.map((engine) => {
          const option = agentOptionOf(engine);
          const active = config.engine === engine;
          const isRecommended = engine === recommendedEngine;
          return (
            <button
              key={engine}
              type="button"
              disabled={disabled || !multiEngine}
              onClick={() => multiEngine && onEngineChange(engine)}
              aria-pressed={active}
              title={
                isRecommended && multiEngine
                  ? t('newChat.modelSelector.unified.recommended')
                  : undefined
              }
              data-engine-capsule={engine}
              data-engine-active={active ? 'true' : undefined}
              className={cn(
                // 设计稿 `.h-seg-btn`:高 26、左右 11、图标与名之间 5、圆角胶囊、无边框。
                'inline-flex h-[26px] shrink-0 items-center gap-[5px] rounded-full px-[11px] text-12 transition-colors',
                active
                  // 选中态的「浮起感」:chip 底 + 一圈极淡的内描边 + 贴地阴影,
                  // 让它从同色系的胶囊行里浮出来(纯换底色在 Dark 下几乎看不出)。
                  ? 'bg-[var(--surface-chip)] font-medium text-[var(--model-item-text)] shadow-[var(--shadow-chip-raised)] ring-1 ring-inset ring-[var(--model-dropdown-border)]'
                  : 'text-[var(--text-tertiary)]',
                !active && multiEngine && 'hover:bg-[var(--model-item-hover)]',
                // 推荐项(未选中时)细描边指路;不写「Recommended」字样(英文太长,§1.7)。
                !active && isRecommended && multiEngine && 'ring-1 ring-inset ring-[var(--model-dropdown-border)]',
                multiEngine ? 'cursor-pointer' : 'cursor-default',
                disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              <option.Mark size={12} className="shrink-0" />
              <span className="max-w-[92px] truncate">{option.label}</span>
              {active && isRecommended && multiEngine && (
                <Check size={10} className="shrink-0" />
              )}
            </button>
          );
        })}
      </div>

      {price && (
        // 价格区(设计稿 v4 定稿):**紧凑两行**,不画删除线表格。
        //   第 1 行:每百万 token · 折扣中,较标准价省 X%(省 X% 绿色加粗)
        //   第 2 行:折后价单行排列 —— 输入 ¥32 · 输出 ¥162 · 缓存读取 ¥3.2
        // 原价对比收进 title(hover 才看):浮层是「选之前扫一眼」的地方,一张对照表
        // 会把它变成账单页,且删除线在 12px 下几乎看不清。
        <div className="mt-2.5 border-t border-[var(--model-dropdown-border)] pt-[9px] text-12 leading-[1.7] text-[var(--text-tertiary)]">
          <div className="flex flex-wrap items-baseline gap-x-1">
            <span>{t('newChat.modelSelector.pricing.title')}</span>
            {price.kind === 'free' ? (
              <span
                className="font-semibold"
                style={{ color: EFFORT_TIER_COLORS.low }}
              >
                · {t('newChat.modelSelector.pricing.free')}
              </span>
            ) : (
              discount !== undefined && (
                <span
                  className="font-semibold"
                  style={{ color: EFFORT_TIER_COLORS.low }}
                >
                  ·{' '}
                  {t(
                    'newChat.modelSelector.pricing.discountedVsStandard',
                    modelPriceDiscountLabelValues(discount),
                  )}
                </span>
              )
            )}
          </div>
          {price.kind === 'priced' && (
            <div
              // 原价与折扣幅度的完整说明留在 title 里(设计稿:详情写全「折扣中 · 标准价 X」)。
              title={priceDetailTitle ?? undefined}
              className="flex flex-wrap items-baseline gap-x-1.5 tabular-nums text-[var(--text-secondary)]"
            >
              {priceRows.map((row, index) => (
                <span key={row.kind} className="whitespace-nowrap">
                  {index > 0 && <span className="pr-1.5 opacity-60">·</span>}
                  {t(`newChat.modelSelector.pricing.${row.kind}`)}{' '}
                  <span className="font-medium text-[var(--model-item-text)]">{row.value}</span>
                </span>
              ))}
            </div>
          )}
          {priceFootnote && (
            <div className="text-11 leading-[1.5] text-[var(--text-tertiary)]">{priceFootnote}</div>
          )}
        </div>
      )}

      {/* 状态底栏三态等高:推荐配置 / 已自定义 · 恢复推荐 / 收藏配置 · 取消收藏。 */}
      <div className="mt-2 flex min-h-[22px] items-center justify-between border-t border-[var(--model-dropdown-border)] pt-2 text-11">
        <span
          className={
            state === 'recommended'
              ? 'text-[var(--text-tertiary)]'
              : 'text-[var(--text-secondary)]'
          }
        >
          {state === 'favorite'
            ? t('newChat.modelSelector.unified.favoriteConfig')
            : state === 'customized'
              ? t('newChat.modelSelector.unified.customized')
              : t('newChat.modelSelector.unified.recommendedConfig')}
        </span>
        {state === 'favorite' ? (
          <button
            type="button"
            disabled={disabled}
            onClick={onRemoveFavorite}
            className="shrink-0 text-[var(--text-secondary)] underline underline-offset-2 transition-colors hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('newChat.modelSelector.unified.removeFavorite')}
          </button>
        ) : state === 'customized' ? (
          <button
            type="button"
            disabled={disabled}
            onClick={onResetToRecommended}
            className="shrink-0 text-[var(--text-secondary)] underline underline-offset-2 transition-colors hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('newChat.modelSelector.unified.reset')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
