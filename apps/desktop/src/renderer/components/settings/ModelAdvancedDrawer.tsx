import { localizedModelDescription } from '@/lib/modelDescriptions';
import { localizedModelName, localizedBrandName } from '@/lib/modelDisplayNames';
/**
 * ModelAdvancedDrawer —— 单模型配置面板。宽屏配置与事实并列，窄屏按同一顺序排成一列。
 *
 * 为什么行尾只有这一个入口:它替代了原先的「⋯」菜单。那个菜单里三项(自定义报价 /
 * 停用此模型 / 删除本机模型)全部搬进本抽屉 —— 一项能力都没减,但用户不必先猜「配置藏在
 * 哪个菜单里」。
 *
 * 分段职责:
 *   - 引擎 / 推理 / 上下文控制与只读事实同时可见;窗口规格紧随上下文输入。
 *   - 默认推理强度 / 上下文上限 / 引擎支持 = **可配置项**,各自写入不同的既有存储
 *     (providerModelMemory / model-context-limit-store / modelVisibilityPrefs)。
 *   - 底部动作区 = 准入轴(停用)与本机文件(删除),与上面的显示轴严格分开。
 *
 * 「显示」与「停用」是两根正交的轴,语义见 UnifiedModelList 头注:开关管陈列,
 * 停用管准入。抽屉把它们放在视觉上分离的位置(引擎支持 vs 底部动作区),不混成一个控件。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, Check, CircleHelp, Minus, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { MODEL_HARNESS_COLOR } from '@/lib/modelHarnessPresentation';
import { ModelCompatibilityNotice } from '@/components/new-chat/ModelCompatibilityNotice';
import { MODEL_PROTOCOL_LABEL } from '@/lib/modelProtocolLabel';
import { toast } from '@/lib/toast';
import { Tip } from '@/components/ui/tooltip';
import { Switch } from '@/components/ui/switch';
import { ClaudeMark } from '@/components/icons/ClaudeMark';
import { CodexMark } from '@/components/icons/CodexMark';
import { PiMark } from '@/components/icons/PiMark';
import { useModelContextLimit } from '@/hooks/useModelContextLimit';
import { modelPriceDetailRows, type ModelPricePresentation } from '@/lib/modelPriceFormat';
import {
  isModelEnabled,
  setModelVisibility,
  isModelVisibilityCustomized,
  resetModelVisibilities,
  useModelVisibilityVersion,
} from '@/state/modelVisibilityPrefs';
import {
  clearProviderModelEffort,
  getProviderModelEffort,
  setProviderModelEffort,
  useProviderModelMemoryVersion,
} from '@/state/providerModelMemory';
import { EFFORT_TIER_COLORS } from '@/themes/effortTierColors';

import {
  classifyVisionCapability,
  clampEffortToSupported,
  EFFORT_VALUES,
  isAgentSelectableModel,
  modelProtocolComparison,
  pickRecommendedAgent,
} from '@cindy/model-providers';
import type {
  AgentKind,
  CatalogModel,
  Effort,
  PiModelApi,
  ProviderView,
} from '@cindy/model-providers';

import { MANAGED_OLLAMA_PROVIDER_ID } from '../../../shared/localModelRuntime';
import { modelBrand } from './modelManagementPresentation';
import { ModelPriceOverrideDialog } from './ModelPriceOverrideDialog';
import type { UnionModelRow } from './UnifiedModelList';

const AGENT_LABEL: Record<AgentKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
};

// Editing uses whole decimal K, rounded down to avoid suggesting a value above the upstream
// maximum. Merely opening/blurring the field never writes this display approximation back.
function editableContextK(tokens: number): string {
  return String(Math.max(1, Math.floor(tokens / 1000)));
}

const AGENT_MARK: Record<AgentKind, (size: number) => ReactNode> = {
  'claude-code': (size) => <ClaudeMark size={size} />,
  codex: (size) => <CodexMark size={size} />,
  pi: (size) => <PiMark size={size} />,
};

/** 抽屉里的档位顺序 = 目录枚举顺序（弱到强）。ultra 只在模型真的提供时出现。 */
const EFFORT_ORDER = EFFORT_VALUES;

/**
 * K / M 缩写在真实数据里是**歧义的**:contextWindow 同时存在 1,000,000、1,050,000、
 * 1,048,576 三种写法,都会被印成「1M」。所以详情处一律给带千分位的准确 token 数,
 * 括注里才给约数 —— 列表那种空间紧的位置继续用缩写。
 */
