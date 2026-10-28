import { DisplayPricingDetails } from '@/components/DisplayPricingDetails';
import { useModelContextLimit } from '@/hooks/useModelContextLimit';
import { localizedModelName } from '@/lib/modelDisplayNames';
import { ChevronDown, Star, TriangleAlert, Zap } from 'lucide-react';
import { SpeedIcon } from './SpeedIcon';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
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
import type {
  SessionUsageLimitFallbackState,
  SessionUsageLimitFallbackTarget,
} from '@/hooks/useSessionUsageLimitFallback';

import { ModelHarnessPicker } from './ModelHarnessPicker';
import { EffortSlider } from '@/components/ui/effort-slider';
import type { UnifiedEngine, UnifiedRowConfig } from './unifiedModelSelection';

/**
 * 占位：等用户确认实际界面后定稿，之后换 i18n。
 * 本文件之外不要新增同一批文案的副本。
 */
const COPY = {
  label: '额度用尽时改用',
  unset: '不启用',
  empty: '同引擎下没有其他可用模型',
  staleHint: '已失效：这条备用路线绑定的模型已不是任务当前使用的组合，不会再触发。',
  reset: '重设',
  error: '没有保存：',
  sectionLabel: '额度用尽时的备用模型',
} as const;

/** 额度备用候选：同一引擎下、目录里已加载的模型（由面板注入，不发额外请求）。 */
export interface UsageLimitFallbackCandidate {
  providerId: string;
  /** 真正发给模型的 wire id（与主进程目录查找、会话 model 同一口径）。 */
  modelId: string;
  displayName: string;
  sourceLabel: string;
}

function fallbackCandidateKey(candidate: { providerId: string; modelId: string }): string {
  return `${candidate.providerId}::${candidate.modelId}`;
}

/** RadioGroup 的「不启用」哨兵值（空串在 Radix 里容易被当成未选）。 */
const FALLBACK_NONE = '__none__';


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
  /** Same-engine views show the current harness without offering a cross-engine switch. */
  engineLocked?: boolean;
  onEngineChange: (engine: UnifiedEngine) => void;
  onEffortChange: (effort: Effort) => void;
  onFastChange: (enabled: boolean | 'ultrafast') => void;
  onResetToRecommended: () => void;
  onAddFavorite: () => void;
  onRemoveFavorite: () => void;
  /**
   * 任务级额度备用路线（已建任务才有）。null / 缺省 = 不画这一区：
   * 新任务草稿、设置类入口与远程目录浏览都没有可写的目标。
   * 由上层注入，本组件不调 hook —— 它同时给非任务场景渲染。
   */
  usageLimitFallback?: SessionUsageLimitFallbackState | null;
  /** 同引擎下的候选（面板已加载的目录）。空数组 = 只能显示「没有其他可用模型」。 */
  usageLimitFallbackCandidates?: readonly UsageLimitFallbackCandidate[];
}

