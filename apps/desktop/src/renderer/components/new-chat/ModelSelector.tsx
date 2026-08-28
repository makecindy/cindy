import {
  useCallback,
  useState,
  useMemo,
  useEffect,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import {
  autoUpdate,
  flip,
  limitShift,
  offset,
  shift,
  size,
  useFloating,
} from '@floating-ui/react-dom';
import { DismissableLayer } from '@radix-ui/react-dismissable-layer';
import { useFocusGuards } from '@radix-ui/react-focus-guards';
import { FocusScope } from '@radix-ui/react-focus-scope';
import {
  Check,
  ChevronDown,
  CircleAlert,
  Loader2,
  PlugZap,
  Plus,
  RefreshCw,
  Search,
  Unplug,
  Zap,
  Lock,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { flashScrollbar } from '@/lib/scrollbarAutoHide';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { MorphPopover } from '@/components/ui/morph-popover';
import { useOptionalConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { AnthropicMark } from '@/components/icons/AnthropicMark';
import { OpenAIMark } from '@/components/icons/OpenAIMark';
import { XDIncMark } from '@/components/icons/XDIncMark';
import { hasProviderLogo, ProviderLogoMark } from '@/components/icons/ProviderLogoMark';
import { agentOptionOf } from './agentOptions';
import type { SelectableVendor } from '@/lib/agentVendors';
import { FastModeToggle } from './FastModeToggle';
import {
  UnifiedModelPanel,
  type UnifiedModelPanelProps,
  type UnifiedSelectedRow,
} from './UnifiedModelPanel';
import { ThinkingToggle } from './ThinkingToggle';
import { useModelDiscoveryPending } from './useModelDiscoveryPending';
import { VendorSegmentedSwitcher } from './VendorSegmentedSwitcher';
import {
  evictDeviceCapabilities,
  prefetchDeviceCapabilities,
  useAgentCapabilities,
  type AgentKind,
} from '@/hooks/useAgentCapabilities';
import { useApiKey } from '@/hooks/useApiKey';
import { useConnectedSource } from '@/hooks/useConnectedSource';
import { useGatewayModelPricing, useReferenceModelPricing } from '@/hooks/useModelPricing';
import { useModelAccessStatus } from '@/hooks/useModelAccessStatus';
import { useProviders } from '@/hooks/useProviders';
import { providerDisplayName as sharedProviderDisplayName } from '@/lib/providerDisplayName';
import {
  evictDeviceProviders,
  prefetchDeviceProviders,
  useDeviceProviders,
} from '@/hooks/useDeviceProviders';
import {
  modelPriceDiscountLabelValues,
  modelPriceDetailRows,
  modelPricePresentation,
} from '@/lib/modelPriceFormat';
import {
  filterChatBridgedCodexProviders,
  isChatBridgedCodexProvider,
  isDeviceModelVisible,
  providerMonogram,
  resolveVisibleModelAgentKind,
  selectVisibleModels,
} from '@/lib/providerModels';
import type { Effort } from '@/lib/userPreferences.types';
import {
  CHATGPT_MODEL_PREFIX,
  XAI_MODEL_PREFIX,
  isSubscriptionDirectModel,
} from '../../../shared/subscriptionModels';
import { isModelEnabled, useModelVisibilityVersion } from '@/state/modelVisibilityPrefs';
import { seedDefaultFavorite } from '@/state/modelFavorites';
import { setModelPickerLayout, useModelPickerLayout } from '@/state/modelPickerLayout';
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
  resolveCodexCompatibilityWireProtocol,
  sourcesForModel,
  unifiedModelEntries,
  visibleModelUnion,
  type ProviderView,
} from '@cindy/model-providers';
import { isProviderLogoKind } from '@cindy/model-providers/branding';
import { compactEnglishEffortLabel } from '@cindy/maker-shared/agent-capabilities';
import { getModelPriceQuote } from '../../../shared/modelPriceQuote';
import type { ModelAccessAccountTier } from '../../../shared/modelAccess';
import { applyProviderOrder } from '../../../shared/providerOrder';
import type { ModelPricingCatalog } from '../../../shared/regionalMoney';
import { buildProviderSections } from './sourceSwitch';

// 短刷新（尤其 auto-refresh cooldown 命中）不应让状态行参与 MorphPopover 的首帧量高：
// 否则它在 220ms 开场内消失后，settle 补量会把面板再缩一次，形成“先变大再变小”。
// 300ms 门槛也与仓库其它本地/远程混合 loading 提示一致；真正的秒级发现仍会明确反馈。
const MODEL_DISCOVERY_INDICATOR_DELAY_MS = 300;

/**
 * 标签降级按选择器 pane 宽度生效。这里的 width 是整个 pane 宽度，不是模型名
 * 实际可用宽度；行还要扣掉左右 padding、来源图标、effort 和选中勾选。因此不能把
 * 300px 当成“能放下全部标签”的阈值，否则英文 Subscription 会先把模型名压成省略号。
 * 模型名优先：促销标签先收起，订阅标签随后收起，只保留「已隐藏」和选中勾选。
 */
export type ModelTagDensity = 'full' | 'subscription' | 'hidden';

export function modelTagDensityForWidth(width: number | null): ModelTagDensity {
  if (width === null || width >= 450) return 'full';
  if (width >= 370) return 'subscription';
  return 'hidden';
}

// 厂商分类 / 分组标题 key 表的纯逻辑在 ./sourceSwitch。这里 re-export 给 ChatInput
// (它从 './ModelSelector' import categorize / CATEGORY_LABEL_KEY / ModelCategory 做跨厂商确认弹窗)。
export { categorize, CATEGORY_LABEL_KEY, type ModelCategory } from './sourceSwitch';

/**
 * 【非当前选中】模型行的 effort/fast 全局预设读写器,由调用方按设备边界注入(ModelSelector 本身
 * 不耦合具体存储)。
 *   - 本地草稿 / 已创建会话 → providerModelMemory(跨对话、跨重启持久)
 *   - device-link 远程草稿 / 会话 → 被控端全局预设的纯显示镜像(写穿被控端),控制端本地不落记忆
 *   - 不传(flat 选择器:CreateWorkerPopover 等)→ 非选中行不读不写任何记忆,只显示模型默认
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
  getThinking?: (agent: AgentKind, providerId: string, modelId: string) => boolean | undefined;
  setThinking?: (agent: AgentKind, providerId: string, modelId: string, enabled: boolean) => void;
  /**
   * 「恢复推荐 / 回落默认」用的**删除**入口(2026-08-17 review H3)。
   *
   * 记忆表是 override 表:表里**没有**该键 ⇒ 跟随当前版本的目录默认。恢复推荐若把这一版的
   * defaultEffort **快照**写回去,用户就被钉死在旧默认上 —— 服务端之后改了推荐档,没自定义过
   * 的人吃不到(与 modelEnginePrefs 的 clear 语义、configuration-and-overrides §4 同一条)。
   *
   * **可选**:device-link 的被控端镜像走隧道写穿,协议里没有「删除」这一笔(加它属于跨端
   * wire protocol 变更,不在本次范围)。没注入时 `resetToRecommended` 退回既有的快照写法,
   * 行为与改动前一致。
   */
  clearEffort?: (agent: AgentKind, providerId: string, modelId: string) => void;
  /** 同 `clearEffort`,针对 Fast(缺省即关,所以删除与写 false 显示等价,但不钉住默认)。 */
  clearFast?: (agent: AgentKind, providerId: string, modelId: string) => void;
}

// 配置面板锚在主菜单内缩 8px 的模型行上；补偿这段内缩，让两块面板贴边但不重叠。
const MODEL_OPTIONS_SIDE_OFFSET = 8;
const MODEL_OPTIONS_COLLISION_PADDING = 8;
const MODEL_OPTIONS_COLLISION_BOUNDARY: Element[] = [];
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

interface ModelOptionsFloatingPanelProps {
  anchor: HTMLElement;
  panelRef: Ref<HTMLDivElement>;
  className?: string;
  onCancelClose: () => void;
  onScheduleClose: () => void;
  onDismiss: () => void;
  children: ReactNode;
}

/**
 * 新建任务页的模型次级面板仍复刻 Radix 的 left/center 几何与 viewport 碰撞规则，
 * 但定位层改用真实 left/top。Electron 的 app-region 只按布局矩形命中；若沿用
 * Popper 的 translate 定位，视觉面板与 no-drag 矩形会错位，覆盖标题栏的区域就会吞 pointer。
 */
function ModelOptionsFloatingPanel({
  anchor,
  panelRef,
  className,
  onCancelClose,
  onScheduleClose,
  onDismiss,
  children,
}: ModelOptionsFloatingPanelProps) {
  useFocusGuards();
  const { refs, floatingStyles, isPositioned, placement } = useFloating<HTMLElement>({
    strategy: 'fixed',
    placement: 'left',
    transform: false,
    open: true,
    elements: { reference: anchor },
    whileElementsMounted: (reference, floating, update) =>
      autoUpdate(reference, floating, update, { animationFrame: false }),
    middleware: [
      offset({ mainAxis: MODEL_OPTIONS_SIDE_OFFSET, alignmentAxis: 0 }),
      shift({
        mainAxis: true,
        crossAxis: false,
        limiter: limitShift(),
        padding: MODEL_OPTIONS_COLLISION_PADDING,
        boundary: MODEL_OPTIONS_COLLISION_BOUNDARY,
        altBoundary: false,
      }),
      flip({
        padding: MODEL_OPTIONS_COLLISION_PADDING,
        boundary: MODEL_OPTIONS_COLLISION_BOUNDARY,
        altBoundary: false,
      }),
      size({
        padding: MODEL_OPTIONS_COLLISION_PADDING,
        boundary: MODEL_OPTIONS_COLLISION_BOUNDARY,
        altBoundary: false,
        apply: ({ elements, availableHeight }) => {
          elements.floating.style.setProperty(
            '--radix-popover-content-available-height',
            `${availableHeight}px`,
          );
        },
      }),
    ],
  });

  const placedSide = placement.startsWith('left') ? 'left' : 'right';

  return createPortal(
    <div
      ref={refs.setFloating}
      data-radix-popper-content-wrapper=""
      className="z-50 w-[248px]"
      style={{
        ...floatingStyles,
        visibility: isPositioned ? undefined : 'hidden',
        pointerEvents: isPositioned ? undefined : 'none',
        ...WINDOW_NO_DRAG_STYLE,
      }}
    >
      <FocusScope
        asChild
        loop
        trapped={false}
        onMountAutoFocus={(event) => event.preventDefault()}
        onUnmountAutoFocus={(event) => event.preventDefault()}
      >
        <DismissableLayer
          asChild
          disableOutsidePointerEvents={false}
          deferPointerDownOutside
          onDismiss={onDismiss}
        >
          <div
            ref={panelRef}
            role="dialog"
            data-state="open"
            data-side={placedSide}
            data-testid="model-options-floating-panel"
            onPointerEnter={onCancelClose}
            onPointerLeave={onScheduleClose}
            onFocusCapture={onCancelClose}
            onBlurCapture={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              onScheduleClose();
            }}
            className={cn(
              'w-full overflow-hidden rounded-[12px] p-2 shadow-[var(--shadow-menu)] outline-none duration-100',
              'animate-float-in border border-[var(--model-dropdown-border)] bg-[var(--model-dropdown-bg)]',
              className,
            )}
            style={{ transformOrigin: placedSide === 'left' ? 'right center' : 'left center' }}
          >
            {children}
          </div>
        </DismissableLayer>
      </FocusScope>
    </div>,
    document.body,
  );
}

function providerDisplayName(p: ProviderView, t: (key: string) => string): string {
  return sharedProviderDisplayName(p, t);
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
        dense ? 'h-[14.2px] w-[14.2px] text-10' : 'h-[15px] w-[15px] text-10',
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
  thinkingToggle?: boolean;
  /** 模型级 Codex bridge 协议；仅同一 Provider 内混合原生/桥接模型时存在。 */
  codexCompatibilityWireProtocol?: 'openai-chat' | 'anthropic-messages';
  /** 展示图标 id(AI Gateway / 目录设定,SectionModel.icon);flat 列表的 ModelDescriptor 无此字段。 */
  icon?: string;
  availability?: 'available' | 'requires_payment';
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

export function modelCompactEffortLabel(
  language: string,
  t: Translate,
  m: Pick<RowModel, 'effortDisplayNames'> | null | undefined,
  e: Effort,
  agentDisplayName?: string,
): string {
  const fullLabel = modelEffortLabel(t, m, e, agentDisplayName);
  return language.toLowerCase().startsWith('en')
    ? compactEnglishEffortLabel(e, fullLabel)
    : fullLabel;
}

function resolvedTranslationLanguage(
  i18n: { resolvedLanguage?: string; language?: string } | undefined,
): string {
  return i18n?.resolvedLanguage ?? i18n?.language ?? '';
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

function RemoteModelLoadNotice({
  status,
  onRetry,
  compact = false,
}: {
  status: 'loading' | 'error';
  onRetry: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  if (status === 'loading') {
    return (
      <div
        className={cn(
          'flex items-center gap-1.5 text-[var(--text-tertiary)]',
          compact ? 'px-3 pt-0.5 text-12' : 'justify-center px-3 py-6 text-13',
        )}
      >
        <span className="inline-flex shrink-0 animate-spinner motion-reduce:animate-none">
          <Loader2 size={compact ? 12 : 14} />
        </span>
        <span>{t('newChat.modelSelector.remoteLoading')}</span>
      </div>
    );
  }
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2 border border-[var(--error-border)] bg-[var(--error-bg)] text-[var(--error-fg)]',
        compact ? 'mx-1 rounded-[8px] px-3 py-2' : 'mx-1 rounded-[8px] px-3 py-3',
      )}
    >
      <CircleAlert size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className={cn(compact ? 'text-11 leading-[1.45]' : 'text-xs leading-[1.45]')}>
          {t('newChat.modelSelector.remoteLoadFailed')}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs font-medium text-[var(--error-fg-strong)] hover:bg-[var(--surface-hover)]"
        >
          <RefreshCw size={12} />
          {t('newChat.modelSelector.retryRemoteModels')}
        </button>
      </div>
    </div>
  );
}

export interface ModelSelectorAgentIdentity {
  vendorKey: 'cc' | 'codex' | 'pi';
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
  const toVendorKey = (kind: AgentKind): 'cc' | 'codex' | 'pi' =>
    kind === 'codex' ? 'codex' : kind === 'pi' ? 'pi' : 'cc';
  if (pendingTarget) {
    return {
      vendorKey: toVendorKey(pendingTarget),
      state: 'pending',
    };
  }
  if (!runtimeAgentKind) return undefined;
  return {
    vendorKey: toVendorKey(runtimeAgentKind),
    state: 'current',
  };
}

