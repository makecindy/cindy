import {
  useCallback,
  useState,
  useMemo,
  useEffect,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Check, ChevronDown, PlugZap, Plus, Search, Unplug, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { flashScrollbar } from '@/lib/scrollbarAutoHide';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { MorphPopover } from '@/components/ui/morph-popover';
import { AnthropicMark } from '@/components/icons/AnthropicMark';
import { OpenAIMark } from '@/components/icons/OpenAIMark';
import { XDIncMark } from '@/components/icons/XDIncMark';
import { hasProviderLogo, ProviderLogoMark } from '@/components/icons/ProviderLogoMark';
import { FastModeToggle } from './FastModeToggle';
import { VendorSegmentedSwitcher } from './VendorSegmentedSwitcher';
import { useAgentCapabilities, type AgentKind } from '@/hooks/useAgentCapabilities';
import { useApiKey } from '@/hooks/useApiKey';
import { useConnectedSource } from '@/hooks/useConnectedSource';
import { useModelPricing } from '@/hooks/useModelPricing';
import { useProviders } from '@/hooks/useProviders';
import { useDeviceProviders } from '@/hooks/useDeviceProviders';
import {
  modelPriceDiscountLabelValues,
  modelPriceDetailRows,
  modelPricePresentation,
} from '@/lib/modelPriceFormat';
import {
  filterChatBridgedCodexProviders,
  isDeviceModelVisible,
  providerMonogram,
  resolveVisibleModelAgentKind,
  selectVisibleModels,
} from '@/lib/providerModels';
import type { Effort } from '@/lib/userPreferences.types';
import { isModelEnabled, useModelVisibilityVersion } from '@/state/modelVisibilityPrefs';
import { useProviderModelMemoryVersion } from '@/state/providerModelMemory';
import { useDeviceLinkModelMirrorVersion } from '@/state/deviceLinkModelMirror';
import {
  connectedProvidersForAgent,
  actualSourceIdForModel,
  effectiveSourceIdForModel,
  getModel,
  modelSupportsFastMode,
  providerOffersModel,
  resolveModelIconKind,
  sourcesForModel,
  visibleModelUnion,
  type ProviderView,
} from '@cindy/model-providers';
import { isProviderLogoKind } from '@cindy/model-providers/branding';
import { getModelPriceQuote } from '../../../shared/modelPriceQuote';
import type { ModelPricingCatalog } from '../../../shared/regionalMoney';
import { buildProviderSections } from './sourceSwitch';

// 厂商分类 / 分组标题 key 表的纯逻辑在 ./sourceSwitch。这里 re-export 给 ChatInput
// (它从 './ModelSelector' import categorize / CATEGORY_LABEL_KEY / ModelCategory 做跨厂商确认弹窗)。
export { categorize, CATEGORY_LABEL_KEY, type ModelCategory } from './sourceSwitch';

/**
 * 【非当前选中】模型行的 effort/fast 全局预设读写器,由调用方按设备边界注入(ModelSelector 本身
 * 不耦合具体存储)。
 *   - 本地草稿 / 已创建会话 → providerModelMemory(跨对话、跨重启持久)
 *   - device-link 远程草稿 / 会话 → 被控端全局预设的纯显示镜像(写穿被控端),控制端本地不落记忆
 *   - 不传(flat 选择器:CreateWorkerPopover / scheduler)→ 非选中行不读不写任何记忆,只显示模型默认
 * 选中行仍只读调用方 props:已创建会话的 props 来自 live DB/runtime,因此不会被其它对话覆盖;
 * 首页草稿的 props 则由 NewMakerDraftRoute 从同一份全局预设派生,没有“当前会话保护”。
 */
export interface ModelMemoryAccessors {
  getEffort: (agent: AgentKind, providerId: string, modelId: string) => Effort | undefined;
  setEffort: (agent: AgentKind, providerId: string, modelId: string, effort: Effort) => void;
  /** 真正选中 / 使用模型时同时更新该来源 lastModel;只编辑非选中行不调用。 */
  setChoice?: (agent: AgentKind, providerId: string, modelId: string, effort: Effort) => void;
  getFast: (agent: AgentKind, providerId: string, modelId: string) => boolean | undefined;
  setFast: (agent: AgentKind, providerId: string, modelId: string, enabled: boolean) => void;
}

// 供应商完整展示名:三个内置 id 复用设置页 i18n 标题(settings.providers.<id>.title),
// 自定义供应商回退目录里的 provider.name。用于模型信息面板的来源说明。
const PROVIDER_TITLE_KEY: Record<string, string> = {
  anthropic: 'settings.providers.anthropic.title',
  openai: 'settings.providers.openai.title',
  xd: 'settings.providers.xd.title',
};

// 配置面板锚在主菜单内缩 8px 的模型行上；补偿这段内缩，让两块面板贴边但不重叠。
const MODEL_OPTIONS_SIDE_OFFSET = 8;
const MODEL_LIST_DEFAULT_MAX_HEIGHT_PX = 300;
// 一级菜单只保留单行模型信息与必要标签：20px 内容 + 16px 纵向 padding。
const MODEL_LIST_ROW_HEIGHT_PX = 36;
const MODEL_LIST_ROW_GAP_PX = 2;

export function modelListMaxHeightForRows(maxVisibleRows?: number): number | undefined {
  if (maxVisibleRows === undefined || !Number.isFinite(maxVisibleRows)) return undefined;
  const rows = Math.max(1, Math.floor(maxVisibleRows));
  return Math.min(
    MODEL_LIST_DEFAULT_MAX_HEIGHT_PX,
    rows * MODEL_LIST_ROW_HEIGHT_PX + Math.max(0, rows - 1) * MODEL_LIST_ROW_GAP_PX,
  );
}

function providerDisplayName(p: ProviderView, t: (key: string) => string): string {
  const key = PROVIDER_TITLE_KEY[p.id];
  return key ? t(key) : p.name;
}

// 来源供应商 → 单色官方 mark(fill=currentColor)。trigger 默认右间距 + trigger 文字色;
// 列表行前缀通过 colorClass / withMargin 改用 secondary 色 + 由 flex gap 控间距。
export function ProviderMark({
  providerId,
  name,
  routing,
  logoKind,
  colorClass = 'text-[var(--model-trigger-text)]',
  withMargin = true,
  dense = false,
}: {
  providerId: string;
  name?: string;
  routing?: ProviderView['routing'];
  logoKind?: ProviderView['logoKind'];
  colorClass?: string;
  withMargin?: boolean;
  /** 列表行前缀用 dense:比 trigger 小一档(约 -10%)。两套静态尺寸,JIT 友好。 */
  dense?: boolean;
}) {
  const common = cn(withMargin && 'mr-1.5', 'shrink-0', colorClass);
  const markSize = dense ? 12.3 : 13;
  if (isProviderLogoKind(logoKind) || hasProviderLogo(providerId, routing)) {
    return (
      <ProviderLogoMark
        providerId={providerId}
        routing={routing}
        logoKind={logoKind}
        size={markSize}
        className={
          providerId === 'xd'
            ? cn(dense ? 'h-[8.4px] w-[14.2px]' : 'h-[9px] w-[15px]', common)
            : common
        }
      />
    );
  }
  if (!name) return null;
  // 未知自定义供应商:首字母描边方盒(border 跟随 currentColor = colorClass 设定的文字色)。
  return (
    <span
      className={cn(
        withMargin && 'mr-1.5',
        'flex shrink-0 items-center justify-center rounded-[4px] border border-current font-semibold leading-none',
        dense ? 'h-[14.2px] w-[14.2px] text-[8.4px]' : 'h-[15px] w-[15px] text-[9px]',
        colorClass,
      )}
      aria-hidden
    >
      {providerMonogram(name)}
    </span>
  );
}

/**
 * 模型行 / trigger 的图标 —— 统一规则(桌面与手机同源,见 resolveModelIconKind):
 * 模型条目带 `icon`(**AI Gateway / 目录设定**)就渲染对应厂牌 mark;缺省或未知值
 * 回落该行来源供应商标(ProviderMark)。禁止在客户端按 model id 猜厂牌。
 */
export function ModelIconMark({
  icon,
  providerId,
  name,
  routing,
  logoKind,
  colorClass = 'text-[var(--model-trigger-text)]',
  withMargin = true,
  dense = false,
}: {
  /** 模型条目的展示图标 id(CatalogModel.icon);undefined = 未设定。 */
  icon?: string;
  /** 回落用的来源供应商 id / 展示名(与 ProviderMark 同语义)。 */
  providerId: string;
  name?: string;
  routing?: ProviderView['routing'];
  logoKind?: ProviderView['logoKind'];
  colorClass?: string;
  withMargin?: boolean;
  dense?: boolean;
}) {
  const kind = resolveModelIconKind(icon);
  if (kind) {
    const common = cn(withMargin && 'mr-1.5', 'shrink-0', colorClass);
    const markSize = dense ? 12.3 : 13;
    if (kind === 'claude') return <AnthropicMark size={markSize} className={common} />;
    if (kind === 'codex') return <OpenAIMark size={markSize} className={common} />;
    return (
      <XDIncMark
        size={markSize}
        className={cn(dense ? 'h-[8.4px] w-[14.2px]' : 'h-[9px] w-[15px]', common)}
      />
    );
  }
  return (
    <ProviderMark
      providerId={providerId}
      name={name}
      routing={routing}
      logoKind={logoKind}
      colorClass={colorClass}
      withMargin={withMargin}
      dense={dense}
    />
  );
}

// 上下文窗口 tokens → 紧凑展示("1M" / "272K" / "8192")。
function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : Number(m.toFixed(1))}M`;
  }
  if (tokens >= 1000) {
    const k = tokens / 1000;
    return `${Number.isInteger(k) ? k : Number(k.toFixed(0))}K`;
  }
  return String(tokens);
}

// 单栏列表里每行 / Edit 配置列消费的最小模型形状(SectionModel 与 renderer ModelDescriptor 都满足)。
interface RowModel {
  id: string;
  displayName: string;
  description?: string;
  contextWindow: number;
  efforts: readonly Effort[];
  defaultEffort: Effort | null;
  effortDisplayNames?: Partial<Record<string, string>>;
  supportsFastMode?: boolean;
  /** 展示图标 id(AI Gateway / 目录设定,SectionModel.icon);flat 列表的 ModelDescriptor 无此字段。 */
  icon?: string;
}

type Translate = (key: string, options?: { defaultValue?: string }) => string;

export function modelEffortLabel(
  t: Translate,
  m: Pick<RowModel, 'effortDisplayNames'> | null | undefined,
  e: Effort,
  agentDisplayName?: string,
): string {
  return t(`effortLevels.${e}`, {
    defaultValue: m?.effortDisplayNames?.[e] ?? agentDisplayName ?? e,
  });
}

function ModelPromotionBadge({ children }: { children: ReactNode }) {
  return (
    <span
      data-model-promotion-badge
      className="inline-flex shrink-0 items-center rounded-full bg-[var(--accent-cta-bg)] px-2 py-[1px] text-11 font-medium leading-[1.45] text-[var(--accent-pure-cta-fg)]"
    >
      {children}
    </span>
  );
}

export interface ModelSelectorAgentIdentity {
  vendorKey: 'cc' | 'codex';
  /**
   * current = 已由会话/runtime 元数据确认的当前 Agent；
   * pending = 已登记、将在下一条消息应用的切换目标。
   */
  state: 'current' | 'pending';
}

export function resolveModelSelectorAgentIdentity(
  runtimeAgentKind: AgentKind | null | undefined,
  pendingTarget: AgentKind | null | undefined,
): ModelSelectorAgentIdentity | undefined {
  if (pendingTarget) {
    return {
      vendorKey: pendingTarget === 'codex' ? 'codex' : 'cc',
      state: 'pending',
    };
  }
  if (!runtimeAgentKind) return undefined;
  return {
    vendorKey: runtimeAgentKind === 'codex' ? 'codex' : 'cc',
    state: 'current',
  };
}

interface ModelSelectorProps {
  modelId: string;
  effort: Effort;
  onModelChange: (modelId: string) => void;
  onEffortChange: (effort: Effort) => void;
  /**
   * per-session 来源选择(B · Provider-first)。
   *   - currentProviderId:本会话当前显式选定的供应商 id(null = 跟随默认路由)。
   *   - onProviderChange:选某行(供应商, 模型)时调用,第 2 参为该行模型 id(原子切 provider+model+effort)。
   *   - onNavigateToProviders:0 个可连来源时空态 CTA / 列表底部「连接来源」跳设置→供应商页。
   * 三者都不传 → 单栏纯列表(无供应商分段),选行只 onModelChange(老入口 / CreateWorkerPopover)。
   */
  currentProviderId?: string | null;
  onProviderChange?: (
    providerId: string | null,
    reconciledModelId?: string,
    reconciledEffort?: Effort,
  ) => void;
  onNavigateToProviders?: () => void;
  /**
   * 会话显式选中的来源已断开(由 ChatInput 按 sessionId / deviceLink scoping 计算,见
   * isSelectedSourceDisconnected)。true → trigger 显示**真实选中来源** + 「已断开」错误态,
   * 不回落默认来源图标(否则界面显示的来源与发送实际使用的来源分叉,用户无法自查)。
   * 其他消费方(ScheduleChips / ImDefaultSettingsSection / CreateWorkerPopover 等)不传 = 行为不变。
   */
  sourceDisconnected?: boolean;
  /** 语义同 ModelSelectorContentProps.actualRoute(仅已建会话传 true)。 */
  actualRoute?: boolean;
  /** Fast Mode 状态 + 回调(从工具栏搬进 Edit 配置列)。不传 → 配置列不显示 Fast 开关。 */
  fastMode?: boolean;
  onFastModeChange?: (enabled: boolean) => void | Promise<void>;
  /** 非选中模型行的 effort/fast 全局预设读写器(按本机 / 被控设备隔离)。 */
  modelMemory?: ModelMemoryAccessors;
  /** When provided, only models with this vendorKey are shown in the dropdown. */
  vendorKey?: 'cc' | 'codex';
  /**
   * 已创建会话的 trigger 同时展示 Agent 与模型，避免 Claude Code 使用 OpenAI 模型时
   * 只看来源图标而误判成 Codex。必须由权威 session/runtime 身份或明确切换 intent 提供，
   * 不得从用于模型列表过滤的 vendorKey 推断。紧凑布局仅视觉收起，aria/title 保留完整语义。
   */
  agentIdentity?: ModelSelectorAgentIdentity;
  /** device-link 远程会话所属被控端 id;非空 = 列被控端的模型 + 退化为纯列表(不分供应商段)。 */
  deviceId?: string;
  /**
   * SSH 远程会话(remoteHostId)传 true:隐藏订阅直连模型(chatgpt/ / xai/)——bridge 只挂在
   * 本地 compat-proxy,远程模式不经它,选了必失败(见 selectVisibleModels 同名参数)。
   */
  excludeSubscriptionDirect?: boolean;
  /**
   * SSH 远程会话(remoteHostId)传 true:隐藏 `wireProtocol: 'openai-chat'` 的 Codex 供应商
   * (DeepSeek / Kimi / GLM 等)——Responses→Chat 桥只挂在本地 codex-proxy,远程不经它
   * (见 selectVisibleModels 同名参数)。
   */
  excludeChatBridgedCodex?: boolean;
  /**
   * device-link 远程切换 in-flight:trigger 置灰 + 禁用点击,直到被控端 echo 回流。
   * 配合 ChatInput 的乐观显示(chip 已显示目标值)给一个「正在生效」的视觉提示,避免回落默认态的跳变。
   * 仅远程会话会为 true;本地会话恒 false。
   */
  switching?: boolean;
  /** 禁用 trigger。用于断线远程会话等只读 composer 状态。 */
  disabled?: boolean;
  /** 窄容器下把 trigger 字号/高度各压一档,默认 false。 */
  dense?: boolean;
  /** 窄 composer 的简略触发器:隐藏 effort / Fast 次要信息并限制模型名宽度。 */
  compactToolbar?: boolean;
  /** 极窄 composer 进一步隐藏模型文字，只保留模型图标和下拉箭头。 */
  ultraCompactToolbar?: boolean;
  /** Trigger presentation: toolbar keeps the compact chat pill; field renders a settings input-like control. */
  triggerVariant?: 'toolbar' | 'field';
  /** CREATE AGENT 首页按 Figma 185:2724 使用独立私有 token。 */
  visualVariant?: 'default' | 'create-agent';
  /** 仅普通 composer 显式开启 chip → panel 容器形变；设置页/worker 等维持 Radix。 */
  useMorphPopover?: boolean;
  /** Popover 弹出方向,默认 "top"（底部工具栏向上弹），dialog 内嵌场景传 "bottom"。 */
  popoverSide?: 'top' | 'bottom';
  /**
   * 模型列表最多露出的标准行数；超出后列表自身滚动。
   * 不传时沿用通用面板的 300px 上限，供 Settings 等紧凑场景按行数收窄。
   */
  maxVisibleModelRows?: number;
  /** 关闭模型的 effort / Fast 编辑入口；只选择模型 id 的设置项使用。 */
  configurationEnabled?: boolean;
  /** 可选的列表首行兜底值，例如“不指定（使用原逻辑）”。 */
  fallbackOption?: { active: boolean; label: string; onSelect: () => void };
  /**
   * 点击**当前已选中**的行时照常回调 onModelChange / onProviderChange（默认 false = 收起了事）。
   * 供「当前值是解析出的继承值、点一下才落成显式值」的调用方（IM 工作目录偏好）使用；
   * 会话场景不要开——那里 modelId 本就是已持久化的值，重选自己是纯无操作。
   */
  reselectEmitsChange?: boolean;
  /**
   * modelId 非空但不在可见清单时的 trigger 文案（默认落「选择模型」占位符）。
   * 供展示已持久化偏好的调用方给出诊断性文案，避免把「存过但当前不可用」显示成「没选过」。
   */
  unknownModelLabel?: (modelId: string) => string;
  /**
   * 可及名上下文前缀(如「模型 · chat」)。多实例同屏(IM 目录偏好逐行一个)时前置到
   * trigger 的 aria-label,行与行才能被读屏区分 —— 与 VendorSegmentedSwitcher.ariaLabel
   * 同一动机;单实例的 composer 不传,行为不变。
   */
  ariaContext?: string;
  /**
   * session-agent-switch:会话内显式两步切换引擎(先选 Agent,再选模型)。
   * 传入后列表顶部渲染 Claude / Codex 分段;切到非当前引擎的 tab 进入「浏览目标
   * 引擎模型」态(带提示行),此时点模型行调 onSwitch(而非 onModelChange),由调用方
   * 执行切换事务。切回当前引擎 tab 恢复原行为。仅本机已建会话传入;草稿 /
   * device-link / SSH 远程不传(v1 不支持切换)。
   */
  agentSwitch?: {
    currentVendor: 'cc' | 'codex';
    /** 进入非当前 Agent 浏览态前确认；false 时保持原分段，什么都不改。 */
    confirmBrowseSwitch?: () => Promise<boolean>;
    onSwitch: (
      targetAgentKind: 'claude-code' | 'codex',
      modelId: string,
      providerId: string | null,
    ) => void | Promise<void>;
  };
}

interface ModelSelectorContentProps {
  modelId: string;
  effort: Effort;
  onModelChange: (modelId: string) => void;
  onEffortChange: (effort: Effort) => void;
  fastMode?: boolean;
  onFastModeChange?: (enabled: boolean) => void | Promise<void>;
  modelMemory?: ModelMemoryAccessors;
  vendorKey?: 'cc' | 'codex';
  /** device-link 远程会话所属被控端 id(列被控端模型)。 */
  deviceId?: string;
  /** SSH 远程会话隐藏订阅直连模型(语义同 ModelSelectorProps 同名字段)。 */
  excludeSubscriptionDirect?: boolean;
  /** SSH 远程会话隐藏 Chat 桥接的 Codex 供应商模型(语义同 ModelSelectorProps 同名字段)。 */
  excludeChatBridgedCodex?: boolean;
  /** 选中后是否自动关闭。Popover 场景传入,内嵌场景不传。 */
  onDismiss?: () => void;
  /**
   * 当前来源解析口径。true = 实际路由口径(actualSourceIdForModel,不剔除停用拷贝)
   * —— 仅**已建会话**的选择器传(ChatInput sessionId 在时):运行中会话的图标/价格/
   * Fast/选中行豁免必须跟真实扣费路由。缺省 false = 准入口径
   * (effectiveSourceIdForModel):草稿 / worker / IM 默认 / hook 配置等**新路由
   * 选择**场景,高亮与元数据必须指向真正会被路由到的启用来源
   * (PR #744 review 第十轮)。
   */
  actualRoute?: boolean;
  /** 语义同 ModelSelectorProps.maxVisibleModelRows。 */
  maxVisibleModelRows?: number;
  /** 模型信息 / 选项浮层的额外样式。供嵌套在高层级 overlay 中的调用方覆盖默认 z-index。 */
  overlayContentClassName?: string;
  currentProviderId?: string | null;
  onProviderChange?: (
    providerId: string | null,
    reconciledModelId?: string,
    reconciledEffort?: Effort,
  ) => void;
  onNavigateToProviders?: () => void;
  /**
   * 可选「跟随会话」行(opt-in)。仅 scheduler 的 heartbeat(绑定会话)任务传入:
   * 在模型列表顶部加一行,选中 = model 留空(跟随绑定会话的模型 / 来源)。
   */
  followSession?: { active: boolean; label: string; onFollow: () => void };
  /** 是否显示模型的 effort / Fast 编辑入口。 */
  configurationEnabled?: boolean;
  /** 语义同 ModelSelectorProps.reselectEmitsChange(点当前行照常回调)。 */
  reselectEmitsChange?: boolean;
  /** Morph 原位展开时，要求真实 pointer move 后才展示行级配置，避免静止光标误触。 */
  pointerRevealRequiresIntent?: boolean;
  /**
   * field 形态:面板宽度绑定 trigger(DESIGN.md §4「Panel width must bind to the
   * trigger width」),主菜单列由固定 320 改为撑满外层 PopoverContent。
   */
  fluidWidth?: boolean;
  /** 语义同 ModelSelectorProps.agentSwitch(显式两步引擎切换)。 */
  agentSwitch?: {
    currentVendor: 'cc' | 'codex';
    confirmBrowseSwitch?: () => Promise<boolean>;
    onSwitch: (
      targetAgentKind: 'claude-code' | 'codex',
      modelId: string,
      providerId: string | null,
    ) => void | Promise<void>;
  };
}

function vendorKeyToAgentKind(v?: 'cc' | 'codex'): AgentKind | null {
  if (v === 'cc') return 'claude-code';
  if (v === 'codex') return 'codex';
  return null;
}

export function ModelSelectorContent(props: ModelSelectorContentProps) {
  const pricing = useModelPricing();
  return <ModelSelectorContentView {...props} pricing={pricing} />;
}

function ModelSelectorContentView({
  modelId,
  effort,
  onModelChange,
  onEffortChange,
  fastMode = false,
  onFastModeChange,
  modelMemory,
  vendorKey,
  deviceId,
  excludeSubscriptionDirect,
  excludeChatBridgedCodex,
  onDismiss,
  actualRoute = false,
  maxVisibleModelRows,
  overlayContentClassName,
  currentProviderId,
  onProviderChange,
  onNavigateToProviders,
  followSession,
  configurationEnabled = true,
  reselectEmitsChange = false,
  pointerRevealRequiresIntent = false,
  fluidWidth = false,
  agentSwitch,
  pricing,
}: ModelSelectorContentProps & { pricing: ModelPricingCatalog | null }) {
  // 当前来源解析器:已建会话 = 实际路由口径(含停用拷贝),其余 = 准入口径。
  const resolveCurrentSourceId = actualRoute ? actualSourceIdForModel : effectiveSourceIdForModel;
  const { t } = useTranslation();
  const constrainedListMaxHeight = modelListMaxHeightForRows(maxVisibleModelRows);
  // session-agent-switch:两步式引擎切换的浏览态。browseVendor 初始 = 会话当前引擎;
  // 切到另一家 tab 只是「浏览目标引擎的模型」,选中模型行才真正触发切换事务。
  const [browseVendor, setBrowseVendor] = useState<'cc' | 'codex'>(
    agentSwitch?.currentVendor ?? vendorKey ?? 'cc',
  );
  const browseSwitchPendingRef = useRef(false);
  const handleBrowseVendorChange = async (next: 'cc' | 'codex') => {
    if (next === browseVendor || browseSwitchPendingRef.current) return;
    // 返回当前引擎（含已有意图时浏览原引擎准备撤销）不需要确认；只有从
    // currentVendor 进入另一 Agent 浏览态才调用上层风险确认。确认前绝不翻分段。
    if (agentSwitch && next !== agentSwitch.currentVendor && agentSwitch.confirmBrowseSwitch) {
      browseSwitchPendingRef.current = true;
      try {
        if (!(await agentSwitch.confirmBrowseSwitch())) return;
      } finally {
        browseSwitchPendingRef.current = false;
      }
    }
    setBrowseVendor(next);
  };
  // 会话引擎在外部变化(切换完成 / 换会话)时重置浏览态,跟随新的当前引擎。
  useEffect(() => {
    if (agentSwitch) setBrowseVendor(agentSwitch.currentVendor);
  }, [agentSwitch?.currentVendor]);
  const browsing = !!agentSwitch && browseVendor !== agentSwitch.currentVendor;
  const agentKind = agentSwitch
    ? vendorKeyToAgentKind(browseVendor)
    : vendorKeyToAgentKind(vendorKey);
  const browseTargetLabel = browseVendor === 'codex' ? 'Codex' : 'Claude Code';
  // 同时拉两个 agent —— vendorKey 不传时把两边模型一起展示。hooks 必须按固定顺序调用。
  const cc = useAgentCapabilities('claude-code', deviceId);
  const codex = useAgentCapabilities('codex', deviceId);
  // 本机折扣 GPT 仍按本机 API key gate；device-link 必须只看被控端 provider 状态。
  // 旧被控端不支持 provider:list 时按远端 capabilities 退化，不得误用控制端 key。
  const { hasSavedKey } = useApiKey();
  // 供应商来源:本机会话用本机 useProviders;device-link 远程会话用**被控端**供应商目录
  // (useDeviceProviders,隧道 maker:provider:list)。两 hook 都无条件调用(hooks 规则),按 deviceId 取。
  const localProviders = useProviders();
  const remoteProviders = useDeviceProviders(deviceId);
  const providers = deviceId ? remoteProviders.providers : localProviders.providers;
  const providersLoading = deviceId ? remoteProviders.loading : localProviders.loading;

  const visibilityVersion = useModelVisibilityVersion();
  const [query, setQuery] = useState('');
  // 当前 hover / focus 展开的浮层目标(供应商id + 模型id)。只把「显示哪一行的选项」
  // 放在本地；effort / fast 的值和持久化仍走 props + modelMemory SSoT。
  const [editing, setEditing] = useState<{ providerId: string | null; modelId: string } | null>(
    null,
  );
  // 非选中模型的 effort/fast 改动写进全局预设,不反映在 live props —— 用 tick 触发重渲染读新值。
  const [editTick, setEditTick] = useState(0);
  const bump = () => setEditTick((n) => n + 1);
  // 跨进程 / 远程改动:device-link push 会直接改底层 store(providerModelMemory /
  // deviceLinkModelMirror),不经本组件的 editTick。订阅两份 store 的版本号,任一变化即重渲染、
  // 重算行 effort/fast 显示(本机用 providerModelMemory,远程用被控端镜像)。
  const storeVersion =
    editTick + useProviderModelMemoryVersion() + useDeviceLinkModelMirrorVersion();
  void storeVersion;

  const listRef = useRef<HTMLDivElement>(null);
  const configPanelRef = useRef<HTMLDivElement>(null);
  // 选中行对齐是程序化滚动,它触发的 scroll 事件不代表用户意图,不应收起行配置浮层。
  const suppressScrollDismissRef = useRef(false);
  const closeOptionsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── pointer-reveal 武装门 ──
  // 面板(MorphPopover)在光标正下方原位展开:行滑到**静止**光标底下会触发
  // pointerenter,行配置浮层闪现一下(2026-07-22 用户反馈)。静止光标不代表
  // hover 意图 —— 以挂载后首个 move 事件为基线,累计移动 ≥4px 才武装
  // pointer-reveal;布局变化后 Chromium 补发的合成 move 坐标不变,天然被挡。
  const hoverIntentArmedRef = useRef(false);
  const hoverIntentBaseRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!pointerRevealRequiresIntent) return;
    const onMove = (e: PointerEvent) => {
      if (!hoverIntentBaseRef.current) {
        hoverIntentBaseRef.current = { x: e.screenX, y: e.screenY };
        return;
      }
      const dx = e.screenX - hoverIntentBaseRef.current.x;
      const dy = e.screenY - hoverIntentBaseRef.current.y;
      if (dx * dx + dy * dy >= 16) {
        hoverIntentArmedRef.current = true;
        document.removeEventListener('pointermove', onMove, true);
      }
    };
    document.addEventListener('pointermove', onMove, true);
    return () => document.removeEventListener('pointermove', onMove, true);
  }, [pointerRevealRequiresIntent]);

  const cancelOptionsClose = () => {
    if (closeOptionsTimerRef.current === null) return;
    clearTimeout(closeOptionsTimerRef.current);
    closeOptionsTimerRef.current = null;
  };
  const scheduleOptionsClose = () => {
    cancelOptionsClose();
    // 给鼠标跨过行与 portaled 浮层之间的 4px 缝隙留一小段 grace period。
    // 80ms 足够接住浮层,又不会产生「鼠标走了选项还赖着」的视觉残留。
    closeOptionsTimerRef.current = setTimeout(() => {
      closeOptionsTimerRef.current = null;
      setEditing(null);
    }, 80);
  };

  // 列表(或任何祖先滚动容器)滚动时立即关掉行级配置浮层:浮层锚定行会跟着滚动
  // 漂移,体验很差(2026-07-22 用户反馈)。桌面端惯例是 scroll 即关(macOS 菜单同);
  // 浮层本身是 hover 即现的,重开零成本。capture 监听兜住所有滚动源,
  // 浮层内部自身的滚动除外(configPanelRef 过滤)。
  useEffect(() => {
    if (!editing) return;
    const onAnyScroll = (event: Event) => {
      if (configPanelRef.current?.contains(event.target as Node)) return;
      cancelOptionsClose();
      setEditing(null);
    };
    document.addEventListener('scroll', onAnyScroll, true);
    return () => document.removeEventListener('scroll', onAnyScroll, true);
  }, [editing]);

  useEffect(
    () => () => {
      if (closeOptionsTimerRef.current !== null) clearTimeout(closeOptionsTimerRef.current);
    },
    [],
  );

  // 模型清单来源:本机会话从 live providers 派生(builtin + 自定义合集);device-link 远程会话
  // 必须列**被控端**模型(cc/codex.capabilities.availableModels,deviceId 作用域),不读控制端本地
  // catalog —— 见 selectVisibleModels 的「以被控端为准」契约。merged 入口(无 vendorKey)cc+codex 去重。
  const visibleModels = useMemo(
    () =>
      selectVisibleModels({
        agentKind,
        deviceId,
        providers,
        deviceCcModels: cc.capabilities?.availableModels ?? [],
        deviceCodexModels: codex.capabilities?.availableModels ?? [],
        excludeSubscriptionDirect,
        excludeChatBridgedCodex,
      }),
    [
      agentKind,
      deviceId,
      providers,
      cc.capabilities,
      codex.capabilities,
      excludeSubscriptionDirect,
      excludeChatBridgedCodex,
    ],
  );

  const currentModel = visibleModels.find((m) => m.id === modelId);

  // 显式 vendor / 浏览分段已给出 agentKind 时直接采用；浏览目标引擎期间 modelId 仍是
  // 旧引擎当前模型，通常不在目标 catalog，不能先因 currentModel 缺失判 null（否则目标
  // 引擎的 connected sources / sections / per-(引擎,来源,模型) 记忆链会全部退化）。
  // 只有 merged picker 没有显式 agentKind 时，才按 currentModel 判归属。
  const currentAgentKind: AgentKind | null = useMemo(() => {
    if (agentKind) return agentKind;
    if (!currentModel) return null;
    return resolveVisibleModelAgentKind({
      modelId: currentModel.id,
      agentKind,
      ccModels: cc.capabilities?.availableModels ?? [],
      codexModels: codex.capabilities?.availableModels ?? [],
      providers,
    });
  }, [agentKind, cc.capabilities, codex.capabilities, currentModel, providers]);

  const effortMeta = useMemo(() => {
    const levels =
      currentAgentKind === 'claude-code'
        ? (cc.capabilities?.effortLevels ?? [])
        : currentAgentKind === 'codex'
          ? (codex.capabilities?.effortLevels ?? [])
          : [];
    return new Map(levels.map((e) => [e.id, e.displayName]));
  }, [currentAgentKind, cc.capabilities, codex.capabilities]);
  // 档名多语言:i18n 词表(effortLevels.*) → 模型级 effortDisplayNames →
  // capabilities displayName(未知档兜底) → 原 id。
  const effortLabelFor = (m: RowModel, e: Effort) => modelEffortLabel(t, m, e, effortMeta.get(e));

  // 当前 agent 是否支持 Fast Mode(agent 级能力,叠加 per-model supportsFastMode 才显示开关)。
  const hasFastModeCap = useMemo(() => {
    if (currentAgentKind === 'claude-code') return !!cc.capabilities?.hasFastMode;
    if (currentAgentKind === 'codex') return !!codex.capabilities?.hasFastMode;
    return false;
  }, [currentAgentKind, cc.capabilities, codex.capabilities]);
  // ── 来源(供应商)栏 ──────────────────────────────────────────────────────
  // 本机 + device-link 远程会话都支持来源分段:providers 已按 deviceId 切到被控端目录,
  // 远程切来源经隧道 set-model(providerId)生效(见 ChatInput.handleProviderChange 的远程分支)。
  // 浏览目标引擎态**必须**保留分段:分段走 connectedProvidersForAgent(只列已连接
  // 来源的模型),与正常模式同口径——flat 列表不过滤连接态,会把未连接来源的模型
  // 列出来,切过去后来源解析不到(trigger 无 icon、发送必失败)。行点击语义由
  // handleRowSelect 的 browsing 分支先行接管(连来源一起交给切换事务)。
  const sourcesEnabled = !!onProviderChange;
  const connected = useMemo(() => {
    if (!sourcesEnabled || !currentAgentKind) return [];
    const candidates = connectedProvidersForAgent(providers, currentAgentKind);
    return filterChatBridgedCodexProviders(
      candidates,
      currentAgentKind,
      excludeChatBridgedCodex === true,
    );
  }, [sourcesEnabled, providers, currentAgentKind, excludeChatBridgedCodex]);
  // 生效来源必须按当前模型收窄。只按 agent 从 connected 里兜底，会在 XD key 缺失但
  // OpenAI 已连接时拼出「OpenAI 图标 + Opus」这种不存在的路由。
  // 用「实际路由口径」(actualSourceIdForModel,不剔除停用拷贝):这里描述的是**当前
  // 会话正在用的来源**——运行中的会话不因停用打断,实际请求仍走原来源;若按准入过滤
  // 后解析,图标/价格/Fast/选中行豁免会显示成替代来源,与真实扣费路由不符
  // (PR #744 review 第五轮)。新路由选择(行点击/浏览)另走 connected 分段,不受影响。
  const activeSourceId = useMemo(
    () =>
      currentAgentKind
        ? resolveCurrentSourceId(providers, currentProviderId, modelId, currentAgentKind)
        : null,
    [providers, currentProviderId, modelId, currentAgentKind, resolveCurrentSourceId],
  );

  // 行级 Fast 可编辑性 = agent 能力 × 该(供应商, 模型)条目的 supportsFastMode。
  // Fast 能力是 per-(provider, agent) 的(见 CatalogModel)：按该行供应商现查它自己的模型条目,
  // 同一 model id 在不同供应商下可不同(如某网关剥掉 fast 字段 ⇒ 那家配 false)。providerId 为 null
  // (flat / device-link 退化)回退 activeSourceId;取不到供应商 / 该来源不提供此模型 ⇒ false。
  // cc / codex 同一套门控,仅各供应商的配置数据不同。查找用全量 providers:activeSourceId
  // 可能指向 suspended 来源(实际路由口径),connected 里查不到会误判 Fast 不可用。
  const fastEditable = (providerId: string | null, m: RowModel): boolean => {
    if (!onFastModeChange || !hasFastModeCap || !currentAgentKind) return false;
    const provider = providers.find((p) => p.id === (providerId ?? activeSourceId));
    return modelSupportsFastMode(provider, m.id, currentAgentKind);
  };

  // ── 模型单价 ─────────────────────────────────────────────────────────────
  // providerId 是价格索引的一部分。同模型经 XD / OpenAI / Anthropic 等来源出现时，
  // 必须按实际行来源查价，不能退化为 pricing[modelId]。只有 XD Gateway 目录价会
  // 叠加 CatalogModel.cost 作为折后展示价；其它来源保持价格源自带的币种。
  const pricePresentationOf = (providerId: string | null, id: string) => {
    // device-link 只同步被控端 provider 目录，不同步价格快照；不能把控制端价格与
    // 被控端 CatalogModel.cost 拼成一个展示结果。在协议补齐前远程选择器不展示价格。
    if (deviceId) return null;
    const effectiveProviderId =
      providerId ??
      (currentAgentKind
        ? resolveCurrentSourceId(providers, currentProviderId, id, currentAgentKind)
        : null);
    const quote = getModelPriceQuote(pricing, effectiveProviderId, id);
    if (effectiveProviderId === 'xd' && (!quote || quote.source === 'gateway')) {
      if (!quote && pricing == null) return null;
      const effectiveProvider = providers.find((provider) => provider.id === effectiveProviderId);
      const effectiveCost =
        effectiveProvider && currentAgentKind
          ? getModel(effectiveProvider, id, currentAgentKind)?.cost
          : undefined;
      return modelPricePresentation(quote ?? null, effectiveCost);
    }
    if (!quote) return null;
    const displayQuote = quote.approximate ? { ...quote, approximate: false } : quote;
    return modelPricePresentation(displayQuote, undefined);
  };
  const modelDisabledOf = (id: string): boolean => {
    if (!deviceId) return id.startsWith('codex/') && !hasSavedKey;
    if (remoteProviders.loading) return true;
    if (remoteProviders.error) return false;
    const rowAgentKind = resolveVisibleModelAgentKind({
      modelId: id,
      agentKind,
      ccModels: cc.capabilities?.availableModels ?? [],
      codexModels: codex.capabilities?.availableModels ?? [],
      providers,
    });
    if (!rowAgentKind) return true;
    // 逐模型停用与供应商级 suspended 同为准入硬门:被控端某来源整体启用但该模型被
    // 点名停用(CatalogModel.disabled,由被控端把 override 烘进 provider 视图)时,
    // 该拷贝不算可路由 —— 只数「来源连接且启用 + 模型条目未停用」的拷贝,否则远程
    // flat picker(如 CreateWorkerPopover)选中后到 Main 准入才失败
    // (PR #744 review 第二十二轮)。
    return !providers.some(
      (provider) =>
        provider.connected &&
        !provider.suspended &&
        provider.agents.includes(rowAgentKind) &&
        providerOffersModel(provider, id, rowAgentKind) &&
        getModel(provider, id, rowAgentKind)?.disabled !== true,
    );
  };

  // ── 供应商分段 / flat 列表 ────────────────────────────────────────────────
  // sections 非空 = 按供应商分段(每行 = (供应商, 模型));null = flat(无供应商概念)。
  // 当前会话的实际来源(activeSourceId)被供应商级停用时,connected(经
  // connectedProvidersForAgent,剔除 suspended)不含它 —— 选中行会整个消失,
  // keepSelected 豁免无从生效。把这个仍然连接着的 suspended 来源补进分段输入,
  // 但只保留选中行(isVisible 收口):它的其它模型不可作为新路由选择
  // (PR #744 review 第七轮)。
  const sectionProviders = useMemo(() => {
    if (!currentAgentKind || !activeSourceId) return connected;
    if (connected.some((p) => p.id === activeSourceId)) return connected;
    const actual = providers.find((p) => p.id === activeSourceId);
    // 只补「已连接但 suspended」的当前来源;未连接来源仍走既有空态/断链路径。
    if (!actual?.connected || !actual.agents.includes(currentAgentKind)) return connected;
    return [...connected, actual];
  }, [connected, providers, activeSourceId, currentAgentKind]);
  const suspendedActiveSourceId =
    sectionProviders === connected ? null : activeSourceId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: visibilityVersion 是外部可见性偏好的刷新信号,需要强制重算分段列表。
  const sections = useMemo(() => {
    if (!sourcesEnabled || !currentAgentKind) return null;
    // 0 个可连来源 → 返回 null 退化到 flat 列表(而非空 sections 触发「无结果」)。覆盖:
    //  · device-link 老被控端不认 maker:provider:list(invoke reject)→ device providers 为空 → flat 兜底;
    //  · providers 拉取中的瞬态窗口;· 本机 0 来源已由上方 emptyState 引导卡先行接管。
    if (sectionProviders.length === 0) return null;
    // 被停用的当前来源只保留选中行(keepSelected 豁免语义)。
    const restrictSuspended = (pid: string, mid: string): boolean =>
      !(suspendedActiveSourceId && pid === suspendedActiveSourceId && mid !== modelId);
    return buildProviderSections({
      providers: sectionProviders,
      agent: currentAgentKind,
      selectedModelId: modelId,
      selectedProviderId: activeSourceId,
      // device-link 远程会话使用被控端随 provider:list 返回的 override 快照，绝不套
      // 控制端本机 modelVisibilityPrefs。旧被控端不回传快照时 fail-open，保持兼容。
      isVisible: deviceId
        ? (pid, mid) => {
            if (!restrictSuspended(pid, mid)) return false;
            const p = sectionProviders.find((x) => x.id === pid);
            const cat = p ? getModel(p, mid, currentAgentKind) : undefined;
            return isDeviceModelVisible(
              remoteProviders.modelVisibilityOverrides,
              currentAgentKind,
              pid,
              { id: mid, defaultEnabled: cat?.defaultEnabled },
            );
          }
        : (pid, mid) => {
            if (!restrictSuspended(pid, mid)) return false;
            const p = sectionProviders.find((x) => x.id === pid);
            const cat = p ? getModel(p, mid, currentAgentKind) : undefined;
            return isModelEnabled(currentAgentKind, pid, {
              id: mid,
              defaultEnabled: cat?.defaultEnabled,
            });
          },
      query,
    });
    // visibilityVersion 仅作刷新触发器(设置页改显示开关后强制重算);deviceId 切换需重算分段。
  }, [
    sourcesEnabled,
    sectionProviders,
    suspendedActiveSourceId,
    currentAgentKind,
    modelId,
    activeSourceId,
    query,
    visibilityVersion,
    deviceId,
    remoteProviders.modelVisibilityOverrides,
  ]);

  const flatModels = useMemo(() => {
    if (sections) return null;
    const q = query.trim().toLowerCase();
    // 浏览目标引擎态的 flat 兜底(目标引擎 0 已连接来源时 sections 为 null)同样
    // 只列已连接来源提供的模型,与分段口径一致——未连接来源的模型切过去后来源
    // 解析不到(trigger 无 icon)、发送必失败。非浏览态保持历史行为不变。
    const base =
      browsing && agentKind
        ? visibleModels.filter((m) => sourcesForModel(providers, m.id, agentKind).length > 0)
        : visibleModels;
    // 本地 flat 入口（子代理模型、Worker 等）没有 provider sections 帮忙过滤，必须显式复用
    // 会话选择器 / IM `/model` 的同一套「已连接来源 × 用户可见模型」规则。否则设置页里
    // 已忽略或仅由断开来源提供的目录项仍会被列出来，选中后没有可用路由。
    // device-link 使用被控端 override；旧被控端没有快照时保持历史 fail-open。
    const selectableIds = deviceId
      ? remoteProviders.modelVisibilityOverrides === undefined
        ? null
        : new Set(
            (agentKind ? [agentKind] : (['claude-code', 'codex'] as const)).flatMap((agent) =>
              visibleModelUnion(providers, agent, (providerId, model) =>
                isDeviceModelVisible(
                  remoteProviders.modelVisibilityOverrides,
                  agent,
                  providerId,
                  model,
                ),
              ).map((model) => model.id),
            ),
          )
      : new Set(
          (agentKind ? [agentKind] : (['claude-code', 'codex'] as const)).flatMap((agent) =>
            visibleModelUnion(providers, agent, (providerId, model) =>
              isModelEnabled(agent, providerId, model),
            ).map((model) => model.id),
          ),
        );
    const selectable = selectableIds ? base.filter((model) => selectableIds.has(model.id)) : base;
    if (!q) return selectable;
    return selectable.filter(
      (m) => m.displayName.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
    );
  }, [
    sections,
    visibleModels,
    query,
    browsing,
    agentKind,
    providers,
    deviceId,
    visibilityVersion,
    remoteProviders.modelVisibilityOverrides,
  ]);

  // 选中判定:flat 模式只比模型 id;分段模式还要比供应商(同模型多供应商下只高亮当前来源那行)。
  // 浏览目标引擎态恒 false:当前会话模型属于旧引擎,目标列表里同 id 行(如 gpt-5.5
  // 两家都提供)高亮会误导成「已选中」。
  const isSelectedRow = (providerId: string | null, id: string): boolean =>
    !browsing && id === modelId && (providerId === null || providerId === activeSourceId);

  // 行内 Fast 闪电:选中行 → 调用方 fastMode(会话 = live;首页草稿 = 全局预设派生);其余行 → (agent,model) 全局预设(本机 =
  // providerModelMemory / 远程 = 被控端镜像),并由 fastEditable 按当前来源 capability 过滤。
  const fastOnOf = (providerId: string | null, m: RowModel): boolean => {
    if (!fastEditable(providerId, m)) return false;
    if (isSelectedRow(providerId, m.id)) return fastMode;
    if (!currentAgentKind || !providerId) return false;
    return modelMemory?.getFast(currentAgentKind, providerId, m.id) ?? false;
  };

  // 某 (供应商, 模型) 行当前要展示的 effort(选中 → 调用方值;否则全局模型预设 → 模型默认)。
  // 预设若不被该来源支持,在这里按行 capabilities 回落;无 effort 档返回 null。
  const rowEffortOf = (providerId: string | null, m: RowModel): Effort | null => {
    if (!m.efforts || m.efforts.length === 0) return null;
    if (isSelectedRow(providerId, m.id)) {
      return m.efforts.includes(effort) ? effort : (m.defaultEffort ?? m.efforts[0]);
    }
    const pe =
      currentAgentKind && providerId
        ? modelMemory?.getEffort(currentAgentKind, providerId, m.id)
        : undefined;
    const cand = pe ?? m.defaultEffort ?? undefined;
    return cand && m.efforts.includes(cand) ? cand : (m.defaultEffort ?? m.efforts[0] ?? null);
  };

  // 滚动到选中行(打开 / 列表变化时)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: sections / flatModels 作为列表内容变化信号,用于重新对齐选中行。
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      const sel = el.querySelector<HTMLElement>('[data-model-selected="true"]');
      if (sel) {
        const delta = sel.getBoundingClientRect().top - el.getBoundingClientRect().top;
        const next = Math.max(0, el.scrollTop + delta);
        if (Math.abs(delta) > 1 && next !== el.scrollTop) {
          suppressScrollDismissRef.current = true;
          el.scrollTop = next;
        }
      }
      flashScrollbar(el);
    });
    return () => cancelAnimationFrame(raf);
  }, [sections, flatModels]);

  // ── 行选择 ───────────────────────────────────────────────────────────────
  const handleRowSelect = (providerId: string | null, id: string) => {
    // 浏览目标引擎态:选中模型 = 确认切换引擎(两步式的第二步),走切换事务。
    // providerId 一起带上:切换后 sessions.provider_id 直接落用户选的来源,
    // trigger 来源 icon / 路由立即正确(null = flat 退化行,交给默认路由)。
    if (browsing && agentSwitch) {
      void agentSwitch.onSwitch(browseVendor === 'codex' ? 'codex' : 'claude-code', id, providerId);
      onDismiss?.();
      return;
    }
    if (isSelectedRow(providerId, id)) {
      // 默认:重选当前行 = 无操作,直接收起(会话场景点自己没有意义)。
      // reselectEmitsChange:调用方的「当前值」可能是**解析出来的继承值**而非已持久化的
      // 显式值(IM 工作目录偏好),这时点当前行的语义是「把继承值钉成显式值」,必须照常回调,
      // 否则用户点了没反应、之后上游默认一变这条偏好就被静默改掉。
      if (reselectEmitsChange) {
        if (sections && providerId) onProviderChange?.(providerId, id);
        else onModelChange(id);
      }
      onDismiss?.();
      return;
    }
    if (sections && providerId) {
      // 原子切 provider+model+effort(effort 由 handleProviderChange 内 resolveSwitchEffort 从记忆解析)。
      onProviderChange?.(providerId, id);
    } else {
      onModelChange(id);
    }
    onDismiss?.();
  };
  // ── hover / focus 浮层目标 ───────────────────────────────────────────────
  const editingModel: RowModel | null = useMemo(() => {
    if (!editing) return null;
    if (sections) {
      const sec = sections.find((s) => s.provider.id === editing.providerId);
      return sec?.models.find((m) => m.id === editing.modelId) ?? null;
    }
    return flatModels?.find((m) => m.id === editing.modelId) ?? null;
  }, [editing, sections, flatModels]);

  // 浏览目标引擎态恒非 active(与 isSelectedRow 同口径):目标列表里可能出现与当前
  // 会话同 id 同来源的行(网关同一模型双引擎都供),悬浮面板里的改动绝不能写进
  // 当前会话的实时 effort / Fast,只能落目标引擎的全局预设。
  const editingIsActive =
    !browsing &&
    !!editing &&
    editing.modelId === modelId &&
    (editing.providerId === null || editing.providerId === activeSourceId);
  const editingProviderId = editing?.providerId ?? null;
  // 当前行可编辑配置的边界:选中行写实时状态;非选中供应商行写模型级全局预设。
  // flat 非选中行没有来源 capability / 写穿上下文,只展示模型信息,避免出现点击后无效果的配置项。
  const canConfigure =
    configurationEnabled &&
    !!editingModel &&
    (editingIsActive || (!!modelMemory && !!currentAgentKind && !!editingProviderId));
  const editShowFast =
    canConfigure && !!editingModel && fastEditable(editingProviderId, editingModel);
  const editHasEfforts = canConfigure && (editingModel?.efforts.length ?? 0) > 0;

  // 配置列当前 effort 值(选中 → live;否则记忆/默认)。
  const editEffortValue: Effort | null = editingModel
    ? rowEffortOf(editingProviderId, editingModel)
    : null;
  const editFastValue: boolean = editingModel
    ? editingIsActive
      ? fastMode
      : ((currentAgentKind && editingProviderId
          ? modelMemory?.getFast(currentAgentKind, editingProviderId, editingModel.id)
          : undefined) ?? false)
    : false;

  const handleEditEffort = (e: Effort) => {
    if (!editing || !editingModel) return;
    if (editingIsActive) {
      onEffortChange(e);
    } else {
      // 非选中行:只写该设备的全局模型预设;不传 modelMemory(flat 选择器)则纯 no-op。
      if (currentAgentKind && editing.providerId) {
        modelMemory?.setEffort(currentAgentKind, editing.providerId, editingModel.id, e);
      }
      bump();
    }
  };
  const handleEditFast = (enabled: boolean) => {
    if (!editing || !editingModel) return;
    if (editingIsActive) {
      // 当前选中模型的 Fast 是会话实时状态,必须等 onFastModeChange 持久化成功后再由
      // ChatInput 同步草稿默认;这里不能预写 modelMemory,否则 device-link 远程失败会污染被控端草稿。
      void onFastModeChange?.(enabled);
    } else {
      // 非选中行:只写该设备的模型级全局预设;来源参数用于 capability / device-link 写穿路由。
      if (currentAgentKind && editing.providerId) {
        modelMemory?.setFast(currentAgentKind, editing.providerId, editingModel.id, enabled);
      }
    }
    bump();
  };

  const editingProvider = useMemo(() => {
    if (!editingModel || !currentAgentKind) return undefined;
    const providerId =
      editingProviderId ??
      resolveCurrentSourceId(providers, currentProviderId, editingModel.id, currentAgentKind);
    return providerId ? providers.find((provider) => provider.id === providerId) : undefined;
  }, [editingModel, currentAgentKind, editingProviderId, providers, currentProviderId, resolveCurrentSourceId]);
  const editingPricePresentation = editingModel
    ? pricePresentationOf(editingProvider?.id ?? editingProviderId, editingModel.id)
    : null;
  const editingDiscount =
    editingPricePresentation?.kind === 'priced' ? editingPricePresentation.discount : undefined;
  const editingPromotionLabel =
    editingPricePresentation?.kind === 'free'
      ? t('newChat.modelSelector.pricing.free')
      : editingDiscount !== undefined
        ? t(
            'newChat.modelSelector.pricing.discount',
            modelPriceDiscountLabelValues(editingDiscount),
          )
        : null;

  // 每个模型行的信息 / 配置内容由一个独立的 portaled Popover 承载,而不是拼进主菜单宽度。
  // 这样浮层会像 Hermes 的 Radix submenu 一样贴着当前行移动,切行不触发主菜单重排。
  const configPanel = editingModel ? (
    <div
      ref={configPanelRef}
      role="group"
      aria-label={`${editingModel.displayName} ${t('newChat.modelSelector.options')}`}
      className="flex flex-col gap-0.5"
    >
      {/* 名字 / 简介先帮助确认模型；面板整体居中后，操作区仍贴近当前 hover 行。 */}
      <div className="flex flex-col gap-1 px-2 py-1.5">
        <span className="min-w-0 text-14 font-medium text-[var(--model-item-text)]">
          {editingModel.displayName}
        </span>
        {editingModel.description && (
          <span className="line-clamp-2 text-12 font-normal leading-[1.4] text-[var(--text-secondary)]">
            {editingModel.description}
          </span>
        )}
      </div>
      {(editShowFast || editHasEfforts) && (
        <div className="mx-1 my-1 h-px bg-[var(--model-dropdown-border)]" />
      )}
      {editShowFast && (
        <div className="px-0.5">
          {/* 遵循设计稿:单色反色(轨/文字 --text-primary,钮 --surface-on-card),不用品牌橙。 */}
          <FastModeToggle
            enabled={editFastValue}
            onToggle={() => handleEditFast(!editFastValue)}
            hideIcon
            accentVar="var(--text-primary)"
            thumbVar="var(--surface-on-card)"
          />
        </div>
      )}
      {editShowFast && editHasEfforts && (
        <div className="mx-1 my-1 h-px bg-[var(--model-dropdown-border)]" />
      )}
      {editHasEfforts && (
        <>
          <div className="px-2 pb-0.5 pt-1">
            <span className="text-11 font-medium text-[var(--text-tertiary)]">
              {t('newChat.modelSelector.effortLabel')}
            </span>
          </div>
          {editingModel.efforts.map((e) => {
            const selected = editEffortValue === e;
            return (
              <button
                type="button"
                key={e}
                onClick={() => handleEditEffort(e)}
                role="option"
                aria-selected={selected}
                className={cn(
                  // 行内边距/圆角/hover 与选中底统一到 --model-item-hover(见 §Select 菜单行规约),
                  // 与一级模型行、权限、+ 菜单一致;px-3 对齐其它菜单行的横向内边距。
                  'flex w-full items-center justify-between rounded-[8px] px-3 py-2 text-left transition-colors duration-100',
                  'hover:bg-[var(--model-item-hover)]',
                  selected && 'bg-[var(--model-item-hover)]',
                )}
              >
                <span
                  className={cn(
                    'truncate text-[13.5px] text-[var(--model-item-text)]',
                    selected ? 'font-medium' : 'font-normal',
                  )}
                >
                  {effortLabelFor(editingModel, e)}
                </span>
                {selected && (
                  <Check size={15} className="ml-2 shrink-0 text-[var(--model-item-check)]" />
                )}
              </button>
            );
          })}
        </>
      )}
      {(editShowFast || editHasEfforts) && (
        <div className="mx-1 my-1 h-px bg-[var(--model-dropdown-border)]" />
      )}
      {editingPricePresentation && (
        <>
          <div className="px-2 pb-1 pt-1">
            <div
              className={cn(
                'flex items-center gap-1.5 text-11 font-medium text-[var(--text-tertiary)]',
                editingPricePresentation.kind === 'priced' && 'mb-1.5',
              )}
            >
              <span>{t('newChat.modelSelector.pricing.title')}</span>
              {editingPromotionLabel && (
                <span data-model-tags className="ml-auto flex shrink-0 items-center">
                  <ModelPromotionBadge>{editingPromotionLabel}</ModelPromotionBadge>
                </span>
              )}
            </div>
            {editingPricePresentation.kind === 'priced' && (
              <>
                <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-12 leading-[1.4]">
                  {modelPriceDetailRows(
                    editingPricePresentation.current,
                    editingPricePresentation.original,
                  ).map((row) => (
                    <div key={row.kind} className="contents">
                      <span className="text-[var(--text-secondary)]">
                        {t(`newChat.modelSelector.pricing.${row.kind}`)}
                      </span>
                      <span className="flex items-center justify-end gap-1.5 tabular-nums">
                        <span className="text-[var(--model-item-text)]">{row.value}</span>
                        {row.originalValue && (
                          <span className="text-[var(--text-tertiary)] line-through">
                            {row.originalValue}
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="mt-1.5 text-11 leading-[1.4] text-[var(--text-tertiary)]">
                  {editingPricePresentation.current.source === 'subscription-reference'
                    ? t('newChat.modelSelector.pricing.subscriptionEstimate')
                    : editingPricePresentation.current.approximate
                      ? t('newChat.modelSelector.pricing.fixedFx')
                      : t('newChat.modelSelector.pricing.perMillion')}
                </div>
              </>
            )}
          </div>
          <div className="mx-1 my-1 h-px bg-[var(--model-dropdown-border)]" />
        </>
      )}
      <div className="px-2 py-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-11 font-normal leading-[1.4] text-[var(--text-tertiary)]">
          {editingProvider && (
            <span>
              {t('newChat.modelSelector.source.viaSource', {
                source: providerDisplayName(editingProvider, t),
              })}
            </span>
          )}
          {editingModel.contextWindow > 0 && (
            <span>
              {t('newChat.modelSelector.meta.context', {
                value: formatContextWindow(editingModel.contextWindow),
              })}
            </span>
          )}
          {editingModel.supportsFastMode && (
            <span>{t('newChat.modelSelector.meta.fastBadge')}</span>
          )}
        </div>
      </div>
    </div>
  ) : null;

  // ── 单个模型行 ───────────────────────────────────────────────────────────
  // provider 非空(分段模式)→ 名字前缀该来源的 mark;null(flat / device-link)→ 无前缀。
  const renderModelItem = (provider: ProviderView | null, model: RowModel) => {
    const providerId = provider?.id ?? null;
    const isSelected = isSelectedRow(providerId, model.id);
    const isBudgetModel = model.id.startsWith('codex/');
    const isSubscriptionModel = provider?.access?.kind === 'subscription';
    const disabled = modelDisabledOf(model.id);
    const rowEffort = rowEffortOf(providerId, model);
    const rowFastOn = fastOnOf(providerId, model);
    const rowPrice = pricePresentationOf(providerId, model.id);
    const rowPromotionLabel =
      rowPrice?.kind === 'free'
        ? t('newChat.modelSelector.pricing.free')
        : rowPrice?.kind === 'priced' && rowPrice.discount !== undefined
          ? t(
              'newChat.modelSelector.pricing.discount',
              modelPriceDiscountLabelValues(rowPrice.discount),
            )
          : null;
    // 信息面板对所有可用模型开放;能否编辑 effort / Fast 在面板内部另行判定。
    // session-agent-switch 浏览目标引擎态同样开放:选模型前正需要看描述/上下文/价格/来源;
    // 面板内配置写的是**目标引擎**的 per-(来源,模型) 全局预设(currentAgentKind 已随浏览态
    // 指向目标引擎),切换确认后由 performAgentSwitch 按预设恢复 effort / Fast。
    const hasOptions = !disabled;
    const isEditingThis =
      !!editing && editing.modelId === model.id && editing.providerId === providerId;
    const revealOptions = () => {
      cancelOptionsClose();
      setEditing(hasOptions ? { providerId, modelId: model.id } : null);
    };
    // pointerenter 触发的 reveal 必须等光标真实移动过才武装:面板(MorphPopover)在
    // 光标正下方原位展开时,行会滑到**静止**光标底下触发 pointerenter,行配置浮层
    // 会闪现一下(2026-07-22 用户反馈)。macOS 菜单同款解法:静止光标不算 hover 意图。
    // 注意 enter 先于 move 派发 —— 首次移入行时 enter 可能仍被拦,由行上的
    // onPointerMove 兜底 reveal(setEditing 同值幂等,不抖)。
    // untrusted 事件(jsdom 测试/程序派发)不设门:布局位移诱发的浏览器事件是
    // trusted 的,真实闪现场景仍被挡。
    const revealOptionsByPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
      if (
        pointerRevealRequiresIntent &&
        !hoverIntentArmedRef.current &&
        event.nativeEvent.isTrusted
      )
        return;
      if (!isEditingThis) revealOptions();
      else cancelOptionsClose();
    };
    return (
      <Popover
        key={`${providerId ?? ''}::${model.id}`}
        open={isEditingThis}
        onOpenChange={(open) => {
          if (!open && isEditingThis) setEditing(null);
        }}
      >
        <PopoverAnchor asChild>
          <div
            role="option"
            aria-selected={isSelected}
            aria-disabled={disabled}
            data-model-selected={isSelected ? 'true' : undefined}
            data-model-options-active={isEditingThis ? 'true' : undefined}
            tabIndex={disabled ? -1 : 0}
            onPointerEnter={revealOptionsByPointer}
            onPointerMove={revealOptionsByPointer}
            onPointerLeave={scheduleOptionsClose}
            onFocus={revealOptions}
            onBlur={(event) => {
              if (configPanelRef.current?.contains(event.relatedTarget as Node | null)) return;
              scheduleOptionsClose();
            }}
            onClick={() => {
              if (disabled) return;
              handleRowSelect(providerId, model.id);
            }}
            onKeyDown={(ev) => {
              if (ev.target !== ev.currentTarget || disabled) return;
              if (ev.key === 'ArrowLeft' && hasOptions) {
                ev.preventDefault();
                revealOptions();
                requestAnimationFrame(() => {
                  configPanelRef.current
                    ?.querySelector<HTMLElement>('button:not(:disabled)')
                    ?.focus();
                });
                return;
              }
              if (ev.key !== 'Enter' && ev.key !== ' ') return;
              ev.preventDefault();
              handleRowSelect(providerId, model.id);
            }}
            className={cn(
              'flex w-full cursor-pointer items-center justify-between rounded-[8px] px-3 py-2',
              constrainedListMaxHeight !== undefined && 'min-h-9',
              'transition-colors duration-100 hover:bg-[var(--model-item-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
              isSelected && 'bg-[var(--model-item-hover)]',
              isEditingThis &&
                'bg-[var(--surface-hover)] ring-1 ring-inset ring-[var(--model-dropdown-border)]',
              disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
            )}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2.5">
              {provider && (
                <ModelIconMark
                  icon={model.icon}
                  providerId={provider.id}
                  name={provider.name}
                  routing={provider.routing}
                  logoKind={provider.logoKind}
                  colorClass="text-[var(--text-secondary)]"
                  withMargin={false}
                  dense
                />
              )}
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="truncate text-14 font-medium leading-5 text-[var(--model-item-text)]">
                    {model.displayName}
                  </span>
                  {rowEffort && (
                    <span className="shrink-0 text-13 font-normal text-[var(--text-tertiary)]">
                      {effortLabelFor(model, rowEffort)}
                    </span>
                  )}
                  {rowFastOn && (
                    <Zap
                      size={13}
                      className="shrink-0 text-[var(--text-tertiary)]"
                      aria-label={t('newChat.modelSelector.meta.fastBadge')}
                    />
                  )}
                </span>
                {(isSubscriptionModel || isBudgetModel || rowPromotionLabel) && (
                  <span data-model-tags className="ml-auto flex shrink-0 items-center gap-1.5">
                    {isSubscriptionModel && (
                      <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--surface-chip)] px-2 py-[1px] text-[11px] font-medium text-[var(--text-secondary)]">
                        {t('settings.providers.models.subscription')}
                      </span>
                    )}
                    {isBudgetModel && (
                      <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--model-budget-badge-bg)] px-2 py-[1px] text-[11px] font-medium text-[var(--model-budget-badge-text)]">
                        {t('newChat.modelSelector.meta.budgetDiscount')}
                      </span>
                    )}
                    {rowPromotionLabel && (
                      <ModelPromotionBadge>{rowPromotionLabel}</ModelPromotionBadge>
                    )}
                  </span>
                )}
              </span>
            </span>
            {isSelected && (
              <span className="ml-2 flex shrink-0 items-center">
                <Check size={15} className="shrink-0 text-[var(--model-item-check)]" />
              </span>
            )}
          </div>
        </PopoverAnchor>
        {isEditingThis && configPanel && (
          <PopoverContent
            side="left"
            align="center"
            sideOffset={MODEL_OPTIONS_SIDE_OFFSET}
            collisionPadding={8}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onPointerEnter={cancelOptionsClose}
            onPointerLeave={scheduleOptionsClose}
            onFocusCapture={cancelOptionsClose}
            onBlurCapture={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              scheduleOptionsClose();
            }}
            className={cn(
              'w-[248px] overflow-hidden rounded-[12px] p-2 shadow-[var(--shadow-menu)] duration-100',
              'border border-[var(--model-dropdown-border)] bg-[var(--model-dropdown-bg)]',
              overlayContentClassName,
            )}
          >
            {configPanel}
          </PopoverContent>
        )}
      </Popover>
    );
  };

  // 0 个可连来源:整张引导卡取代列表(仅 providers 加载完成后判,避免拉取期闪空态)。
  // device-link 远程会话不显示该引导(控制端无法替被控端连来源)→ 退化为扁平兜底列表。
  const emptyState =
    sourcesEnabled &&
    !deviceId &&
    currentAgentKind &&
    !providersLoading &&
    connected.length === 0 ? (
      <div className="flex flex-col gap-[14px] p-2">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-[var(--model-item-hover)]">
            <Unplug size={16} className="text-[var(--text-secondary)]" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <span className="truncate text-sm font-medium text-[var(--model-item-text)]">
              {t('newChat.modelSelector.source.emptyTitle')}
            </span>
            <span className="text-12 font-normal text-[var(--text-secondary)]">
              {t('newChat.modelSelector.source.emptyDesc')}
            </span>
          </div>
        </div>
        {onNavigateToProviders && (
          <button
            type="button"
            onClick={onNavigateToProviders}
            className={cn(
              'flex h-[34px] w-full items-center justify-center rounded-[8px]',
              'bg-[var(--accent-cta-bg)] transition-opacity hover:opacity-90',
            )}
          >
            <span className="text-13 font-medium text-[var(--accent-pure-cta-fg)]">
              {t('newChat.modelSelector.source.connectCta')}
            </span>
          </button>
        )}
      </div>
    ) : null;

  if (emptyState) return emptyState;

  const hasAnyModel = sections ? sections.length > 0 : (flatModels?.length ?? 0) > 0;

  // ── 主菜单:固定 320 宽(field 形态改绑 trigger 宽度,见 fluidWidth),选项浮层
  //    portal 到 body,hover 时主菜单完全不重排 ─────
  const pane = (
    <div
      className={cn(
        'flex shrink-0 flex-col gap-1.5 p-2',
        fluidWidth ? 'w-full min-w-0' : 'w-[320px]',
      )}
    >
      {/* session-agent-switch:显式两步引擎切换——先在分段里选 Agent,再选模型。
          复用新建会话的 VendorSegmentedSwitcher 视觉(dense),宽度撑满列表列。 */}
      {agentSwitch && (
        <>
          <VendorSegmentedSwitcher
            value={browseVendor}
            onChange={(next) => void handleBrowseVendorChange(next === 'codex' ? 'codex' : 'cc')}
            dense
            width={304}
            className="mx-auto"
            // 浮层内选中段用黑白反转强对比(default 的暗色 Card 凸起在浮层
            // 表面上分不清"当前选的是哪家",2026-07-20 产品实测反馈)。
            visualVariant="dropdown"
          />
          {browsing && (
            <div className="px-2 pb-0.5 text-12 text-[var(--text-tertiary)]">
              {t('newChat.modelSelector.agentSwitch.hint', { agent: browseTargetLabel })}
            </div>
          )}
          <div className="mx-1 h-px bg-[var(--model-dropdown-border)]" />
        </>
      )}
      {/* 「跟随会话」行(opt-in,仅 scheduler heartbeat) */}
      {followSession && (
        <>
          <button
            type="button"
            onClick={() => {
              followSession.onFollow();
              onDismiss?.();
            }}
            role="option"
            aria-selected={followSession.active}
            className={cn(
              'flex w-full items-center justify-between rounded-[8px] px-3 py-2 transition-colors',
              'hover:bg-[var(--model-item-hover)]',
              followSession.active && 'bg-[var(--model-item-hover)]',
            )}
          >
            <span className="text-14 font-medium text-[var(--model-item-text)]">
              {followSession.label}
            </span>
            {followSession.active && (
              <Check size={16} className="ml-2 shrink-0 text-[var(--model-item-check)]" />
            )}
          </button>
          <div className="mx-1 h-px bg-[var(--model-dropdown-border)]" />
        </>
      )}
      {/* 搜索框 —— 药丸样式。 */}
      <div className="flex items-center gap-2 rounded-full border border-[var(--model-dropdown-border)] bg-[var(--surface)] px-3 py-[7px]">
        <Search size={16} className="shrink-0 text-[var(--text-tertiary)]" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('newChat.modelSelector.search.placeholderAll')}
          className="min-w-0 flex-1 bg-transparent text-14 text-[var(--model-item-text)] outline-none placeholder:text-[var(--text-tertiary)]"
          aria-label={t('newChat.modelSelector.search.placeholderAll')}
        />
      </div>

      {/* 模型列表 —— 单栏;分段(供应商)或 flat。 */}
      <div
        ref={listRef}
        // -mr-2 把滚动条挪进面板右侧 8px 留白;scrollbar-gutter:stable 让无滚动时
        // 行宽与有滚动时一致(否则行会比搜索框宽 8px);细滚动条见 globals.css
        className="morph-panel-list-scroll -mr-2 flex max-h-[300px] flex-col gap-0.5 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
        style={
          constrainedListMaxHeight === undefined
            ? undefined
            : { maxHeight: `${constrainedListMaxHeight}px` }
        }
        role="listbox"
        aria-label="Model list"
        onScroll={() => {
          if (suppressScrollDismissRef.current) {
            suppressScrollDismissRef.current = false;
            return;
          }
          // 滚动不派发 pointerleave,行级配置浮层会跟着滚出视口的锚点行跑到菜单外 → 一滚动就收起。
          if (editing) setEditing(null);
        }}
      >
        {!hasAnyModel ? (
          <div className="px-3 py-6 text-center text-13 text-[var(--text-tertiary)]">
            {t('newChat.modelSelector.search.noResults')}
          </div>
        ) : sections ? (
          // 平铺:每行带来源 mark 前缀,无分组标题(同供应商行仍因 buildProviderSections 顺序而相邻)。
          sections.flatMap((sec) => sec.models.map((m) => renderModelItem(sec.provider, m)))
        ) : (
          (flatModels ?? []).map((m) => renderModelItem(null, m))
        )}
      </div>

      {/* 「连接来源」footer(供应商入口)—— device-link 远程会话隐藏(无法替被控端连来源)。 */}
      {onNavigateToProviders && !deviceId && (
        <>
          <div className="mx-1 h-px bg-[var(--model-dropdown-border)]" />
          <button
            type="button"
            onClick={onNavigateToProviders}
            className={cn(
              'flex w-full items-center gap-1.5 rounded-[8px] px-3 py-2',
              'transition-colors hover:bg-[var(--model-item-hover)]',
            )}
          >
            <Plus size={14} className="shrink-0 text-[var(--text-tertiary)]" />
            <span className="truncate text-13 font-normal text-[var(--text-tertiary)]">
              {t('newChat.modelSelector.source.connect')}
            </span>
          </button>
        </>
      )}
    </div>
  );

  return pane;
}

export function ModelSelector({
  modelId,
  effort,
  onModelChange,
  onEffortChange,
  fastMode,
  onFastModeChange,
  modelMemory,
  vendorKey,
  agentIdentity,
  deviceId,
  excludeSubscriptionDirect,
  excludeChatBridgedCodex,
  switching = false,
  disabled = false,
  dense = false,
  compactToolbar = false,
  ultraCompactToolbar = false,
  triggerVariant = 'toolbar',
  visualVariant = 'default',
  useMorphPopover = false,
  popoverSide = 'top',
  maxVisibleModelRows,
  configurationEnabled = true,
  fallbackOption,
  reselectEmitsChange = false,
  unknownModelLabel,
  ariaContext,
  currentProviderId,
  sourceDisconnected = false,
  actualRoute = false,
  onProviderChange,
  onNavigateToProviders,
  agentSwitch,
}: ModelSelectorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const [keepOpenForAgentConfirmation, setKeepOpenForAgentConfirmation] = useState(false);
  const setOpenWithoutAutoRefresh = useCallback((next: boolean): void => {
    openRef.current = next;
    setOpen(next);
  }, []);
  const handleOpenChange = useCallback(
    (next: boolean): void => {
      const nextOpen = disabled ? false : next;
      const wasOpen = openRef.current;
      openRef.current = nextOpen;
      if (nextOpen && !wasOpen && !deviceId) {
        void window.electronAPI.maker
          .requestProviderModelsAutoRefresh('model-selector-open')
          .catch(() => undefined);
      }
      setOpen(nextOpen);
    },
    [deviceId, disabled],
  );

  // AlertDialog 打开时会被 Popover 视作外部交互并请求关闭。Agent 分段确认期间
  // 强制保留已展开的模型面板；确认结束后把底层 open 恢复为 true，避免弹窗关闭
  // 时的焦点回落再次把面板收掉。模型行确认及其它消费者不经过这层包装。
  const contentAgentSwitch = useMemo(() => {
    const confirmBrowseSwitch = agentSwitch?.confirmBrowseSwitch;
    if (!confirmBrowseSwitch) return agentSwitch;
    return {
      ...agentSwitch,
      confirmBrowseSwitch: async () => {
        setKeepOpenForAgentConfirmation(true);
        try {
          return await confirmBrowseSwitch();
        } finally {
          setOpenWithoutAutoRefresh(true);
          setKeepOpenForAgentConfirmation(false);
        }
      },
    };
  }, [agentSwitch, setOpenWithoutAutoRefresh]);

  const agentKind = vendorKeyToAgentKind(vendorKey);
  const cc = useAgentCapabilities('claude-code', deviceId);
  const codex = useAgentCapabilities('codex', deviceId);
  const pricing = useModelPricing();
  // trigger 的来源 icon / 当前模型也按来源取:device-link 用被控端供应商目录(否则控制端本地
  // 查不到被控端独有模型 → currentModel undefined → label 退成 "Select model")。
  const localProviders = useProviders();
  const remoteProviders = useDeviceProviders(deviceId);
  const providers = deviceId ? remoteProviders.providers : localProviders.providers;
  const visibleModels = useMemo(
    () =>
      selectVisibleModels({
        agentKind,
        deviceId,
        providers,
        deviceCcModels: cc.capabilities?.availableModels ?? [],
        deviceCodexModels: codex.capabilities?.availableModels ?? [],
        excludeSubscriptionDirect,
        excludeChatBridgedCodex,
      }),
    [
      agentKind,
      deviceId,
      providers,
      cc.capabilities,
      codex.capabilities,
      excludeSubscriptionDirect,
      excludeChatBridgedCodex,
    ],
  );

  const currentModel = visibleModels.find((m) => m.id === modelId);
  // 已保存的模型不在可见清单里(被隐藏 / 供应商断开 / 目录下架)时,默认落到「选择模型」
  // 占位符 —— 对会话是对的(没选过),但对「展示一条已持久化偏好」的调用方是信息丢失:
  // 用户既看不到自己存的是什么,也看不到实际会跑什么。unknownModelLabel 让这类调用方
  // 给出诊断性文案(通常是裸 id),行为与本组件接管前一致。
  // unknown label 空串/全空白按缺省处理(否则 ?? 不回落,trigger 渲染成空白)。
  const unknownLabel = modelId && unknownModelLabel ? unknownModelLabel(modelId).trim() : '';
  const displayLabel = fallbackOption?.active
    ? fallbackOption.label
    : (currentModel?.displayName ??
      (unknownLabel !== '' ? unknownLabel : null) ??
      t('newChat.modelSelector.trigger.placeholder'));
  const agentName =
    agentIdentity && !fallbackOption?.active
      ? agentIdentity.vendorKey === 'cc'
        ? t('newChat.modelSelector.trigger.agent.claudeCode')
        : t('newChat.modelSelector.trigger.agent.codex')
      : null;
  const agentIdentityLabel =
    agentName && agentIdentity?.state === 'pending'
      ? t('newChat.modelSelector.trigger.agent.pending', { agent: agentName })
      : agentName;
  const displayIdentityLabel = agentIdentityLabel
    ? `${agentIdentityLabel} · ${displayLabel}`
    : displayLabel;
  const efforts = currentModel?.efforts ?? [];

  const currentAgentKind: AgentKind | null = useMemo(() => {
    if (agentKind) return agentKind;
    if (!currentModel) return null;
    if (providers.some((p) => providerOffersModel(p, currentModel.id, 'claude-code'))) {
      return 'claude-code';
    }
    if (providers.some((p) => providerOffersModel(p, currentModel.id, 'codex'))) {
      return 'codex';
    }
    return null;
  }, [currentModel, providers, agentKind]);

  const effortMeta = useMemo(() => {
    const levels =
      currentAgentKind === 'claude-code'
        ? (cc.capabilities?.effortLevels ?? [])
        : currentAgentKind === 'codex'
          ? (codex.capabilities?.effortLevels ?? [])
          : [];
    return new Map(levels.map((e) => [e.id, e.displayName]));
  }, [currentAgentKind, cc.capabilities, codex.capabilities]);
  // 档名多语言(与列表侧 effortLabelFor 同序):i18n 词表 → 模型级覆盖 → capabilities 英文名 → id。
  const labelOf = (e: Effort) => modelEffortLabel(t, currentModel, e, effortMeta.get(e));

  // 「有没有可选来源」走统一判定 hook(与 ChatInput Send 门禁同一条规则)。
  const { hasConnectedSource, loading: providersLoading } = useConnectedSource(
    currentAgentKind,
    modelId,
  );
  // trigger 左侧来源 icon 必须是当前模型真正可路由的来源，不能拿“支持该 agent 但不提供
  // 此模型”的供应商作兜底。
  const activeSourceId = useMemo<string | null>(
    () =>
      currentAgentKind
        ? (actualRoute ? actualSourceIdForModel : effectiveSourceIdForModel)(providers, currentProviderId, modelId, currentAgentKind)
        : null,
    [providers, currentAgentKind, currentProviderId, modelId, actualRoute],
  );
  // 空態:当前模型一个已连接来源都没有 → trigger 改「连接来源」CTA。
  // device-link 远程会话不走此 CTA(控制端无法替被控端连来源;hasConnectedSource 是本机口径)。
  const noSource =
    !!onProviderChange &&
    !!onNavigateToProviders &&
    !deviceId &&
    !!currentAgentKind &&
    !providersLoading &&
    !hasConnectedSource;
  // trigger 上仍展示当前模型的 effort(模型支持时)。
  const showEffort = !fallbackOption?.active && efforts.length > 0 && efforts.includes(effort);
  const effortLabel = showEffort ? labelOf(effort) : null;
  // Fast 工具栏按钮已移除 → trigger 上用闪电标出当前是否 Fast(模型支持 + 已开启时)。
  // 支持性按「当前生效来源」现查 per-provider 条目;无法解析来源(flat / device-link 退化)时
  // 回退拍平值,避免误隐藏闪电。
  const triggerActiveProvider = activeSourceId
    ? providers.find((p) => p.id === activeSourceId)
    : undefined;
  // trigger 图标的统一规则:当前 (来源, 模型) 条目的 icon(AI Gateway / 目录设定)优先,
  // 缺省回落来源供应商标 —— 与列表行、手机版同一套口径(ModelIconMark)。
  const triggerModelIcon =
    triggerActiveProvider && currentAgentKind
      ? getModel(triggerActiveProvider, modelId, currentAgentKind)?.icon
      : undefined;
  const triggerPricePresentation = (() => {
    if (deviceId || activeSourceId !== 'xd' || !triggerActiveProvider || !currentAgentKind)
      return null;
    const quote = getModelPriceQuote(pricing, activeSourceId, modelId);
    if (quote && quote.source !== 'gateway') return null;
    if (!quote && pricing == null) return null;
    return modelPricePresentation(
      quote ?? null,
      getModel(triggerActiveProvider, modelId, currentAgentKind)?.cost,
    );
  })();
  const triggerPromotionLabel =
    triggerPricePresentation?.kind === 'free'
      ? t('newChat.modelSelector.pricing.free')
      : triggerPricePresentation?.kind === 'priced' &&
          triggerPricePresentation.discount !== undefined
        ? t(
            'newChat.modelSelector.pricing.discount',
            modelPriceDiscountLabelValues(triggerPricePresentation.discount),
          )
        : null;
  // 断开态同一规则,只是来源取「真实断开来源」(currentProviderId)。
  const disconnectedProvider = currentProviderId
    ? providers.find((p) => p.id === currentProviderId)
    : undefined;
  const disconnectedModelIcon =
    disconnectedProvider && currentAgentKind
      ? getModel(disconnectedProvider, modelId, currentAgentKind)?.icon
      : undefined;
  const triggerFastSupported =
    triggerActiveProvider && currentAgentKind
      ? modelSupportsFastMode(triggerActiveProvider, modelId, currentAgentKind)
      : !!currentModel?.supportsFastMode;
  const triggerFastOn = fastMode === true && triggerFastSupported;
  // 断开态仅在「非 noSource」时生效:全部来源都断开时 noSource CTA 优先(下拉已无可选行,
  // 跳设置才是正确恢复路径);还有别的已连接来源时,下拉换源就是恢复路径,trigger 保持可点。
  const showSourceDisconnected = !noSource && sourceDisconnected && !!currentProviderId;
  const baseAriaLabel = noSource
    ? t('newChat.modelSelector.source.connect')
    : showSourceDisconnected
      ? `${t('newChat.modelSelector.source.disconnected')}: ${displayIdentityLabel}`
      : agentIdentity?.state === 'pending' && agentName
        ? effortLabel
          ? t('newChat.modelSelector.trigger.pendingAriaWithEffort', {
              agent: agentName,
              model: displayLabel,
              effort: effortLabel,
            })
          : t('newChat.modelSelector.trigger.pendingAria', {
              agent: agentName,
              model: displayLabel,
            })
        : effortLabel
          ? t('newChat.modelSelector.trigger.ariaWithEffort', {
              model: displayIdentityLabel,
              effort: effortLabel,
            })
          : t('newChat.modelSelector.trigger.aria', { model: displayIdentityLabel });
  // compact 会隐藏断连状态文字；原生 title 仍需保留同一状态，避免鼠标用户悬停
  // 错误图标时只看到模型名、无法判断发送为何被阻断。
  const triggerTitle = showSourceDisconnected ? baseAriaLabel : displayIdentityLabel;
  // 多实例同屏(IM 目录偏好)时前置「字段名 · 行别名」,读屏才能区分行与行。
  const ariaLabel = ariaContext ? `${ariaContext}:${baseAriaLabel}` : baseAriaLabel;
  const isBudget = modelId.startsWith('codex/');
  const isFieldTrigger = triggerVariant === 'field';
  const isCreateAgentVariant = visualVariant === 'create-agent';
  // compact 是 composer 容器宽度状态，不是 create-agent 的视觉私有状态。
  // 正常会话在侧栏 + 浏览器 split-pane 下也必须让长模型名承担收缩。
  const isCompactToolbar = compactToolbar && !isFieldTrigger;
  const isUltraCompactToolbar = ultraCompactToolbar && isCompactToolbar;
  const agentIdentityPrefix =
    agentIdentityLabel && !isCompactToolbar ? (
      <>
        <span
          className={cn(
            'shrink-0 font-normal text-[var(--model-trigger-meta)]',
            isCreateAgentVariant ? 'text-[12px]' : dense ? 'text-[12.5px]' : 'text-[13px]',
          )}
        >
          {agentIdentityLabel}
        </span>
        <span
          className={cn(
            'shrink-0 font-normal text-[var(--model-trigger-meta)]',
            isCreateAgentVariant ? 'text-[12px]' : dense ? 'text-[12.5px]' : 'text-[13px]',
          )}
          aria-hidden="true"
        >
          ·
        </span>
      </>
    ) : null;
  // 保留 useMorphPopover 作用域开关(仅 composer 工具条 opt-in;settings/CreateWorker 用 Radix 回退),
  // 但去掉 !isCreateAgentVariant —— 新建对话框工具条也走脱身上浮 morph,与会话内统一(2026-07-22)。
  const morphEnabled = useMorphPopover && !isFieldTrigger;
  const budgetGradientStyle: CSSProperties | undefined = isBudget
    ? {
        background: 'var(--model-budget-gradient)',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        color: 'transparent',
      }
    : undefined;

  const trigger = (
    <button
      type="button"
      disabled={switching || disabled}
      onClick={morphEnabled ? () => handleOpenChange(!openRef.current) : undefined}
      aria-expanded={open && !disabled}
      aria-haspopup="listbox"
      title={triggerTitle}
      className={cn(
        'flex min-w-0 max-w-full items-center gap-1 transition-colors',
        isFieldTrigger
          ? cn(
              // pill 而非 8px:DESIGN.md §4 Select & Dropdown 规定单行 select trigger 同单行输入,胶囊形。
              'w-full rounded-full border border-[var(--border-default)] bg-[var(--settings-input-bg)] px-3',
              dense ? 'h-9' : 'h-10',
              'hover:bg-[var(--surface-hover-soft)]',
            )
          : cn(
              'rounded-full',
              // 裸态工具条(2026-07-22 用户定稿):默认无框,hover 才浮现胶囊外框。
              // create-agent(新建对话框)与会话内共用同一套裸态,不再分叉 —— 静息/hover 逐字一致。
              'h-[30px] max-w-full shrink overflow-hidden px-2.5',
              // 窄态工具条:钳制唯一可收缩的模型入口，给语音 / 发送固定动作留足空间。
              isUltraCompactToolbar
                ? 'w-[64px] min-w-[64px]'
                : isCompactToolbar
                  ? 'w-[148px] min-w-[72px]'
                  : 'min-w-[72px]',
              'border border-transparent bg-transparent',
              'hover:border-[var(--border-default)] hover:bg-[var(--composer-pill-bg,#FCFCFC)] dark:hover:bg-[var(--composer-pill-bg,#393838)]',
            ),
        // device-link 远程切换 in-flight:置灰 + 禁用点击(复用本文件 disabled 行的 opacity-50 习惯)。
        (switching || disabled) && 'pointer-events-none opacity-50',
      )}
      aria-label={ariaLabel}
    >
      {noSource ? (
        <>
          <PlugZap
            size={isCreateAgentVariant ? 11 : 13}
            className={cn(
              'mr-0.5 shrink-0',
              isCreateAgentVariant
                ? 'text-[var(--create-agent-control-icon)]'
                : 'text-[var(--text-primary)]',
            )}
          />
          <span
            className={cn(
              'min-w-0 font-medium',
              isCreateAgentVariant
                ? 'text-[var(--create-agent-control-text)]'
                : 'text-[var(--text-primary)]',
              isUltraCompactToolbar
                ? 'hidden'
                : isCompactToolbar
                  ? 'max-w-[108px] truncate'
                  : isCreateAgentVariant
                    ? 'truncate'
                    : cn('truncate', isFieldTrigger ? 'max-w-[260px]' : ''),
              isCreateAgentVariant ? 'text-[12px]' : dense ? 'text-[12.5px]' : 'text-[13px]',
            )}
          >
            {t('newChat.modelSelector.source.connect')}
          </span>
        </>
      ) : showSourceDisconnected && currentProviderId ? (
        // 选中来源已断开:显示**真实来源**(currentProviderId)而非 activeSourceId 的默认回落
        // ——回落图标会让用户以为在用默认来源,而发送实际按 DB 里的断开来源走(no_oauth 事故)。
        // 错误态用语义豁免 error token(规则 16);trigger 保持可点击,下拉换源即恢复。
        <>
          <ModelIconMark
            icon={disconnectedModelIcon}
            providerId={currentProviderId}
            name={disconnectedProvider?.name}
            routing={disconnectedProvider?.routing}
            logoKind={disconnectedProvider?.logoKind}
            colorClass="text-[var(--error-fg)]"
          />
          {agentIdentityPrefix}
          <span
            className={cn(
              'min-w-0 font-normal text-[var(--text-primary)]',
              isUltraCompactToolbar
                ? 'hidden'
                : isCompactToolbar
                  ? 'max-w-[108px] truncate'
                  : isCreateAgentVariant
                    ? 'truncate'
                    : isFieldTrigger
                      ? 'max-w-[260px] truncate'
                      : 'truncate',
              isCreateAgentVariant ? 'text-[12px]' : dense ? 'text-[12.5px]' : 'text-[13px]',
            )}
          >
            {/* 断开来源可能是该模型的唯一提供方 → visibleModels 查不到,回落显示原始 id,
                    比 "Select model" 占位更能说明「哪个模型的来源断了」。 */}
            {currentModel?.displayName ?? modelId}
          </span>
          <Unplug
            size={dense ? 11 : 12}
            className="ml-0.5 shrink-0 text-[var(--error-fg)]"
            aria-hidden
          />
          {!isCompactToolbar && (
            <span
              className={cn(
                'shrink-0 font-medium text-[var(--error-fg)]',
                dense ? 'text-[11.5px]' : 'text-[12px]',
              )}
            >
              {t('newChat.modelSelector.source.disconnected')}
            </span>
          )}
        </>
      ) : (
        <>
          {/* 图标统一规则:模型条目 icon(AI Gateway / 目录设定)优先,缺省回落
                  当前真正路由的来源标(activeSourceId)——客户端不按 model id 猜厂牌。 */}
          {activeSourceId && (
            <ModelIconMark
              icon={triggerModelIcon}
              providerId={activeSourceId}
              name={triggerActiveProvider?.name}
              routing={triggerActiveProvider?.routing}
              logoKind={triggerActiveProvider?.logoKind}
              colorClass={
                isCreateAgentVariant ? 'text-[var(--create-agent-control-icon)]' : undefined
              }
            />
          )}
          {agentIdentityPrefix}
          <span
            className={cn(
              'min-w-0 font-normal',
              isUltraCompactToolbar
                ? 'hidden'
                : isCompactToolbar
                  ? 'max-w-[108px] truncate'
                  : isCreateAgentVariant
                    ? 'truncate'
                    : isFieldTrigger
                      ? 'max-w-[260px] truncate'
                      : 'truncate',
              !isBudget &&
                (isCreateAgentVariant
                  ? 'text-[var(--create-agent-control-text)]'
                  : 'text-[var(--text-primary)]'),
              isCreateAgentVariant ? 'text-[12px]' : dense ? 'text-[12.5px]' : 'text-[13px]',
            )}
            style={budgetGradientStyle}
          >
            {displayLabel}
          </span>
          {!fallbackOption?.active && triggerPromotionLabel && !isCompactToolbar && (
            <ModelPromotionBadge>{triggerPromotionLabel}</ModelPromotionBadge>
          )}
          {effortLabel && !isCompactToolbar && (
            <>
              <span
                className={cn(
                  'shrink-0 font-normal',
                  isCreateAgentVariant
                    ? 'text-[var(--create-agent-control-text)]'
                    : 'text-[var(--model-trigger-meta)]',
                  isCreateAgentVariant
                    ? 'shrink-0 text-[12px]'
                    : dense
                      ? 'shrink-0 text-[12.5px]'
                      : 'shrink-0 text-[13px]',
                )}
                aria-hidden="true"
              >
                ·
              </span>
              <span
                className={cn(
                  'min-w-0 font-normal',
                  isCreateAgentVariant
                    ? 'text-[var(--create-agent-control-text)]'
                    : 'text-[var(--text-primary)]',
                  isCreateAgentVariant
                    ? 'truncate'
                    : isFieldTrigger
                      ? 'max-w-[120px] truncate'
                      : 'shrink-0 whitespace-nowrap',
                  isCreateAgentVariant ? 'text-[12px]' : dense ? 'text-[12.5px]' : 'text-[13px]',
                )}
              >
                {effortLabel}
              </span>
            </>
          )}
          {triggerFastOn && !isCompactToolbar && (
            <Zap
              size={isCreateAgentVariant ? 11 : dense ? 12 : 13}
              className={cn(
                'ml-0.5 shrink-0',
                isCreateAgentVariant
                  ? 'text-[var(--create-agent-control-icon)]'
                  : 'text-[var(--composer-pill-icon,#3C3F43)] dark:text-[var(--composer-pill-icon,#D9D9D9)]',
              )}
              aria-label={t('newChat.modelSelector.meta.fastBadge')}
            />
          )}
        </>
      )}
      <ChevronDown
        size={isCreateAgentVariant ? 8 : dense ? 13 : 14}
        className={cn(
          'shrink-0',
          isCreateAgentVariant
            ? 'text-[var(--create-agent-control-icon)]'
            : 'text-[var(--composer-pill-icon,#3C3F43)] dark:text-[var(--composer-pill-icon,#D9D9D9)]' /* spec 2026-07-17, token by 一哥 */,
          isFieldTrigger && 'ml-auto',
        )}
      />
    </button>
  );

  const content = (
    <ModelSelectorContentView
      modelId={modelId}
      effort={effort}
      onModelChange={onModelChange}
      onEffortChange={onEffortChange}
      fastMode={fastMode}
      onFastModeChange={onFastModeChange}
      modelMemory={modelMemory}
      vendorKey={vendorKey}
      deviceId={deviceId}
      excludeSubscriptionDirect={excludeSubscriptionDirect}
      excludeChatBridgedCodex={excludeChatBridgedCodex}
      onDismiss={() => setOpenWithoutAutoRefresh(false)}
      actualRoute={actualRoute}
      maxVisibleModelRows={maxVisibleModelRows}
      currentProviderId={currentProviderId}
      onProviderChange={onProviderChange}
      onNavigateToProviders={onNavigateToProviders}
      configurationEnabled={configurationEnabled}
      reselectEmitsChange={reselectEmitsChange}
      pointerRevealRequiresIntent={morphEnabled}
      fluidWidth={isFieldTrigger}
      agentSwitch={contentAgentSwitch}
      pricing={pricing}
      followSession={
        fallbackOption
          ? {
              active: fallbackOption.active,
              label: fallbackOption.label,
              onFollow: fallbackOption.onSelect,
            }
          : undefined
      }
    />
  );

  if (morphEnabled) {
    return (
      <MorphPopover
        open={(open || keepOpenForAgentConfirmation) && !disabled}
        onOpenChange={handleOpenChange}
        side={popoverSide}
        align="end"
        wrapperClassName="min-w-0 max-w-full shrink"
        panelClassName="p-0"
        panelAriaLabel={ariaLabel}
        trigger={trigger}
      >
        {content}
      </MorphPopover>
    );
  }

  return (
    <Popover
      open={(open || keepOpenForAgentConfirmation) && !disabled}
      onOpenChange={handleOpenChange}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side={popoverSide}
        align="end"
        sideOffset={4}
        collisionPadding={8}
        className={cn(
          // field 形态面板宽度绑定 trigger(DESIGN.md §4 Select & Dropdown 宽度铁则,
          // 与隔壁权限字段同规则),且压掉共享 PopoverContent 的 shadow-md(§4 面板无
          // 阴影);toolbar 等非 field 的 Radix 分支维持既有视觉不动。
          isFieldTrigger ? 'w-[var(--radix-popover-trigger-width)] shadow-none' : 'w-auto',
          'overflow-hidden rounded-[12px] p-0',
          'bg-[var(--model-dropdown-bg)]',
          'border border-[var(--model-dropdown-border)]',
        )}
      >
        {content}
      </PopoverContent>
    </Popover>
  );
}