/**
 * ModelConfigFlyout —— 模型行的**配置浮层**(model-selector-unified §1.3 / §1.5)。
 *
 * 自上而下:标题(+☆) → 来源 · 上下文 → 推理强度滑杆(+⚡) → 引擎选项 → 价格 → 状态底栏。
 * 原生协议作为简短参考；具体选项展示当前路由的原生/兼容关系。
 *
 * 两条「不做假按钮」的硬边界:
 *   - 滑杆只在该 (模型, 引擎) 真实支持 ≥2 个档位时出现;1 档或 0 档 = 不可调,整块不画。
 *   - ⚡ 只在该 (模型, 引擎) 的 `supportsFastMode` × agent 运行时能力都为真时出现。
 * 引擎选项只列**候选引擎**，标注原生/兼容；单候选或同引擎轨锁定时不可切换。
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
  engineLocked = false,
  onEngineChange,
  onEffortChange,
  onFastChange,
  onResetToRecommended,
  onAddFavorite,
  onRemoveFavorite,
  usageLimitFallback = null,
  usageLimitFallbackCandidates = [],
}: ModelConfigFlyoutProps) {
  const { t } = useTranslation();
  const displayName = localizedModelName(entry.displayName, t);
  const showSlider = config.efforts.length > 1;
  const contextLimit = useModelContextLimit({
    providerId: entry.providerId,
    agent: config.engine === 'cc' ? 'claude-code' : config.engine,
    modelId: config.wireModelId ?? entry.modelId,
  });
  const contextWindow = contextLimit.limit ?? config.capability?.contextWindow ?? 0;
  const codexDefaultContext = config.engine === 'codex';
  const codexContext = codexDefaultContext ? contextLimit.codexContext ?? null : null;
  const starred = state === 'favorite' || justFavorited;

  // 额度备用路线：已存目标按候选表反查展示名；存着但已不在候选里的（失效/被隐藏/目录变了）
  // 退回显示 model id —— 至少能对上是哪一条，失效提示另有单独一行。
  const fallbackTarget: SessionUsageLimitFallbackTarget | null = usageLimitFallback?.target ?? null;
  const fallbackSelectedKey = fallbackTarget
    ? fallbackCandidateKey({ providerId: fallbackTarget.providerId, modelId: fallbackTarget.model })
    : FALLBACK_NONE;
  const fallbackSelected = fallbackTarget
    ? usageLimitFallbackCandidates.find(
        (candidate) => fallbackCandidateKey(candidate) === fallbackSelectedKey,
      ) ?? null
    : null;
  const fallbackTargetLabel = fallbackTarget
    ? fallbackSelected
      ? `${localizedModelName(fallbackSelected.displayName, t)} · ${fallbackSelected.sourceLabel}`
      : fallbackTarget.model
    : COPY.unset;

  const applyFallbackValue = (value: string) => {
    if (!usageLimitFallback) return;
    if (value === FALLBACK_NONE) {
      void usageLimitFallback.clearTarget();
      return;
    }
    const candidate = usageLimitFallbackCandidates.find(
      (item) => fallbackCandidateKey(item) === value,
    );
    if (!candidate) return;
    void usageLimitFallback.setTarget({
      providerId: candidate.providerId,
      model: candidate.modelId,
    });
  };
  // 重设 = 用已存目标再写一次：主进程按任务当时的实际组合重记来源，写完成 stale 自然消失。
  const resetFallback = () => {
    if (!usageLimitFallback?.target) return;
    void usageLimitFallback.setTarget(usageLimitFallback.target);
  };

  const discount = price?.kind === 'priced' ? price.discount : undefined;
  const priceRows =
    price?.kind === 'priced' ? modelPriceDetailRows(price.current, price.original) : [];
  // 折后价那一行的 hover 全文:逐项「标准价 X」;没有原价对比时不挂 title。
  const priceDetailTitle = priceRows.some((row) => row.originalValue)
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
      aria-label={`${displayName} ${t('newChat.modelSelector.options')}`}
      className="flex flex-col"
    >
      <div className="flex items-start gap-2">
        <span
          title={displayName}
          className="line-clamp-2 min-w-0 flex-1 text-14 font-semibold leading-[1.35] text-[var(--model-item-text)]"
        >
          {displayName}
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
              value: codexDefaultContext
                ? codexContext ? formatContextWindow(codexContext.contextWindow) : t('settings.providers.models.advanced.codexContextUnknown')
                : formatContextWindow(contextWindow),
            })}
          </>
        )}
      </div>

      {codexDefaultContext && (
        <p className="pt-1.5 text-11 leading-relaxed text-[var(--text-tertiary)]">
          {t('ccAgent.layout.contextRing.codexAutoHint')}
        </p>
      )}

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
          {config.fastCapable && config.capability?.supportsUltrafastMode && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={t('newChat.modelSelector.speed.label')}
                  title={t(`newChat.modelSelector.speed.${config.fast === 'ultrafast' ? 'ultrafast' : config.fast ? 'fast' : 'standard'}`)}
                  className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors',
                    config.fast ? 'border-transparent text-[var(--fast-accent)]' : 'border-[var(--model-dropdown-border)] text-[var(--text-tertiary)]',
                  )}
                >
                  <SpeedIcon mode={config.fast} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuRadioGroup
                  value={config.fast === 'ultrafast' ? 'ultrafast' : config.fast ? 'fast' : 'standard'}
                  onValueChange={value => onFastChange(value === 'ultrafast' ? 'ultrafast' : value === 'fast')}
                >
                  {(['standard', 'fast', 'ultrafast'] as const).map(speed => (
                    <DropdownMenuRadioItem key={speed} value={speed}>
                      {t(`newChat.modelSelector.speed.${speed}`)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {config.fastCapable && !config.capability?.supportsUltrafastMode && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onFastChange(!config.fast)}
              aria-pressed={!!config.fast}
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

      <ModelHarnessPicker
        entry={entry}
        value={config.engine}
        disabled={disabled}
        locked={engineLocked}
        onChange={onEngineChange}
      />

      {config.capability?.displayPricing && config.capability.currency && (
        <div className="mt-2.5 max-h-72 overflow-y-auto border-t border-[var(--model-dropdown-border)] pt-2.5">
          <DisplayPricingDetails model={config.capability} />
        </div>
      )}
      {!config.capability?.displayPricing && price && (
        // 价格区(设计稿 v4 定稿):**紧凑两行**,不画删除线表格。
        //   第 1 行:每百万 token · 折扣中,较标准价省 X%(省 X% 绿色加粗)
        //   第 2 行:折后价单行排列 —— 输入 ¥32 · 输出 ¥162 · 缓存读取 ¥3.2
        // 原价对比收进 title(hover 才看):浮层是「选之前扫一眼」的地方,一张对照表
        // 会把它变成账单页,且删除线在 12px 下几乎看不清。
        <div className="mt-2.5 border-t border-[var(--model-dropdown-border)] pt-[9px] text-12 leading-[1.7] text-[var(--text-tertiary)]">
          <div className="flex flex-wrap items-baseline gap-x-1">
            <span>{t('newChat.modelSelector.pricing.title')}</span>
            {price.kind === 'free' ? (
              <span className="font-semibold" style={{ color: EFFORT_TIER_COLORS.low }}>
                · {t('newChat.modelSelector.pricing.free')}
              </span>
            ) : (
              discount !== undefined && (
                <span className="font-semibold" style={{ color: EFFORT_TIER_COLORS.low }}>
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

      {usageLimitFallback && (
        // 任务级额度备用路线：排在 Fast 之后、状态底栏（收藏 / 恢复推荐）之前。
        // 草稿、设置类入口与远程目录浏览不传这个 prop，整区不画。
        <div className="mt-2.5 border-t border-[var(--model-dropdown-border)] pt-2.5 text-12">
          {usageLimitFallback.stale && (
            <div className="mb-1.5 flex items-start gap-1.5 leading-[1.5] text-[var(--warning-fg)]">
              <TriangleAlert size={12} className="mt-[2px] shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">{COPY.staleHint}</span>
              <button
                type="button"
                disabled={disabled || usageLimitFallback.loading}
                onClick={resetFallback}
                className="shrink-0 underline underline-offset-2 transition-colors hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {COPY.reset}
              </button>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="shrink-0 text-[var(--text-secondary)]">{COPY.label}</span>
            {usageLimitFallbackCandidates.length === 0 ? (
              <span
                className="min-w-0 truncate text-[var(--text-tertiary)]"
                title={COPY.empty}
              >
                {COPY.empty}
              </span>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={disabled || usageLimitFallback.loading}
                    aria-label={COPY.sectionLabel}
                    title={fallbackTargetLabel}
                    className={cn(
                      'flex h-7 min-w-0 max-w-[220px] items-center gap-1 rounded-full border px-2.5 text-12 transition-colors',
                      'border-[var(--model-dropdown-border)] hover:bg-[var(--model-item-hover)]',
                      fallbackTarget
                        ? 'text-[var(--model-item-text)]'
                        : 'text-[var(--text-tertiary)]',
                      (disabled || usageLimitFallback.loading) && 'cursor-not-allowed opacity-50',
                    )}
                  >
                    <span className="truncate">{fallbackTargetLabel}</span>
                    <ChevronDown size={12} className="shrink-0 opacity-60" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuRadioGroup
                    value={fallbackSelectedKey}
                    onValueChange={applyFallbackValue}
                  >
                    <DropdownMenuRadioItem value={FALLBACK_NONE}>
                      {COPY.unset}
                    </DropdownMenuRadioItem>
                    {usageLimitFallbackCandidates.map((candidate) => (
                      <DropdownMenuRadioItem
                        key={fallbackCandidateKey(candidate)}
                        value={fallbackCandidateKey(candidate)}
                      >
                        {localizedModelName(candidate.displayName, t)}
                        <span className="ml-1 opacity-60">· {candidate.sourceLabel}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          {usageLimitFallback.error && (
            <div className="mt-1 leading-[1.5] text-[var(--error-fg)]" role="alert">
              {COPY.error}
              {usageLimitFallback.error}
            </div>
          )}
        </div>
      )}

      {/* 状态底栏三态等高:推荐配置 / 已自定义 · 恢复推荐 / 收藏配置 · 取消收藏。 */}
      <div className="mt-2 flex min-h-[22px] items-center justify-between border-t border-[var(--model-dropdown-border)] pt-2 text-11">
        <span
          className={
            state === 'recommended' ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-secondary)]'
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