interface ModelSelectorProps {
  modelId: string;
  effort: Effort;
  onModelChange: (modelId: string) => void;
  /**
   * 改深度。返回值(若有)= **这次写入真的落下去了没有**(`false` / 抛错 = 没落;返回 void 的
   * 调用方视为落了)。统一面板的三个「先应用、后清存储」入口(恢复推荐 / 删选中收藏 /
   * 编辑选中收藏)靠它决定要不要收尾;其余调用方照旧无视返回值。
   */
  onEffortChange: (effort: Effort) => void | boolean | Promise<void | boolean>;
  /**
   * per-session 来源选择(B · Provider-first)。
   *   - currentProviderId:本会话当前显式选定的供应商 id(null = 跟随默认路由)。
   *   - onProviderChange:选某行(供应商, 模型)时调用,第 2 参为该行模型 id,第 3 参为该来源该模型的
   *     当前 effort(无 effort 档时为空串),由各调用方一次性落下 provider/model/effort。
   *   - onNavigateToProviders:0 个可连来源时空态 CTA / 列表底部「连接来源」跳设置→供应商页。
   * 三者都不传 → 单栏纯列表(无供应商分段),选行只 onModelChange(老入口 / CreateWorkerPopover)。
   */
  currentProviderId?: string | null;
  /**
   * 返回值(若有)= **这次选择真的应用了没有**(`false` / 抛错 = 没应用;返回 void 的调用方
   * 视为应用了)。统一面板的会话路径靠它决定要不要记收藏锚点 —— 取消上下文容量确认、
   * 远程写穿失败、settingsLocked 都会走到 `false` 那一支(2026-08-17 review 第五轮 M4);
   * 其余调用方照旧无视返回值。
   */
  onProviderChange?: (
    providerId: string | null,
    reconciledModelId?: string,
    reconciledEffort?: Effort,
  ) => void | boolean | Promise<void | boolean>;
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
  /** 语义同 onEffortChange(含返回值口径)。 */
  onFastModeChange?: (enabled: boolean) => void | boolean | Promise<void | boolean>;
  thinkingEnabled?: boolean;
  onThinkingChange?: (enabled: boolean) => void | Promise<void>;
  /** 非选中模型行的 effort/fast 全局预设读写器(按本机 / 被控设备隔离)。 */
  modelMemory?: ModelMemoryAccessors;
  /** When provided, only models with this vendorKey are shown in the dropdown. */
  vendorKey?: 'cc' | 'codex' | 'pi';
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
  /**
   * 指针关闭后的回焦目标(composer 输入框)。选完模型 / 点空白后立刻送回输入框;
   * Esc 仍回 pill(§14.2)。设置页等非 composer 入口不传。
   */
  restoreFocusTarget?: () => HTMLElement | null;
  /** Popover 弹出方向,默认 "top"（底部工具栏向上弹），dialog 内嵌场景传 "bottom"。 */
  popoverSide?: 'top' | 'bottom';
  /**
   * 模型列表最多露出的标准行数；超出后列表自身滚动。
   * 不传时沿用通用面板的 300px 上限，供 Settings 等紧凑场景按行数收窄。
   */
  maxVisibleModelRows?: number;
  /** 关闭模型的 effort / Fast 编辑入口与行内状态摘要；只选择模型 id 的设置项使用。 */
  configurationEnabled?: boolean;
  /** 语义同 ModelSelectorContentProps.unifiedPanel（统一模型选择器面板，opt-in）。 */
  unifiedPanel?: boolean;
  /** 语义同 ModelSelectorContentProps.unifiedPanelAvailable。 */
  unifiedPanelAvailable?: boolean;
  /** 语义同 ModelSelectorContentProps.sessionEngineFilter（统一面板的会话内形态）。 */
  sessionEngineFilter?: UnifiedModelPanelProps['sessionEngineFilter'];
  /** 语义同 ModelSelectorContentProps.unifiedAgents（参与联合列表的引擎集合）。 */
  unifiedAgents?: readonly AgentKind[];
  /**
   * composer pill 尾部的**引擎小标**(model-selector-unified §1.1)。
   *
   * 传入 = pill 不再写 harness 名字文本(旧形态「Codex · GPT-5.6-Luna · 最高」),改成
   * 「模型名 + 引擎图标 + 思考深度」——图标与档字挨在一起收尾,和面板里每一行右侧的
   * 三元组同构。宽度紧张时**先截模型名**,图标与档字保留(它们是定宽的身份信息,
   * 截掉等于把「现在用哪个引擎、多深」这件事藏起来)。
   *
   * 只有 composer(新会话 / 会话内)传;scheduler / IM / Hook / Subagent / Worker /
   * GhostErrand / 设置这些入口不传,展示逐像素不变。
   *
   * 与 `agentIdentity` 的关系:传了本 prop 就不再渲染 agentIdentity 的名字前缀
   * (含「即将切到 X」),但 title / aria-label 仍原样保留那份措辞 —— 读屏与 hover
   * 拿得到的信息不减,只是视觉上换成图标。
   */
  engineMarkVendor?: SelectableVendor | null;
  /** 语义同 ModelSelectorContentProps.selectedFavoriteUid（统一面板的收藏锚点选中态）。 */
  selectedFavoriteUid?: string | null;
  /** 语义同 ModelSelectorContentProps.onSessionFavoriteAnchorChange（会话内收藏锚点回传）。 */
  onSessionFavoriteAnchorChange?: ModelSelectorContentProps['onSessionFavoriteAnchorChange'];
  /** 语义同 ModelSelectorContentProps.onUnifiedSelect（统一面板选中直通）。 */
  onUnifiedSelect?: ModelSelectorContentProps['onUnifiedSelect'];
  /** 可选的列表首行兜底值，例如“不指定（使用原逻辑）”。 */
  fallbackOption?: { active: boolean; label: string; onSelect: () => void };
  /**
   * 点击**当前已选中**的行时照常回调 onModelChange / onProviderChange（默认 false = 收起了事）。
   * 供「当前值是解析出的继承值、点一下才落成显式值」的调用方（IM 工作目录偏好）使用；
   * 会话场景不要开——那里 modelId 本就是已持久化的值，重选自己是纯无操作。
   */
  reselectEmitsChange?: boolean;
  /** 点击当前已选模型行时打开该行的配置浮层，而不是直接收起选择器。 */
  selectedRowClickOpensConfiguration?: boolean;
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
    currentVendor: 'cc' | 'codex' | 'pi';
    /**
     * 进入非当前 Agent 浏览态前确认；false 时保持原分段，什么都不改。
     *
     * ★ 必须把**本次目标引擎**交出去(Chris 2026-08-19):调用方的「已确认过就不再问」
     * 判据是「会话上已有**指向该目标**的切换意图」。不传目标,它只能判「有没有意图」,
     * 于是先切 Codex 再选 Pi 时确认框永久静默(见 agentSwitchConfirmation.hasSwitchIntent)。
     */
    confirmBrowseSwitch?: (targetVendor: 'cc' | 'codex' | 'pi') => Promise<boolean>;
    /**
     * 返回值(若有)= 切换事务**真的登记成功了没有**;本两步分段路径不消费它,
     * 声明成宽联合只是为了让同一个 `performAgentSwitch` 能同时喂给这里与统一面板的
     * `onCrossEngineSelect`(后者按真实结果决定要不要做清理动作)。
     */
    onSwitch: (
      targetAgentKind: 'claude-code' | 'codex' | 'pi',
      modelId: string,
      providerId: string | null,
    ) => void | boolean | Promise<void | boolean>;
  };
}

interface ModelSelectorContentProps {
  modelId: string;
  effort: Effort;
  onModelChange: (modelId: string) => void;
  /**
   * 改深度。返回值(若有)= **这次写入真的落下去了没有**(`false` / 抛错 = 没落;返回 void 的
   * 调用方视为落了)。统一面板的三个「先应用、后清存储」入口(恢复推荐 / 删选中收藏 /
   * 编辑选中收藏)靠它决定要不要收尾;其余调用方照旧无视返回值。
   */
  onEffortChange: (effort: Effort) => void | boolean | Promise<void | boolean>;
  fastMode?: boolean;
  /** 语义同 onEffortChange(含返回值口径)。 */
  onFastModeChange?: (enabled: boolean) => void | boolean | Promise<void | boolean>;
  thinkingEnabled?: boolean;
  onThinkingChange?: (enabled: boolean) => void | Promise<void>;
  modelMemory?: ModelMemoryAccessors;
  vendorKey?: 'cc' | 'codex' | 'pi';
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
  /** 语义同 ModelSelectorProps.onProviderChange(含返回值口径)。 */
  onProviderChange?: (
    providerId: string | null,
    reconciledModelId?: string,
    reconciledEffort?: Effort,
  ) => void | boolean | Promise<void | boolean>;
  onNavigateToProviders?: () => void;
  /**
   * 可选「跟随会话」行(opt-in)。仅 scheduler 的 heartbeat(绑定会话)任务传入:
   * 在模型列表顶部加一行,选中 = model 留空(跟随绑定会话的模型 / 来源)。
   */
  followSession?: { active: boolean; label: string; onFollow: () => void };
  /** 是否显示模型的 effort / Fast 编辑入口。 */
  configurationEnabled?: boolean;
  /**
   * **统一模型选择器面板**(模型优先,model-selector-unified M3 / M4)。opt-in:
   * true = 列表换成跨引擎联合清单(行 = (来源, 模型),右侧常驻「引擎图标 · 推理强度 · ⚡」
   * 三元组,收藏区置顶,hover 出行配置浮层);缺省 false = 既有「先选引擎再选模型」面板,
   * 逐像素不变。
   *
   * 为什么做成开关而不是直接换掉:新会话入口撤 AgentSelect(M5)与会话内同引擎过滤(M6)
   * 还没接线,而本组件有 9 个消费入口(会话 / 草稿 / scheduler / IM / Hook / Subagent /
   * Worker / GhostErrand / 设置)。先让面板可用、再逐个入口切过去,任何一轮都不会出现
   * 「某个入口的模型列表突然换了一套语义」。
   *
   * 已知边界(开这个开关前必须确认不适用):联合列表的数据源是**供应商目录**
   * (unifiedModelEntries),device-link 老被控端的 capabilities-only 扁平兜底没有目录 →
   * 该场景下开了会得到空列表。
   *
   * 会话内形态见 `sessionEngineFilter`;`followSession` 已在统一面板等价渲染;
   * `agentSwitch` 的两步分段在统一面板下**刻意不渲染**(见该 prop 的说明)。
   */
  unifiedPanel?: boolean;
  /**
   * 统一面板**可用但未启用**(用户形态偏好停在 'original')时为 true:老面板
   * footer 据此摆「尝试新选择器」入口(modelPickerLayout 三档并存,Chris
   * 2026-08-17)。设置类等从不支持统一面板的入口两者皆不传。
   */
  unifiedPanelAvailable?: boolean;
  /**
   * 统一面板的**会话内形态**(model-selector-unified §1.6,M6 面板侧)。仅在
   * `unifiedPanel` 为 true 时生效;新会话 / 草稿不传。
   *
   * 传入后:rail 顶部出现「同引擎」过滤(默认选中)、该视图内的行默认落在当前引擎上、
   * 离开该视图时列表顶部出现有损警示、选中跨引擎行时走 `onCrossEngineSelect`
   * (调用方在那里执行既有的 performAgentSwitch 事务)。
   *
   * 与 `agentSwitch` 的关系:两者**不要同时用**。旧的两步分段(先选引擎 tab、再选模型)
   * 被这套「同引擎默认 + 显式跨引擎入口 + 行浮层引擎胶囊」完整取代,统一面板下不渲染
   * 分段。切换的执行链路没变,仍是调用方的 performAgentSwitch。
   */
  sessionEngineFilter?: UnifiedModelPanelProps['sessionEngineFilter'];
  /**
   * 参与统一面板联合列表的引擎集合。缺省 = 三个引擎全参与。
   *
   * **刻意不按 `vendorKey` 收窄**:vendorKey 在这里是「当前正在用哪个引擎」,不是
   * 「只准看这个引擎」—— 拿它收窄会把跨引擎联合列表压回单引擎,统一面板也就没了。
   * 当前引擎的身份由 `liveAgentKind` / `sessionEngineFilter.currentAgent` 表达。
   *
   * 调用方该传什么:**运行时已注册**的引擎(maker:list-available-agents),不是模型目录
   * 里出现过的。Pi 二进制缺失时目录照样投影 Pi 模型,只看目录会让用户一路选到
   * `requireAgent` 的 not-registered —— 这条门禁原本挂在新会话工具条的 AgentSelect
   * (hiddenVendors)上,工具条撤了就得由这里接住。未加载完成时**不传**(fail-open,
   * 不隐藏任何引擎);当前引擎必须始终在列。
   */
  unifiedAgents?: readonly AgentKind[];
  /**
   * 统一面板里被选中的**收藏锚点** uid(规格 §1.5:选中的是那一条收藏副本,不是模型本体)。
   * 由调用方持有(草稿层),因为它与 (来源, 模型) 一样属于「当前选了什么」这份状态。
   * 传 null / 不传 = 当前选中的是模型行;锚点在收藏里查无此条时面板自动回落模型行。
   */
  selectedFavoriteUid?: string | null;
  /**
   * 会话内经统一面板选中一行后回传该行的**收藏锚点**(选普通模型行 = null)。
   *
   * 草稿的锚点由 `onUnifiedSelect` 的 `favoriteUid` 一并带走(那条链路整行直通),这个回调
   * 只服务**已建会话**:同引擎行走 `onProviderChange` 那条单引擎链路,锚点在那里会被丢掉,
   * 于是重开面板选中的是模型行而不是刚用的那条收藏,「删除选中收藏回落默认」在会话内也永远
   * 不可达。只在**真的应用了**这次选择时回调(同引擎直切是同步成功;跨引擎由调用方在切换
   * 事务返回非 false 后自行记录,不经本回调)。
   */
  onSessionFavoriteAnchorChange?: (
    anchor: {
      uid: string;
      wireModelId: string;
      engine: 'cc' | 'codex' | 'pi';
      /** 选中时的显式来源。来源也是锚点身份的一部分:同 wire id 同引擎、仅来源不同的
       *  配置是两份配置,少了它,别的窗口把会话来源从 A 切到 B 后,面板仍在 A 的收藏上
       *  打勾(2026-08-17 review)。 */
      providerId: string;
    } | null,
  ) => void;
  /**
   * 统一面板的**选中直通**(M5 新会话接线)。传入后,联合列表里的每一次行选中都原样交给
   * 调用方 —— (来源, 模型, 深度, 该行生效引擎, Fast, 收藏锚点) 一次给全,不再走
   * `onProviderChange` / `onModelChange` 那条**单引擎**链路。
   *
   * 为什么必须直通:那条链路的下游按「当前正在用的引擎」查目录解析档位
   * (ChatInput.resolveModelEfforts 在显式来源下是 fail-closed 的),而统一面板的一行可能
   * 落在**另一个**引擎上 —— 会拿旧引擎的档位表去校验目标行,把面板已经解析好的档清成空。
   * 草稿换引擎无损(会话还没建),所以直接写下去,不经切换事务。
   *
   * 只有**草稿**传;已建会话用 `sessionEngineFilter`(跨引擎走 performAgentSwitch)。
   * 两者不要同时传:同时传时本 prop 生效,跨引擎行就不会再走切换事务了。
   */
  onUnifiedSelect?: (selection: {
    providerId: string;
    modelId: string;
    /** 该行生效档位;该 (模型, 引擎) 不可调档时为 undefined。 */
    effort?: Effort;
    engine: 'cc' | 'codex' | 'pi';
    fast: boolean;
    favoriteUid: string | null;
    /** 配置浮层「恢复推荐」的应用动作；调用方应删除 override，不得重新记忆推荐值。 */
    resetToRecommended?: true;
  }) => void;
  /** 语义同 ModelSelectorProps.reselectEmitsChange(点当前行照常回调)。 */
  reselectEmitsChange?: boolean;
  /** 点击当前已选模型行时打开该行的配置浮层，而不是直接收起选择器。 */
  selectedRowClickOpensConfiguration?: boolean;
  /** Morph 原位展开时，要求真实 pointer move 后才展示行级配置，避免静止光标误触。 */
  pointerRevealRequiresIntent?: boolean;
  /** 次级面板用真实 left/top 定位，保持原位置并让 Electron no-drag 几何与视觉一致。 */
  optionsPanelUsesLayoutPositioning?: boolean;
  /**
   * field 形态:面板宽度绑定 trigger(DESIGN.md §4「Panel width must bind to the
   * trigger width」),主菜单列由固定 320 改为撑满外层 PopoverContent。
   */
  fluidWidth?: boolean;
  /** 语义同 ModelSelectorProps.agentSwitch(显式两步引擎切换)。 */
  agentSwitch?: {
    currentVendor: 'cc' | 'codex' | 'pi';
    /** 语义同 ModelSelectorProps.agentSwitch.confirmBrowseSwitch(带本次目标引擎)。 */
    confirmBrowseSwitch?: (targetVendor: 'cc' | 'codex' | 'pi') => Promise<boolean>;
    /**
     * 返回值(若有)= 切换事务**真的登记成功了没有**;本两步分段路径不消费它,
     * 声明成宽联合只是为了让同一个 `performAgentSwitch` 能同时喂给这里与统一面板的
     * `onCrossEngineSelect`(后者按真实结果决定要不要做清理动作)。
     */
    onSwitch: (
      targetAgentKind: 'claude-code' | 'codex' | 'pi',
      modelId: string,
      providerId: string | null,
    ) => void | boolean | Promise<void | boolean>;
  };
  /**
   * 是否显示打开选择器触发的供应商模型发现提示。调用方可延迟短任务的提示，但一旦传 true，
   * 对应的发现仍必须在途。
   *
   * 为什么需要它:发现不是本地读取 —— ChatGPT 订阅那条要起一个 codex app-server 再 RPC 列
   * 模型,秒级到十几秒。以前这个过程完全静默,列表在用户看完关掉之后才更新,于是「只能看到
   * 少数模型,进一次设置页再回来就全了」——用户以为是设置页刷新的功劳,其实是那几秒没等到。
   *
   * 刻意做成列表**下方追加一行**,不是 loading 态界面:已有清单照常可读可选(它多半是上次
   * 成功的结果),列表结构不动、不产生跳变,只是明说「还在找」。
   */
  discoveringModels?: boolean;
  /** 外层异步切换进行中时锁住已打开面板，避免重复提交互相覆盖。 */
  interactionDisabled?: boolean;
}

