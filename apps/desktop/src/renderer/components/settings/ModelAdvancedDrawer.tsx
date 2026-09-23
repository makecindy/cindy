import { Button } from '@/components/ui/button';
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
import { AlertTriangle, Check, ChevronDown, CircleHelp, Minus, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { SegmentedControl } from '@/components/ui/segmented-control';
import { cn } from '@/lib/utils';
import { providerViewToCustomProviderConfig, updateCustomProvider } from '@/lib/customProviders';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@/components/ui/dropdown-menu';
import { MODEL_HARNESS_COLOR } from '@/lib/modelHarnessPresentation';
import { ModelCompatibilityNotice } from '@/components/new-chat/ModelCompatibilityNotice';
import { MODEL_PROTOCOL_LABEL, MODEL_PROTOCOL_OPTIONS } from '@/lib/modelProtocolLabel';
import { toast } from '@/lib/toast';
import { Tip } from '@/components/ui/tooltip';
import { Switch } from '@/components/ui/switch';
import { ClaudeMark } from '@/components/icons/ClaudeMark';
import { CodexMark } from '@/components/icons/CodexMark';
import { PiMark } from '@/components/icons/PiMark';
import { useModelContextLimit } from '@/hooks/useModelContextLimit';
import { useModelCatalogImageInput } from '@/hooks/useModelCatalogImageInput';
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
  providerWireProtocolForApi,
  providerBaseUrlForApi,
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

import { isLocalRuntimeBetaProviderId, MANAGED_OLLAMA_PROVIDER_ID } from '../../../shared/localModelRuntime';
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
  const [protocolSaving, setProtocolSaving] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  // 开关/档位写的是 renderer 本地存储，订阅 version 才能在写后重渲染。
  useModelVisibilityVersion();
  useProviderModelMemoryVersion();

  /**
   * 主展示引擎:该模型可用引擎里的第一个。只读事实(上下文、报价、能力)按它取 ——
   * 同一模型跨引擎的元数据可能不同,抽屉顶部标注了这一点,逐引擎差异在「引擎支持」段展开。
   */
  const chatAgents = useMemo(() => (row?.avail ?? []).filter((agent) => {
    const model = row?.byAgent[agent];
    return model && isAgentSelectableModel(model, { userProvider: provider.source === 'user' });
  }), [row, provider.source]);
  const primaryCandidates = chatAgents?.length ? chatAgents : row?.avail;
  const primaryAgent =
    primaryCandidates?.find((agent) =>
      provider.id === 'openai'
        ? agent === 'codex'
        : provider.id === 'anthropic'
          ? agent === 'claude-code'
          : agent === 'pi',
    ) ?? primaryCandidates?.[0] ?? null;
  const primaryModel = row && primaryAgent ? (row.byAgent[primaryAgent] ?? null) : null;

  const contextAgent = primaryAgent && chatAgents.includes(primaryAgent) ? primaryAgent : null;
  const contextModel = contextAgent ? row?.byAgent[contextAgent] : null;

  const contextTarget = useMemo(
    () =>
      contextAgent && contextModel
        ? {
            providerId: provider.id,
            agent: contextAgent,
            modelId: contextModel.id,
            relatedTargets: chatAgents
              .filter((a) => a !== contextAgent)
              .flatMap((agent) => {
                const model = row?.byAgent[agent];
                return model ? [{ providerId: provider.id, agent, modelId: model.id }] : [];
              }),
          }
        : null,
    [contextAgent, contextModel, provider.id, row, chatAgents],
  );
  const ctx = useModelContextLimit(open ? contextTarget : null);
  // 图片输入能力的本地声明。与上下文上限同一个目标形状；agent 只用于目录成员校验。
  // 必须覆盖该行全部引擎的 id：运行期真正消费这个能力的只有 Pi，而桥接投影两端 id 不同
  // （openai 行：codex 用 gpt-5.6-sol、pi 用 chatgpt/gpt-5.6-sol）—— 只写主展示引擎的 id，
  // Pi 侧读不到（override 按 providerId:modelId 精确匹配），UI 却会显示「已声明」。
  const imageInputTarget = useMemo(() => {
    if (!open || !primaryAgent || !primaryModel) return null;
    const relatedTargets = (row?.avail ?? [])
      .filter((agent) => agent !== primaryAgent)
      .flatMap((agent) => {
        const model = row?.byAgent[agent];
        return model ? [{ providerId: provider.id, agent, modelId: model.id }] : [];
      });
    return {
      providerId: provider.id,
      agent: primaryAgent,
      modelId: primaryModel.id,
      ...(relatedTargets.length > 0 ? { relatedTargets } : {}),
    };
  }, [open, primaryAgent, primaryModel, provider.id, row]);
  const imageInput = useModelCatalogImageInput(imageInputTarget);
  // 'inherit' = 删除本机 override，回到跟随供应商。失败由 hook 回读真值，这里只负责提示。
  const setImageInput = async (next: string) => {
    const value = next === 'inherit' ? null : next === 'true';
    // 已经是该状态就别再写一次：免掉一次空写入引起的全量目录刷新与广播。但各引擎键分叉时
    // 必须放行 —— 否则“重选当前项”被 no-op 挡掉，分叉永远修不掉（UI 显示一侧、运行期读另一侧）。
    const already =
      value === null ? !imageInput.isCustomized : imageInput.isCustomized && value === imageInput.value;
    if (already && !imageInput.diverged) {
      return;
    }
    const persisted = await imageInput.setValue(value);
    if (!persisted) {
      // main 在这条路径上会给出可执行指引（手改文件里有无法保留的条目时要先修文件）：
      // 把它带进提示，否则用户反复保存失败却看不到唯一的修复方式。
      const reason = imageInput.errorReason;
      toast.error(
        reason
          ? t('settings.providers.models.advanced.imageInputOverride.saveFailedWithReason', {
              message: reason,
            })
          : t('settings.providers.models.advanced.imageInputOverride.saveFailed'),
      );
    }
  };
  const setModelApi = async (agent: AgentKind, api: PiModelApi) => {
    if (protocolSaving || provider.source !== 'user' || provider.auth?.native || !row?.byAgent[agent]) return;
    const config = providerViewToCustomProviderConfig(provider);
    const runtime = config.runtimes[agent];
    const model = runtime?.models.find(m => m.id === row.byAgent[agent]!.id);
    if (!runtime || !model) return;
    model.api = api;
    if (agent === 'pi') model.piApi = api;
    const wire = providerWireProtocolForApi(api);
    if (!wire) return;
    const existingRoute = { ...(model.route ?? {}) };
    delete existingRoute.requestPath;
    model.route = {
      ...existingRoute,
      baseUrl: providerBaseUrlForApi(model.route?.baseUrl ?? runtime.baseUrl, api),
      wireProtocol: wire,
    };
    setProtocolSaving(true);
    try {
      const result = await updateCustomProvider(config, {}, { source: 'manual-settings' });
      if (!result.ok) toast.error(t('settings.providers.custom.toast.saveFailed'));
    }
    catch { toast.error(t('settings.providers.custom.toast.saveFailed')); }
    finally { setProtocolSaving(false); }
  };


  const [ctxDraft, setCtxDraft] = useState('');
  // 提交后写入是异步的：hook 先置 loading、等 IPC 回声才落新值。若提交瞬间就丢掉草稿，
  // 说明行会先退回**旧的** effectiveLimit、回声到了再跳新值 —— 用户实测到的「闪一下旧值」。
  // 这里把「提交在途」也当成还在编辑：显示值继续取草稿，直到写入收口。
  const [ctxCommitting, setCtxCommitting] = useState(false);
  // 提交代次：目标（模型/agent/provider）一变或又一次提交开始，旧提交的 finally 就不许再
  // 清掉新的 committing 状态 —— 否则 A 写未完成时切到 B 并提交，A 完成会把 B 的「提交在途」
  // 提前收掉，B 在写入期间重新显示旧的 effectiveLimit（本次修改要消除的闪回原地复活）。
  const ctxCommitGen = useRef(0);
  const ctxDirtyRef = useRef(false);
  const defaultWindow = contextAgent === 'codex' && ctx.codexContext
    ? ctx.codexContext.contextWindow : contextModel?.contextWindow ?? 0;
  // The editor guard is not a native request-capacity limit. Keep small/local
  // model windows selectable and never derive this floor from a saved override.
  // Local runtimes own their loaded window; their catalog maximum cannot set an editor floor.
  const modelWindows = chatAgents.map((agent) => row?.byAgent[agent]?.contextWindow)
    .filter((window): window is number => typeof window === 'number' && Number.isFinite(window) && window > 0);
  const minimumContextK = isLocalRuntimeBetaProviderId(provider.id)
    ? 1 : Math.max(1, Math.floor(Math.min(100_000, ...modelWindows) / 1000));
  // 「上游最大上下文」这一行显示上游**确实下发过**的窗口，来源按优先级：
  //   1) contextWindowMax —— 路由/网关声明的容量；
  //   2) contextWindowVerified === true 的 contextWindow —— 用户或预设显式配置的窗口
  //      （预设/服务端目录给自定义连接下发窗口就走这里，例如 opencode-go 的 deepseek-v4.1-flash = 1M）；
  //   3) 都没有 → 未声明。
  // 第 3 条必须排除「自定义模型缺元数据时的 200K 兜底」：那个常量在 user-provider.ts 里
  // 明确写着「仅用于展示」，不带 contextWindowVerified —— 把它印成上游下发的窗口，会让用户
  // 以为容量只有 200K，而运行期窗口其实取模型级上下文上限（实测报障：圆环 1.0M、这里 200K）。
  const declaredCapacity = primaryModel?.contextWindowMax ?? 0;
  const declaredWindow =
    declaredCapacity > 0
      ? declaredCapacity
      : primaryModel?.contextWindowVerified === true
        ? (primaryModel.contextWindow ?? 0)
        : 0;
  const effectiveLimit = ctx.limit ?? (defaultWindow > 0 ? defaultWindow : null);
  useEffect(() => {
    ctxDirtyRef.current = false;
    ctxCommitGen.current += 1;
    setCtxCommitting(false);
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
    ctxDirtyRef.current && ctxDraft.trim() !== '' &&
    (!Number.isSafeInteger(parsedK) || parsedK < minimumContextK || parsedTokens > 100_000_000);
  const commitCtxDraft = useCallback(() => {
    if (!ctxDirtyRef.current || ctxInvalid || ctx.loading) return;
    ctxDirtyRef.current = false;
    const generation = (ctxCommitGen.current += 1);
    setCtxCommitting(true);
    // hook 的 promise 在它把新值（或失败回滚后的值）写进 state 之后才 resolve，
    // 所以这里收口不会再产生一帧旧值。仅当没有更新的提交/重置发生时才能清状态。
    void Promise.resolve(ctx.setLimit(ctxDraft.trim() === '' ? null : parsedTokens)).finally(() => {
      if (ctxCommitGen.current === generation) setCtxCommitting(false);
    });
  }, [ctx, ctxDraft, ctxInvalid, parsedTokens]);
  const resetCtx = useCallback(() => {
    ctxDirtyRef.current = false;
    ctxCommitGen.current += 1;
    setCtxCommitting(false);
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
              isAgentSelectableModel(model, { userProvider: provider.source === 'user' }) &&
              !model.disabled &&
              model.status !== 'retired' &&
              model.availability !== 'requires_payment'
            );
          }),
        )
      : null;
  const visibilityTargets = row.avail.flatMap((agent) => {
    const model = row.byAgent[agent];
    return model && isAgentSelectableModel(model, { userProvider: provider.source === 'user' }) ? [{ agent, modelId: model.id }] : [];
  });
  const visibilityCustomized = visibilityTargets.some(({ agent, modelId }) =>
    isModelVisibilityCustomized(agent, provider.id, modelId),
  );
  const description = localizedModelDescription(primaryModel, t);
  const price = pricePresentationOf(primaryAgent, primaryModel);
  const protocols = modelProtocolComparison(provider, row.byAgent);
  const protocolLabel = (api: PiModelApi | null) =>
    api ? MODEL_PROTOCOL_LABEL[api] ?? null : t('settings.providers.models.advanced.undeclared');
  const displayedLimit = ctxDirtyRef.current || ctxCommitting
    ? ctxDraft.trim() === ''
      ? defaultWindow
      : parsedTokens
    : effectiveLimit;
  // 只有「上游声明的容量」比它小时才该告警；未声明容量时拿工作默认值当窗口会误报
  // （自定义连接上 200K 只是兜底，不是任何人的声明）。来源与上方「上游最大上下文」同一套：
  // contextWindowMax → 已验证的 contextWindow → 未声明，否则「已验证窗口但无 max」的模型
  // 把限制填到窗口以上也不会告警。
  const editCapacity = contextModel?.contextWindowMax ?? 0;
  const editRouteWindow =
    editCapacity > 0
      ? editCapacity
      : contextModel?.contextWindowVerified === true
        ? (contextModel.contextWindow ?? 0)
        : 0;
  const overRouteWindow =
    editRouteWindow > 0 &&
    displayedLimit !== null &&
    Number.isFinite(displayedLimit) &&
    displayedLimit > editRouteWindow;

  const efforts = EFFORT_ORDER.filter((effort) =>
    chatAgents.some((a) => row.byAgent[a]?.efforts.includes(effort)),
  );
  const commonEfforts = efforts.filter((intent) => chatAgents.every((agent) => {
    const model = row.byAgent[agent];
    return !model?.efforts.length ||
      clampEffortToSupported(intent, model.efforts) ===
        (getProviderModelEffort(agent, provider.id, model.id) ?? model.defaultEffort);
  }));
  const preferredEffort = conversational
    ? getProviderModelEffort(primaryAgent, provider.id, primaryModel.id) ?? primaryModel.defaultEffort
    : null;
  const effortMixed = efforts.length > 0 && commonEfforts.length === 0;
  const currentEffort = preferredEffort && commonEfforts.some((effort) => effort === preferredEffort)
    ? preferredEffort : commonEfforts[0] ?? null;
  const shownEfforts = EFFORT_ORDER.filter((effort) =>
    chatAgents.some((agent) => {
      const model = row.byAgent[agent];
      return model?.efforts.includes(effort) || model?.displayEfforts?.includes(effort);
    }),
  );
  /**
   * 推理强度的存储是 per (agent, provider, model) 的。这里按显示轴同一条哲学
   * **一次写该模型全部可用引擎** —— 用户在这个面板里选的是「这个模型默认想多用力」,
   * 同一选择写入全部可调引擎；不支持的档位只做能力适配，不留下另一套旧默认值。
   */
  const applyEffort = (effort: Effort) => {
    if (!efforts.includes(effort)) return;
    for (const agent of chatAgents) {
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
                      {protocols.reference && protocolLabel(protocols.reference) && <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-11">
                        <span className="text-[var(--text-tertiary)]">
                          {t('settings.providers.models.advanced.protocol.reference')}
                        </span>
                        <span className="text-[var(--text-secondary)]">
                          {protocolLabel(protocols.reference)}
                        </span>
                      </div>}
                      {provider.agents.map((agent) => {
                        const model = row.byAgent[agent];
                        // Missing catalog membership proves no configured route, not upstream incompatibility.
                        const supported = Boolean(model && isAgentSelectableModel(model, { userProvider: provider.source === 'user' }));
                        const protocol = protocols.forAgent(agent);
                        const compatibility = protocol?.mode === 'compatibility';
                        const protocolId = `model-protocol-${agent}`;
                        const notes: string[] = [];
                        if (model) {
                          // 同一模型在不同引擎下的元数据差异如实标出来 —— 这些值来自目录的
                          // perAgent 覆盖，用户看到「Codex 下 272K / 6 档」才知道差异是真的。
                          if (
                            model.contextWindow > 0 &&
                            model.contextWindow !==
                              (declaredWindow > 0
                                ? declaredWindow
                                : (primaryModel?.contextWindow ?? 0))
                          ) {
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
                                  {provider.source === 'user' && !provider.auth?.native && !model?.catalogPresetId && supported ? (
                                    <DropdownMenu>
                                      <DropdownMenuTrigger asChild>
                                        <button type="button" disabled={protocolSaving}
                                          aria-label={`${AGENT_LABEL[agent]} · ${t('settings.providers.custom.fields.wireProtocol')}`}
                                          className="rounded-full px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]">
                                          {protocolLabel(protocol.outbound)} <ChevronDown size={12} className="inline" aria-hidden />
                                        </button>
                                      </DropdownMenuTrigger>
                                      <DropdownMenuContent className="z-[10003]" align="start">
                                        <DropdownMenuRadioGroup value={protocol.outbound ?? ''}
                                          onValueChange={value => void setModelApi(agent, value as PiModelApi)}>
                                          {MODEL_PROTOCOL_OPTIONS.map(([api, label]) => <DropdownMenuRadioItem key={api} value={api}>{label}</DropdownMenuRadioItem>)}
                                        </DropdownMenuRadioGroup>
                                      </DropdownMenuContent>
                                    </DropdownMenu>
                                  ) : protocolLabel(protocol.outbound)}
                                  {/* Missing manufacturer metadata does not make a configured
                                      outbound protocol unconfirmed. Keep that distinction in
                                      the manufacturer reference when one is declared. */}
                                  {(protocol.mode !== 'unknown' || !protocol.outbound) && <>
                                    {protocolLabel(protocol.outbound) && ' · '}
                                    {compatibility ? <ModelCompatibilityNotice /> : t(
                                      `settings.providers.models.advanced.protocol.${protocol.mode}`,
                                    )}
                                  </>}
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
                                  text={t('settings.providers.models.advanced.engineNotConfigured')}
                                >
                                  <button
                                    type="button"
                                    aria-label={`${AGENT_LABEL[agent]} · ${t('settings.providers.models.advanced.engineNotConfigured')}`}
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
                                onCheckedChange={async (next) => {
                                  if (!model || !selectionAvailable) return;
                                  if (
                                    await setModelVisibility(agent, provider.id, model.id, next) === false
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
                        <Button
                          variant="secondary"
                          size="sm"
                          tone="quiet"
                          compact
                          type="button"
                          onClick={async () => {
                            if (!await resetModelVisibilities(provider.id, visibilityTargets))
                              toast.error(t('settings.providers.models.visibilityWriteFailed'));
                          }}
                          className="mt-2"
                        >
                          {t('settings.providers.models.advanced.restoreDefault')}
                        </Button>
                      )}
                    </Section>
                  )}

                  {conversational && shownEfforts.length > 0 && (
                    <Section
                      title={t('settings.providers.models.advanced.defaultEffort')}
                      hint={t('settings.providers.models.advanced.defaultEffortHint')}
                    >
                      <SegmentedControl
                        className="mt-1"
                        fullWidth
                        height={32}
                        optionHeight={24}
                        aria-label={t('settings.providers.models.advanced.defaultEffort')}
                        value={shownEfforts.find((effort) => effort === currentEffort) ?? null}
                        onValueChange={applyEffort}
                        disabled={paymentRequired}
                        options={shownEfforts.map((effort) => ({
                          value: effort,
                          label: t(`effortLevels.${effort}`),
                          disabled: !efforts.includes(effort),
                        }))}
                      />
                      {effortMixed && (
                        <p className="mt-1.5 text-12 text-[var(--text-tertiary)]">
                          {t('settings.providers.models.advanced.effortMixed')}
                        </p>
                      )}
                      {chatAgents.some(
                        (a) =>
                          getProviderModelEffort(a, provider.id, row.byAgent[a]!.id) !== undefined,
                      ) && (
                        <Button
                          variant="secondary"
                          size="sm"
                          tone="quiet"
                          compact
                          type="button"
                          disabled={paymentRequired}
                          onClick={() => {
                            for (const a of chatAgents)
                              clearProviderModelEffort(a, provider.id, row.byAgent[a]!.id);
                          }}
                          className="mt-2"
                        >
                          {t('settings.providers.models.advanced.restoreDefault')}
                        </Button>
                      )}
                    </Section>
                  )}

                  {conversational && (
                    <Section
                      title={t('settings.providers.models.advanced.contextLimit')}
                      hint={t(/^(?:(?:codex|openai|chatgpt)\/)?gpt-/.test(primaryModel.id) && provider.source !== 'user' && ['openai', 'xd'].includes(provider.id)
                        ? 'settings.providers.models.advanced.contextLimitGptHint'
                        : 'settings.providers.models.advanced.contextLimitHint')}
                    >
                      {contextTarget && (
                        <>
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
                                { min: minimumContextK },
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
                      {declaredWindow > 0 ? (
                        <>
                          {formatExactTokens(declaredWindow, locale)}
                          <span className="ml-1 text-11 text-[var(--text-tertiary)]">
                            {t('settings.providers.models.advanced.tokensApprox', {
                              approx: approxTokens(declaredWindow),
                            })}
                          </span>
                        </>
                      ) : (
                        <span className="text-[var(--text-tertiary)]">
                          {t('settings.providers.models.advanced.undeclared')}
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
                      {/*
                        三态声明：目录未声明图片能力时，Pi 会在客户端就拒收图片（请求根本不出网），
                        用户此前没有任何可点的入口去声明它 —— 报错文案让人去开的开关并不存在。
                        这里把状态与声明合成一个控件：图标+文案保留「目录怎么说」的事实，
                        下拉写本机目录 override（不改连接配置，preset 连接因此仍跟随官方目录）。
                      */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            // 只在真写入期间禁用。刷新期间(hook 收到 PROVIDER_CHANGED 会重读)
                            // 值原样保留，禁用它只会造成一次多余的明暗跳变；透明度也不动 ——
                            // 与同抽屉协议控件一致(disabled 但不改 opacity)。
                            disabled={imageInput.saving || provider.id === 'xd'}
                            aria-label={t('settings.providers.models.advanced.imageInputOverride.label')}
                            title={
                              primaryModel.modalities || primaryModel.supportsImageInput !== undefined
                                ? t('settings.providers.models.advanced.catalogCapabilities')
                                : t(`settings.providers.models.advanced.visionSource.${vision}`)
                            }
                            className="inline-flex items-center gap-1 rounded-full px-2 py-1 hover:bg-[var(--surface-hover)]"
                          >
                            <CapabilityValue
                              state={
                                vision === 'vision' ? true : vision === 'no-vision' ? false : undefined
                              }
                              label={t(`settings.providers.models.advanced.vision.${vision}`)}
                            />
                            <span className="text-11 text-[var(--text-tertiary)]">
                              {imageInput.isCustomized
                                ? imageInput.value === true
                                  ? t('settings.providers.models.advanced.imageInputOverride.declaredTrue')
                                  : t('settings.providers.models.advanced.imageInputOverride.declaredFalse')
                                : t('settings.providers.models.advanced.imageInputOverride.inherit')}
                            </span>
                            <ChevronDown size={12} className="inline" aria-hidden />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent className="z-[10003]" align="end">
                          <DropdownMenuRadioGroup
                            value={
                              imageInput.isCustomized ? String(imageInput.value) : 'inherit'
                            }
                            onValueChange={(next) => void setImageInput(next)}
                          >
                            <DropdownMenuRadioItem value="inherit">
                              {t('settings.providers.models.advanced.imageInputOverride.inherit')}
                            </DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="true">
                              {t('settings.providers.models.advanced.imageInputOverride.declaredTrue')}
                            </DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="false">
                              {t('settings.providers.models.advanced.imageInputOverride.declaredFalse')}
                            </DropdownMenuRadioItem>
                          </DropdownMenuRadioGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
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

            {/* Missing manufacturer metadata does not make a configured
                outbound protocol unconfirmed. Keep that distinction in
                the manufacturer reference when one is declared. */}
            {!paymentRequired && (
              <div className="flex shrink-0 flex-col gap-2 border-t border-[var(--settings-theme-card-border)] px-5 py-3">
                <Button
                  variant="secondary"
                  size="md"
                  compact
                  type="button"
                  disabled={disabled && !selectionAvailable}
                  onClick={() => onDisable(row)}
                >
                  {disabled
                    ? t('settings.providers.models.enableModel')
                    : t('settings.providers.models.disableModel')}
                </Button>
                {isLocalOllama && onDeleteLocal && (
                  <Button
                    variant="secondary"
                    size="md"
                    tone="danger"
                    compact
                    type="button"
                    onClick={() => onDeleteLocal(row)}
                  >
                    <Trash2 size={13} />
                    {t('settings.providers.local.deleteModel')}
                  </Button>
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