function formatExactTokens(tokens: number, locale: string): string {
  return tokens.toLocaleString(locale);
}

function approxTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : Number(m.toFixed(2))}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

/** 定义列表的一行:左标签右值 + 细分隔线。 */
function Row({
  label,
  children,
  muted,
}: {
  label: string;
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="flex min-h-[34px] items-center justify-between gap-4 border-b border-[var(--settings-theme-card-border)] py-2 last:border-b-0">
      <span className="shrink-0 text-13 text-[var(--text-secondary)]">{label}</span>
      <span
        className={cn(
          'min-w-0 break-words text-right text-13',
          muted ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]',
        )}
      >
        {children}
      </span>
    </div>
  );
}

function CapabilityValue({ state, label }: { state: boolean | undefined; label: string }) {
  const Icon = state === true ? Check : state === false ? Minus : CircleHelp;
  return (
    <span className="inline-flex items-center gap-1.5 text-[var(--text-secondary)]">
      <Icon size={13} aria-hidden />
      {label}
    </span>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="pt-5 first:pt-1">
      <div className="flex items-center gap-1.5">
        <h4 className="text-12 font-medium text-[var(--text-secondary)]">{title}</h4>
        {hint && (
          <Tip text={hint} contentClassName="z-[10002]">
            <button
              type="button"
              aria-label={hint}
              className="rounded-full p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            >
              <CircleHelp size={12} aria-hidden />
            </button>
          </Tip>
        )}
      </div>
      <div className="mt-1.5">{children}</div>
    </section>
  );
}

interface Props {
  provider: ProviderView;
  row: UnionModelRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 该行的报价展示（与列表同一份派生结果，避免抽屉自己再算一遍算出别的）。 */
  pricePresentationOf: (agent: AgentKind, model: CatalogModel) => ModelPricePresentation | null;
  /** 准入轴:停用此模型（main 侧 model-disable-store）。 */
  onDisable: (row: UnionModelRow) => void;
  /** 本机 Ollama 专有:删除磁盘上的模型文件。 */
  onDeleteLocal?: (row: UnionModelRow) => void;
  /** 该行当前是否已被停用（用于底部动作区的方向）。 */
  disabled: boolean;
  /** 付费锁定行不给写入入口（与列表行同一判定）。 */
  paymentRequired: boolean;
}