function vendorKeyToAgentKind(v?: 'cc' | 'codex' | 'pi'): AgentKind | null {
  if (v === 'cc') return 'claude-code';
  if (v === 'codex') return 'codex';
  if (v === 'pi') return 'pi';
  return null;
}

export type RemoteModelListStatus = 'idle' | 'loading' | 'ready' | 'error';

interface RemoteCapabilityLoadState {
  capabilities: unknown | null;
  loading?: boolean;
  error?: string | null;
}

interface RemoteProviderLoadState {
  loading?: boolean;
  error?: string | null;
  unsupported?: boolean;
}

/**
 * device-link 模型列表的权威状态：目标 agent 的 capabilities 与 provider 目录必须都结算。
 * 只有老被控端明确不支持 provider:list 时允许 capabilities-only flat fallback。
 */
export function resolveRemoteModelListStatus({
  deviceId,
  agentKind,
  cc,
  codex,
  pi,
  providers,
}: {
  deviceId?: string;
  agentKind: AgentKind | null;
  cc: RemoteCapabilityLoadState;
  codex: RemoteCapabilityLoadState;
  pi: RemoteCapabilityLoadState;
  providers: RemoteProviderLoadState;
}): RemoteModelListStatus {
  if (!deviceId) return 'idle';
  const required = agentKind
    ? [agentKind === 'claude-code' ? cc : agentKind === 'codex' ? codex : pi]
    : [cc, codex, pi];
  if (required.some((state) => !!state.error)) return 'error';
  if (providers.error && !providers.unsupported) return 'error';
  if (providers.loading || required.some((state) => state.loading || state.capabilities == null)) {
    return 'loading';
  }
  return 'ready';
}

export function ModelSelectorContent(props: ModelSelectorContentProps) {
  const gatewayPricing = useGatewayModelPricing();
  const referencePricing = useReferenceModelPricing();
  const { accountTier } = useModelAccessStatus();
  return (
    <ModelSelectorContentView
      {...props}
      gatewayPricing={gatewayPricing}
      referencePricing={referencePricing}
      modelAccessAccountTier={accountTier}
    />
  );
}

