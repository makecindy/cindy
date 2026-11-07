import { modelImageInputDefault } from '../../../shared/modelImageInputOverride';
import { displayPricingComponent, isDisplayPricingTableRedundant } from '@/lib/displayPricingFormat';
import { DisplayPricingDetails, DisplayPricingQuote } from '@/components/DisplayPricingDetails';
import { Button } from '@/components/ui/button';
import { localizedModelDescription } from '@/lib/modelDescriptions';
import { providerDisplayName } from '@/lib/providerDisplayName';
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
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
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
import { useModelImageInputOverride } from '@/hooks/useModelImageInputOverride';
import { parseContextTokenInput } from '../../../shared/modelContextLimit';
import { useModelCatalogThinking } from '@/hooks/useModelCatalogThinking';
import { ModelCompactionSettings } from './ModelCompactionSettings';
import { modelPriceDetailRows, type ModelPricePresentation } from '@/lib/modelPriceFormat';
import {
  isModelEnabled,
  setModelVisibility, setModelVisibilities,
  isModelVisibilityCustomized,
  resetModelVisibilities,
  useModelVisibilityVersion,
} from '@/state/modelVisibilityPrefs';
import {
  clearProviderModelEffort, editProviderModelMemoryBatch,
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
  isOrganizationManagedProvider,
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

import { isLocalRuntimeBetaProviderId, isManagedSidecarProviderId, MANAGED_OLLAMA_PROVIDER_ID } from '../../../shared/localModelRuntime';
import { MANAGED_LLAMACPP_PROVIDER_ID, supportsLlamaCppMillionContext, llamaCppMaxContextSize } from '../../../shared/llamaCpp';
import { modelBrand } from './modelManagementPresentation';
import { ModelPriceOverrideDialog } from './ModelPriceOverrideDialog';
import type { UnionModelRow } from './UnifiedModelList';

const AGENT_LABEL: Record<AgentKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
};

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
  selectedMemberId?: string;
  onSelectMember?: (row: UnionModelRow) => void;
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
  row: groupRow,
  selectedMemberId,
  onSelectMember,
  open,
  onOpenChange,
  pricePresentationOf,
  onDisable,
  onDeleteLocal,
  disabled,
  paymentRequired,
}: Props) {
  const row = groupRow?.aliasRows?.find((member) => member.id === selectedMemberId)
    ?? groupRow?.aliasRows?.find((member) => member.id === groupRow.id) ?? groupRow;
  const memberRows = groupRow?.aliasRows ?? (row ? [row] : []);
  const memberTargets = memberRows.flatMap((member) => member.avail.flatMap((agent) => {
    const model = member.byAgent[agent];
    return model ? [{ agent, modelId: model.id, model }] : [];
  }));
  const { t, i18n } = useTranslation();
  const selectionAvailable = provider.connected && !provider.suspended;
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'en';
  const pricePendingRef = useRef(false);
  const [protocolSaving, setProtocolSaving] = useState(false);
  const [imageCapabilitySaving, setImageCapabilitySaving] = useState(false);
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
  const priceRow = useMemo<UnionModelRow | null>(() => row && chatAgents.length ? {
    ...row, avail: chatAgents,
    byAgent: Object.fromEntries(chatAgents.map(agent => [agent, row.byAgent[agent]])),
  } : null, [row, chatAgents]);
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
  const [localModelRepo, setLocalModelRepo] = useState<{ id: string; repo: string } | null>(null);
  const [localConfigurationBlocked, setLocalConfigurationBlocked] = useState(false);
  useEffect(() => {
    let active = true;
    setLocalModelRepo(null);
    setLocalConfigurationBlocked(false);
    if (open && provider.id === MANAGED_LLAMACPP_PROVIDER_ID && primaryModel) {
      const modelId = primaryModel.id;
      void window.electronAPI.maker.llamaCppStatus().then((snapshot) => {
        if (active) setLocalConfigurationBlocked(snapshot.canConfigure === false);
        if (active) setLocalModelRepo(snapshot.models.find((model) => model.id === modelId) ?? null);
      }).catch(() => {});
    }
    return () => { active = false; };
  }, [open, provider.id, primaryModel?.id]);
  const supportsMillionContext = provider.id === MANAGED_LLAMACPP_PROVIDER_ID &&
    !!primaryModel && localModelRepo?.id === primaryModel.id && supportsLlamaCppMillionContext(localModelRepo);
  const maximumContext = provider.id === MANAGED_LLAMACPP_PROVIDER_ID
    ? llamaCppMaxContextSize(localModelRepo?.id === primaryModel?.id && localModelRepo ? localModelRepo : { repo: '' })
    : 100_000_000;

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
  // 思考档位的本地声明。目标形状与上下文上限同一个 contextTarget：必须覆盖该行全部引擎
  // 的 id —— 运行期真正消费 thinking 档位的是 Pi，桥接投影两端 id 不同，只写主展示引擎
  // 会让声明对运行期无效、UI 却显示「已声明」。
  const thinking = useModelCatalogThinking(open ? contextTarget : null);
  /**
   * 档位组合用固定候选（与目录 Effort 全集同序）而不是自由输入：组合爆炸（2^7）无法
   * 列举，而真实诉求只有「沿用厂商 / 声明常见的几档」两类。勾选语义 = 该模型支持这一档。
   */
  // 与目录 Effort 全集同序（含 ultra：它是合法 Effort，IPC 与 Pi 映射都接受）。
  // 漏掉它会让「已有含 ultra 的声明」在用户勾选其它档位时被按这份列表重建 → 静默删除。
  const THINKING_TIER_CHOICES = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
  const setThinkingTiers = async (tiers: string[] | null) => {
    // 已经是该状态就别再写一次：免掉一次空写入引起的全量目录刷新与广播。各引擎键分叉时
    // 必须放行 —— 否则「重选当前项」被 no-op 挡掉，分叉永远修不掉。
    const already =
      tiers === null
        ? !thinking.isCustomized
        : thinking.isCustomized &&
          tiers.length === (thinking.value?.length ?? -1) &&
          tiers.every((tier) => thinking.value?.includes(tier));
    if (already && !thinking.diverged) return;
    // 默认档**不猜**：沿用读回回来的既有默认档（仍在新集合内才继续沿用），用户没有
    // 单独改默认档的入口，猜「排序第一档」会把厂商声明的默认（如 max）静默改成 low。
    const keptDefault =
      tiers !== null && thinking.defaultEffort && tiers.includes(thinking.defaultEffort)
        ? thinking.defaultEffort
        : null;
    const persisted = await thinking.setTiers(tiers, keptDefault);
    if (!persisted) {
      const reason = thinking.errorReason;
      toast.error(
        reason
          ? t('settings.providers.models.advanced.thinkingOverride.saveFailedWithReason', { reason })
          : t('settings.providers.models.advanced.thinkingOverride.saveFailed'),
      );
    }
  };
  const imageInputOverride = useModelImageInputOverride(open ? contextTarget : null);
  const canEditProtocol = provider.source === 'user' && !provider.auth?.native && !isManagedSidecarProviderId(provider.id);
  const imageAgents = canEditProtocol
    ? provider.agents.filter(agent => provider.routing?.[agent]?.imageApi === 'openai-images')
    : [];
  const imageAgent = imageAgents.length === 1 ? imageAgents[0] : undefined;
  const imageModel = imageAgent ? row?.byAgent[imageAgent] : undefined;
  const imageCapability = imageModel?.userModelConfig?.mode === 'image_generation'
    ? imageModel.userModelConfig.modalities?.input.includes('image') ? 'edit' : 'generate'
    : 'default';
  const videoAgents = canEditProtocol
    ? provider.agents.filter(agent => provider.routing?.[agent]?.videoApi === 'xai-videos') : [];
  const videoAgent = videoAgents.length === 1 ? videoAgents[0] : undefined;
  const videoModel = videoAgent ? row?.byAgent[videoAgent] : undefined;
  const videoCapability = videoModel?.userModelConfig?.mode === 'video_generation'
    ? videoModel.userModelConfig.modalities?.input.includes('image') ? 'edit' : 'generate' : 'default';
  const setImageCapability = async (value: string, kind: 'image' | 'video' = 'image') => {
    const agent = kind === 'image' ? imageAgent : videoAgent;
    const sourceModel = kind === 'image' ? imageModel : videoModel;
    if (imageCapabilitySaving || !agent || !sourceModel || !['default', 'generate', 'edit'].includes(value)) return;
    const config = providerViewToCustomProviderConfig(provider);
    const model = config.runtimes[agent]?.models.find(item => item.id === sourceModel.id);
    if (!model) return;
    if (value === 'default') {
      delete model.mode;
      delete model.modalities;
    } else {
      model.mode = kind === 'image' ? 'image_generation' : 'video_generation';
      model.modalities = { input: value === 'edit' ? ['text', 'image'] : ['text'], output: [kind] };
    }
    setImageCapabilitySaving(true);
    try {
      const result = await updateCustomProvider(config, {}, { source: 'manual-settings' });
      if (!result.ok) toast.error(t('settings.providers.custom.toast.saveFailed'));
    } catch { toast.error(t('settings.providers.custom.toast.saveFailed')); }
    finally { setImageCapabilitySaving(false); }
  };
  const setModelApi = async (agent: AgentKind, api: string) => {
    if (protocolSaving || !canEditProtocol || !row?.byAgent[agent]) return;
    const config = providerViewToCustomProviderConfig(provider);
    const runtime = config.runtimes[agent];
    const model = runtime?.models.find(m => m.id === row.byAgent[agent]!.id);
    if (!runtime || !model) return;
    const choice = row.byAgent[agent]?.availableInterfaces?.find(item => item.profileId === api);
    if (api === 'auto' || choice) {
      model.interfaceId = api;
      delete model.api;
      delete model.piApi;
      delete model.route;
    } else {
      delete model.interfaceId;
      model.api = api as PiModelApi;
      if (agent === 'pi') model.piApi = api as PiModelApi;
      const wire = providerWireProtocolForApi(api);
      if (!wire) return;
      // Pi gets the selected API from api/piApi. A same-endpoint generated route
      // would look explicit after refresh and block a later Messages /v1 fix.
      // Keep existing routes and endpoints that change for the selected API.
      const inheritPiEndpoint = agent === 'pi' && !model.route && !runtime.requestPath &&
        (runtime.wireProtocol === 'openai-chat' || runtime.wireProtocol === 'openai-responses' ||
          runtime.wireProtocol === 'anthropic-messages' || runtime.wireProtocol === 'google-generative-ai') &&
        (api === 'anthropic-messages' ||
          ((api === 'openai-completions' || api === 'openai-responses' || api === 'google-generative-ai') &&
            providerBaseUrlForApi(runtime.baseUrl, api) === runtime.baseUrl));
      if (!inheritPiEndpoint) {
        model.route = {
          baseUrl: providerBaseUrlForApi(model.route?.baseUrl ?? runtime.baseUrl, api),
          wireProtocol: wire,
        };
      }
    }
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
  const defaultWindow =
    contextAgent === 'codex' && ctx.codexContext
      ? ctx.codexContext.contextWindow
      : (contextModel?.contextWindow ?? 0);
  // The editor guard is not a native request-capacity limit. Keep small/local
  // model windows selectable and never derive this floor from a saved override.
  // Local runtimes own their loaded window; their catalog maximum cannot set an editor floor.
  const modelWindows = chatAgents
    .map((agent) => row?.byAgent[agent]?.contextWindow)
    .filter(
      (window): window is number =>
        typeof window === 'number' && Number.isFinite(window) && window > 0,
    );
  const minimumContextK = isLocalRuntimeBetaProviderId(provider.id)
    ? 1
    : Math.max(1, Math.floor(Math.min(100_000, ...modelWindows) / 1000));
  // A working default (including a heuristic fallback) is not a declared capacity.
  // Codex's native maximum may already contain the user's override, so it
  // cannot establish the provider's declared capacity.
  const routeWindow = supportsMillionContext ? 1_000_000
    : (contextModel ?? primaryModel)?.contextWindowMax
      ?? (primaryModel?.contextWindowVerified === true ? primaryModel.contextWindow : 0);
  // Without a declared capacity, compare working defaults across engines only.
  const engineWindowReference = routeWindow > 0 ? routeWindow : (primaryModel?.contextWindow ?? 0);
  const effectiveLimit = ctx.limit ?? (defaultWindow > 0 ? defaultWindow : null);
  useEffect(() => {
    ctxDirtyRef.current = false;
    ctxCommitGen.current += 1;
    setCtxCommitting(false);
    setCtxDraft('');
  }, [open, primaryAgent, primaryModel?.id, provider.id]);
  useEffect(() => {
    if (ctx.loading || ctxDirtyRef.current) return;
    setCtxDraft(effectiveLimit === null ? '' : String(effectiveLimit));
  }, [ctx.loading, effectiveLimit, open]);
  const parsedTokens = parseContextTokenInput(ctxDraft);
  const ctxInvalid =
    ctxDirtyRef.current &&
    ctxDraft.trim() !== '' &&
    (parsedTokens === null ||
      parsedTokens < minimumContextK * 1000 ||
      parsedTokens > maximumContext);
  const commitCtxDraft = useCallback(() => {
    if (!ctxDirtyRef.current || ctxInvalid || ctx.loading || localConfigurationBlocked) return;
    ctxDirtyRef.current = false;
    // 提交在途期间锁住 displayedLimit：hook 的 promise 在它把新值（或失败回滚后的值）
    // 写进 state 之后才 resolve，不锁会闪回一帧旧值。仅当没有更新的提交/重置发生时
    // 才清状态（ctxCommitGen 递增即代表有更新的那次）。
    const generation = (ctxCommitGen.current += 1);
    setCtxCommitting(true);
    void Promise.resolve(ctx.setLimit(ctxDraft.trim() === '' ? null : parsedTokens)).finally(() => {
      if (ctxCommitGen.current === generation) setCtxCommitting(false);
    });
  }, [ctx, ctxDraft, ctxInvalid, parsedTokens, localConfigurationBlocked]);
  const resetCtx = useCallback(() => {
    if (localConfigurationBlocked) return;
    ctxDirtyRef.current = false;
    setCtxDraft(defaultWindow > 0 ? String(defaultWindow) : '');
    void ctx.reset();
  }, [ctx, defaultWindow, localConfigurationBlocked]);

  if (!row || !primaryAgent || !primaryModel) {
    return (
      <Dialog.Root open={false} onOpenChange={onOpenChange}>
        <Dialog.Portal />
      </Dialog.Root>
    );
  }

  const capabilityModel = primaryModel.mode === 'video_generation' ? videoModel ?? primaryModel : imageModel ?? videoModel ?? primaryModel;
  // 本行的能力事实必须属于**被编辑的那个模型**：图片输入控件把声明写到该行选中模型的
  // override，图标/文案却显示图片/视频生成模型（上游 capabilityModel）会变成「编辑 A 却
  // 显示 B」。生成模型的能力展示由上游新增的图片/视频能力行与 modalities 行承担。
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
  const imageInputDefault = modelImageInputDefault(primaryModel, row.id);
  // An undeclared catalog has no default option: both choices remain explicit overrides.
  // A failed read retains the chat route's effective fields, independently of media routes.
  const imageInputValue = imageInputOverride.value ?? (imageInputOverride.error || imageInputOverride.mixed
    ? modelImageInputDefault({ ...primaryModel, imageInputDefault: undefined }, row.id)
    : imageInputDefault);
  const imageInputTargets = contextTarget ? [contextTarget, ...contextTarget.relatedTargets] : [];
  const imageInputTargetDefaults = imageInputTargets.map(({ agent }) => {
    const candidate = row.byAgent[agent];
    return candidate ? modelImageInputDefault(candidate, row.id) : null;
  });
  const imageDefaultsMatch = (value: boolean) => imageInputTargetDefaults.length > 0 &&
    imageInputTargetDefaults.every(defaultValue => defaultValue === value);
  // Different override provenance can still resolve to the same effective capability.
  const imageInputMixed = imageInputOverride.mixed
    ? new Set(imageInputTargets.map(({ agent }) => {
        const candidate = row.byAgent[agent];
        return candidate ? modelImageInputDefault({ ...candidate, imageInputDefault: undefined }, row.id) : null;
      })).size > 1
    : !imageInputOverride.error && imageInputOverride.value === null && new Set(imageInputTargetDefaults).size > 1;

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
  if (groupRow?.aliasRows) visibilityTargets.splice(0, visibilityTargets.length, ...memberTargets.map(({ agent, modelId }) => ({ agent, modelId })));
  const visibilityCustomized = visibilityTargets.some(({ agent, modelId }) =>
    isModelVisibilityCustomized(agent, provider.id, modelId),
  );
  const description = localizedModelDescription(primaryModel, t);
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
  const rememberedEffort = (agent: AgentKind, modelId: string) => {
    const ids = groupRow?.aliasRows
      ? memberTargets.filter((target) => target.agent === agent).map((target) => target.modelId)
      : [modelId];
    const values = [...new Set(ids.map((id) => getProviderModelEffort(agent, provider.id, id))
      .filter((value) => value !== undefined))];
    return values.length === 1 ? values[0] : undefined;
  };
  const commonEfforts = efforts.filter((intent) => chatAgents.every((agent) => {
    const model = row.byAgent[agent];
    return !model?.efforts.length ||
      clampEffortToSupported(intent, model.efforts) ===
        (rememberedEffort(agent, model.id) ?? model.defaultEffort);
  }));
  const preferredEffort = conversational
    ? rememberedEffort(primaryAgent, primaryModel.id) ?? primaryModel.defaultEffort
    : null;
  const effortMixed = efforts.length > 0 && commonEfforts.length === 0;
  const currentEffort = preferredEffort ?? commonEfforts[0] ?? null;
  const shownEfforts = EFFORT_ORDER.filter((effort) =>
    chatAgents.some((agent) => {
      const model = row.byAgent[agent];
      return model?.efforts.includes(effort) || model?.displayEfforts?.includes(effort);
    }),
  );
  const ultrafastSupport = chatAgents.includes('codex')
    ? row.byAgent.codex?.supportsUltrafastMode
    : false;
  /**
   * 推理强度的存储是 per (agent, provider, model) 的。这里按显示轴同一条哲学
   * **一次写该模型全部可用引擎** —— 用户在这个面板里选的是「这个模型默认想多用力」,
   * 同一选择写入全部可调引擎；不支持的档位只做能力适配，不留下另一套旧默认值。
   */
  const applyEffort = (effort: Effort) => {
    if (!efforts.includes(effort)) return;
    if (groupRow?.aliasRows) {
      const ok = editProviderModelMemoryBatch(memberTargets.filter((target) => target.model.efforts.length).map((target) => ({
        kind: 'set-effort' as const, agent: target.agent, providerId: provider.id, model: target.modelId,
        effort: clampEffortToSupported(effort, target.model.efforts) as Effort,
      })));
      if (!ok) toast.error(t('settings.providers.models.visibilityWriteFailed'));
      return;
    }
    for (const agent of chatAgents) {
      const model = row.byAgent[agent];
      if (!model) continue;
      if (!model.efforts.length) continue;
      setProviderModelEffort(agent, provider.id, model.id,
        clampEffortToSupported(effort, model.efforts) as Effort);
    }
  };

  const isLocalOllama = provider.id === MANAGED_OLLAMA_PROVIDER_ID;

  const referencePricing = (model: CatalogModel, agent: AgentKind) => {
    const price = pricePresentationOf(agent, model);
    // Ordinary Gateway chat models carry effective cost; keep their inferred discount.
    const discount =
      (!model.displayPricing && price?.kind === 'priced' ? price.discount : undefined) ??
      model.costDiscount;
    return (
      <Section title={t('settings.providers.models.advanced.pricing')}>
        {model.displayPricing && model.currency ? (
          <>
            {(['input', 'output', 'cacheRead', 'cacheWrite'] as const).map((role) => {
              const quotes = model.displayPricing?.summary?.[role];
              if (!quotes?.length) return null;
              const components = quotes.map(quote => displayPricingComponent(quote.component));
              const component = components.every(value => value === components[0]) ? components[0] : undefined;
              return (
                <Row
                  key={role}
                  label={component
                    ? t(`newChat.modelSelector.displayPricing.roles.${component}.${role}`)
                    : t(`settings.providers.models.advanced.price.${role === 'cacheWrite' ? 'cacheCreate' : role}`)}
                >
                  <span className="flex flex-col items-end gap-1">
                    {quotes.map((quote, index) => (
                      <DisplayPricingQuote
                        key={index}
                        quote={quote}
                        currency={model.currency!}
                        costDiscount={discount}
                        componentLabel={!component && components[index]
                          ? t(`newChat.modelSelector.displayPricing.components.${components[index]}`)
                          : undefined}
                      />
                    ))}
                  </span>
                </Row>
              );
            })}
          </>
        ) : price === null ? (
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
        {discount !== undefined && discount > 0 && discount <= 1 && (
          <Row label={t('settings.providers.models.advanced.discount')}>
            <span
              className="inline-flex items-center rounded-full px-2 py-[1px] text-10 font-medium"
              style={{
                color: EFFORT_TIER_COLORS.low,
                backgroundColor: `color-mix(in srgb, ${EFFORT_TIER_COLORS.low} 14%, transparent)`,
              }}
            >
              {`↓${Math.round(discount * 100)}%`}
            </span>
          </Row>
        )}
        {/* Keep conditions and notes after the primary quotes and their discount. */}
        {model.displayPricing && model.currency &&
          !isDisplayPricingTableRedundant(model.displayPricing) && (
            <div className={model.displayPricing.summary ? 'pt-3' : undefined}>
              <DisplayPricingDetails model={model} />
            </div>
          )}
      </Section>
    );
  };

  return (
    <>
      <Dialog.Root open={open} onOpenChange={(next) => {
        if (!next && pricePendingRef.current) return;
        onOpenChange(next);
      }}>
        <Dialog.Portal>
          <Dialog.Overlay
            className={cn(
              'modal-scrim fixed inset-0 z-[10001]',
            )}
          />
          <Dialog.Content
            onPointerDownOutside={(event) => event.preventDefault()}
            className={cn(
              'modal-panel fixed inset-0 z-[10001] m-auto flex h-fit max-h-[calc(100dvh-48px)] w-[800px] max-w-[calc(100vw-32px)] flex-col overflow-hidden',
            )}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            aria-describedby={undefined}
            onEscapeKeyDown={(event) => {
              if (!(event.target instanceof HTMLElement) || !event.target.closest('[data-model-price-editor]')) return;
              event.preventDefault();
            }}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              titleRef.current?.focus();
            }}
          >
            <header className="flex shrink-0 items-start gap-3 border-b border-[var(--settings-theme-card-border)] px-5 pb-3 pt-4">
              <div className="min-w-0 flex-1">
                {groupRow?.aliasRows && <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" disabled={ctx.loading || protocolSaving} aria-label={t('settings.providers.models.advanced.modelId')}
                      className="mb-2 flex max-w-full items-center gap-1 rounded-full px-2 py-1 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-chip)]">
                      <span className="truncate">{row.id}</span><ChevronDown size={12} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="z-[10003]" align="start">
                    <DropdownMenuRadioGroup value={row.id} onValueChange={(id) => {
                      if (ctx.loading || ctxDirtyRef.current || protocolSaving || pricePendingRef.current) return;
                      const member = memberRows.find((candidate) => candidate.id === id);
                      if (member) onSelectMember?.(member);
                    }}>
                      {memberRows.map((member) => <DropdownMenuRadioItem key={member.id} value={member.id}>{member.id}</DropdownMenuRadioItem>)}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>}
                <Dialog.Title
                  ref={titleRef}
                  tabIndex={-1}
                  className="break-words text-15 font-medium text-[var(--text-primary)] outline-none"
                >
                  {localizedModelName(primaryModel.name, t)}
                </Dialog.Title>
                <p className="mt-0.5 truncate text-12 text-[var(--text-tertiary)]">
                  {providerDisplayName(provider, t)}
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
                      {protocols.upstreamApis.length > 0 && <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-11">
                        <span className="text-[var(--text-tertiary)]">
                          {t('settings.providers.models.advanced.protocol.upstream')}
                        </span>
                        <span className="text-[var(--text-secondary)]">
                          {protocols.upstreamApis.map(api => MODEL_PROTOCOL_LABEL[api as PiModelApi] ?? api).join(' · ')}
                        </span>
                      </div>}
                      {provider.agents.map((agent) => {
                        const model = row.byAgent[agent];
                        // Missing catalog membership proves no configured route, not upstream incompatibility.
                        const supported = Boolean(model && isAgentSelectableModel(model, { userProvider: provider.source === 'user' }));
                        const protocol = protocols.forAgent(agent);
                        const compatibility = protocol?.path === 'local';
                        const protocolId = `model-protocol-${agent}`;
                        const notes: string[] = [];
                        if (model) {
                          // 同一模型在不同引擎下的元数据差异如实标出来 —— 这些值来自目录的
                          // perAgent 覆盖，用户看到「Codex 下 272K / 6 档」才知道差异是真的。
                          // A shared saved budget overrides every engine's working default.
                          if (!supportsMillionContext && (ctx.limit === null || ctx.mixed) &&
                              model.contextWindow > 0 && model.contextWindow !== engineWindowReference) {
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
                                  {/* Presets follow the catalog; any saved explicit choice, including older api/route-only
                                      ones, keeps its way back to automatic. */}
                                  {canEditProtocol && supported && (!model?.catalogPresetId || model.userModelConfig?.interfaceId ||
                                    model.userModelConfig?.api || model.userModelConfig?.piApi || model.userModelConfig?.route?.wireProtocol) ? (
                                    <DropdownMenu>
                                      <DropdownMenuTrigger asChild>
                                        <button type="button" disabled={protocolSaving}
                                          aria-label={`${AGENT_LABEL[agent]} · ${t('settings.providers.custom.fields.wireProtocol')}`}
                                          className="rounded-full px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]">
                                          {protocolLabel(protocol.outbound)} <ChevronDown size={12} className="inline" aria-hidden />
                                        </button>
                                      </DropdownMenuTrigger>
                                      <DropdownMenuContent className="z-[10003]" align="start">
                                        <DropdownMenuRadioGroup value={model?.availableInterfaces?.length ? model.userModelConfig?.interfaceId ?? ((model.userModelConfig?.api || model.userModelConfig?.piApi || model.userModelConfig?.route) ? model.selectedInterface?.profileId : 'auto') : protocol.outbound ?? ''}
                                          onValueChange={value => void setModelApi(agent, value)}>
                                          {model?.availableInterfaces?.length ? <>
                                            <DropdownMenuRadioItem value="auto">{t('settings.providers.models.advanced.protocol.automatic')}</DropdownMenuRadioItem>
                                            {model.availableInterfaces.map(item => <DropdownMenuRadioItem key={item.profileId} value={item.profileId}>{protocolLabel(item.api)}</DropdownMenuRadioItem>)}
                                          </> : MODEL_PROTOCOL_OPTIONS.map(([api, label]) => <DropdownMenuRadioItem key={api} value={api}>{label}</DropdownMenuRadioItem>)}
                                        </DropdownMenuRadioGroup>
                                      </DropdownMenuContent>
                                    </DropdownMenu>
                                  ) : protocolLabel(protocol.outbound)}
                                  {/* Only Cindy's local conversion is called out; phone widths put it on its own line. */}
                                  {compatibility && <>
                                    <span className="hidden min-[400px]:inline"> · </span>
                                    <span className="block min-[400px]:inline"><ModelCompatibilityNotice /></span>
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
                                    (groupRow?.aliasRows
                                      ? await setModelVisibilities(provider.id, memberTargets.filter((m) => m.agent === agent), next)
                                      : await setModelVisibility(agent, provider.id, model.id, next)) === false
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
                        // Six translated labels exceed a details column. Keep every
                        // level visible instead of hiding Ultra in horizontal overflow.
                        style={shownEfforts.length > 4 ? {
                          display: 'grid',
                          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                          borderRadius: 'var(--radius-xl)',
                        } : undefined}
                        optionClassName={shownEfforts.length > 4 ? '!min-w-0 px-1' : undefined}
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
                          rememberedEffort(a, row.byAgent[a]!.id) !== undefined,
                      ) && (
                        <Button
                          variant="secondary"
                          size="sm"
                          tone="quiet"
                          compact
                          type="button"
                          disabled={paymentRequired}
                          onClick={() => {
                            if (groupRow?.aliasRows) {
                              if (!editProviderModelMemoryBatch(memberTargets.map((target) => ({ kind: 'clear-effort' as const,
                                agent: target.agent, providerId: provider.id, model: target.modelId })))) toast.error(t('settings.providers.models.visibilityWriteFailed'));
                              return;
                            }
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
                      hint={t(supportsMillionContext ? 'settings.providers.models.advanced.contextLimitLocalMillionHint' : /^(?:(?:openai-codex|codex|openai|chatgpt)\/)?gpt-/.test(primaryModel.id) && provider.source !== 'user' && ['openai', 'xd'].includes(provider.id)
                        ? 'settings.providers.models.advanced.contextLimitGptHint'
                        : 'settings.providers.models.advanced.contextLimitHint')}
                    >
                      {contextTarget && (
                        <>
                          {localConfigurationBlocked && <p className="text-12 text-[var(--text-secondary)]">{t('settings.providers.llamacpp.ownedElsewhere')}</p>}
                          {supportsMillionContext && (
                            <div className="mt-2 flex gap-2">
                              {[{ label: '256K', tokens: 262144 }, { label: '1M', tokens: 1_000_000 }].map((preset) => (
                                <Button key={preset.tokens} variant={effectiveLimit === preset.tokens ? 'primary' : 'secondary'} compact
                                  aria-pressed={effectiveLimit === preset.tokens}
                                  disabled={paymentRequired || ctx.loading || localConfigurationBlocked}
                                  onClick={() => {
                                    ctxDirtyRef.current = false;
                                    setCtxDraft(String(preset.tokens));
                                    void ctx.setLimit(preset.tokens);
                                  }}
                                >{preset.label}</Button>
                              ))}
                            </div>
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
                                inputMode="text"
                                maxLength={32}
                                disabled={paymentRequired || ctx.loading || localConfigurationBlocked}
                                aria-label={t(
                                  'settings.providers.models.advanced.contextLimitAria',
                                )}
                                className="w-28 bg-transparent text-center text-13 tabular-nums text-[var(--text-primary)] outline-none"
                              />
                              <span className="text-11 text-[var(--text-tertiary)]">tokens</span>
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
                                disabled={paymentRequired || ctx.loading || localConfigurationBlocked}
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
                                { min: formatExactTokens(minimumContextK * 1000, locale), max: formatExactTokens(maximumContext, locale) },
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
                      {ctx.compaction && (
                        <ModelCompactionSettings policy={ctx.compaction}
                          disabled={paymentRequired || ctx.loading || localConfigurationBlocked}
                          onChange={ctx.setCompaction} />
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
                    {imageModel && (
                      <>
                        <Row label={t('settings.providers.models.advanced.imageCapability.label')}>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button type="button" disabled={imageCapabilitySaving || !selectionAvailable || paymentRequired}
                                aria-label={t('settings.providers.models.advanced.imageCapability.label')}
                                className="rounded-full px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]">
                                {t(`settings.providers.models.advanced.imageCapability.${imageCapability}`)} <ChevronDown size={12} className="inline" aria-hidden />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent className="z-[10003]" align="start">
                              <DropdownMenuRadioGroup value={imageCapability} onValueChange={value => void setImageCapability(value)}>
                                {(['default', 'generate', 'edit'] as const).map(value => (
                                  <DropdownMenuRadioItem key={value} value={value}>{t(`settings.providers.models.advanced.imageCapability.${value}`)}</DropdownMenuRadioItem>
                                ))}
                              </DropdownMenuRadioGroup>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </Row>
                        <p className="text-12 leading-5 text-[var(--text-tertiary)]">
                          {t('settings.providers.models.advanced.imageCapability.hint', { agent: AGENT_LABEL[imageAgent!] })}
                        </p>
                      </>
                    )}
                    {videoModel && (
                      <>
                        <Row label={t('settings.providers.models.advanced.videoCapability.label')}>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button type="button" disabled={imageCapabilitySaving || !selectionAvailable || paymentRequired}
                                aria-label={t('settings.providers.models.advanced.videoCapability.label')}
                                className="rounded-full px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]">
                                {t(`settings.providers.models.advanced.videoCapability.${videoCapability}`)} <ChevronDown size={12} className="inline" aria-hidden />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent className="z-[10003]" align="start">
                              <DropdownMenuRadioGroup value={videoCapability} onValueChange={value => void setImageCapability(value, 'video')}>
                                {(['default', 'generate', 'edit'] as const).map(value => (
                                  <DropdownMenuRadioItem key={value} value={value}>{t(`settings.providers.models.advanced.videoCapability.${value}`)}</DropdownMenuRadioItem>
                                ))}
                              </DropdownMenuRadioGroup>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </Row>
                        <p className="text-12 leading-5 text-[var(--text-tertiary)]">
                          {t('settings.providers.models.advanced.videoCapability.hint', { agent: AGENT_LABEL[videoAgent!] })}
                        </p>
                      </>
                    )}
                    <Row label={t('settings.providers.models.advanced.imageInput')}>
                      {conversational && !isOrganizationManagedProvider(provider) ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button type="button" disabled={imageInputOverride.loading || localConfigurationBlocked}
                              aria-label={t('settings.providers.models.advanced.imageInput')}
                              className="inline-flex min-h-8 items-center gap-1.5 rounded-full px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50">
                              {imageInputMixed
                                ? t('settings.providers.models.advanced.imageInputMixed')
                                : imageInputValue === null
                                  ? t('settings.providers.models.advanced.undeclared')
                                  : t(`settings.providers.models.advanced.${imageInputValue ? 'supported' : 'unsupported'}`)}
                              <ChevronDown size={12} aria-hidden />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent className="z-[10003]" align="end">
                            <DropdownMenuRadioGroup
                              value={imageInputMixed || imageInputValue === null ? '' : String(imageInputValue)}
                              onValueChange={(value) => void imageInputOverride.setValue(
                                imageDefaultsMatch(value === 'true') ? null : value === 'true',
                              )}>
                              {[true, false].map((supported) => {
                                const label = t(`settings.providers.models.advanced.${supported ? 'supported' : 'unsupported'}`);
                                return <DropdownMenuRadioItem key={String(supported)} value={String(supported)}>
                                  {imageDefaultsMatch(supported)
                                    ? t('settings.providers.models.advanced.imageInputDefault', { value: label }) : label}
                                </DropdownMenuRadioItem>;
                              })}
                            </DropdownMenuRadioGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : <span
                        title={
                          capabilityModel.modalities || capabilityModel.supportsImageInput !== undefined
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
                      </span>}
                    </Row>
                    {imageInputOverride.error && (
                      <p role="alert" className="text-12 leading-5 text-[var(--error-fg)]">
                        {t('settings.providers.custom.toast.saveFailed')}
                      </p>
                    )}
                    <Row label={t('settings.providers.models.advanced.thinking')}>
                      {/*
                        思考档位三态声明：目录说「不支持思考」时，Pi 客户端就没有 thinking
                        通道，模型推理只能随 content 返回、被当成普通正文渲染（用户看到的是
                        「思考被写进正文」）。此前没有任何入口能声明这件事。勾选语义 = 该模型
                        支持这一档；「跟随供应商」删除本机 override。
                      */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            // xd 的能力由服务端目录决定、组织托管供应商的能力由管理员下发：两者
                            // 本机都不可覆盖，控件保留但禁用（与同抽屉其他不可改项一致）；
                            // Main IPC 侧另有 INVALID_PARAMS / PERMISSION_DENIED 拒写兜底。
                            disabled={
                              // 首次读回前空值只是占位：此时勾一档会把「只有这一档」当成完整集合
                              // 写盘，靜默覆盖本机已声明的档位与默认档。后续后台刷新不受影响。
                              !thinking.loaded ||
                              thinking.saving ||
                              provider.id === 'xd' ||
                              isOrganizationManagedProvider(provider)
                            }
                            aria-label={t('settings.providers.models.advanced.thinkingOverride.label')}
                            // 下拉触发器是动作入口（档位勾选项才是设置本体）：登记操作说明，
                            // 让设置搜索能解释这个控件，而不是把它当设置控件本身。
                            data-settings-search-action="Declare the thinking tiers for this model"
                            title={
                              (primaryModel.efforts?.length ?? 0) > 0
                                ? t('settings.providers.models.advanced.catalogCapabilities')
                                : t('settings.providers.models.advanced.thinkingOverride.sourceHint')
                            }
                            className="inline-flex items-center gap-1 rounded-full px-2 py-1 hover:bg-[var(--surface-hover)]"
                          >
                            <CapabilityValue
                              state={(primaryModel.efforts?.length ?? 0) > 0}
                              label={
                                (primaryModel.efforts?.length ?? 0) > 0
                                  ? t('settings.providers.models.advanced.thinkingCapability.on')
                                  : t('settings.providers.models.advanced.thinkingCapability.off')
                              }
                            />
                            <span className="text-11 text-[var(--text-tertiary)]">
                              {thinking.isCustomized
                                ? t('settings.providers.models.advanced.thinkingOverride.declared')
                                : t('settings.providers.models.advanced.thinkingOverride.inherit')}
                            </span>
                            <ChevronDown size={12} className="inline" aria-hidden />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent className="z-[10003]" align="end">
                          <DropdownMenuItem onSelect={() => void setThinkingTiers(null)}>
                            {t('settings.providers.models.advanced.thinkingOverride.inherit')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          {THINKING_TIER_CHOICES.map((tier) => {
                            const active = thinking.value?.includes(tier) ?? false;
                            return (
                              <DropdownMenuCheckboxItem
                                key={tier}
                                checked={active}
                                onSelect={(event) => {
                                  // 多选：preventDefault 关掉 Radix 的自动关闭，用户可以连续勾多档。
                                  event.preventDefault();
                                  const next = active
                                    ? (thinking.value ?? []).filter((item) => item !== tier)
                                    : THINKING_TIER_CHOICES.filter((item) =>
                                        item === tier || (thinking.value ?? []).includes(item),
                                      );
                                  // 空组合 = 「明确不支持思考」，必须走 null 之外的显式空数组：
                                  // null 是「跟随供应商」，两者语义不同。
                                  void setThinkingTiers(next.length > 0 ? next : []);
                                }}
                              >
                                {/* 档位名一律用既有正本 effortLevels：与「默认推理强度」
                                    选择器逐字一致，避免同一档位在两处叫不同名字（也避免
                                    ultra 被译成与 xhigh 同名的「超高」）。 */}
                                {t(`effortLevels.${tier}`)}
                              </DropdownMenuCheckboxItem>
                            );
                          })}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </Row>
                    {capabilityModel.modalities &&
                      (['input', 'output'] as const).map((direction) => (
                        <Row
                          key={direction}
                          label={t(`settings.providers.models.advanced.${direction}Modalities`)}
                        >
                          {capabilityModel
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
                    <Row label={t('newChat.modelSelector.speed.ultrafast')} muted>
                      <CapabilityValue
                        state={ultrafastSupport}
                        label={t(
                          `settings.providers.models.advanced.${ultrafastSupport === true ? 'supported' : ultrafastSupport === false ? 'unsupported' : 'undeclared'}`,
                        )}
                      />
                    </Row>
                  </Section>

                  {provider.id !== 'xd' && !isOrganizationManagedProvider(provider) && !paymentRequired && priceRow ? (
                    <ModelPriceOverrideDialog provider={provider} row={priceRow} open={open} onOpenChange={onOpenChange}
                      presentation="inline" referenceDetails={(agent) => {
                        const model = priceRow.byAgent[agent];
                        return model ? referencePricing(model, agent) : null;
                      }}
                      onPendingChange={(pending) => { pricePendingRef.current = pending; }} />
                  ) : referencePricing(primaryModel, primaryAgent)}
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
                  data-settings-search-action="Enable or disable the displayed model group"
                  onClick={() => { if (!pricePendingRef.current) onDisable(groupRow ?? row); }}
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
                    data-settings-search-action="Delete the displayed local model"
                    onClick={() => { if (!pricePendingRef.current) onDeleteLocal(row); }}
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
    </>
  );
}