export function ModelAdvancedDrawer({
  provider,
  row,
  open,
  onOpenChange,
  pricePresentationOf,
  onDisable,
  onDeleteLocal,
  disabled,
  paymentRequired,
}: Props) {
  const { t, i18n } = useTranslation();
  const selectionAvailable = provider.connected && !provider.suspended;
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'en';
  const [priceDialogOpen, setPriceDialogOpen] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  // 开关/档位写的是 renderer 本地存储，订阅 version 才能在写后重渲染。
  useModelVisibilityVersion();
  useProviderModelMemoryVersion();

  /**
   * 主展示引擎:该模型可用引擎里的第一个。只读事实(上下文、报价、能力)按它取 ——
   * 同一模型跨引擎的元数据可能不同,抽屉顶部标注了这一点,逐引擎差异在「引擎支持」段展开。
   */
  const primaryAgent =
    row?.avail.find((agent) =>
      provider.id === 'openai'
        ? agent === 'codex'
        : provider.id === 'anthropic'
          ? agent === 'claude-code'
          : agent === 'pi',
    ) ??
    row?.avail[0] ??
    null;
  const primaryModel = row && primaryAgent ? (row.byAgent[primaryAgent] ?? null) : null;

  // Built-in Codex uses its own process/model ceiling. A shared row edit must not
  // promise to expand it or silently write a Codex override along with Pi/Claude.
  const separateCodexContext = provider.source !== 'user' && Boolean(row?.byAgent.codex);
  const contextAgent =
    separateCodexContext && primaryAgent === 'codex'
      ? (row?.avail.find((agent) => agent !== 'codex') ?? null)
      : primaryAgent;
  const contextModel = contextAgent ? row?.byAgent[contextAgent] : null;

  const contextTarget = useMemo(
    () =>
      contextAgent && contextModel
        ? {
            providerId: provider.id,
            agent: contextAgent,
            modelId: contextModel.id,
            relatedTargets: (row?.avail ?? [])
              .filter((a) => a !== contextAgent && !(separateCodexContext && a === 'codex'))
              .flatMap((agent) => {
                const model = row?.byAgent[agent];
                return model ? [{ providerId: provider.id, agent, modelId: model.id }] : [];
              }),
          }
        : null,
    [contextAgent, contextModel, provider.id, row, separateCodexContext],
  );
  const ctx = useModelContextLimit(open ? contextTarget : null);

  const [ctxDraft, setCtxDraft] = useState('');
  const ctxDirtyRef = useRef(false);
  const defaultWindow = contextModel?.contextWindow ?? 0;
  const routeWindow = primaryModel?.contextWindowMax ?? primaryModel?.contextWindow ?? 0;
  const effectiveLimit = ctx.limit ?? (defaultWindow > 0 ? defaultWindow : null);
  useEffect(() => {
    ctxDirtyRef.current = false;
    setCtxDraft('');
    setPriceDialogOpen(false);
  }, [open, primaryAgent, primaryModel?.id, provider.id]);
  useEffect(() => {
    if (ctx.loading || ctxDirtyRef.current) return;
    setCtxDraft(effectiveLimit === null ? '' : editableContextK(effectiveLimit));
  }, [ctx.loading, effectiveLimit, open]);
  const parsedK = Number(ctxDraft.trim());
  const parsedTokens = parsedK * 1000;
  const ctxInvalid =
    ctxDraft.trim() !== '' &&
    (!Number.isSafeInteger(parsedK) || parsedTokens < 1000 || parsedTokens > 100_000_000);
  const commitCtxDraft = useCallback(() => {
    if (!ctxDirtyRef.current || ctxInvalid || ctx.loading) return;
    ctxDirtyRef.current = false;
    void ctx.setLimit(ctxDraft.trim() === '' ? null : parsedTokens);
  }, [ctx, ctxDraft, ctxInvalid, parsedTokens]);
  const resetCtx = useCallback(() => {
    ctxDirtyRef.current = false;
    setCtxDraft(defaultWindow > 0 ? editableContextK(defaultWindow) : '');
    void ctx.reset();
  }, [ctx, defaultWindow]);

  if (!row || !primaryAgent || !primaryModel) {
    return (
      <Dialog.Root open={false} onOpenChange={onOpenChange}>
        <Dialog.Portal />
      </Dialog.Root>
    );
  }

  const vision =
    primaryModel.supportsImageInput !== undefined
      ? primaryModel.supportsImageInput
        ? 'vision'
        : 'no-vision'
      : primaryModel.modalities
        ? primaryModel.modalities.input.includes('image')
          ? 'vision'
          : 'no-vision'
        : classifyVisionCapability(primaryModel.id);
  const conversational = isAgentSelectableModel(primaryModel, {
    userProvider: provider.source === 'user',
  });
  // Same policy as the unified model selector. Visibility is a user preference,
  // so hiding an engine does not change which compatible engine we recommend.
  const recommendedAgent =
    conversational && !disabled && !paymentRequired
      ? pickRecommendedAgent(
          provider,
          row.id,
          row.avail.filter((agent) => {
            const model = row.byAgent[agent];
            return (
              model &&
              !model.disabled &&
              model.status !== 'retired' &&
              model.availability !== 'requires_payment'
            );
          }),
        )
      : null;
  const visibilityTargets = row.avail.flatMap((agent) => {
    const model = row.byAgent[agent];
    return model ? [{ agent, modelId: model.id }] : [];
  });
  const visibilityCustomized = visibilityTargets.some(({ agent, modelId }) =>
    isModelVisibilityCustomized(agent, provider.id, modelId),
  );
  const description = localizedModelDescription(primaryModel, t);
  const price = pricePresentationOf(primaryAgent, primaryModel);
  const protocols = modelProtocolComparison(provider, row.byAgent);
  const protocolLabel = (api: PiModelApi | null) =>
    api ? MODEL_PROTOCOL_LABEL[api] : t('settings.providers.models.advanced.undeclared');
  const displayedLimit = ctxDirtyRef.current
    ? ctxDraft.trim() === ''
      ? defaultWindow
      : parsedTokens
    : effectiveLimit;
  const editRouteWindow = contextModel?.contextWindowMax ?? defaultWindow;
  const overRouteWindow =
    editRouteWindow > 0 &&
    displayedLimit !== null &&
    Number.isFinite(displayedLimit) &&
    displayedLimit > editRouteWindow;

  const efforts = EFFORT_ORDER.filter((effort) =>
    row.avail.some((a) => row.byAgent[a]?.efforts.includes(effort)),
  );
  const commonEfforts = efforts.filter((intent) => row.avail.every((agent) => {
    const model = row.byAgent[agent];
    return !model?.efforts.length ||
      clampEffortToSupported(intent, model.efforts) ===
        (getProviderModelEffort(agent, provider.id, model.id) ?? model.defaultEffort);
  }));
  const preferredEffort = getProviderModelEffort(primaryAgent, provider.id, primaryModel.id)
    ?? primaryModel.defaultEffort;
  const effortMixed = efforts.length > 0 && commonEfforts.length === 0;
  const currentEffort = preferredEffort && commonEfforts.some((effort) => effort === preferredEffort)
    ? preferredEffort : commonEfforts[0] ?? null;
  const shownEfforts = efforts;
  /**
   * 推理强度的存储是 per (agent, provider, model) 的。这里按显示轴同一条哲学
   * **一次写该模型全部可用引擎** —— 用户在这个面板里选的是「这个模型默认想多用力」,
   * 同一选择写入全部可调引擎；不支持的档位只做能力适配，不留下另一套旧默认值。
   */
  const applyEffort = (effort: Effort) => {
    for (const agent of row.avail) {
      const model = row.byAgent[agent];
      if (!model) continue;
      if (!model.efforts.length) continue;
      setProviderModelEffort(agent, provider.id, model.id,
        clampEffortToSupported(effort, model.efforts) as Effort);
    }
  };

  const isLocalOllama = provider.id === MANAGED_OLLAMA_PROVIDER_ID;

  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay
            className={cn(
              'fixed inset-0 z-[10001] bg-[var(--overlay-modal)]',
              'data-[state=open]:animate-confirm-overlay-in',
              'data-[state=closed]:animate-confirm-overlay-out',
            )}
          />
          <Dialog.Content
            className={cn(
              'fixed inset-0 z-[10001] m-auto flex h-fit max-h-[calc(100dvh-48px)] w-[800px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl',
              'border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]',
              'data-[state=open]:animate-confirm-content-layout-in',
              'data-[state=closed]:animate-confirm-content-layout-out',
            )}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            aria-describedby={undefined}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              titleRef.current?.focus();
            }}
          >
            <header className="flex shrink-0 items-start gap-3 border-b border-[var(--settings-theme-card-border)] px-5 pb-3 pt-4">
              <div className="min-w-0 flex-1">
                <Dialog.Title
                  ref={titleRef}
                  tabIndex={-1}
                  className="break-words text-15 font-medium text-[var(--text-primary)] outline-none"
                >
                  {localizedModelName(primaryModel.name, t)}
                </Dialog.Title>
                <p className="mt-0.5 truncate text-12 text-[var(--text-tertiary)]">
                  {provider.id === 'xd' ? t('settings.providers.xd.title') : provider.name}
                </p>
              </div>
              <Dialog.Close
                className="-mr-1 -mt-1 shrink-0 rounded-full p-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--settings-menu-bg-hover)] hover:text-[var(--text-primary)]"
                aria-label={t('settings.providers.models.advanced.close')}
              >
                <X size={16} aria-hidden />
              </Dialog.Close>
            </header>

            <div
              key={`${provider.id}:${primaryModel.id}`}
              className="min-h-0 overflow-y-auto px-5 pb-5 pt-3"
            >
              <div className="grid gap-5 min-[760px]:grid-cols-2 min-[760px]:gap-6">
                <div className="min-w-0">
                  {conversational && (
                    <Section
                      title={t('settings.providers.models.advanced.engines')}
                      hint={t('settings.providers.models.advanced.enginesHint')}
                    >
                      {!selectionAvailable && (
                        <p className="mb-2 text-12 text-[var(--text-secondary)]">
                          {t('settings.providers.models.manage.connectionRequired')}
                        </p>
                      )}
                      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-11">
                        <span className="text-[var(--text-tertiary)]">
                          {t('settings.providers.models.advanced.protocol.reference')}
                        </span>
                        <span className="text-[var(--text-secondary)]">
                          {protocolLabel(protocols.reference)}
                        </span>
                      </div>
                      {provider.agents.map((agent) => {
                        const model = row.byAgent[agent];
                        const supported = Boolean(model);
                        const protocol = protocols.forAgent(agent);
                        const compatibility = protocol?.mode === 'compatibility';
                        const protocolId = `model-protocol-${agent}`;
                        const notes: string[] = [];
                        if (model) {
                          // 同一模型在不同引擎下的元数据差异如实标出来 —— 这些值来自目录的
                          // perAgent 覆盖，用户看到「Codex 下 272K / 6 档」才知道差异是真的。
                          if (model.contextWindow > 0 && model.contextWindow !== routeWindow) {
                            notes.push(approxTokens(model.contextWindow));
                          }
                          if (
                            model.supportsFastMode === false &&
                            primaryModel.supportsFastMode === true
                          ) {
                            notes.push(t('settings.providers.models.advanced.engineNoFast'));
                          }
                        }
                        return (
                          <div
                            key={agent}
                            className={cn(
                              'flex min-h-[34px] items-center gap-2.5 border-b border-[var(--settings-theme-card-border)] py-2 last:border-b-0',
                              !supported && 'opacity-50',
                            )}
                          >
                            <span
                              className="inline-flex h-5 w-4 shrink-0 self-start items-center justify-center leading-none"
                              style={{ color: MODEL_HARNESS_COLOR[agent] }}
                              aria-hidden
                            >
                              {AGENT_MARK[agent](14)}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1">
                                <span className="text-13 leading-5 text-[var(--text-primary)]">
                                  {AGENT_LABEL[agent]}
                                </span>
                                {agent === recommendedAgent && (
                                  <span className="rounded-full bg-[var(--surface-chip)] px-1.5 py-0.5 text-10 text-[var(--text-tertiary)]">
                                    {t('newChat.modelSelector.unified.recommended')}
                                  </span>
                                )}
                              </div>
                              {protocol && (
                                <p
                                  id={protocolId}
                                  className="mt-0.5 text-11 leading-4 text-[var(--text-tertiary)]"
                                >
                                  {protocolLabel(protocol.outbound)}
                                  {' · '}
                                  {compatibility ? (
                                    <ModelCompatibilityNotice />
                                  ) : (
                                    t(
                                      `settings.providers.models.advanced.protocol.${protocol.mode}`,
                                    )
                                  )}
                                </p>
                              )}
                            </div>
                            <span
                              className="min-w-0 max-w-[80px] truncate text-right text-11 text-[var(--text-tertiary)]"
                              title={supported ? notes.join(' · ') : undefined}
                            >
                              {supported ? (
                                notes.join(' · ')
                              ) : (
                                <Tip
                                  contentClassName="z-[10002]"
                                  text={t('settings.providers.models.advanced.engineUnsupported')}
                                >
                                  <button
                                    type="button"
                                    aria-label={`${AGENT_LABEL[agent]} · ${t('settings.providers.models.advanced.engineUnsupported')}`}
                                    className="inline-flex rounded-full p-1"
                                  >
                                    <CircleHelp size={13} aria-hidden />
                                  </button>
                                </Tip>
                              )}
                            </span>
                            <span className="inline-flex shrink-0 rounded-full border border-transparent p-0.5">
                              <Switch
                                aria-describedby={protocol ? protocolId : undefined}
                                data-compatibility={compatibility || undefined}
                                checked={
                                  selectionAvailable && supported
                                    ? isModelEnabled(agent, provider.id, model!)
                                    : false
                                }
                                disabled={!supported || paymentRequired || !selectionAvailable}
                                onCheckedChange={(next) => {
                                  if (!model || !selectionAvailable) return;
                                  if (
                                    setModelVisibility(agent, provider.id, model.id, next) === false
                                  ) {
                                    toast.error(
                                      t('settings.providers.models.visibilityWriteFailed'),
                                    );
                                  }
                                }}
                                aria-label={`${localizedModelName(primaryModel.name, t)} · ${AGENT_LABEL[agent]}`}
                              />
                            </span>
                          </div>
                        );
                      })}
                      {visibilityCustomized && !paymentRequired && selectionAvailable && (
                        <button
                          type="button"
                          onClick={() => {
                            if (!resetModelVisibilities(provider.id, visibilityTargets))
                              toast.error(t('settings.providers.models.visibilityWriteFailed'));
                          }}
                          className="mt-2 rounded-full px-2 py-1 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-chip)]"
                        >
                          {t('settings.providers.models.advanced.restoreDefault')}
                        </button>
                      )}
                    </Section>
                  )}

                  {conversational && efforts.length > 0 && (
                    <Section
                      title={t('settings.providers.models.advanced.defaultEffort')}
                      hint={t('settings.providers.models.advanced.defaultEffortHint')}
                    >
                      <div className="mt-1 flex flex-wrap gap-1 rounded-2xl border border-[var(--settings-theme-card-border)] p-[3px]">
                        {shownEfforts.map((effort) => {
                          const available = efforts.includes(effort);
                          const active = currentEffort === effort;
                          return (
                            <button
                              key={effort}
                              type="button"
                              disabled={!available || paymentRequired}
                              aria-pressed={active}
                              onClick={() => applyEffort(effort)}
                              className={cn(
                                'flex-1 rounded-full py-1 text-12 transition-colors',
                                active
                                  ? 'bg-[var(--settings-menu-bg-hover)] text-[var(--text-primary)]'
                                  : available
                                    ? 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                                    : 'cursor-not-allowed text-[var(--text-tertiary)] opacity-45',
                              )}
                            >
                              {t(`effortLevels.${effort}`)}
                            </button>
                          );
                        })}
                      </div>
                      {effortMixed && (
                        <p className="mt-1.5 text-12 text-[var(--text-tertiary)]">
                          {t('settings.providers.models.advanced.effortMixed')}
                        </p>
                      )}
                      {row.avail.some(
                        (a) =>
                          getProviderModelEffort(a, provider.id, row.byAgent[a]!.id) !== undefined,
                      ) && (
                        <button
                          type="button"
                          disabled={paymentRequired}
                          onClick={() => {
                            for (const a of row.avail)
                              clearProviderModelEffort(a, provider.id, row.byAgent[a]!.id);
                          }}
                          className="mt-2 rounded-full px-2 py-1 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-chip)]"
                        >
                          {t('settings.providers.models.advanced.restoreDefault')}
                        </button>
                      )}
                    </Section>
                  )}

                  {conversational && (
                    <Section
                      title={t('settings.providers.models.advanced.contextLimit')}
                      hint={t('settings.providers.models.advanced.contextLimitHint')}
                    >
                      {separateCodexContext && (
                        <p
                          data-codex-context-note
                          className="mb-2 text-12 leading-relaxed text-[var(--text-secondary)]"
                        >
                          {t('settings.providers.models.advanced.codexContextHint')}
                        </p>
                      )}
                      {contextTarget && (
                        <>
                          {separateCodexContext && (
                            <p className="mb-1 text-11 text-[var(--text-tertiary)]">
                              {[
                                contextTarget.agent,
                                ...(contextTarget.relatedTargets ?? []).map(
                                  (target) => target.agent,
                                ),
                              ]
                                .map((agent) => AGENT_LABEL[agent])
                                .join(' / ')}
                            </p>
                          )}
                          <div className="mt-1 flex flex-wrap items-center gap-2.5">
                            <span
                              className={cn(
                                'inline-flex h-7 items-center gap-1 rounded-full border px-2',
                                overRouteWindow
                                  ? 'border-[var(--warning-fg)]'
                                  : 'border-[var(--settings-theme-card-border)]',
                              )}
                            >
                              <input
                                value={ctxDraft}
                                onChange={(event) => {
                                  ctxDirtyRef.current = true;
                                  setCtxDraft(event.target.value);
                                }}
                                onBlur={commitCtxDraft}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') {
                                    event.preventDefault();
                                    event.currentTarget.blur();
                                  }
                                }}
                                aria-invalid={ctxInvalid || undefined}
                                inputMode="numeric"
                                disabled={paymentRequired || ctx.loading}
                                aria-label={t(
                                  'settings.providers.models.advanced.contextLimitAria',
                                )}
                                className="w-20 bg-transparent text-center text-13 tabular-nums text-[var(--text-primary)] outline-none"
                              />
                              <span className="text-11 text-[var(--text-tertiary)]">K</span>
                            </span>
                            <span className="min-w-0 flex-1 text-11 tabular-nums text-[var(--text-tertiary)]">
                              {t('settings.providers.models.advanced.contextLimitRoute', {
                                tokens: formatExactTokens(
                                  !ctxInvalid ? (displayedLimit ?? 0) : (effectiveLimit ?? 0),
                                  locale,
                                ),
                              })}
                            </span>
                            {ctx.isCustomized && (
                              <button
                                type="button"
                                onClick={resetCtx}
                                disabled={paymentRequired || ctx.loading}
                                className="shrink-0 text-11 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
                              >
                                {t('settings.providers.models.advanced.restoreDefault')}
                              </button>
                            )}
                          </div>
                          {(ctxInvalid || ctx.error || ctx.mixed) && (
                            <p role="status" className="mt-1.5 text-12 text-[var(--warning-fg)]">
                              {t(
                                `settings.providers.models.advanced.${ctxInvalid ? 'contextInvalid' : ctx.error ? 'contextWriteFailed' : 'contextMixed'}`,
                              )}
                            </p>
                          )}
                          {overRouteWindow && (
                            <p className="mt-1.5 flex items-start gap-1.5 text-11 leading-[1.5] text-[var(--warning-fg)]">
                              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                              {t('settings.providers.models.advanced.contextLimitOverWindow')}
                            </p>
                          )}
                        </>
                      )}
                    </Section>
                  )}

                  <Section title={t('settings.providers.models.advanced.spec')}>
                    <Row label={t('settings.providers.models.advanced.contextWindow')}>
                      {routeWindow > 0 ? (
                        <>
                          {formatExactTokens(routeWindow, locale)}
                          <span className="ml-1 text-11 text-[var(--text-tertiary)]">
                            {t('settings.providers.models.advanced.tokensApprox', {
                              approx: approxTokens(routeWindow),
                            })}
                          </span>
                        </>
                      ) : (
                        <span className="text-[var(--text-tertiary)]">
                          {t('settings.providers.models.advanced.catalogMissing')}
                        </span>
                      )}
                    </Row>
                    {primaryModel.maxOutput !== undefined && (
                      <Row label={t('settings.providers.models.advanced.maxOutput')}>
                        {formatExactTokens(primaryModel.maxOutput, locale)}
                      </Row>
                    )}
                  </Section>
                </div>
                <div className="min-w-0 border-t border-[var(--settings-theme-card-border)] pt-4 min-[760px]:border-l min-[760px]:border-t-0 min-[760px]:pl-6 min-[760px]:pt-0">
                  <Section
                    title={t('settings.providers.models.advanced.capability')}
                    hint={t('settings.providers.models.advanced.capabilityHint')}
                  >
                    <Row label={t('settings.providers.models.advanced.imageInput')}>
                      <span
                        title={
                          primaryModel.modalities || primaryModel.supportsImageInput !== undefined
                            ? t('settings.providers.models.advanced.catalogCapabilities')
                            : t(`settings.providers.models.advanced.visionSource.${vision}`)
                        }
                      >
                        <CapabilityValue
                          state={
                            vision === 'vision' ? true : vision === 'no-vision' ? false : undefined
                          }
                          label={t(`settings.providers.models.advanced.vision.${vision}`)}
                        />
                      </span>
                    </Row>
                    {primaryModel.modalities &&
                      (['input', 'output'] as const).map((direction) => (
                        <Row
                          key={direction}
                          label={t(`settings.providers.models.advanced.${direction}Modalities`)}
                        >
                          {primaryModel
                            .modalities![direction].map((modality) =>
                              ['text', 'image', 'audio', 'video', 'file'].includes(modality)
                                ? t(`settings.providers.models.advanced.modalities.${modality}`)
                                : modality,
                            )
                            .join(' · ') || t('settings.providers.models.advanced.undeclared')}
                        </Row>
                      ))}
                    <Row label="Fast" muted>
                      <CapabilityValue
                        state={primaryModel.supportsFastMode}
                        label={t(
                          `settings.providers.models.advanced.${primaryModel.supportsFastMode === true ? 'supported' : primaryModel.supportsFastMode === false ? 'unsupported' : 'undeclared'}`,
                        )}
                      />
                    </Row>
                  </Section>

                  <Section title={t('settings.providers.models.advanced.pricing')}>
                    {price === null ? (
                      <Row label={t('settings.providers.models.advanced.pricingLabel')} muted>
                        {t(
                          provider.access?.kind === 'subscription'
                            ? 'settings.providers.models.subscription'
                            : 'settings.providers.models.advanced.noPricing',
                        )}
                      </Row>
                    ) : price.kind === 'free' ? (
                      <Row label={t('settings.providers.models.advanced.pricingLabel')}>
                        {t('newChat.modelSelector.pricing.free')}
                      </Row>
                    ) : (
                      modelPriceDetailRows(price.current, price.original).map((detail) => (
                        <Row
                          key={detail.kind}
                          label={t(`settings.providers.models.advanced.price.${detail.kind}`)}
                        >
                          {/* 有折扣时给**实付价**，标准价划掉跟在后面：只写标准价再另起一行
                          「折扣 40%」等于让人自己乘一遍，而实付才是他要判断的数。 */}
                          {detail.value}
                          {detail.originalValue && (
                            <span className="ml-1.5 text-11 text-[var(--text-tertiary)] line-through">
                              {detail.originalValue}
                            </span>
                          )}
                          <span className="ml-1 text-11 text-[var(--text-tertiary)]">
                            {t('settings.providers.models.advanced.perMtok')}
                          </span>
                        </Row>
                      ))
                    )}
                    {price?.kind === 'priced' && price.discount !== undefined && (
                      <Row label={t('settings.providers.models.advanced.discount')}>
                        <span
                          className="inline-flex items-center rounded-full px-2 py-[1px] text-10 font-medium"
                          style={{
                            color: EFFORT_TIER_COLORS.low,
                            backgroundColor: `color-mix(in srgb, ${EFFORT_TIER_COLORS.low} 14%, transparent)`,
                          }}
                        >
                          {`↓${Math.round(price.discount * 100)}%`}
                        </span>
                      </Row>
                    )}
                    {/* 自定义报价:原「⋯」菜单的一项,搬到它真正相关的段落里。
                    XD 网关的价格由服务端定,不给覆盖入口(与 IPC 侧的拒绝一致)。 */}
                    {provider.id !== 'xd' && !paymentRequired && (
                      <button
                        type="button"
                        onClick={() => setPriceDialogOpen(true)}
                        className="mt-2 text-12 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                      >
                        {t('settings.providers.models.priceOverride.menu')}
                      </button>
                    )}
                  </Section>
                  <Section title={t('settings.providers.models.advanced.identity')}>
                    {description && (
                      <p className="mb-2 text-12 leading-relaxed text-[var(--text-secondary)]">{description}</p>
                    )}
                    <Row label={t('settings.providers.models.advanced.modelId')}>
                      <code className="select-text break-all text-12">{primaryModel.id}</code>
                    </Row>
                    {modelBrand(primaryModel) && (
                      <Row label={t('settings.providers.models.management.brand')} muted>
                        {localizedBrandName(modelBrand(primaryModel)!, t)}
                      </Row>
                    )}
                    {primaryModel.status && primaryModel.status !== 'active' && (
                      <Row label={t('settings.providers.models.advanced.status')} muted>
                        {t(`settings.providers.models.advanced.lifecycle.${primaryModel.status}`)}
                      </Row>
                    )}
                  </Section>
                </div>
              </div>
            </div>

            {/* 动作区:准入轴与本机文件。与上面的显示轴刻意隔开一段留白 ——
                  它们不是同一件事,放在一起会让人以为关了开关就等于停用。 */}
            {!paymentRequired && (
              <div className="flex shrink-0 flex-col gap-2 border-t border-[var(--settings-theme-card-border)] px-5 py-3">
                <button
                  type="button"
                  disabled={disabled && !selectionAvailable}
                  onClick={() => onDisable(row)}
                  className="h-8 rounded-full disabled:opacity-50 border border-[var(--settings-btn-secondary-border)] text-13 text-[var(--settings-btn-secondary-text)] transition-colors hover:bg-[var(--settings-menu-bg-hover)]"
                >
                  {disabled
                    ? t('settings.providers.models.enableModel')
                    : t('settings.providers.models.disableModel')}
                </button>
                {isLocalOllama && onDeleteLocal && (
                  <button
                    type="button"
                    onClick={() => onDeleteLocal(row)}
                    className="flex h-8 items-center justify-center gap-1.5 rounded-full text-13 text-[var(--error-flat)] transition-colors hover:bg-[var(--settings-menu-bg-hover)]"
                  >
                    <Trash2 size={13} />
                    {t('settings.providers.local.deleteModel')}
                  </button>
                )}
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {priceDialogOpen && (
        <ModelPriceOverrideDialog
          provider={provider}
          row={row}
          open={priceDialogOpen}
          onOpenChange={setPriceDialogOpen}
        />
      )}
    </>
  );
}