function ModelSelectorContentView({
  modelId,
  effort,
  onModelChange,
  onEffortChange,
  fastMode = false,
  onFastModeChange,
  thinkingEnabled = true,
  onThinkingChange,
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
  unifiedPanel = false,
  unifiedPanelAvailable = false,
  sessionEngineFilter,
  unifiedAgents,
  selectedFavoriteUid = null,
  onSessionFavoriteAnchorChange,
  onUnifiedSelect,
  reselectEmitsChange = false,
  selectedRowClickOpensConfiguration = false,
  pointerRevealRequiresIntent = false,
  optionsPanelUsesLayoutPositioning = false,
  fluidWidth = false,
  agentSwitch,
  discoveringModels = false,
  interactionDisabled = false,
  gatewayPricing,
  referencePricing,
  modelAccessAccountTier,
}: ModelSelectorContentProps & {
  gatewayPricing: ModelPricingCatalog | null;
  referencePricing: ModelPricingCatalog | null;
  modelAccessAccountTier: ModelAccessAccountTier | null;
}) {
  const confirmDialog = useOptionalConfirmDialog();
  // 当前来源解析器:已建会话 = 实际路由口径(含停用拷贝),其余 = 准入口径。
  const resolveCurrentSourceId = actualRoute ? actualSourceIdForModel : effectiveSourceIdForModel;
  const { t, i18n } = useTranslation();
  // 列表样式试用开关(本机偏好):footer 的切换按钮 + 面板行样式共用。
  const pickerLayout = useModelPickerLayout();
  const constrainedListMaxHeight = modelListMaxHeightForRows(maxVisibleModelRows);
  const [paneElement, setPaneElement] = useState<HTMLDivElement | null>(null);
  const [paneWidth, setPaneWidth] = useState<number | null>(null);
  const bindPaneElement = useCallback((node: HTMLDivElement | null) => {
    setPaneElement(node);
  }, []);
  useEffect(() => {
    if (!paneElement || typeof ResizeObserver === 'undefined') {
      setPaneWidth(null);
      return;
    }
    setPaneWidth(paneElement.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === paneElement) ?? entries[0];
      if (entry) setPaneWidth(entry.contentRect.width);
    });
    observer.observe(paneElement);
    return () => observer.disconnect();
  }, [paneElement]);
  // 非 fluid 选择器的契约宽度就是 320px。此前这里直接传 null，导致固定宽度的聊天
  // 选择器永远处于 full 密度，英文 Subscription 会把当前模型名挤成 GPT-...。
  // ResizeObserver 可用时仍以实际宽度为准；测试/首帧则用契约宽度避免标签闪现。
  const modelTagDensity = modelTagDensityForWidth(paneWidth ?? (fluidWidth ? null : 320));
  // session-agent-switch:两步式引擎切换的浏览态。browseVendor 初始 = 会话当前引擎;
  // 切到另一家 tab 只是「浏览目标引擎的模型」,选中模型行才真正触发切换事务。
  const [browseVendor, setBrowseVendor] = useState<'cc' | 'codex' | 'pi'>(
    agentSwitch?.currentVendor ?? vendorKey ?? 'cc',
  );
  const browseSwitchPendingRef = useRef(false);
  const handleBrowseVendorChange = async (next: 'cc' | 'codex' | 'pi') => {
    if (interactionDisabled || next === browseVendor || browseSwitchPendingRef.current) return;
    // 返回当前引擎（含已有意图时浏览原引擎准备撤销）不需要确认；只有从
    // currentVendor 进入另一 Agent 浏览态才调用上层风险确认。确认前绝不翻分段。
    if (agentSwitch && next !== agentSwitch.currentVendor && agentSwitch.confirmBrowseSwitch) {
      browseSwitchPendingRef.current = true;
      try {
        if (!(await agentSwitch.confirmBrowseSwitch(next))) return;
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
  const browseTargetLabel =
    browseVendor === 'codex' ? 'Codex' : browseVendor === 'pi' ? 'Pi' : 'Claude Code';
  const enqueueAgentSwitch = (
    targetAgentKind: 'claude-code' | 'codex' | 'pi',
    targetModelId: string,
    targetProviderId: string | null,
  ) => {
    if (!agentSwitch) return;
    // 立即交给调用方同步登记目标 session 的 pending token。真正的顺序由
    // agentSwitchCoordinator 按 session 串行；组件级 Promise 队列会把不同 session
    // 错误地串在一起，并在回调尚未启动时留下可发送窗口。
    void agentSwitch.onSwitch(targetAgentKind, targetModelId, targetProviderId);
  };
  // 同时拉三个 agent —— vendorKey 不传时把三边模型一起展示。hooks 必须按固定顺序调用。
  const cc = useAgentCapabilities('claude-code', deviceId);
  const codex = useAgentCapabilities('codex', deviceId);
  const pi = useAgentCapabilities('pi', deviceId);
  // 本机折扣 GPT 仍按本机 API key gate；device-link 必须只看被控端 provider 状态。
  // 旧被控端不支持 provider:list 时按远端 capabilities 退化，不得误用控制端 key。
  const { hasSavedKey } = useApiKey();
  // 供应商来源:本机会话用本机 useProviders;device-link 远程会话用**被控端**供应商目录
  // (useDeviceProviders,隧道 maker:provider:list)。两 hook 都无条件调用(hooks 规则),按 deviceId 取。
  const localProviders = useProviders();
  const remoteProviders = useDeviceProviders(deviceId);
  const providers = deviceId ? remoteProviders.providers : localProviders.providers;
  const providersLoading = deviceId ? remoteProviders.loading : localProviders.loading;
  const remoteModelListStatus = resolveRemoteModelListStatus({
    deviceId,
    agentKind,
    cc,
    codex,
    pi,
    providers: remoteProviders,
  });
  const retryRemoteModels = useCallback(() => {
    if (!deviceId) return;
    evictDeviceCapabilities(deviceId);
    evictDeviceProviders(deviceId);
    void Promise.allSettled([
      prefetchDeviceCapabilities(deviceId),
      prefetchDeviceProviders(deviceId),
    ]);
  }, [deviceId]);

  const visibilityVersion = useModelVisibilityVersion();
  const [query, setQuery] = useState('');
  // 当前 hover / focus 展开的浮层目标(供应商id + 模型id)。只把「显示哪一行的选项」
  // 放在本地；effort / fast 的值和持久化仍走 props + modelMemory SSoT。
  const [editing, setEditing] = useState<{ providerId: string | null; modelId: string } | null>(
    null,
  );
  const [optionsAnchor, setOptionsAnchor] = useState<HTMLElement | null>(null);
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
  const previousSelectionRef = useRef<{ modelId: string; sourceId: string | null } | null>(null);
  // 选中行对齐是程序化滚动,它触发的 scroll 事件不代表用户意图,不应收起行配置浮层。
  const suppressScrollDismissRef = useRef(false);
  const closeOptionsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeOptionsPanel = useCallback(() => {
    setEditing(null);
    setOptionsAnchor(null);
  }, []);

  // ── pointer-reveal 武装门 ──
  // 面板(MorphPopover)在光标正下方原位展开:行滑到**静止**光标底下会触发
  // pointerenter,行配置浮层闪现一下(2026-07-22 用户反馈)。静止光标不代表
  // hover 意图 —— 以挂载后首个 move 事件为基线,累计移动 ≥4px 才武装
  // pointer-reveal;布局变化后 Chromium 补发的合成 move 坐标不变,天然被挡。
  const hoverIntentArmedRef = useRef(false);
  const hoverIntentBaseRef = useRef<{ x: number; y: number } | null>(null);
  const detachedAnchorRecoveryRef = useRef<{
    providerId: string | null;
    modelId: string;
  } | null>(null);
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
        detachedAnchorRecoveryRef.current = null;
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
      closeOptionsPanel();
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
      closeOptionsPanel();
    };
    document.addEventListener('scroll', onAnyScroll, true);
    return () => document.removeEventListener('scroll', onAnyScroll, true);
  }, [closeOptionsPanel, editing]);

  useEffect(
    () => () => {
      if (closeOptionsTimerRef.current !== null) clearTimeout(closeOptionsTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!interactionDisabled) return;
    if (closeOptionsTimerRef.current !== null) {
      clearTimeout(closeOptionsTimerRef.current);
      closeOptionsTimerRef.current = null;
    }
    closeOptionsPanel();
  }, [closeOptionsPanel, interactionDisabled]);

  // ── 统一面板的联合列表入参 —— **组件作用域单点定义** ────────────────────────
  // 种子收藏 effect 与面板渲染必须用同一份口径:effect 里裸调 unifiedModelEntries
  // (不带可见性 / 排除 / agents / scope)会枚举出面板里根本不显示的行,于是投出一条
  // 永远看不见的收藏 —— 而 `seeded` 是一次性标记(投完不复种),用户就此永远等不到
  // 那条官方推荐。谓词走 useCallback / useMemo 保持引用稳定,免得 effect 每次 render 重跑。
  const unifiedIsVisible = useCallback(
    (
      providerId: string,
      model: { id: string; defaultEnabled?: boolean },
      agent: AgentKind,
    ): boolean =>
      deviceId
        ? isDeviceModelVisible(remoteProviders.modelVisibilityOverrides, agent, providerId, model)
        : isModelEnabled(agent, providerId, model),
    // biome-ignore lint/correctness/useExhaustiveDependencies: visibilityVersion 是本机可见性偏好的外部刷新信号(值本身不进判定)。
    [deviceId, remoteProviders.modelVisibilityOverrides, visibilityVersion],
  );
  const unifiedExcludeProvider = useMemo(
    () =>
      excludeChatBridgedCodex
        ? (provider: ProviderView, agent: AgentKind): boolean =>
            agent === 'codex' && isChatBridgedCodexProvider(provider)
        : undefined,
    [excludeChatBridgedCodex],
  );
  const unifiedExcludeModel = useMemo(
    () =>
      excludeSubscriptionDirect
        ? (model: { id: string }): boolean => isSubscriptionDirectModel(model.id)
        : undefined,
    [excludeSubscriptionDirect],
  );
  const unifiedScope: 'draft' | 'session' = actualRoute ? 'session' : 'draft';
  const unifiedAgentsKey = unifiedAgents ? unifiedAgents.join(',') : 'all';

  // 官方默认推荐 → 一次性**种子收藏**(Chris 2026-08-16 裁决,替代列表里的「默认」
  // 小节):服务端目录用 `newSessionDefault` 标记推荐模型(gateway 下发),首个命中
  // 项以收藏形态投放。只投一次、取消不复种、已有收藏的用户不打扰 —— 这三条都由
  // seedDefaultFavorite 内部保证,这里重复跑只是 no-op。device-link 远程视图不投:
  // 标记来自被控端目录,控制端的本机收藏不该被它污染。
  useEffect(() => {
    if (!unifiedPanel || deviceId) return;
    const entries = unifiedModelEntries({
      providers,
      ...(unifiedAgents ? { agents: unifiedAgents } : {}),
      isVisible: unifiedIsVisible,
      ...(unifiedExcludeProvider ? { excludeProvider: unifiedExcludeProvider } : {}),
      ...(unifiedExcludeModel ? { excludeModel: unifiedExcludeModel } : {}),
      scope: unifiedScope,
    });
    for (const entry of entries) {
      const provider = providers.find((item) => item.id === entry.providerId);
      if (!provider) continue;
      const markedAgents = entry.candidates.filter((agent) => {
        const wireId = entry.capabilities[agent]?.wireModelId ?? entry.modelId;
        const marked = getModel(provider, wireId, agent)?.newSessionDefault;
        return Array.isArray(marked) && marked.includes(agent as 'claude-code' | 'codex');
      });
      if (markedAgents.length === 0) continue;
      // 引擎按**该行的推荐引擎**优先取:同一行在 cc / codex 下都带标记时,无脑取候选序
      // 第一个会把用户钉在与官方推荐不符的引擎上(种子收藏是配置副本,引擎写死在里面)。
      const markedAgent = markedAgents.includes(entry.recommended)
        ? entry.recommended
        : markedAgents[0]!;
      seedDefaultFavorite({
        providerId: entry.providerId,
        modelId: entry.modelId,
        agent: markedAgent === 'claude-code' ? 'cc' : markedAgent === 'codex' ? 'codex' : 'pi',
      });
      break;
    }
    // 一行都没命中 → **什么都不做**(不落 seeded):目录还没到 / 这一版没下发推荐时落
    // 标记,等于把这一版的官方推荐永久作废。
    // biome-ignore lint/correctness/useExhaustiveDependencies: unifiedAgents 以 unifiedAgentsKey 表达身份(数组每次 render 都是新引用)。
  }, [
    providers,
    unifiedPanel,
    deviceId,
    unifiedIsVisible,
    unifiedExcludeProvider,
    unifiedExcludeModel,
    unifiedScope,
    unifiedAgentsKey,
  ]);

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
        devicePiModels: pi.capabilities?.availableModels ?? [],
        excludeSubscriptionDirect,
        excludeChatBridgedCodex,
      }),
    [
      agentKind,
      deviceId,
      providers,
      cc.capabilities,
      codex.capabilities,
      pi.capabilities,
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
      piModels: pi.capabilities?.availableModels ?? [],
      providers,
    });
  }, [agentKind, cc.capabilities, codex.capabilities, pi.capabilities, currentModel, providers]);

  const effortMeta = useMemo(() => {
    const levels =
      currentAgentKind === 'claude-code'
        ? (cc.capabilities?.effortLevels ?? [])
        : currentAgentKind === 'codex'
          ? (codex.capabilities?.effortLevels ?? [])
          : currentAgentKind === 'pi'
            ? (pi.capabilities?.effortLevels ?? [])
            : [];
    return new Map(levels.map((e) => [e.id, e.displayName]));
  }, [currentAgentKind, cc.capabilities, codex.capabilities, pi.capabilities]);
  // 档名多语言:i18n 词表(effortLevels.*) → 模型级 effortDisplayNames →
  // capabilities displayName(未知档兜底) → 原 id。
  const effortLabelFor = (m: RowModel, e: Effort) => modelEffortLabel(t, m, e, effortMeta.get(e));
  const compactEffortLabelFor = (m: RowModel, e: Effort) =>
    modelCompactEffortLabel(resolvedTranslationLanguage(i18n), t, m, e, effortMeta.get(e));

  // 当前 agent 是否支持 Fast Mode(agent 级能力,叠加 per-model supportsFastMode 才显示开关)。
  const hasFastModeCap = useMemo(() => {
    if (currentAgentKind === 'claude-code') return !!cc.capabilities?.hasFastMode;
    if (currentAgentKind === 'codex') return !!codex.capabilities?.hasFastMode;
    if (currentAgentKind === 'pi') return !!pi.capabilities?.hasFastMode;
    return false;
  }, [currentAgentKind, cc.capabilities, codex.capabilities, pi.capabilities]);
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
  const currentModelProvider = useMemo(
    () =>
      activeSourceId ? providers.find((provider) => provider.id === activeSourceId) : undefined,
    [activeSourceId, providers],
  );
  const currentCatalogModel =
    currentModelProvider && currentAgentKind
      ? getModel(currentModelProvider, modelId, currentAgentKind)
      : undefined;
  const isCurrentModelHidden =
    !browsing &&
    !!currentAgentKind &&
    !!currentModelProvider &&
    (deviceId
      ? !isDeviceModelVisible(
          remoteProviders.modelVisibilityOverrides,
          currentAgentKind,
          currentModelProvider.id,
          { id: modelId, defaultEnabled: currentCatalogModel?.defaultEnabled },
        )
      : !isModelEnabled(currentAgentKind, currentModelProvider.id, {
          id: modelId,
          defaultEnabled: currentCatalogModel?.defaultEnabled,
        }));

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
  // XD 实际报价与非 XD Catalog 参考价是两份独立快照。这里只按行来源选择快照，
  // 相同 modelId 不跨 Provider 复用或兜底。
  // agentOverride:统一面板的行各自有自己的生效引擎(不共用面板级 currentAgentKind),
  // 报价必须按**该行的引擎**查(同一 id 跨引擎可以是两条不同的路由 / 两份不同的价)。
  const pricePresentationOf = (
    providerId: string | null,
    id: string,
    agentOverride?: AgentKind,
  ) => {
    // device-link 只同步被控端 provider 目录，不同步价格快照；不能把控制端价格与
    // 被控端 CatalogModel.cost 拼成一个展示结果。在协议补齐前远程选择器不展示价格。
    if (deviceId) return null;
    const priceAgentKind = agentOverride ?? currentAgentKind;
    const effectiveProviderId =
      providerId ??
      (priceAgentKind
        ? resolveCurrentSourceId(providers, currentProviderId, id, priceAgentKind)
        : null);
    const pricing = effectiveProviderId === 'xd' ? gatewayPricing : referencePricing;
    const quote = getModelPriceQuote(pricing, effectiveProviderId, id, priceAgentKind ?? undefined);
    if (effectiveProviderId === 'xd' && (!quote || quote.source === 'gateway')) {
      if (!quote && gatewayPricing == null) return null;
      const effectiveProvider = providers.find((provider) => provider.id === effectiveProviderId);
      const effectiveCost =
        effectiveProvider && priceAgentKind
          ? getModel(effectiveProvider, id, priceAgentKind)?.cost
          : undefined;
      return modelPricePresentation(quote ?? null, effectiveCost);
    }
    if (!quote) return null;
    const displayQuote = quote.approximate ? { ...quote, approximate: false } : quote;
    return modelPricePresentation(displayQuote, undefined);
  };
  // SSH 远程会话里订阅直连模型(chatgpt/ / xai/)不可路由:远端 cc 不经本地
  // compat-proxy 的 responses-bridge,选了必失败。保留在列表但置灰 + 原因提示,
  // 避免静默消失让用户误以为订阅掉了。device-link 远程(deviceId 非空)不受此限。
  const subscriptionDirectDisabledReason = (id: string): string | null => {
    if (!excludeSubscriptionDirect || !isSubscriptionDirectModel(id)) return null;
    return id.startsWith(CHATGPT_MODEL_PREFIX)
      ? t('newChat.modelSelector.subscriptionDirectDisabled.chatgpt')
      : id.startsWith(XAI_MODEL_PREFIX)
        ? t('newChat.modelSelector.subscriptionDirectDisabled.xai')
        : t('newChat.modelSelector.subscriptionDirectDisabled.generic');
  };
  const modelDisabledOf = (provider: ProviderView | null, id: string): boolean => {
    if (!deviceId) {
      if (subscriptionDirectDisabledReason(id)) return true;
      // codex/ 的本机 key gate 只属于 XD 网关折扣路由。自定义(user)供应商目录里的
      // 同前缀模型由该供应商自身配置路由(codex-proxy-host 按会话显式供应商解析,
      // 不按前缀落网关),不依赖 Cindy 登录/网关 key(#1568)。flat 列表(provider
      // 为 null,无供应商概念)与内置来源保持原前缀判定。
      if (provider?.source === 'user') return false;
      return id.startsWith('codex/') && !hasSavedKey;
    }
    if (remoteModelListStatus !== 'ready') return true;
    if (remoteProviders.error) return remoteProviders.unsupported ? false : true;
    const rowAgentKind = resolveVisibleModelAgentKind({
      modelId: id,
      agentKind,
      ccModels: cc.capabilities?.availableModels ?? [],
      codexModels: codex.capabilities?.availableModels ?? [],
      piModels: pi.capabilities?.availableModels ?? [],
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
  // Provider order is a display preference. Apply it only to local picker sections so source
  // resolution and first-wins catalog derivation keep their canonical catalog order.
  const orderedSectionProviders = useMemo(
    () =>
      deviceId
        ? sectionProviders
        : applyProviderOrder(sectionProviders, localProviders.providerOrder),
    [deviceId, localProviders.providerOrder, sectionProviders],
  );
  const suspendedActiveSourceId = sectionProviders === connected ? null : activeSourceId;
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
      providers: orderedSectionProviders,
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
      includePaymentRequired: true,
    });
    // visibilityVersion 仅作刷新触发器(设置页改显示开关后强制重算);deviceId 切换需重算分段。
  }, [
    sourcesEnabled,
    sectionProviders,
    orderedSectionProviders,
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
            (agentKind ? [agentKind] : (['claude-code', 'codex', 'pi'] as const)).flatMap((agent) =>
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
          (agentKind ? [agentKind] : (['claude-code', 'codex', 'pi'] as const)).flatMap((agent) =>
            visibleModelUnion(providers, agent, (providerId, model) =>
              isModelEnabled(agent, providerId, model),
            ).map((model) => model.id),
          ),
        );
    // flat 清单没有 buildProviderSections 的 keepSelected。这里只豁免当前且确实已隐藏的
    // 模型，避免它从已有会话的选择器消失；其它隐藏模型仍按正常可见性过滤。
    const selectable = selectableIds
      ? base.filter(
          (model) => selectableIds.has(model.id) || (isCurrentModelHidden && model.id === modelId),
        )
      : base;
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
    isCurrentModelHidden,
    modelId,
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

  // 列表变化时只在选中行跑出可视区域时做最小滚动。
  // 选中模型 / 来源本身变化触发的分组重算不做任何对齐,否则用户刚点击一行后列表会
  // 突然跳位;真正的过滤、加载或排序变化仍保留“确保选中项可见”的能力。
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      const previousSelection = previousSelectionRef.current;
      const selectionChanged =
        previousSelection !== null &&
        (previousSelection.modelId !== modelId || previousSelection.sourceId !== activeSourceId);
      previousSelectionRef.current = { modelId, sourceId: activeSourceId };
      if (selectionChanged) {
        flashScrollbar(el);
        return;
      }
      const sel = el.querySelector<HTMLElement>('[data-model-selected="true"]');
      if (sel) {
        const listRect = el.getBoundingClientRect();
        const selectedRect = sel.getBoundingClientRect();
        const delta =
          selectedRect.top < listRect.top
            ? selectedRect.top - listRect.top
            : selectedRect.bottom > listRect.bottom
              ? selectedRect.bottom - listRect.bottom
              : 0;
        const next = Math.max(0, el.scrollTop + delta);
        if (Math.abs(delta) > 1 && next !== el.scrollTop) {
          suppressScrollDismissRef.current = true;
          el.scrollTop = next;
        }
      }
      flashScrollbar(el);
    });
    return () => cancelAnimationFrame(raf);
  }, [sections, flatModels, modelId, activeSourceId]);

  // ── 行选择 ───────────────────────────────────────────────────────────────
  /**
   * 返回值 = **这次选择真的应用了没有**,原样透传自 `onProviderChange`
   * (`false` / 抛错 = 没应用;返回 void 视为应用了 —— 与 `onCrossEngineSelect` 同一条约定)。
   * 统一面板的会话路径靠它决定要不要记收藏锚点(2026-08-17 review 第五轮 M4);
   * 其余调用点照旧无视返回值,行为一个字没变。
   */
  const handleRowSelect = (
    providerId: string | null,
    id: string,
    dismiss = true,
    effortOverride?: Effort,
  ): void | boolean | Promise<void | boolean> => {
    if (interactionDisabled) return false;
    const dismissAfterSelection = () => {
      if (!dismiss) return;
      closeOptionsPanel();
      onDismiss?.();
    };
    // 浏览目标引擎态:选中模型 = 确认切换引擎(两步式的第二步),走切换事务。
    // providerId 一起带上:切换后 sessions.provider_id 直接落用户选的来源,
    // trigger 来源 icon / 路由立即正确(null = flat 退化行,交给默认路由)。
    if (browsing && agentSwitch) {
      enqueueAgentSwitch(
        browseVendor === 'codex' ? 'codex' : browseVendor === 'pi' ? 'pi' : 'claude-code',
        id,
        providerId,
      );
      dismissAfterSelection();
      return;
    }
    const selectedModel = sections
      ? sections
          .find((section) => section.provider.id === providerId)
          ?.models.find((m) => m.id === id)
      : flatModels?.find((m) => m.id === id);
    // Provider rows own their effort metadata.  Return the value rendered on the
    // clicked row so every caller (chat, scheduler, settings, worker) applies the
    // same provider/model/effort tuple instead of re-deriving it locally.
    const reconciledEffort =
      effortOverride ??
      (selectedModel ? (rowEffortOf(providerId, selectedModel) ?? '') : undefined);
    if (isSelectedRow(providerId, id)) {
      const selectedModelHasConfiguration =
        !!selectedModel &&
        (selectedModel.efforts.length > 0 || fastEditable(providerId, selectedModel));
      const opensConfiguration =
        selectedRowClickOpensConfiguration && configurationEnabled && selectedModelHasConfiguration;
      // A selected row can be the effective fallback for a stale explicit
      // provider.  Repair that route before opening its configuration, but do
      // not persist the row's derived/default effort just by opening the card.
      let reselectApplied: void | boolean | Promise<void | boolean> = undefined;
      if (reselectEmitsChange) {
        if (sections && providerId) {
          const needsProviderRepair = !!currentProviderId && currentProviderId !== providerId;
          if (!opensConfiguration || needsProviderRepair) {
            reselectApplied = onProviderChange?.(
              providerId,
              id,
              opensConfiguration ? undefined : reconciledEffort,
            );
          }
        } else if (!opensConfiguration) {
          onModelChange(id);
        }
      }
      if (opensConfiguration) {
        setEditing({ providerId, modelId: id });
        return;
      }
      // 默认:重选当前行 = 无操作,直接收起(会话场景点自己没有意义)。
      // reselectEmitsChange:调用方的「当前值」可能是**解析出来的继承值**而非已持久化的
      // 显式值(IM 工作目录偏好),这时点当前行的语义是「把继承值钉成显式值」,必须照常回调,
      // 否则用户点了没反应、之后上游默认一变这条偏好就被静默改掉。
      dismissAfterSelection();
      return reselectApplied;
    }
    if (sections && providerId) {
      // 原子切 provider+model+effort; effort 由目标来源行的 catalog/记忆统一解析。
      const applied = onProviderChange?.(providerId, id, reconciledEffort);
      dismissAfterSelection();
      return applied;
    }
    onModelChange(id);
    dismissAfterSelection();
  };

  /**
   * 归一「这次实时写入真的落下去了没有」:只有明确的 `false` 与抛错算失败,返回 void 的
   * 调用方视为落了 —— 与统一面板 `useUnifiedRowActions.runLive` 逐字同一条约定。
   */
  const runLiveWrite = async (
    call: () => void | boolean | Promise<void | boolean>,
  ): Promise<boolean> => {
    try {
      return (await call()) !== false;
    } catch {
      return false;
    }
  };

  /**
   * 把一份行配置的**深度 + Fast**应用到正在跑的这一份上(来源 / 模型 / 引擎都没变,差的只有
   * 这两格)。
   *
   * 两笔要么都落、要么回滚:第二笔失败时用同一条实时通道把第一笔写回原值,绝不留下
   * 「新深度 + 旧 Fast」这个用户从没选过的组合(口径与 useUnifiedRowActions.applyDefaultsLive
   * 一致,2026-08-17 review 第五轮 M1)。回滚本身也失败时两侧都脏,但**锚点不记、面板不收**,
   * 用户重试整段即可。与当前值相同的那一格不写(省掉一次可能失败的往返)。
   */
  const applyLiveRowConfig = async (
    targetEffort: Effort | undefined,
    targetFast: boolean,
  ): Promise<boolean> => {
    const previousEffort = effort;
    let effortWritten = false;
    if (targetEffort && targetEffort !== previousEffort) {
      if (!(await runLiveWrite(() => onEffortChange(targetEffort)))) return false;
      effortWritten = true;
    }
    if (onFastModeChange && targetFast !== (fastMode ?? false)) {
      const fastChange = onFastModeChange;
      if (!(await runLiveWrite(() => fastChange(targetFast)))) {
        if (effortWritten) await runLiveWrite(() => onEffortChange(previousEffort));
        return false;
      }
    }
    return true;
  };

  /**
   * 统一面板在**已建会话**里选中一行(跨引擎行在 selectRow 里就改道 `onCrossEngineSelect`,
   * 到不了这里)。两件事必须收在这一条上:
   *
   *   · **同来源 + 同模型 + 同引擎、只有深度 / Fast 不同的收藏**(2026-08-17 review 第五轮 M3):
   *     按 (来源, 模型) 判重的 handleRowSelect 会把它当成「点了当前行」直接收起 —— 界面勾上
   *     这条收藏,任务却还在旧配置上跑。这类行改为把副本的深度 / Fast 当一次实时应用,
   *     两笔都落才算选中(失败不记锚点、不收面板,与跨引擎被取消同一条待遇)。
   *   · **锚点只在选择真的应用之后才记**(M4):handleRowSelect → onProviderChange →
   *     performProviderChange 的取消(上下文容量确认)/ 远程写穿失败 / settingsLocked 出口都
   *     返回 false,此前那个结果被丢掉,于是会话还在旧配置上跑、面板已经勾了新收藏。
   *     `await` 之后再记同时保住既有顺序(G4:单引擎链路内部会按新的 (来源, 模型) 收敛调用方
   *     状态,先记锚点会被它顺手清掉)。
   */
  const applyUnifiedSessionSelect = async (args: {
    providerId: string;
    /** 该行生效引擎的 **wire model id**(选择链路唯一可发送的 id)。 */
    wireModelId: string;
    effort: Effort | undefined;
    config: UnifiedSelectedRow;
  }): Promise<void> => {
    const anchor = args.config.favoriteUid
      ? {
          uid: args.config.favoriteUid,
          wireModelId: args.wireModelId,
          engine: args.config.engine,
          providerId: args.providerId,
        }
      : null;
    // 「正在跑的是哪个引擎」以会话形态给的那一个为准(已确认的会话引擎);没有会话形态的
    // 入口回落 currentAgentKind —— 与列表行三元组同一个口径,不另推一份。
    const liveAgentKind = sessionEngineFilter?.currentAgent ?? currentAgentKind;
    if (
      anchor &&
      isSelectedRow(args.providerId, args.wireModelId) &&
      liveAgentKind !== null &&
      vendorKeyToAgentKind(args.config.engine) === liveAgentKind
    ) {
      if (!(await applyLiveRowConfig(args.effort, args.config.fast))) return;
      onSessionFavoriteAnchorChange?.(anchor);
      closeOptionsPanel();
      onDismiss?.();
      return;
    }
    const applied = await Promise.resolve(
      handleRowSelect(args.providerId, args.wireModelId, true, args.effort),
    ).catch(() => false);
    if (applied === false) return;
    onSessionFavoriteAnchorChange?.(anchor);
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

  // 搜索过滤会卸载当前模型行。create-agent 的自定位浮层不能继续保留 detached DOM
  // 作为锚点；否则清空搜索后 configPanel 恢复时会先在旧锚点上重挂载。
  useEffect(() => {
    if (!optionsPanelUsesLayoutPositioning || !editing) return;
    if (!editingModel || (optionsAnchor !== null && !optionsAnchor.isConnected)) {
      const anchorDetached = optionsAnchor !== null && !optionsAnchor.isConnected;
      if (anchorDetached) {
        // 只允许刚失联的同一模型行恢复一次。不要武装组件级 hover gate，否则后续
        // 任意行都能绕过 pointer movement 门槛（见 PR#1792 关联回归）。
        detachedAnchorRecoveryRef.current = editing;
      }
      closeOptionsPanel();
    }
  }, [closeOptionsPanel, editing, editingModel, optionsAnchor, optionsPanelUsesLayoutPositioning]);

  // effect 会清理失效状态；渲染门再保证清理提交前也绝不把 detached 锚点交给 Floating UI。
  const connectedOptionsAnchor = optionsAnchor?.isConnected ? optionsAnchor : null;

  // 浏览目标引擎态恒非 active(与 isSelectedRow 同口径):目标列表里可能出现与当前
  // 会话同 id 同来源的行(网关同一模型双引擎都供),悬浮面板里的改动绝不能写进
  // 当前会话的实时 effort / Fast,只能落目标引擎的全局预设。
  const editingIsActive =
    !browsing &&
    !!editing &&
    editing.modelId === modelId &&
    (editing.providerId === null || editing.providerId === activeSourceId);
  const editingProviderId = editing?.providerId ?? null;
  // 当前行可编辑配置的边界:选中行写实时状态;非选中供应商行可把 effort 与
  // provider/model 一次性交给调用方。若调用方另传 modelMemory,同时允许编辑该模型的
  // 全局 effort/Fast 预设。flat 非选中行没有来源 capability / 原子选择上下文,仍只展示信息。
  const inactiveProviderCanSelectEffort =
    !editingIsActive && !!editingProviderId && !!onProviderChange;
  const inactiveProviderHasMemory =
    !editingIsActive && !!modelMemory && !!currentAgentKind && !!editingProviderId;
  const canConfigure =
    !interactionDisabled &&
    configurationEnabled &&
    !!editingModel &&
    (editingIsActive || inactiveProviderCanSelectEffort || inactiveProviderHasMemory);
  const editShowFast =
    canConfigure &&
    (editingIsActive || inactiveProviderHasMemory) &&
    !!editingModel &&
    fastEditable(editingProviderId, editingModel);
  const editThinkingToggle =
    canConfigure && currentAgentKind === 'pi' && editingModel?.thinkingToggle === true;
  const editHasEfforts =
    canConfigure && (editingModel?.efforts.length ?? 0) > 0 && !editThinkingToggle;

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
    if (interactionDisabled || !editing || !editingModel) return;
    if (editingIsActive) {
      onEffortChange(e);
    } else {
      // 非选中行:若入口提供模型记忆则同步预设；无论是否有记忆,都把本次明确点击的
      // effort 直接交给选择事务,一次落定 model/provider/effort。Scheduler / 设置页因此
      // 无需为了显示同一张配置卡而伪造或复制一套 effort 状态。
      if (currentAgentKind && editing.providerId) {
        modelMemory?.setEffort(currentAgentKind, editing.providerId, editingModel.id, e);
      }
      bump();
      // 配置点击同时选中模型，但保留模型选择窗口，方便继续比较和调整。
      handleRowSelect(editing.providerId, editingModel.id, false, e);
    }
  };
  const handleEditFast = (enabled: boolean) => {
    if (interactionDisabled || !editing || !editingModel) return;
    if (editingIsActive) {
      // 当前选中模型的 Fast 是会话实时状态,必须等 onFastModeChange 持久化成功后再由
      // ChatInput 同步草稿默认;这里不能预写 modelMemory,否则 device-link 远程失败会污染被控端草稿。
      void onFastModeChange?.(enabled);
    } else {
      // 非选中行:先写模型级全局预设,再选中这行。模型切换恢复 Fast 时会读到本次点击值。
      // 来源参数用于 capability / device-link 写穿路由。
      if (currentAgentKind && editing.providerId) {
        modelMemory?.setFast(currentAgentKind, editing.providerId, editingModel.id, enabled);
      }
      // 配置点击同时选中模型，但保留模型选择窗口，方便继续比较和调整。
      handleRowSelect(editing.providerId, editingModel.id, false);
    }
    bump();
  };

  const editingProvider = useMemo(() => {
    if (!editingModel || !currentAgentKind) return undefined;
    const providerId =
      editingProviderId ??
      resolveCurrentSourceId(providers, currentProviderId, editingModel.id, currentAgentKind);
    return providerId ? providers.find((provider) => provider.id === providerId) : undefined;
  }, [
    editingModel,
    currentAgentKind,
    editingProviderId,
    providers,
    currentProviderId,
    resolveCurrentSourceId,
  ]);
  const editingPricePresentation = editingModel
    ? pricePresentationOf(editingProvider?.id ?? editingProviderId, editingModel.id)
    : null;
  const editingCodexCompatibilityProtocol = editingProvider
    ? resolveCodexCompatibilityWireProtocol(editingProvider, currentAgentKind, editingModel)
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
      {(editShowFast || editHasEfforts || editThinkingToggle) && (
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
      {editShowFast && (editHasEfforts || editThinkingToggle) && (
        <div className="mx-1 my-1 h-px bg-[var(--model-dropdown-border)]" />
      )}
      {editThinkingToggle && editingModel && (
        <div className="px-0.5">
          <ThinkingToggle
            enabled={
              editingIsActive
                ? thinkingEnabled
                : currentAgentKind && editingProviderId
                  ? (modelMemory?.getThinking?.(
                      currentAgentKind,
                      editingProviderId,
                      editingModel.id,
                    ) ?? true)
                  : true
            }
            onToggle={() => {
              const next = editingIsActive
                ? !thinkingEnabled
                : !(currentAgentKind && editingProviderId
                    ? (modelMemory?.getThinking?.(
                        currentAgentKind,
                        editingProviderId,
                        editingModel.id,
                      ) ?? true)
                    : true);
              if (currentAgentKind && editingProviderId) {
                modelMemory?.setThinking?.(
                  currentAgentKind,
                  editingProviderId,
                  editingModel.id,
                  next,
                );
              }
              if (editingIsActive) void onThinkingChange?.(next);
              bump();
            }}
            label={t('newChat.modelSelector.thinking')}
            hideIcon
            accentVar="var(--text-primary)"
            thumbVar="var(--surface-on-card)"
          />
        </div>
      )}
      {editThinkingToggle && editHasEfforts && (
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
                    'truncate text-14 text-[var(--model-item-text)]',
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
        {editingCodexCompatibilityProtocol && (
          <div className="mt-0.5 text-11 font-normal leading-[1.4] text-[var(--text-tertiary)]">
            {t('newChat.modelSelector.meta.codexCompatibilityMode')}
          </div>
        )}
      </div>
    </div>
  ) : null;

  const showPaymentRequired = () => {
    if (!confirmDialog) return;
    void confirmDialog
      .confirm({
        title: t('newChat.modelSelector.paymentRequired.title'),
        description: t('newChat.modelSelector.paymentRequired.description'),
        confirmText: t('newChat.modelSelector.paymentRequired.action'),
        cancelText: t('commonUi.confirmDialog.cancel'),
      })
      .then((accepted) => {
        if (!accepted) return;
        // Desktop 使用 createHashRouter；ModelSelectorContent 同时是可裸渲染的复用组件，
        // 不能在这里强依赖 Router context。写入 hash 会触发 hashchange，并由正式路由
        // 切到设置里的计费 tab；直接 pushState(pathname) 不会被 HashRouter 接管。
        window.location.hash = '#/settings?tab=billing';
      });
  };

  // ── 单个模型行 ───────────────────────────────────────────────────────────
  // provider 非空(分段模式)→ 名字前缀该来源的 mark;null(flat / device-link)→ 无前缀。
  const renderModelItem = (provider: ProviderView | null, model: RowModel) => {
    const providerId = provider?.id ?? null;
    const isSelected = isSelectedRow(providerId, model.id);
    // flat 行仍保持 providerId=null 的选择语义，但当前行的状态展示要读取会话实际来源：
    // 否则拍平后既看不到 Subscription，也无法判断该 (agent,provider,model) 是否已隐藏。
    const statusProvider = provider ?? (isSelected ? currentModelProvider : undefined);
    const isSubscriptionModel = statusProvider?.access?.kind === 'subscription';
    const selectedCatalogModel =
      statusProvider && currentAgentKind
        ? getModel(statusProvider, model.id, currentAgentKind)
        : undefined;
    const isHiddenSelectedModel =
      isSelected &&
      !!statusProvider &&
      !!currentAgentKind &&
      (deviceId
        ? !isDeviceModelVisible(
            remoteProviders.modelVisibilityOverrides,
            currentAgentKind,
            statusProvider.id,
            { id: model.id, defaultEnabled: selectedCatalogModel?.defaultEnabled },
          )
        : !isModelEnabled(currentAgentKind, statusProvider.id, {
            id: model.id,
            defaultEnabled: selectedCatalogModel?.defaultEnabled,
          }));
    const disabled = interactionDisabled || modelDisabledOf(provider, model.id);
    const paymentRequired = model.availability === 'requires_payment';
    const disabledReason = subscriptionDirectDisabledReason(model.id);
    // 只选择模型 id 的入口没有 effort / Fast 语义；继续展示目录默认档会让用户
    // 误以为该值可在当前入口调整。选择事务仍由 handleRowSelect 独立解析 effort，
    // 此处只收窄可见摘要，不改变支持配置入口的行为。
    const rowEffort = configurationEnabled ? rowEffortOf(providerId, model) : null;
    const rowFastOn = configurationEnabled ? fastOnOf(providerId, model) : false;
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
    // 普通模型沿用订阅标识；只有“当前模型已隐藏”这一额外状态与订阅标签争抢空间时，
    // 才按宽度收起订阅标签，确保模型名、已隐藏状态和选中勾选都完整可见。
    const showSubscriptionTag =
      isSubscriptionModel && (!isHiddenSelectedModel || modelTagDensity !== 'hidden');
    const showPromotionTag =
      !!rowPromotionLabel && (!isHiddenSelectedModel || modelTagDensity === 'full');
    // 信息面板对所有可用模型开放;能否编辑 effort / Fast 在面板内部另行判定。
    // session-agent-switch 浏览目标引擎态同样开放:选模型前正需要看描述/上下文/价格/来源;
    // 面板内配置写的是**目标引擎**的 per-(来源,模型) 全局预设(currentAgentKind 已随浏览态
    // 指向目标引擎),切换确认后由 performAgentSwitch 按预设恢复 effort / Fast。
    const hasOptions = !disabled && !paymentRequired;
    const isEditingThis =
      !!editing && editing.modelId === model.id && editing.providerId === providerId;
    const revealOptions = (anchor: HTMLDivElement) => {
      cancelOptionsClose();
      if (!hasOptions) {
        closeOptionsPanel();
        return;
      }
      setOptionsAnchor((current) => (current === anchor ? current : anchor));
      setEditing((current) =>
        current?.providerId === providerId && current.modelId === model.id
          ? current
          : { providerId, modelId: model.id },
      );
    };
    // pointerenter 触发的 reveal 必须等光标真实移动过才武装:面板(MorphPopover)在
    // 光标正下方原位展开时,行会滑到**静止**光标底下触发 pointerenter,行配置浮层
    // 会闪现一下(2026-07-22 用户反馈)。macOS 菜单同款解法:静止光标不算 hover 意图。
    // 注意 enter 先于 move 派发 —— 首次移入行时 enter 可能仍被拦,由行上的
    // onPointerMove 兜底 reveal(setEditing 同值幂等,不抖)。
    // untrusted 事件(jsdom 测试/程序派发)不设门:布局位移诱发的浏览器事件是
    // trusted 的,真实闪现场景仍被挡。
    const revealOptionsByPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
      const recoveryTarget = detachedAnchorRecoveryRef.current;
      const isDetachedAnchorRecovery =
        optionsPanelUsesLayoutPositioning &&
        recoveryTarget?.providerId === providerId &&
        recoveryTarget.modelId === model.id;
      if (
        pointerRevealRequiresIntent &&
        !hoverIntentArmedRef.current &&
        !isDetachedAnchorRecovery &&
        event.nativeEvent.isTrusted
      )
        return;
      if (isDetachedAnchorRecovery) detachedAnchorRecoveryRef.current = null;
      revealOptions(event.currentTarget);
    };
    return (
      <Popover
        key={`${providerId ?? ''}::${model.id}`}
        open={isEditingThis}
        onOpenChange={(open) => {
          if (!open && isEditingThis) closeOptionsPanel();
        }}
      >
        <PopoverAnchor asChild>
          <div
            role="option"
            aria-selected={isSelected}
            aria-disabled={disabled ? true : undefined}
            aria-label={
              paymentRequired
                ? `${model.displayName} · ${t('newChat.modelSelector.paymentRequired.unlock')}`
                : undefined
            }
            title={disabledReason ?? undefined}
            data-model-selected={isSelected ? 'true' : undefined}
            data-model-options-active={isEditingThis ? 'true' : undefined}
            tabIndex={disabled ? -1 : 0}
            onPointerEnter={revealOptionsByPointer}
            onPointerMove={revealOptionsByPointer}
            onPointerLeave={scheduleOptionsClose}
            onFocus={(event) => revealOptions(event.currentTarget)}
            onBlur={(event) => {
              if (configPanelRef.current?.contains(event.relatedTarget as Node | null)) return;
              scheduleOptionsClose();
            }}
            onClick={() => {
              if (disabled) return;
              if (paymentRequired) {
                showPaymentRequired();
                return;
              }
              handleRowSelect(providerId, model.id);
            }}
            onKeyDown={(ev) => {
              if (ev.target !== ev.currentTarget || disabled) return;
              if (paymentRequired && (ev.key === 'Enter' || ev.key === ' ')) {
                ev.preventDefault();
                showPaymentRequired();
                return;
              }
              if (ev.key === 'ArrowLeft' && hasOptions) {
                ev.preventDefault();
                revealOptions(ev.currentTarget);
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
              'group/row flex w-full cursor-pointer items-center justify-between rounded-[8px] px-3 py-2',
              constrainedListMaxHeight !== undefined && 'min-h-9',
              'transition-colors duration-100 hover:bg-[var(--model-item-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
              isSelected && 'bg-[var(--model-item-hover)]',
              isEditingThis &&
                'bg-[var(--surface-hover)] ring-1 ring-inset ring-[var(--model-dropdown-border)]',
              (disabled || paymentRequired) && 'opacity-50',
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
                    <span
                      aria-label={effortLabelFor(model, rowEffort)}
                      title={effortLabelFor(model, rowEffort)}
                      className="shrink-0 text-13 font-normal text-[var(--text-tertiary)]"
                    >
                      {compactEffortLabelFor(model, rowEffort)}
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
                {(paymentRequired ||
                  isHiddenSelectedModel ||
                  showSubscriptionTag ||
                  showPromotionTag) && (
                  <span data-model-tags className="ml-auto flex shrink-0 items-center gap-1.5">
                    {paymentRequired && (
                      <span
                        data-payment-required-unlock
                        className="invisible shrink-0 select-none text-11 font-medium text-[var(--text-secondary)] group-hover/row:visible group-focus-within/row:visible"
                      >
                        {t('newChat.modelSelector.paymentRequired.unlock')}
                      </span>
                    )}
                    {paymentRequired && (
                      <span
                        data-payment-required-badge
                        className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11 text-[var(--text-secondary)]"
                      >
                        <Lock size={11} />
                        {t('newChat.modelSelector.paymentRequired.badge')}
                      </span>
                    )}
                    {isHiddenSelectedModel && (
                      <span
                        data-model-hidden-label
                        className="shrink-0 select-none text-11 font-normal text-[var(--text-tertiary)]"
                      >
                        {t('newChat.modelSelector.hidden')}
                      </span>
                    )}
                    {showSubscriptionTag && (
                      <span
                        aria-label={t('settings.providers.models.subscription')}
                        title={t('settings.providers.models.subscription')}
                        className="inline-flex shrink-0 items-center rounded-full bg-[var(--surface-chip)] px-2 py-[1px] text-11 font-medium text-[var(--text-secondary)]"
                      >
                        {t('newChat.modelSelector.meta.subscriptionBadgeCompact', {
                          defaultValue: t('settings.providers.models.subscription'),
                        })}
                      </span>
                    )}
                    {showPromotionTag && rowPromotionLabel && (
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
        {!optionsPanelUsesLayoutPositioning && isEditingThis && configPanel && (
          <PopoverContent
            ref={configPanelRef}
            side="left"
            align="center"
            sideOffset={MODEL_OPTIONS_SIDE_OFFSET}
            collisionPadding={MODEL_OPTIONS_COLLISION_PADDING}
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
            disabled={interactionDisabled}
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

  // 统一面板的三个标签 / 能力回调(2026-08-19 预审 P2-4):包 useCallback 免得 render body
  // 裸函数每帧换引用,把面板内 useCallback / useMemo 的缓存全部打穿。
  // ★ 位置必须在下面 `if (emptyState) return` 这个**提前返回之前**:hooks 数量在空态与
  // 正常态之间必须一致(2026-08-19 实测:放在 emptyState 之后,providers 从空到有的那一次
  // 渲染直接 "Rendered more hooks" 崩溃)。
  const unifiedProviderLabel = useCallback(
    (providerId: string): string => {
      const provider = providers.find((entry) => entry.id === providerId);
      return provider ? providerDisplayName(provider, t) : providerId;
    },
    [providers, t],
  );
  // 档名多语言按**该行自己的引擎**取 capabilities 兜底名(不同 agent 的同名档可能有
  // 各自的英文名),优先仍是 i18n 词表 effortLevels.*。
  const unifiedEffortLabel = useCallback(
    (agent: AgentKind, value: Effort): string => {
      const levels =
        agent === 'claude-code'
          ? (cc.capabilities?.effortLevels ?? [])
          : agent === 'codex'
            ? (codex.capabilities?.effortLevels ?? [])
            : (pi.capabilities?.effortLevels ?? []);
      return modelEffortLabel(t, null, value, levels.find((e) => e.id === value)?.displayName);
    },
    [cc.capabilities, codex.capabilities, pi.capabilities, t],
  );
  const unifiedAgentFastCapable = useCallback(
    (agent: AgentKind): boolean =>
      agent === 'claude-code'
        ? !!cc.capabilities?.hasFastMode
        : agent === 'codex'
          ? !!codex.capabilities?.hasFastMode
          : !!pi.capabilities?.hasFastMode,
    [cc.capabilities, codex.capabilities, pi.capabilities],
  );

  if (emptyState) return emptyState;

  const hasAnyModel = sections ? sections.length > 0 : (flatModels?.length ?? 0) > 0;
  const trimmedQuery = query.trim();
  const remoteStatusInList =
    deviceId && (remoteModelListStatus === 'loading' || remoteModelListStatus === 'error')
      ? remoteModelListStatus
      : null;
  const showRemoteStatusFooter =
    remoteStatusInList !== null && (hasAnyModel || trimmedQuery.length > 0);

  // 搜索框 —— 药丸样式,**只给既有分段面板用**。统一面板的搜索行是设计稿的无框平铺形态
  // (见下方 unifiedPanel 分支),与这里的胶囊框是两套视觉,刻意不共用;共用的只有
  // placeholder / a11y 名的同一条 i18n key。
  const searchField = (
    <div
      className={cn(
        'flex items-center gap-2 rounded-full border border-[var(--model-dropdown-border)] px-3 py-[7px] transition-colors',
        interactionDisabled
          ? 'cursor-not-allowed bg-[var(--surface-elevated-soft)]'
          : 'bg-[var(--surface)]',
      )}
    >
      <Search
        size={16}
        className={cn(
          'shrink-0',
          interactionDisabled
            ? 'text-[var(--text-disabled-tertiary)]'
            : 'text-[var(--text-tertiary)]',
        )}
      />
      <input
        type="text"
        disabled={interactionDisabled}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('newChat.modelSelector.search.placeholderAll')}
        className={cn(
          'min-w-0 flex-1 bg-transparent text-14 outline-none',
          interactionDisabled
            ? 'cursor-not-allowed text-[var(--text-disabled)] placeholder:text-[var(--text-disabled-tertiary)]'
            : 'text-[var(--model-item-text)] placeholder:text-[var(--text-tertiary)]',
        )}
        aria-label={t('newChat.modelSelector.search.placeholderAll')}
      />
    </div>
  );

  // ── 统一模型选择器面板(opt-in,M3 / M4)────────────────────────────────────
  // 联合列表的可见性 / 排除口径必须与既有面板**逐条对齐**(否则「统一面板里能看到、
  // 切回旧面板就没了」),故这里复用同一批判定函数,只是补上 agent 维度。
  // unifiedProviderLabel / unifiedEffortLabel / unifiedAgentFastCapable 三个回调声明在
  // emptyState 提前返回之前(hooks 数量恒定的硬要求,见彼处注释)。
  if (unifiedPanel) {
    // 可见性 / 排除谓词与 scope 一律从组件作用域取(见 unifiedIsVisible 的定义处):
    // 种子收藏 effect 用的是同一份,两边不能各写一遍。
    return (
      // 外层多包一层「百分比钳制」:面板列自身的 max-h 公式(560px/100vh)不知道宿主
      // popover 实际给了多少纵向空间 —— morph 弹层按锚点位置算出的可用高度可能更小,
      // 面板列超出的部分被宿主 overflow-hidden 裁掉,最后一行和 footer 永远缺一截
      // (2026-08-13 实测:外层 456px、面板列 511px,底部 55px 被裁)。这层 max-h-full
      // 在宿主高度**确定**时把面板列钳到宿主内(flex 拉伸 → 列内 min-h-0 让列表收缩滚动),
      // 宿主高度不确定时百分比落空为 none,由面板列自己的绝对上限兜底 —— 两个分支各管一头。
      <div className="flex max-h-full min-h-0 w-full min-w-0">
        <div
          ref={bindPaneElement}
          data-model-tag-density={modelTagDensity}
          data-unified-model-panel="true"
          className={cn(
            // 设计稿的面板骨架:搜索行贴顶(border-b 分隔)、列表贴边(自带 8px 内距)、
            // footer 用 border-t 分隔 —— 外层不再加统一 padding。
            // grow:stickyWidth 下宿主可能比内容宽(筛选后内容变窄、面板不回缩),
            // 面板列拉伸填满,不在边框内留空条。
            'flex min-h-0 grow flex-col',
            // 高度上限必须给在**面板**上:不给的话,列表按内容撑到比视口还高,外层
            // popover 裁掉超出部分,用户就翻不到最后几行(2026-08-13 实测)。列表侧配
            // min-h-0 + flex-1 收缩并内部滚动,搜索框与底部 footer 始终露着。
            'max-h-[min(560px,calc(100vh-120px))]',
            // 宽度自适应(规格 §1.2):长模型名先把面板撑宽,到上限才截断,不硬砍名字。
            // 最小宽只兜「搜索行 + 空态不局促」的底(Chris 2026-08-13:min 460 让短名列表
            // 中间留一条空隙 —— 面板应该贴着最长行收窄,理论最小值可以很小)。
            fluidWidth
              ? 'w-full min-w-0'
              : 'w-max min-w-[300px] max-w-[min(600px,calc(100vw-48px))]',
          )}
        >
          {/* 设计稿 .search-wrap:无框平铺行 + 底部 hairline(不是独立的胶囊输入框)。 */}
          <div
            className={cn(
              'flex shrink-0 items-center gap-2 border-b border-[var(--model-dropdown-border)] px-3.5 py-3',
              interactionDisabled
                ? 'text-[var(--text-disabled-tertiary)]'
                : 'text-[var(--text-tertiary)]',
            )}
          >
            <Search size={14} className="shrink-0" />
            <input
              type="text"
              disabled={interactionDisabled}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('newChat.modelSelector.search.placeholderAll')}
              className={cn(
                'min-w-0 flex-1 bg-transparent text-13 outline-none',
                interactionDisabled
                  ? 'cursor-not-allowed text-[var(--text-disabled)] placeholder:text-[var(--text-disabled-tertiary)]'
                  : 'text-[var(--model-item-text)] placeholder:text-[var(--text-tertiary)]',
              )}
              aria-label={t('newChat.modelSelector.search.placeholderAll')}
            />
          </div>
          <UnifiedModelPanel
            providers={providers}
            providerOrder={deviceId ? undefined : localProviders.providerOrder}
            {...(unifiedAgents ? { agents: unifiedAgents } : {})}
            scope={unifiedScope}
            isVisible={unifiedIsVisible}
            {...(unifiedExcludeProvider ? { excludeProvider: unifiedExcludeProvider } : {})}
            {...(unifiedExcludeModel ? { excludeModel: unifiedExcludeModel } : {})}
            sourceVersion={[
              visibilityVersion,
              deviceId ?? '',
              excludeSubscriptionDirect ? 1 : 0,
              excludeChatBridgedCodex ? 1 : 0,
              remoteProviders.modelVisibilityOverrides ? 'ov' : 'no-ov',
            ].join('|')}
            query={query}
            // field 形态的面板宽度绑 trigger,定宽 sizer 无用武之地(见该 prop 说明)。
            panelWidthFluid={fluidWidth}
            selected={{ providerId: activeSourceId, modelId }}
            selectedFavoriteUid={selectedFavoriteUid}
            liveAgentKind={currentAgentKind}
            fastMode={fastMode}
            selectedEffort={effort}
            {...(modelMemory ? { modelMemory } : {})}
            agentFastModeCapable={unifiedAgentFastCapable}
            priceOf={(providerId, id, agent) => pricePresentationOf(providerId, id, agent)}
            providerLabel={unifiedProviderLabel}
            effortLabelOf={unifiedEffortLabel}
            {...(constrainedListMaxHeight !== undefined
              ? { listMaxHeight: constrainedListMaxHeight }
              : {})}
            interactionDisabled={interactionDisabled}
            includePaymentRequired
            paymentRequiredLabel={t('newChat.modelSelector.paymentRequired.badge')}
            paymentRequiredUnlockLabel={t('newChat.modelSelector.paymentRequired.unlock')}
            onPaymentRequired={showPaymentRequired}
            configurationEnabled={configurationEnabled}
            {...(sessionEngineFilter ? { sessionEngineFilter } : {})}
            {...(followSession ? { followSession } : {})}
            onSelect={(providerId, id, rowEffort, rowConfig) => {
              const rowEffortValue = rowEffort === '' ? undefined : rowEffort;
              // 草稿(M5):整行原样直通给调用方 —— 引擎跟着模型一起落，中途不再被单引擎
              // 链路重解析一次(见 onUnifiedSelect 的说明)。
              if (onUnifiedSelect) {
                onUnifiedSelect({
                  providerId,
                  modelId: id,
                  ...(rowEffortValue ? { effort: rowEffortValue } : {}),
                  engine: rowConfig.engine,
                  fast: rowConfig.fast,
                  favoriteUid: rowConfig.favoriteUid,
                  ...(rowConfig.resetToRecommended
                    ? { resetToRecommended: true as const }
                    : {}),
                });
                closeOptionsPanel();
                onDismiss?.();
                return;
              }
              // 已建会话(M6):同引擎行照旧走 onProviderChange 直切;跨引擎行在 selectRow
              // 里就已经改道 sessionEngineFilter.onCrossEngineSelect,到不了这里。
              // 「同模型不同配置的收藏」与「锚点只在真的应用后才记」两件事收在
              // applyUnifiedSessionSelect 里(见其头注,M3 / M4)。
              void applyUnifiedSessionSelect({
                providerId,
                wireModelId: id,
                effort: rowEffortValue,
                config: rowConfig,
              });
            }}
            onSelectedFavoriteAnchorClear={(providerId, id, rowEffort, rowConfig) => {
              // 用户在**同模型的普通模型行**上改了实时深度 / Fast:正在跑的配置已经不再等于那份
              // 收藏副本(2026-08-17 review 第五轮 M2)。这里只清锚点 —— 模型 / 引擎一个字没变,
              // 不是一次行选择,**刻意不收面板**(用户还在浮层里继续调)。
              const rowEffortValue = rowEffort === '' ? undefined : rowEffort;
              if (onUnifiedSelect) {
                // 草稿:锚点由这条直通链路的 favoriteUid 承载(草稿层没有第二个清锚入口),
                // 原样把当前 (来源, 模型, 引擎) 连同刚改完的深度 / Fast 重写一遍并置空 uid。
                onUnifiedSelect({
                  providerId,
                  modelId: id,
                  ...(rowEffortValue ? { effort: rowEffortValue } : {}),
                  engine: rowConfig.engine,
                  fast: rowConfig.fast,
                  favoriteUid: null,
                });
                return;
              }
              onSessionFavoriteAnchorChange?.(null);
            }}
            {...(onEffortChange ? { onEffortChangeLive: onEffortChange } : {})}
            {...(onFastModeChange ? { onFastModeChangeLive: onFastModeChange } : {})}
            panelElement={paneElement}
            {...(overlayContentClassName !== undefined
              ? { overlayClassName: overlayContentClassName }
              : {})}
          />
          {/* footer:「连接来源」(与既有面板同规则,device-link 远程隐藏)+ 右侧
            列表样式试用开关(本机偏好,见 modelPickerLayout;两种样式并存期的入口)。 */}
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--model-dropdown-border)] px-3.5 py-[9px]">
            {onNavigateToProviders && !deviceId ? (
              <button
                type="button"
                disabled={interactionDisabled}
                onClick={onNavigateToProviders}
                className={cn(
                  'flex min-w-0 items-center gap-1.5 text-13 text-[var(--text-secondary)]',
                  'transition-colors hover:text-[var(--text-primary)]',
                  interactionDisabled && 'cursor-not-allowed opacity-50',
                )}
              >
                <Plus size={14} className="shrink-0" />
                <span className="truncate">{t('newChat.modelSelector.source.connect')}</span>
              </button>
            ) : (
              <span />
            )}
            {/* 右侧两个文字按钮(三档并存,Chris 2026-08-17):A/B 互切 + 切回老版。 */}
            <div className="flex shrink-0 items-center gap-3">
              <button
                type="button"
                data-layout-toggle
                disabled={interactionDisabled}
                onClick={() => setModelPickerLayout(pickerLayout === 'badge' ? 'classic' : 'badge')}
                className={cn(
                  'shrink-0 whitespace-nowrap text-12 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]',
                  interactionDisabled && 'cursor-not-allowed opacity-50',
                )}
              >
                {pickerLayout === 'badge'
                  ? t('newChat.modelSelector.unified.layoutClassic')
                  : t('newChat.modelSelector.unified.layoutBadge')}
              </button>
              <button
                type="button"
                data-layout-original
                disabled={interactionDisabled}
                onClick={() => setModelPickerLayout('original')}
                className={cn(
                  'shrink-0 whitespace-nowrap text-12 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]',
                  interactionDisabled && 'cursor-not-allowed opacity-50',
                )}
              >
                {t('newChat.modelSelector.unified.layoutOriginal')}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── 主菜单:固定 320 宽(field 形态改绑 trigger 宽度,见 fluidWidth),选项浮层
  //    portal 到 body,hover 时主菜单完全不重排 ─────
  const pane = (
    <div
      ref={bindPaneElement}
      data-model-tag-density={modelTagDensity}
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
            onChange={(next) => {
              if (next !== 'orca') void handleBrowseVendorChange(next);
            }}
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
            disabled={interactionDisabled}
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
      {searchField}

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
        aria-label={t('newChat.modelSelector.modelListAria')}
        onScroll={() => {
          if (suppressScrollDismissRef.current) {
            suppressScrollDismissRef.current = false;
            return;
          }
          // 滚动不派发 pointerleave,行级配置浮层会跟着滚出视口的锚点行跑到菜单外 → 一滚动就收起。
          if (editing) closeOptionsPanel();
        }}
      >
        {!hasAnyModel ? (
          // 发现还在途、且用户没在搜索时不摆「无结果」:那句话和下方的「正在获取」自相矛盾,
          // 而用户看到「没有模型」就会走。搜索无命中是本地过滤的确定结论,照常显示。
          remoteStatusInList && trimmedQuery.length === 0 ? (
            <RemoteModelLoadNotice status={remoteStatusInList} onRetry={retryRemoteModels} />
          ) : discoveringModels && trimmedQuery.length === 0 ? null : (
            <div className="px-3 py-6 text-center text-13 text-[var(--text-tertiary)]">
              {t(
                deviceId && remoteModelListStatus === 'ready' && trimmedQuery.length === 0
                  ? 'newChat.modelSelector.remoteEmpty'
                  : 'newChat.modelSelector.search.noResults',
              )}
            </div>
          )
        ) : sections ? (
          // 按供应商分组:每组一个轻量标题 + 该供应商下的模型行。
          sections
            .filter((sec) => sec.models.length > 0)
            .map((sec, index) => (
              <div
                key={sec.provider.id}
                role="group"
                aria-label={providerDisplayName(sec.provider, t)}
              >
                {index > 0 && <div className="mx-1 my-1 h-px bg-[var(--model-dropdown-border)]" />}
                <div className="flex min-w-0 items-center gap-2 px-3 pb-0.5 pt-1 text-11 font-medium text-[var(--text-tertiary)]">
                  <span className="min-w-0 truncate">{providerDisplayName(sec.provider, t)}</span>
                  {!deviceId && sec.provider.id === 'xd' && modelAccessAccountTier === 'free' && (
                    <span
                      data-testid="cindy-ai-model-group-free-tier-badge"
                      className="ml-auto inline-flex shrink-0 items-center rounded-full bg-[var(--surface-chip)] px-2 py-[1px] text-11 font-medium leading-[1.45] text-[var(--text-secondary)]"
                    >
                      {t('settings.providers.xd.accountTier.free')}
                    </span>
                  )}
                </div>
                <div className="flex flex-col gap-0.5">
                  {sec.models.map((m) => renderModelItem(sec.provider, m))}
                </div>
              </div>
            ))
        ) : (
          (flatModels ?? []).map((m) => renderModelItem(null, m))
        )}
      </div>

      {showRemoteStatusFooter && remoteStatusInList && (
        <RemoteModelLoadNotice status={remoteStatusInList} onRetry={retryRemoteModels} compact />
      )}

      {/* 发现在途提示 —— 追加在列表下方,不接管列表(见 discoveringModels 注释)。
          spinner 挂 HTML wrapper + animate-spinner(DESIGN.md §14.4 / 工程规范 §7)。 */}
      {discoveringModels && (
        <div className="flex items-center gap-1.5 px-3 pt-0.5 text-12 text-[var(--text-tertiary)]">
          <span className="inline-flex shrink-0 animate-spinner motion-reduce:animate-none">
            <Loader2 size={12} />
          </span>
          <span className="truncate">{t('newChat.modelSelector.discovering')}</span>
        </div>
      )}

      {/* 「连接来源」footer(供应商入口)—— device-link 远程会话隐藏(无法替被控端连来源)。
          统一面板可用但未启用('original' 形态)时,「添加模型」改为左对齐按钮,右侧摆
          「尝试新选择器」入口(三档并存,Chris 2026-08-17,见 modelPickerLayout)。 */}
      {((onNavigateToProviders && !deviceId) || unifiedPanelAvailable) && (
        <>
          <div className="mx-1 h-px bg-[var(--model-dropdown-border)]" />
          <div className="flex items-center justify-between gap-2">
            {onNavigateToProviders && !deviceId ? (
              <button
                type="button"
                disabled={interactionDisabled}
                onClick={onNavigateToProviders}
                className={cn(
                  'flex min-w-0 items-center gap-1.5 rounded-[8px] px-3 py-2',
                  'transition-colors hover:bg-[var(--model-item-hover)]',
                )}
              >
                <Plus size={14} className="shrink-0 text-[var(--text-tertiary)]" />
                <span className="truncate text-13 font-normal text-[var(--text-tertiary)]">
                  {t('newChat.modelSelector.source.connect')}
                </span>
              </button>
            ) : (
              <span />
            )}
            {unifiedPanelAvailable && (
              <button
                type="button"
                data-try-unified-picker
                disabled={interactionDisabled}
                onClick={() => setModelPickerLayout('classic')}
                className={cn(
                  'shrink-0 whitespace-nowrap rounded-[8px] px-3 py-2 text-12 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--model-item-hover)] hover:text-[var(--text-secondary)]',
                  interactionDisabled && 'cursor-not-allowed opacity-50',
                )}
              >
                {t('newChat.modelSelector.unified.layoutTryUnified')}
              </button>
            )}
          </div>
        </>
      )}

      {optionsPanelUsesLayoutPositioning && connectedOptionsAnchor && configPanel && (
        <ModelOptionsFloatingPanel
          anchor={connectedOptionsAnchor}
          panelRef={configPanelRef}
          className={overlayContentClassName}
          onCancelClose={cancelOptionsClose}
          onScheduleClose={scheduleOptionsClose}
          onDismiss={closeOptionsPanel}
        >
          {configPanel}
        </ModelOptionsFloatingPanel>
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
  thinkingEnabled,
  onThinkingChange,
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
  restoreFocusTarget,
  popoverSide = 'top',
  maxVisibleModelRows,
  configurationEnabled = true,
  unifiedPanel = false,
  unifiedPanelAvailable = false,
  sessionEngineFilter,
  unifiedAgents,
  engineMarkVendor = null,
  selectedFavoriteUid = null,
  onSessionFavoriteAnchorChange,
  onUnifiedSelect,
  fallbackOption,
  reselectEmitsChange = false,
  selectedRowClickOpensConfiguration = false,
  unknownModelLabel,
  ariaContext,
  currentProviderId,
  sourceDisconnected = false,
  actualRoute = false,
  onProviderChange,
  onNavigateToProviders,
  agentSwitch,
}: ModelSelectorProps) {
  const { t, i18n } = useTranslation();
  // 列表样式开关也决定 pill 首位图标形态(badge = 引擎 mark 打头,见 engineLeadsTrigger)。
  const pickerLayout = useModelPickerLayout();
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const [keepOpenForAgentConfirmation, setKeepOpenForAgentConfirmation] = useState(false);
  // 打开触发的那次模型发现是否仍在途(并发语义与理由见 useModelDiscoveryPending)。
  const discovery = useModelDiscoveryPending();
  const [showDiscoveryPending, setShowDiscoveryPending] = useState(false);
  const showDiscoveryPendingRef = useRef(false);
  const discoveryIndicatorTimerRef = useRef<number | null>(null);
  const resetDiscoveryPresentation = useCallback((): void => {
    if (discoveryIndicatorTimerRef.current !== null) {
      window.clearTimeout(discoveryIndicatorTimerRef.current);
      discoveryIndicatorTimerRef.current = null;
    }
    if (!showDiscoveryPendingRef.current) return;
    showDiscoveryPendingRef.current = false;
    setShowDiscoveryPending(false);
  }, []);
  useEffect(() => {
    resetDiscoveryPresentation();
    if (!discovery.pending) return;
    const timer = window.setTimeout(() => {
      discoveryIndicatorTimerRef.current = null;
      showDiscoveryPendingRef.current = true;
      setShowDiscoveryPending(true);
    }, MODEL_DISCOVERY_INDICATOR_DELAY_MS);
    discoveryIndicatorTimerRef.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (discoveryIndicatorTimerRef.current === timer) {
        discoveryIndicatorTimerRef.current = null;
      }
    };
  }, [discovery.pending, resetDiscoveryPresentation]);
  const setOpenWithoutAutoRefresh = useCallback(
    (next: boolean): void => {
      openRef.current = next;
      if (!next) {
        discovery.reset();
        resetDiscoveryPresentation();
      }
      setOpen(next);
    },
    [discovery, resetDiscoveryPresentation],
  );
  const handleOpenChange = useCallback(
    (next: boolean): void => {
      const nextOpen = disabled ? false : next;
      const wasOpen = openRef.current;
      openRef.current = nextOpen;
      if (nextOpen && !wasOpen && !deviceId) {
        discovery.begin(() =>
          window.electronAPI.maker.requestProviderModelsAutoRefresh('model-selector-open'),
        );
      }
      if (!nextOpen) {
        discovery.reset();
        resetDiscoveryPresentation();
      }
      setOpen(nextOpen);
    },
    [deviceId, disabled, discovery, resetDiscoveryPresentation],
  );

  // AlertDialog 打开时会被 Popover 视作外部交互并请求关闭。Agent 分段确认期间
  // 强制保留已展开的模型面板；确认结束后把底层 open 恢复为 true，避免弹窗关闭
  // 时的焦点回落再次把面板收掉。模型行确认及其它消费者不经过这层包装。
  const contentAgentSwitch = useMemo(() => {
    const confirmBrowseSwitch = agentSwitch?.confirmBrowseSwitch;
    if (!confirmBrowseSwitch) return agentSwitch;
    return {
      ...agentSwitch,
      confirmBrowseSwitch: async (targetVendor: 'cc' | 'codex' | 'pi') => {
        setKeepOpenForAgentConfirmation(true);
        try {
          return await confirmBrowseSwitch(targetVendor);
        } finally {
          setOpenWithoutAutoRefresh(true);
          setKeepOpenForAgentConfirmation(false);
        }
      },
    };
  }, [agentSwitch, setOpenWithoutAutoRefresh]);

  // 统一面板下没有「先切分段再选模型」那一步,跨引擎的确认落在**真正选中那一行**的这一下。
  // 确认用的 AlertDialog 同样会被 Popover 当成外部交互顺手把面板收掉,所以复用上面那把
  // 保命锁。收尾**成功也不关**(Chris 2026-08-20):切完引擎用户还要改思维 / 再点胶囊,
  // 以前 applied=true 就收窗,表象就是「所有模型改不了 Harness」。取消 / 失败同样留在原地。
  //
  // 2026-08-17 review 第二项之后,这个 await 等的是**整条切换事务**(确认框 + 登记往返),
  // 不再只是确认框那一下。保命锁刻意**覆盖整个 await 期**:事务在途时面板被 Popover 的
  // 外点判定收掉,收尾再把 open 设回 true,就成了「面板闪一下又自己弹回来」。锁按住期间
  // 面板恒可见,切换 in-flight 由 interactionDisabled 置灰。
  //
  // ★ open 的表达式必须是 `open || keepOpenForAgentConfirmation`,disabled **不能**参与
  // 开关(Chris 2026-08-19「面板原地刷新」+ 2026-08-20「改思维闪关菜单」):
  // 事务一进 beginAgentSwitchOperation,调用方的 agentSwitchInFlight 就把 disabled 拉高。
  // `(open && !disabled) || keepOpen` 只保住确认框那条路,改思维 / 同引擎重登记不走
  // keepOpen,选单照关。disabled 只该让面板置灰(interactionDisabled),不该有权把窗口关掉。
  // 不能写成 `(open || keepOpen) && !disabled` —— 那是 08-19 的原症状。
  // 不能写成 `(open && !disabled) || keepOpen` —— 那是 08-20 改思维仍闪关。
  const contentSessionEngineFilter = useMemo(() => {
    if (!sessionEngineFilter) return undefined;
    const { onCrossEngineSelect } = sessionEngineFilter;
    return {
      ...sessionEngineFilter,
      onCrossEngineSelect: async (
        args: Parameters<typeof onCrossEngineSelect>[0],
      ): Promise<boolean> => {
        setKeepOpenForAgentConfirmation(true);
        try {
          const applied = await onCrossEngineSelect(args);
          // 成功也不收选单(Chris 2026-08-20):切完引擎用户还要改思维 / 再点胶囊。
          // 以前 `applied === true` 就把窗口关了,表象就是「所有模型改不了 Harness」——
          // 一点胶囊选单消失,变量还没调完。取消 / 失败同样留在原地。用户自己点外面才关。
          setOpenWithoutAutoRefresh(true);
          return applied !== false;
        } finally {
          setKeepOpenForAgentConfirmation(false);
        }
      },
    };
  }, [sessionEngineFilter, setOpenWithoutAutoRefresh]);

  const agentKind = vendorKeyToAgentKind(vendorKey);
  const cc = useAgentCapabilities('claude-code', deviceId);
  const codex = useAgentCapabilities('codex', deviceId);
  const pi = useAgentCapabilities('pi', deviceId);
  const gatewayPricing = useGatewayModelPricing();
  const referencePricing = useReferenceModelPricing();
  const { accountTier: modelAccessAccountTier } = useModelAccessStatus();
  // trigger 的来源 icon / 当前模型也按来源取:device-link 用被控端供应商目录(否则控制端本地
  // 查不到被控端独有模型 → currentModel undefined → label 退成 "Select model")。
  const localProviders = useProviders();
  const remoteProviders = useDeviceProviders(deviceId);
  const providers = deviceId ? remoteProviders.providers : localProviders.providers;
  const remoteModelListStatus = resolveRemoteModelListStatus({
    deviceId,
    agentKind,
    cc,
    codex,
    pi,
    providers: remoteProviders,
  });
  const remoteModelLoading = !!deviceId && remoteModelListStatus === 'loading';
  const remoteModelLoadFailed = !!deviceId && remoteModelListStatus === 'error';
  const visibleModels = useMemo(
    () =>
      selectVisibleModels({
        agentKind,
        deviceId,
        providers,
        deviceCcModels: cc.capabilities?.availableModels ?? [],
        deviceCodexModels: codex.capabilities?.availableModels ?? [],
        devicePiModels: pi.capabilities?.availableModels ?? [],
        excludeSubscriptionDirect,
        excludeChatBridgedCodex,
      }),
    [
      agentKind,
      deviceId,
      providers,
      cc.capabilities,
      codex.capabilities,
      pi.capabilities,
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
      (remoteModelLoading ? t('newChat.modelSelector.remoteLoading') : null) ??
      (remoteModelLoadFailed ? t('newChat.modelSelector.remoteLoadFailedShort') : null) ??
      (unknownLabel !== '' ? unknownLabel : null) ??
      t('newChat.modelSelector.trigger.placeholder'));
  const agentName =
    agentIdentity && !fallbackOption?.active
      ? agentIdentity.vendorKey === 'cc'
        ? t('newChat.modelSelector.trigger.agent.claudeCode')
        : agentIdentity.vendorKey === 'pi'
          ? t('newChat.modelSelector.trigger.agent.pi')
          : t('newChat.modelSelector.trigger.agent.codex')
      : null;
  const agentIdentityLabel =
    agentName && agentIdentity?.state === 'pending'
      ? t('newChat.modelSelector.trigger.agent.pending', { agent: agentName })
      : agentName;
  const baseDisplayIdentityLabel = agentIdentityLabel
    ? `${agentIdentityLabel} · ${displayLabel}`
    : displayLabel;
  const remoteStatusLabel = currentModel
    ? remoteModelLoading
      ? t('newChat.modelSelector.remoteLoading')
      : remoteModelLoadFailed
        ? t('newChat.modelSelector.remoteLoadFailedShort')
        : null
    : null;
  const displayIdentityLabel = remoteStatusLabel
    ? `${baseDisplayIdentityLabel} · ${remoteStatusLabel}`
    : baseDisplayIdentityLabel;
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
        ? (actualRoute ? actualSourceIdForModel : effectiveSourceIdForModel)(
            providers,
            currentProviderId,
            modelId,
            currentAgentKind,
          )
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
  const triggerProvider = providers.find((provider) => provider.id === activeSourceId);
  const activeThinkingToggle =
    currentAgentKind === 'pi' &&
    !!triggerProvider &&
    getModel(triggerProvider, modelId, currentAgentKind)?.thinkingToggle === true;
  const showEffort =
    !fallbackOption?.active &&
    efforts.length > 0 &&
    efforts.includes(effort) &&
    !activeThinkingToggle;
  const fullEffortLabel = showEffort
    ? labelOf(effort)
    : activeThinkingToggle && thinkingEnabled
      ? t('newChat.modelSelector.thinking')
      : null;
  const effortLabel = showEffort
    ? modelCompactEffortLabel(
        resolvedTranslationLanguage(i18n),
        t,
        currentModel,
        effort,
        effortMeta.get(effort),
      )
    : null;
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
        ? fullEffortLabel
          ? t('newChat.modelSelector.trigger.pendingAriaWithEffort', {
              agent: agentName,
              model: displayLabel,
              effort: fullEffortLabel,
            })
          : t('newChat.modelSelector.trigger.pendingAria', {
              agent: agentName,
              model: displayLabel,
            })
        : fullEffortLabel
          ? t('newChat.modelSelector.trigger.ariaWithEffort', {
              model: displayIdentityLabel,
              effort: fullEffortLabel,
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
  // ── composer pill 的引擎小标(model-selector-unified §1.1)─────────────────────
  // 传了 engineMarkVendor 就走新形态:harness 名字文本让位给尾部的一枚 mark,和深度档字
  // 紧挨着收尾(与面板行右侧三元组同构)。没传的入口一个像素都不变。
  const engineMarkOption = engineMarkVendor ? agentOptionOf(engineMarkVendor) : null;
  // badge 样式的 pill(Chris 2026-08-17 裁决):首位图标 = 用户在用的 harness mark,
  // 渠道图标与尾部 harness 小标一并去掉 —— 行内已按「引擎徽标行」建立了引擎优先的
  // 心智,pill 跟着同一套;渠道归属由面板里的分栏题头回答。classic 一个像素不动。
  const engineLeadsTrigger = pickerLayout === 'badge' && engineMarkOption !== null;
  // 引擎小标 + 深度是 pill 的**定宽身份位**:窄工具条下也要留着,先让模型名截断
  // (Chris 2026-08-12 裁决)。只有 ultra-compact(整段文字都收起、只剩图标)才一并隐藏。
  const showTriggerTail = engineMarkOption ? !isUltraCompactToolbar : !isCompactToolbar;
  const engineMarkNode = engineMarkOption ? (
    // aria-hidden:引擎名已经在 button 的 aria-label / title 里(displayIdentityLabel 仍带
    // agentIdentityLabel),这里再念一遍是重复。data 属性供接线测试定位。
    <span
      data-composer-engine-mark={engineMarkVendor}
      className="flex shrink-0 items-center"
      aria-hidden="true"
    >
      <engineMarkOption.Mark
        size={isCreateAgentVariant ? 11 : dense ? 11 : 12}
        className={cn(
          'ml-1 shrink-0',
          isCreateAgentVariant
            ? 'text-[var(--create-agent-control-icon)]'
            : 'text-[var(--composer-pill-icon,#3C3F43)] dark:text-[var(--composer-pill-icon,#D9D9D9)]',
        )}
      />
    </span>
  ) : null;
  const agentIdentityPrefix =
    agentIdentityLabel && !isCompactToolbar && !engineMarkOption ? (
      <>
        <span
          className={cn(
            'shrink-0 font-normal text-[var(--model-trigger-meta)]',
            isCreateAgentVariant ? 'text-12' : dense ? 'text-12' : 'text-13',
          )}
        >
          {agentIdentityLabel}
        </span>
        <span
          className={cn(
            'shrink-0 font-normal text-[var(--model-trigger-meta)]',
            isCreateAgentVariant ? 'text-12' : dense ? 'text-12' : 'text-13',
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
      // 阻 mousedown 抢焦点 —— 否则点 pill 会先把光标从输入框挪走,选完模型后
      // 还要再点一次才能接着打字。键盘 Tab 仍可正常 focus。
      onMouseDown={morphEnabled ? (event) => event.preventDefault() : undefined}
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
              isCreateAgentVariant ? 'text-12' : dense ? 'text-12' : 'text-13',
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
              isCreateAgentVariant ? 'text-12' : dense ? 'text-12' : 'text-13',
            )}
          >
            {/* 断开来源可能是该模型的唯一提供方 → visibleModels 查不到,回落显示原始 id,
                    比 "Select model" 占位更能说明「哪个模型的来源断了」。 */}
            {currentModel?.displayName ?? modelId}
          </span>
          {/* 来源断开是**来源**的事,引擎身份位照常保留(规格 §1.2:引擎可见性靠一致的
              结构位,不靠出错才显示)。 */}
          {showTriggerTail && engineMarkNode}
          <Unplug
            size={dense ? 11 : 12}
            className="ml-0.5 shrink-0 text-[var(--error-fg)]"
            aria-hidden
          />
          {!isCompactToolbar && (
            <span
              className={cn(
                'shrink-0 font-medium text-[var(--error-fg)]',
                dense ? 'text-11' : 'text-12',
              )}
            >
              {t('newChat.modelSelector.source.disconnected')}
            </span>
          )}
        </>
      ) : (
        <>
          {!currentModel && remoteModelLoading && (
            <span className="inline-flex shrink-0 animate-spinner text-[var(--text-tertiary)] motion-reduce:animate-none">
              <Loader2 size={dense ? 12 : 13} />
            </span>
          )}
          {!currentModel && remoteModelLoadFailed && (
            <CircleAlert size={dense ? 12 : 13} className="shrink-0 text-[var(--error-fg)]" />
          )}
          {/* 图标统一规则:badge 样式首位放**引擎 mark**(engineLeadsTrigger,渠道图标
              让位);classic 保持模型条目 icon(AI Gateway / 目录设定)优先、缺省回落
              当前真正路由的来源标(activeSourceId)——客户端不按 model id 猜厂牌。 */}
          {engineLeadsTrigger && engineMarkOption ? (
            <span
              data-composer-engine-lead={engineMarkVendor}
              className="mr-1.5 flex shrink-0 items-center"
              aria-hidden="true"
            >
              <engineMarkOption.Mark
                size={isCreateAgentVariant ? 12 : 13}
                className={cn(
                  'shrink-0',
                  isCreateAgentVariant
                    ? 'text-[var(--create-agent-control-icon)]'
                    : 'text-[var(--composer-pill-icon,#3C3F43)] dark:text-[var(--composer-pill-icon,#D9D9D9)]',
                )}
              />
            </span>
          ) : activeSourceId ? (
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
          ) : null}
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
              isCreateAgentVariant ? 'text-12' : dense ? 'text-12' : 'text-13',
            )}
            style={budgetGradientStyle}
          >
            {displayLabel}
          </span>
          {/* 引擎小标 + 深度 = pill 的收尾身份组(新形态,见 engineMarkVendor)。
              旧形态没有 mark,深度前保留「·」分隔;有 mark 时图标本身就是分隔,再加点
              会读成「模型 · 引擎 · 深度」三段,又变回被撤掉的那种堆砌。
              badge 样式引擎已在首位(engineLeadsTrigger),尾部不再重复一枚。 */}
          {showTriggerTail && !engineLeadsTrigger && engineMarkNode}
          {effortLabel && showTriggerTail && (
            <>
              {/* 尾部没有 mark 作视觉分隔(旧形态,或 badge 把 mark 移到了首位)时,
                  深度前补「·」—— 否则「名字 深度」贴着读会粘成一个词。 */}
              {(!engineMarkOption || engineLeadsTrigger) && (
                <span
                  className={cn(
                    'shrink-0 font-normal',
                    isCreateAgentVariant
                      ? 'text-[var(--create-agent-control-text)]'
                      : 'text-[var(--model-trigger-meta)]',
                    isCreateAgentVariant
                      ? 'shrink-0 text-12'
                      : dense
                        ? 'shrink-0 text-12'
                        : 'shrink-0 text-13',
                  )}
                  aria-hidden="true"
                >
                  ·
                </span>
              )}
              <span
                title={fullEffortLabel ?? undefined}
                className={cn(
                  'min-w-0 font-normal',
                  isCreateAgentVariant
                    ? 'text-[var(--create-agent-control-text)]'
                    : 'text-[var(--text-primary)]',
                  engineMarkOption
                    ? 'shrink-0 whitespace-nowrap'
                    : isCreateAgentVariant
                      ? 'truncate'
                      : isFieldTrigger
                        ? 'max-w-[120px] truncate'
                        : 'shrink-0 whitespace-nowrap',
                  isCreateAgentVariant ? 'text-12' : dense ? 'text-12' : 'text-13',
                )}
              >
                {effortLabel}
              </span>
            </>
          )}
          {triggerFastOn && showTriggerTail && (
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
          {currentModel && remoteModelLoading && (
            <span className="ml-0.5 inline-flex shrink-0 animate-spinner text-[var(--text-tertiary)] motion-reduce:animate-none">
              <Loader2 size={dense ? 11 : 12} />
            </span>
          )}
          {currentModel && remoteModelLoadFailed && (
            <CircleAlert
              size={dense ? 11 : 12}
              className="ml-0.5 shrink-0 text-[var(--error-fg)]"
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
      thinkingEnabled={thinkingEnabled}
      onThinkingChange={onThinkingChange}
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
      unifiedPanel={unifiedPanel}
      unifiedPanelAvailable={unifiedPanelAvailable}
      sessionEngineFilter={contentSessionEngineFilter}
      unifiedAgents={unifiedAgents}
      selectedFavoriteUid={selectedFavoriteUid}
      onSessionFavoriteAnchorChange={onSessionFavoriteAnchorChange}
      onUnifiedSelect={onUnifiedSelect}
      reselectEmitsChange={reselectEmitsChange}
      selectedRowClickOpensConfiguration={selectedRowClickOpensConfiguration}
      pointerRevealRequiresIntent={morphEnabled}
      optionsPanelUsesLayoutPositioning={isCreateAgentVariant}
      fluidWidth={isFieldTrigger}
      agentSwitch={contentAgentSwitch}
      discoveringModels={showDiscoveryPending && discovery.pending}
      interactionDisabled={switching || disabled}
      gatewayPricing={gatewayPricing}
      referencePricing={referencePricing}
      modelAccessAccountTier={modelAccessAccountTier}
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
        open={open || keepOpenForAgentConfirmation}
        onOpenChange={handleOpenChange}
        side={popoverSide}
        align="end"
        // flex-col + min-h-0:morph 外层按可用空间钳了显式高度,但内容包装本身
        // height:auto + max-h-full 对子元素来说不是"确定高度",百分比钳制解析不出 ——
        // 面板列比可用空间高时被 overflow-hidden 裁掉底部(2026-08-13 实测:最后一行
        // 与 footer 缺一截)。改成弹性列后 flex 布局用 max-height 钳出的容器主轴尺寸
        // 收缩子项(min-h-0 链),列表在自己内部滚动,搜索行与 footer 完整露出。
        wrapperClassName="min-w-0 max-w-full shrink"
        panelClassName="flex min-h-0 flex-col p-0"
        // 宽度只进不退(2026-08-14 实测反馈):rail 筛选把内容变窄时面板宽度回缩,
        // rail 图标在指针底下移位。高度照常双向跟随(底边锚定向上收)。
        // 列表样式切换是**形态换代**,水位随 key 清零 —— 否则从 classic(带 48px
        // 侧栏)当场切到 badge,面板扛着旧宽度不回缩(Chris 2026-08-17:「有一点点宽」)。
        stickyWidth
        stickyWidthKey={pickerLayout}
        panelAriaLabel={ariaLabel}
        {...(restoreFocusTarget ? { restoreFocusTarget } : {})}
        trigger={trigger}
      >
        {content}
      </MorphPopover>
    );
  }

  return (
    <Popover open={open || keepOpenForAgentConfirmation} onOpenChange={handleOpenChange}>
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
