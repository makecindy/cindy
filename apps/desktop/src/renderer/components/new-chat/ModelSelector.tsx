import { useRemoteProviderDisable } from '@/lib/remoteProviderDisable';
import { listedSourceFolds } from '@cindy/model-providers';
import { deviceDisplayName } from '@/lib/deviceName';
import { ProviderShareQuotaViewingContext, useProviderShareQuotaViewing } from '@/features/provider-share/useProviderShareWeeklyQuota';
import { SpeedIcon } from './SpeedIcon';
import { ErrorNotice } from '@/components/ui/error-notice';
import { SearchInput } from '@/components/ui/search-input';
import { DisplayPricingDetails } from '@/components/DisplayPricingDetails';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { localizedModelDescription } from '@/lib/modelDescriptions';
import { localizedModelName, matchesModelName } from '@/lib/modelDisplayNames';
import {
  useCallback,
  useState,
  useMemo,
  useEffect,
  useLayoutEffect,
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
  Clock3,
  Loader2,
  PlugZap,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Unplug,
  WifiOff,
  Zap,
  Lock,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { flashScrollbar } from '@/lib/scrollbarAutoHide';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { MorphPopover } from '@/components/ui/morph-popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { currentFocusedRow } from '@/components/ui/dropdown-menu-highlight';
import {
  COMPOSER_MENU_ROW,
  MenuHighlightLayer,
  menuPanelAttrs,
  menuRowAttrs,
  menuSkipAttrs,
  useMenuPanel,
  withMenuLabels,
} from '@/components/ui/menu-row';
import { useOptionalConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { AnthropicMark } from '@/components/icons/AnthropicMark';
import { OpenAIMark } from '@/components/icons/OpenAIMark';
import { CindyMark } from '@/components/icons/CindyMark';
import { CustomProviderIcon } from '@/components/icons/CustomProviderIcon';
import { hasProviderLogo, ProviderLogoMark } from '@/components/icons/ProviderLogoMark';
import { agentOptionOf } from './agentOptions';
import type { SelectableVendor } from '@/lib/agentVendors';
import { FastModeToggle } from './FastModeToggle';
import {
  UnifiedModelPanel,
  type UnifiedModelPanelProps,
  type UnifiedSelectedRow,
} from './UnifiedModelPanel';
import { matchPluginModels, PluginModelIcon, PluginModelsSection, type PluginModelsPickerProps } from './PluginModelsSection';
import { useFavoritePluginModelCount } from '@/features/cc-agent/pluginModelFavorites';
import { MODEL_GROUPS_DEFAULTS } from '../../../shared/modelGroups';
import { isSourceRouteProviderId } from '@/features/model-groups/sourceRouteProviders';
import {
  buildPanelModelGroups,
  resolveModelSelectorDeviceGroups,
  resolveModelSelectorRoutingMode,
  resolveModelSelectorTriggerRouting,
  useModelSelectorSmartRouting,
} from './modelSelectorSmartRouting';
import { refreshModelGroups } from '@/features/model-groups/modelGroupsClient';
import { buildModelGroupPickerRows, matchModelGroupRows, ModelGroupIcon, ModelGroupsPickerSection, useFavoriteModelGroupCount, useModelGroupPickerRows, type ModelGroupsPickerProps } from './ModelGroupsPickerSection';
import { PluginEngineIcon } from '@/components/icons/PluginEngineIcon';
import {
  PluginEngineSessionPanel,
  usePluginEngineChoiceLabel,
  type PluginEnginePendingSelection,
  type PluginEngineSessionPickerProps,
  type PluginEnginesPickerProps,
} from './PluginEnginesSection';
import {
  PLUGIN_ENGINE_DEFAULT_MODEL,
  isSamePluginEngineChoice,
  pluginEngineModelName,
  resolvePluginEngineEffort,
  type PluginEngineChoice,
} from '@/lib/pluginEngineSelection';
import type { PluginEngineEffort } from '../../../shared/pluginEngines';
import { stopWheelPropagation } from '@/lib/stopWheelPropagation';
import type { ProviderGroupUsageOf, ProviderUsageScope } from './useProviderWeeklyQuota';
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
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import { retryProviderShareCatalog } from '@/lib/remoteCatalogSnapshot';
import { useModelAccessStatus } from '@/hooks/useModelAccessStatus';
import { requestPluginEnginesRefresh } from '@/hooks/usePluginEngines';
import { useProviders } from '@/hooks/useProviders';
import { withSubscriptionDisplayModels } from '@/lib/localCatalogSnapshot';
import { LocalModelCatalogNotice } from './LocalModelCatalogNotice';
import { PROVIDER_TITLE_KEY, providerDisplayName as sharedProviderDisplayName } from '@/lib/providerDisplayName';
import {
  evictDeviceProviders,
  prefetchDeviceProviders,
  useDeviceProviders,
} from '@/hooks/useDeviceProviders';
import { isTemporaryCatalogFailure } from '@/lib/temporaryCatalogFailure';
import { useDevicesProviders } from '@/hooks/useDevicesProviders';
import { modelCatalogKey, type ControlledModelFavoriteSource } from '../../../shared/controlledModelCatalog';
import { RemoteSourceMark } from '@/components/icons/RemoteSourceMark';
import { RouteSourceMark } from '@/components/icons/RouteSourceMark';
import { buildUnifiedRail, remoteAgentProviders } from './unifiedModelSelection';
import {
  collectRemoteProviderGroups,
  providerGroupMemberOfRoute,
  remoteProviderEntryKey,
  type RemoteProviderGroupEntry,
} from '@/lib/remoteProviderGroups';
import { providerGroupDeviceCount, type ProviderGroupConfig } from '../../../shared/providerGroup';
import { useLocalProviderGroups } from '@/features/provider-group/useLocalProviderGroups';
import { isProviderAccessDeniedError, providerSharePickerState, readProviderShareGroupSize } from '@cindy/device-link';
import { SharedProviderGroupStatus } from '@/features/provider-share/SharedProviderGroupStatus';
import { useProviderShareReceived } from '@/features/provider-share/providerShareStore';
import { providerShareAgentDeviceId } from '@/features/provider-share/providerShareFormat';
import { modelPriceDiscountLabelValues, modelPriceDetailRows } from '@/lib/modelPriceFormat';
import { resolveModelPricePresentation } from '@/lib/modelPricePresentation';
import {
  filterChatBridgedCodexProviders,
  isLocalOnlyProviderForAgent,
  isDeviceModelVisible,
  providerMonogram,
  resolveVisibleModelAgentKind,
  selectVisibleModels,
} from '@/lib/providerModels';
import type { Effort } from '@/lib/userPreferences.types';
import type { SessionRuntimeProfileProjection } from '@/lib/ccAgent.types';
import { isProviderShareAgentDeviceId, providerShareIdOfAgentDeviceId } from '../../../shared/providerShare';
import {
  CHATGPT_MODEL_PREFIX,
  XAI_MODEL_PREFIX,
  isSubscriptionDirectModel,
} from '../../../shared/subscriptionModels';
import { extractIpcError } from '@/utils/ipcError';
import { isModelEnabled, useModelVisibilityVersion } from '@/state/modelVisibilityPrefs';
import { seedDefaultFavorite } from '@/state/modelFavorites';
import { useProviderModelMemoryVersion } from '@/state/providerModelMemory';
import { useDeviceLinkModelMirrorVersion } from '@/state/deviceLinkModelMirror';
import { useAgentDeviceModelMemoryVersion } from '@/state/agentDeviceModelMemory';
import {
  connectedProvidersForAgent,
  chatEligibleSourcesForModel,
  actualSourceIdForModel,
  effectiveSourceIdForModel,
  displayNameOfStoredModelId,
  findCatalogModel,
  nativeDefaultSourceId,
  getModel,
  isCustomRoutedProvider,
  isCodexGatewayWireModel,
  movedCindyAutoSourceId,
  modelSupportsFastMode,
  providerOffersModel,
  resolveModelIconKind,
  resolveCodexCompatibilityWireProtocol,
  sourcesForModel,
  unifiedModelEntries,
  visibleModelUnion,
  withEffectiveModelContextWindows,
  type ProviderView,
} from '@cindy/model-providers';
import { isProviderLogoKind } from '@cindy/model-providers/branding';
import { compactEnglishEffortLabel } from '@cindy/maker-shared/agent-capabilities';
import type { ModelAccessAccountTier } from '../../../shared/modelAccess';
import { applyProviderOrder } from '../../../shared/providerOrder';
import type { ModelPricingCatalog } from '../../../shared/regionalMoney';
import { buildProviderSections, isSelectedSourceDisconnected, withFollowedAccountSource } from './sourceSwitch';
import type { ModelPickerPreferenceStore } from './modelPickerPreferences';
import { mergeSshCodexCatalog, type SshCodexCatalog } from '@/lib/sshCodexCatalog';

const MAX_PREFETCH_REMOTE_CATALOGS = 8;
const REMOTE_CATALOG_WARM_RETRY_MS = 15_000;
const failedRemoteCatalogWarmAt = new WeakMap<DataOwnerGeneration, Map<string, number>>();
const warmingRemoteCatalogKeys = new WeakMap<DataOwnerGeneration, Set<string>>();

function orderedRemoteCatalogKeys(
  devices: readonly { deviceId: string }[] | undefined,
  catalogHostDeviceId?: string,
): string[] {
  if (!devices?.length) return [];
  const shares: string[] = [];
  const others: string[] = [];
  for (const device of devices) {
    const key = modelCatalogKey(device.deviceId, catalogHostDeviceId);
    if (!key) continue;
    if (isProviderShareAgentDeviceId(device.deviceId)) shares.push(key);
    else others.push(key);
  }
  return [...shares, ...others].slice(0, MAX_PREFETCH_REMOTE_CATALOGS);
}

function warmRemoteModelCatalogs(keys: readonly string[]): void {
  if (keys.length === 0) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  const owner = getDataOwnerGeneration();
  let failed = failedRemoteCatalogWarmAt.get(owner);
  if (!failed) {
    failed = new Map();
    failedRemoteCatalogWarmAt.set(owner, failed);
  }
  let active = warmingRemoteCatalogKeys.get(owner);
  if (!active) {
    active = new Set();
    warmingRemoteCatalogKeys.set(owner, active);
  }
  const now = Date.now();
  for (const key of keys) {
    if (active.has(key)) continue;
    const failedAt = failed.get(key);
    if (failedAt !== undefined && now - failedAt < REMOTE_CATALOG_WARM_RETRY_MS) continue;
    active.add(key);
    void Promise.resolve(prefetchDeviceProviders(key))
      .then((payload) => {
        if (!isDataOwnerGenerationCurrent(owner)) return;
        if (payload === null) {
          failed.set(key, Date.now());
          return;
        }
        failed.delete(key);
        if (payload && remoteAgentProviders(payload.providers).length > 0) {
          return prefetchDeviceCapabilities(key);
        }
        return undefined;
      })
      .finally(() => {
        active.delete(key);
      });
  }
}

// 短刷新（尤其 auto-refresh cooldown 命中）不应让状态行参与 MorphPopover 的首帧量高：
// 否则它在 220ms 开场内消失后，settle 补量会把面板再缩一次，形成“先变大再变小”。
// 300ms 门槛也与仓库其它本地/远程混合 loading 提示一致；真正的秒级发现仍会明确反馈。
const MODEL_DISCOVERY_INDICATOR_DELAY_MS = 300;

/**
 * 工具栏紧凑统一面板宽度。规格 `docs/product-rules/model-selector-unified.md` §1.2：
 * max-content，下限 300px，上限 min(460px, 100vw-48px)。完整 class 字面量必须留在
 * 源码里给 Tailwind 扫描；改数字时同步规格。
 */
export const UNIFIED_COMPACT_PANEL_MAX_WIDTH_PX = 460;
export const UNIFIED_COMPACT_PANEL_WIDTH_CLASS =
  'w-max min-w-[300px] max-w-[min(460px,calc(100vw-48px))]';

/**
 * 标签降级按选择器 pane 宽度生效。这里的 width 是整个 pane 宽度，不是模型名
 * 实际可用宽度；行还要扣掉左右 padding、来源图标、effort 和选中勾选。因此不能把
 * 300px 当成“能放下全部标签”的阈值，否则英文 Subscription 会先把模型名压成省略号。
 * 模型名优先：促销标签先收起，订阅标签随后收起，只保留「已隐藏」和选中勾选。
 * full 只在宽过紧凑面板上限时启用，避免 460px 触顶时促销标签把刚留给长模型名的空间吃回去。
 */
export type ModelTagDensity = 'full' | 'subscription' | 'hidden';

/** 改深度的附加信息。 */
export interface EffortChangeOptions {
  /**
   * 由统一面板发起:面板已保证同一时刻只提交一笔,调用方不必为防并发写入而锁住 selector。
   * 其余入口(平铺选择器、快捷键)缺省为 false,仍按原样锁定。
   */
  serializedByPanel?: boolean;
}

export function modelTagDensityForWidth(width: number | null): ModelTagDensity {
  if (width === null || width > UNIFIED_COMPACT_PANEL_MAX_WIDTH_PX) return 'full';
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
  /** False for engines without a memory store; edits then use the configuration callback. */
  supportsAgent?: (agent: AgentKind) => boolean;
  /** Optional atomic alias-group edits; absent on older remote hosts. */
  editMany?: (ops: readonly import('@/state/providerModelMemory').ProviderModelMemoryEdit[]) => boolean;
  getEffort: (agent: AgentKind, providerId: string, modelId: string) => Effort | undefined;
  setEffort: (agent: AgentKind, providerId: string, modelId: string, effort: Effort) => void;
  /** 真正选中 / 使用模型时同时更新该来源 lastModel;只编辑非选中行不调用。 */
  setChoice?: (agent: AgentKind, providerId: string, modelId: string, effort: Effort) => void;
  getFast: (agent: AgentKind, providerId: string, modelId: string) => boolean | 'ultrafast' | undefined;
  setFast: (agent: AgentKind, providerId: string, modelId: string, enabled: boolean | 'ultrafast') => void;
  getThinking?: (agent: AgentKind, providerId: string, modelId: string) => boolean | undefined;
  setThinking?: (agent: AgentKind, providerId: string, modelId: string, enabled: boolean) => void;
  /** Delete the override; older remote mirrors fall back to setting the default. */
  clearThinking?: (agent: AgentKind, providerId: string, modelId: string) => void;
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
      className={cn('z-dropdown w-[248px]', className)}
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
            // 与统一面板同因:portal 在 body,模态对话框里滚轮会被 react-remove-scroll
            // 拦掉;stopPropagation 放行原生滚动(见 stopWheelPropagation 注释)。
            onWheel={stopWheelPropagation}
            onPointerEnter={onCancelClose}
            onPointerLeave={onScheduleClose}
            onFocusCapture={onCancelClose}
            onBlurCapture={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              onScheduleClose();
            }}
            className={cn(
              'w-full overflow-hidden rounded-xl p-2 shadow-[shadow:var(--shadow-menu)] outline-none duration-100',
              'animate-float-in border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]',
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

/** Display-only alias lookup; implicit choices retain the default-source eligibility/order. */
function modelDisplayProvider(
  providers: ProviderView[], providerId: string | null | undefined,
  modelId: string, agent: AgentKind, actualRoute: boolean,
): ProviderView | undefined {
  if (providerId) return providers.find((provider) => provider.id === providerId);
  const resolveSource = actualRoute ? actualSourceIdForModel : effectiveSourceIdForModel;
  const eligible = providers.filter((provider) => {
    // Source eligibility must preserve distinct products such as [1m]. Metadata
    // may fall back to the base model only after the source has been selected.
    const model = findCatalogModel(provider, modelId, agent, { exact: true });
    return model && resolveSource([provider], provider.id, model.id, agent) === provider.id;
  });
  const defaultId = nativeDefaultSourceId(eligible, agent);
  return eligible.find((provider) => provider.id === defaultId);
}

// 来源供应商 → 单色官方 mark(fill=currentColor)。trigger 默认右间距 + trigger 文字色;
// 列表行前缀通过 colorClass / withMargin 改用 secondary 色 + 由 flex gap 控间距。
export function ProviderMark(props: Parameters<typeof DefaultProviderMark>[0] & {
  customIcon?: string;
}) {
  return (
    <CustomProviderIcon svg={props.customIcon} size={props.dense ? 12.3 : 13}
      className={cn(props.withMargin !== false && 'mr-1.5', 'shrink-0')}>
      <DefaultProviderMark {...props} />
    </CustomProviderIcon>
  );
}

function DefaultProviderMark({
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
          logoKind === 'xd'
            ? cn(dense ? 'h-[8.4px] w-[14.2px]' : 'h-[9px] w-[15px]', common)
            : common
        }
      />
    );
  }
  // 智能路由(合并了整个供应商、或自己排的那几条)没有品牌标时画路由图形，不画名字的第一个字(「智」)。
  if (isSourceRouteProviderId(providerId)) {
    return <Sparkles size={markSize} strokeWidth={2.2} aria-hidden className={common} />;
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
 * 已选的连接图标优先，否则使用模型厂牌 `icon`，缺省时回落来源供应商标。
 * 禁止在客户端按 model id 猜厂牌。
 */
export function ModelIconMark({
  icon,
  customIcon,
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
  customIcon?: string;
  /** 回落用的来源供应商 id / 展示名(与 ProviderMark 同语义)。 */
  providerId: string;
  name?: string;
  routing?: ProviderView['routing'];
  logoKind?: ProviderView['logoKind'];
  colorClass?: string;
  withMargin?: boolean;
  dense?: boolean;
}) {
  const kind = resolveModelIconKind(icon, logoKind, customIcon);
  if (kind) {
    const common = cn(withMargin && 'mr-1.5', 'shrink-0', colorClass);
    const markSize = dense ? 12.3 : 13;
    const Mark = kind === 'claude' ? AnthropicMark : kind === 'codex' ? OpenAIMark : CindyMark;
    return <Mark size={markSize} className={common} />;
  }
  return (
    <ProviderMark
      providerId={providerId}
      name={name}
      routing={routing}
      logoKind={logoKind}
      customIcon={customIcon}
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
  displayEfforts?: readonly Effort[];
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
    <Badge data-model-promotion-badge tone="accent">
      {children}
    </Badge>
  );
}

function RemoteModelLoadNotice({
  status,
  onRetry,
  compact = false,
  message,
}: {
  status: 'loading' | 'error';
  onRetry: () => void;
  compact?: boolean;
  /** 失败时代替笼统的「读取失败」，说明具体原因(例如分享者需要更新 Cindy)。 */
  message?: string;
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
    <ErrorNotice
      role="alert"
      className="mx-1"
      message={message ?? t('newChat.modelSelector.remoteLoadFailed')}
      actions={
        <Button size="sm" compact onClick={onRetry}>
          <RefreshCw size={12} />
          {t('newChat.modelSelector.retryRemoteModels')}
        </Button>
      }
    />
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

/** 远程 Agent 草稿里一次行选中的落点电脑;null = Agent 在本机。 */
export type UnifiedSelectionAgentDevice = {
  deviceId: string;
  name: string;
} | null;

/** 「配置模型」打开设置 → 模型供应商时直接选中的一项;不传 = 只打开供应商页。 */
export interface ProvidersNavigationTarget {
  /** 分享来的供应商:选中「分享给我的供应商」里的这一条(provider-sharing.md §5.2)。 */
  shareId: string;
}

/** 已建任务里选中了另一台电脑(或本机)目录里的一行:连 Agent 的运行位置一起换。 */
export interface RemoteAgentRelocation {
  providerId: string;
  /** 目标引擎的 wire model id。 */
  modelId: string;
  agent: AgentKind;
  /** 该行生效档位;不可调档时为 undefined。 */
  effort?: Effort;
  fast: boolean | 'ultrafast';
  /** 这一行所属的电脑;null = 本机。 */
  agentDevice: UnifiedSelectionAgentDevice;
  /** An explicit model selection, rather than an edit inside its options panel. */
  retryQueuedSend: boolean;
}

/**
 * 远程 Agent 的选择入口(本机新任务草稿、本机已建任务,以及远程控制的被控电脑上的已建任务与
 * 建到被控电脑的新任务草稿传)。
 * 模型面板的左侧栏在任务所在电脑的供应商之后列出这些电脑上的供应商;选中那台电脑上的模型 =
 * Agent 在那台电脑运行,任务和文件仍在任务所在电脑。
 */
export interface RemoteAgentSelectorOptions {
  /** 可以运行 Agent 的其他电脑(已配对、在线);不含任务所在电脑。 */
  devices: readonly { deviceId: string; name: string; favoriteSource?: ControlledModelFavoriteSource }[];
  /** 当前的 Agent 所在电脑(已建任务按下一条消息时的位置);null = 任务所在电脑。 */
  selectedDeviceId: string | null;
  /**
   * 任务所在电脑:远程控制的被控电脑上的任务(含草稿)传那台的 deviceId,它的目录照远程控制列出全部供应商;
   * 不传 = 本机任务,用本机目录。
   */
  homeDeviceId?: string;
  /** Read remote sources through the task computer, using its grants and connections. */
  catalogHostDeviceId?: string;
  /** homeDeviceId 那台电脑的名字(供应商组那一项的悬停写任务在哪台运行时用)。 */
  homeDeviceName?: string;
  /** 本机的设备 id:供应商组里的组员就是本机时,按任务所在电脑比对任务在哪台运行。 */
  selfDeviceId?: string | null;
  /** 任务所在电脑目录的模型记忆。Agent 当前在其他电脑时,浏览那份目录用它显示各行的档位。 */
  localModelMemory?: ModelMemoryAccessors;
  /**
   * 本机为某台电脑记的模型记忆。浏览不是 Agent 当前所在的那台电脑的目录时,用它显示 / 记住
   * 各行的档位与 Fast(当前所在那台走 modelMemory)。
   */
  deviceModelMemory?: (deviceId: string) => ModelMemoryAccessors;
  /**
   * 已建任务传:选中的行不在 Agent 落点那台电脑的目录里 = 把 Agent 挪过去(与跨引擎同一套意图,
   * 下一条消息发送时生效)。返回 false = 没有执行(确认被取消 / 登记失败),面板留在原地。
   * 草稿不传(草稿走 onUnifiedSelect,行带 agentDevice)。
   */
  onRelocate?: (selection: RemoteAgentRelocation) => Promise<boolean>;
  /**
   * 已建任务传:这个任务此刻归哪个供应商组(组那一项的位置,provider-groups.md §10)。面板每次打开读一次。
   * 归组的任务在组那一项下显示为「正在用的」,在组那一项里选模型 = 留在此刻运行的那台、只换模型,
   * 不把 Agent 挪到组所在电脑。不传 / 读到 null = 没归组。
   */
  readProviderGroup?: () => Promise<RemoteProviderGroupEntry | null>;
}

/**
 * 只限本机的原因是封闭清单：不能把模型放到别的电脑运行的入口才用它，
 * 规则见 docs/product-rules/model-selector-unified.md。
 */
export type ModelSelectorLocalOnlyReason =
  | 'subagent-in-parent-task'
  | 'one-shot-local-request';

/**
 * 每个入口都必须声明模型来源，漏传不能再静默变成只有本机。
 * remoteAgent 为 undefined 只表示此刻不可用（SSH、旧版被控电脑等）。
 */
export type ModelSelectorSource =
  | { remoteAgent: RemoteAgentSelectorOptions | undefined; localOnlyReason?: never }
  | { remoteAgent?: never; localOnlyReason: ModelSelectorLocalOnlyReason };

export type ModelSelectorProps = ModelSelectorBaseProps & ModelSelectorSource;

export interface ModelSelectorBaseProps {
  /** Nonzero request from a terminal-error recovery action; selection still uses the normal transaction. */
  openRequest?: number;
  draftModelPending?: boolean;
  onOpenRequestConsumed?: (nonce: number) => void;
  'data-setting-id'?: string;
  /** 语义同 ModelSelectorContentProps.pluginModels。 */
  pluginModels?: PluginModelsPickerProps;
  /** 语义同 ModelSelectorContentProps.modelGroups。 */
  modelGroups?: ModelGroupsPickerProps;
  readModelGroupDevices?: ModelSelectorContentBaseProps['readModelGroupDevices'];
  /** 语义同 ModelSelectorContentProps.pluginEngines。选中某个引擎时 trigger 显示该引擎与模型。 */
  pluginEngines?: PluginEnginesPickerProps;
  /**
   * 运行在插件引擎上的已建任务(sessions.agent_kind = 'acp')。传入时 trigger 显示引擎名与模型。
   * 同时传 pluginEngines(本机普通任务，能换引擎)时面板与内置任务一样列出内置模型与插件引擎；
   * 只传本项时面板只列该引擎的模型。
   */
  pluginEngineSession?: PluginEngineSessionPickerProps;
  /** 已建任务下一条消息要切到的插件引擎：trigger 显示「下条：引擎 · 模型」。 */
  pluginEnginePending?: PluginEnginePendingSelection;
  /** Authoritative surface-specific allowlist (e.g. one-shot or vision routes). */
  providersOverride?: ProviderView[];
  providersOverrideState?: { status: 'loading' | 'error' | 'ready'; refresh: () => void };
  /**
   * 已建立的本机任务跟着账号走时的原来源视图(sourceSwitch.ts followedAccountSourceProvider)：
   * 只替换本机目录里同 id 的那一项；远程目录、SSH 与外部注入目录不受影响。
   */
  taskSourceProvider?: ProviderView;
  /**
   * SSH project: Codex models come from the host (see mergeSshCodexCatalog), Claude Code
   * and Pi keep the local catalog. `idle` = not read yet; opening the picker calls refresh.
   */
  sshCodex?: SshCodexCatalog;
  currentSelection?: SessionRuntimeProfileProjection;
  selectionPreparation?: 'pending' | 'preparing' | 'failed';
  /** Open recovery for the selected source; generic Add model navigation stays separate. */
  onReconnectSource?: () => void;
  modelId: string;
  effort: Effort;
  onModelChange: (modelId: string) => void | boolean | Promise<void | boolean>;
  /**
   * 改深度。返回值(若有)= **这次写入真的落下去了没有**(`false` / 抛错 = 没落;返回 void 的
   * 调用方视为落了)。统一面板的三个「先应用、后清存储」入口(恢复推荐 / 删选中收藏 /
   * 编辑选中收藏)靠它决定要不要收尾;其余调用方照旧无视返回值。
   */
  onEffortChange: (
    effort: Effort,
    options?: EffortChangeOptions,
  ) => void | boolean | Promise<void | boolean>;
  /**
   * per-session 来源选择(B · Provider-first)。
   *   - currentProviderId:本会话当前显式选定的供应商 id(null = 跟随默认路由)。
   *   - onProviderChange:选某行(供应商, 模型)时调用,第 2 参为该行模型 id,第 3 参为该来源该模型的
   *     当前 effort(无 effort 档时为空串),由各调用方一次性落下 provider/model/effort。
   *   - onNavigateToProviders:0 个可连来源时空态 CTA / 列表底部「配置模型」跳设置→供应商页;
   *     正在看分享来的供应商时带上它(ProvidersNavigationTarget),设置页直接选中那一条。
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
    reconciledFast?: boolean | 'ultrafast',
  ) => void | boolean | Promise<void | boolean>;
  onNavigateToProviders?: (target?: ProvidersNavigationTarget) => void;
  /**
   * 会话显式选中的来源已断开(由 ChatInput 按 sessionId / deviceLink scoping 计算,见
   * isSelectedSourceDisconnected)。true → trigger 显示**真实选中来源** + 「已断开」错误态,
   * 不回落默认来源图标(否则界面显示的来源与发送实际使用的来源分叉,用户无法自查)。
   * 其他消费方(ScheduleChips / ImDefaultSettingsSection / CreateWorkerPopover 等)不传 = 行为不变。
   */
  sourceDisconnected?: boolean;
  /** Check the fixed source of a saved model against the local catalog. */
  checkSavedSource?: boolean;
  /** A saved draft retains its model trigger while the source is being checked or unavailable. */
  preserveDraftModel?: boolean;
  /** 语义同 ModelSelectorContentProps.actualRoute(仅已建会话传 true)。 */
  actualRoute?: boolean;
  /** Task whose existing subscription binding should be displayed, when browsing its host. */
  subscriptionTaskId?: string;
  /** 语义同 ModelSelectorContentProps.taskStarted。 */
  taskStarted?: boolean;
  /** Fast Mode 状态 + 回调(从工具栏搬进 Edit 配置列)。不传 → 配置列不显示 Fast 开关。 */
  fastMode?: boolean | 'ultrafast';
  /** 语义同 onEffortChange(含返回值口径)。 */
  onFastModeChange?: (enabled: boolean | 'ultrafast') => void | boolean | Promise<void | boolean>;
  thinkingEnabled?: boolean;
  onThinkingChange?: (enabled: boolean) => void | boolean | Promise<void | boolean>;
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
   * 任务的 Agent 在另一台电脑运行:trigger 的来源图标换成带信号波纹的远程供应商 Logo,
   * 读屏 / 悬停名带上那台电脑。只影响展示。
   */
  agentDevice?: { deviceId: string; name: string | null } | null;
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
  /** 窄 composer 的简略触发器；模型名按剩余空间收缩。 */
  compactToolbar?: boolean;
  /** 极窄 composer 收起尾部的次要身份信息。 */
  ultraCompactToolbar?: boolean;
  /** 输入区宽度变化时关闭浮层，避免分栏拖动后与触发器脱离。 */
  composerRef?: { readonly current: HTMLElement | null };
  /** Toolbar/field stay compact; settings allows the complete model name to wrap. */
  triggerVariant?: 'toolbar' | 'field' | 'settings';
  /**
   * field 形态的面板宽度：默认 trigger(与表单字段等宽)；content = 与输入框里的模型选择器一样随内容撑开，
   * 至少与 trigger 等宽。readable = 为 IM 项目模型的来源栏和型号留出阅读宽度，
   * 超过视口时收缩（见 DESIGN.md §4 Select & Dropdown）。
   */
  fieldPanelWidth?: 'trigger' | 'content' | 'readable';
  /** CREATE AGENT 首页按 Figma 185:2724 使用独立私有 token。 */
  visualVariant?: 'default' | 'create-agent';
  /** 仅普通 composer 显式开启 chip → panel 容器形变；设置页/worker 等维持 Radix。 */
  useMorphPopover?: boolean;
  /** Let the current task change effort from the visible model-pill tail. */
  showEffortShortcut?: boolean;
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
  /** false hides configuration; 'harness' lets the caller select a model with a Harness. */
  configurationEnabled?: UnifiedModelPanelProps['configurationEnabled'];
  /** Restrict Fast to the Harnesses this entry can persist and dispatch; false disables it. */
  fastModeConfigurable?: boolean | readonly AgentKind[];
  /** 语义同 ModelSelectorContentProps.unifiedPanel（统一模型选择器面板，默认开启）。 */
  unifiedPanel?: boolean;
  /** 语义同 ModelSelectorContentProps.sessionEngineFilter（统一面板的会话内形态）。 */
  sessionEngineFilter?: UnifiedModelPanelProps['sessionEngineFilter'];
  /** 语义同 ModelSelectorContentProps.unifiedAgents（参与联合列表的引擎集合）。 */
  unifiedAgents?: readonly AgentKind[];
  /** 统一面板是否只采用目录官方推荐配置，不读取个人引擎偏好与收藏配置。 */
  unifiedSelectionPolicy?: UnifiedModelPanelProps['selectionPolicy'];
  /** 语义同 ModelSelectorContentProps.recordRecentUsage（选中成功后记入「最近使用」）。 */
  recordRecentUsage?: boolean;
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
  fallbackOption?: { active: boolean; label: string; onSelect: () => void | boolean | Promise<void | boolean> };
  /**
   * 点击**当前已选中**的行时照常回调 onModelChange / onProviderChange（默认 false = 收起了事）。
   * 供「当前值是解析出的继承值、点一下才落成显式值」的调用方（IM 工作目录偏好）使用；
   * 会话场景不要开——那里 modelId 本就是已持久化的值，重选自己是纯无操作。
   */
  reselectEmitsChange?: boolean;
  /** 点击当前已选模型行时打开该行的配置浮层，而不是直接收起选择器。 */
  selectedRowClickOpensConfiguration?: boolean;
  /**
   * modelId 非空但不在可见清单时的诊断文案（默认提示模型信息暂不可用）。
   * 供展示已持久化偏好的调用方给出诊断性文案，避免把「存过但当前不可用」显示成「没选过」。
   */
  unknownModelLabel?: (modelId: string) => string;
  /** Optional separate status below an unknown model, retaining unknownModelLabel for accessible text. */
  unknownModelDescription?: string;
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

export type ModelSelectorContentProps = ModelSelectorContentBaseProps & ModelSelectorSource;

export interface ModelSelectorContentBaseProps {
  /** 新任务的「让插件选」；只有草稿传(已有任务、伙伴对话不传)。 */
  pluginModels?: PluginModelsPickerProps;
  /**
   * 插件提供的执行引擎(「插件引擎」分组,docs/plans/acp-plugin-bridge.md)。只有本机新任务草稿
   * 在至少有一个引擎时传；不传时面板与没装插件时逐像素一致。
   */
  pluginEngines?: PluginEnginesPickerProps;
  /** 新任务的模型组(用户建的模式与路线)；只有草稿传。 */
  modelGroups?: ModelGroupsPickerProps;
  /** 打开面板时读取远程模型组，包括首次读取失败、还没有配置时。 */
  readModelGroupDevices?(): void;
  providersOverride?: ProviderView[];
  providersOverrideState?: ModelSelectorProps['providersOverrideState'];
  taskSourceProvider?: ModelSelectorProps['taskSourceProvider'];
  sshCodex?: SshCodexCatalog;
  modelId: string;
  effort: Effort;
  onModelChange: (modelId: string) => void | boolean | Promise<void | boolean>;
  /**
   * 改深度。返回值(若有)= **这次写入真的落下去了没有**(`false` / 抛错 = 没落;返回 void 的
   * 调用方视为落了)。统一面板的三个「先应用、后清存储」入口(恢复推荐 / 删选中收藏 /
   * 编辑选中收藏)靠它决定要不要收尾;其余调用方照旧无视返回值。
   */
  onEffortChange: (
    effort: Effort,
    options?: EffortChangeOptions,
  ) => void | boolean | Promise<void | boolean>;
  fastMode?: boolean | 'ultrafast';
  /** 语义同 onEffortChange(含返回值口径)。 */
  onFastModeChange?: (enabled: boolean | 'ultrafast') => void | boolean | Promise<void | boolean>;
  thinkingEnabled?: boolean;
  onThinkingChange?: (enabled: boolean) => void | boolean | Promise<void | boolean>;
  modelMemory?: ModelMemoryAccessors;
  /** Request-owned preferences; edits never reach the user's saved defaults. */
  preferenceStore?: ModelPickerPreferenceStore;
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
  /** Task whose existing subscription binding should be displayed, when browsing its host. */
  subscriptionTaskId?: string;
  /**
   * 任务已经运行过(有 Agent 回复)。供应商组在任务第一次运行时选好电脑(provider-groups.md §6),
   * 之后组那一项的用量按任务实际运行的那台显示;草稿与还没运行过的任务不传。
   */
  taskStarted?: boolean;
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
    reconciledFast?: boolean | 'ultrafast',
  ) => void | boolean | Promise<void | boolean>;
  onNavigateToProviders?: (target?: ProvidersNavigationTarget) => void;
  /**
   * 可选「跟随会话」行(opt-in)。仅 scheduler 的 heartbeat(绑定会话)任务传入:
   * 在模型列表顶部加一行,选中 = model 留空(跟随绑定会话的模型 / 来源)。
   */
  followSession?: { active: boolean; label: string; onFollow: () => void | boolean | Promise<void | boolean> };
  /** 是否显示模型的 effort / Fast 编辑入口。 */
  configurationEnabled?: UnifiedModelPanelProps['configurationEnabled'];
  /** Restrict Fast to the Harnesses this entry can persist and dispatch; false disables it. */
  fastModeConfigurable?: boolean | readonly AgentKind[];
  /** A is the default for every entry. False is reserved for capabilities-only remote compatibility. */
  unifiedPanel?: boolean;
  /**
   * 统一面板的**会话内形态**(model-selector-unified §1.6,M6 面板侧)。仅在
   * `unifiedPanel` 为 true 时生效;新会话 / 草稿不传。
   *
   * 传入后默认展示全部，保留有损切换警示；选中跨引擎行时走 `onCrossEngineSelect`
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
  unifiedSelectionPolicy?: UnifiedModelPanelProps['selectionPolicy'];
  /**
   * 选择真的应用成功后,把该模型记进「最近使用」(见 state/recentModels 的语义边界)。
   * **默认关**:统一面板被对话之外的入口共用(定时任务 / IM 默认 / Bot / Hook /
   * Worker / 子代理 / 设置页),那些选择是配置动作;只有对话侧真正的两个入口
   * (ChatInput 的新任务草稿与会话内)开启,且 SSH / device-link 远程不开启。
   */
  recordRecentUsage?: boolean;
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
    fast: boolean | 'ultrafast';
    favoriteUid: string | null;
    /** 配置浮层「恢复推荐」的应用动作；调用方应删除 override，不得重新记忆推荐值。 */
    resetToRecommended?: true;
    /**
     * 只在传了 `remoteAgent` 时出现:这一行属于哪台电脑的目录(null = 本机)。与草稿
     * 当前的 Agent 所在电脑不同时,调用方要连 Agent 运行位置一起换。
     */
    agentDevice?: UnifiedSelectionAgentDevice;
  }) => void | boolean | Promise<void | boolean>;
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
  readableRows?: boolean;
  /** 语义同 ModelSelectorProps.agentSwitch(显式两步引擎切换)。 */
  agentSwitch?: {
    currentVendor: 'cc' | 'codex' | 'pi';
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
  /** The bounded catalog still on screen, if any (kept across a temporary read failure). */
  providers?: readonly unknown[];
}

/**
 * A temporary read failure (timeout, offline blip, busy link) while a bounded snapshot is still on
 * screen is not a broken source: the snapshot is within its host trust budget (an expired budget,
 * a refusal or an unsupported target report non-temporary errors and clear it) and the read is
 * retried in the background. Showing it as a failure made the task pill blink red on every blip
 * and only clear when the picker was opened (2026-11-23 field report).
 */
function isTemporaryFailureWithSnapshot(error: string | null | undefined, hasSnapshot: boolean): boolean {
  return hasSnapshot && isTemporaryCatalogFailure(error);
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
  if (required.some((state) => !!state.error
    && !isTemporaryFailureWithSnapshot(state.error, state.capabilities != null))) return 'error';
  if (providers.error && !providers.unsupported
    && !isTemporaryFailureWithSnapshot(providers.error, (providers.providers?.length ?? 0) > 0)) return 'error';
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

/** 「让插件选」生效时不点亮任何模型行(空 modelId 不匹配任何条目)。 */
const NO_MODEL_SELECTION = { providerId: null, modelId: '' } as const;

function ModelSelectorContentView({
  pluginModels,
  modelGroups: modelGroupsProp,
  readModelGroupDevices,
  pluginEngines,
  providersOverride,
  providersOverrideState,
  taskSourceProvider,
  sshCodex,
  modelId,
  effort,
  onModelChange,
  onEffortChange,
  fastMode = false,
  onFastModeChange,
  thinkingEnabled = true,
  onThinkingChange,
  modelMemory: modelMemoryProp,
  preferenceStore,
  vendorKey,
  deviceId: deviceIdProp,
  remoteAgent,
  excludeSubscriptionDirect,
  excludeChatBridgedCodex,
  onDismiss,
  actualRoute = false,
  subscriptionTaskId,
  taskStarted = false,
  maxVisibleModelRows,
  overlayContentClassName,
  currentProviderId: currentProviderIdProp,
  onProviderChange,
  onNavigateToProviders,
  followSession,
  configurationEnabled = true,
  fastModeConfigurable = true,
  unifiedPanel: useUnifiedPanel = true,
  sessionEngineFilter,
  unifiedAgents: requestedUnifiedAgents,
  unifiedSelectionPolicy = 'personalized',
  recordRecentUsage = false,
  selectedFavoriteUid = null,
  onSessionFavoriteAnchorChange,
  onUnifiedSelect: onUnifiedSelectProp,
  reselectEmitsChange = false,
  selectedRowClickOpensConfiguration = false,
  pointerRevealRequiresIntent = false,
  optionsPanelUsesLayoutPositioning = false,
  fluidWidth = false,
  readableRows = false,
  agentSwitch,
  discoveringModels = false,
  interactionDisabled = false,
  pickerOpen = true,
  gatewayPricing,
  referencePricing,
  modelAccessAccountTier,
}: ModelSelectorContentProps & {
  pickerOpen?: boolean;
  gatewayPricing: ModelPricingCatalog | null;
  referencePricing: ModelPricingCatalog | null;
  modelAccessAccountTier: ModelAccessAccountTier | null;
}) {
  const confirmDialog = useOptionalConfirmDialog();
  // 面板打开时请插件引擎刷新模型列表(或读取同账号其他电脑开放的插件引擎)，与供应商模型在同一时机自动刷新(冷却由 main 控制)。
  const hasPluginEngines = (pluginEngines?.engines.length ?? 0) > 0;
  const readCatalogue = pluginEngines?.readCatalogue
    ?? (hasPluginEngines ? requestPluginEnginesRefresh : undefined);
  useEffect(() => {
    readCatalogue?.();
  }, [readCatalogue]);
  // 当前来源解析器:已建会话 = 实际路由口径(含停用拷贝),其余 = 准入口径。
  const resolveCurrentSourceId = actualRoute ? actualSourceIdForModel : effectiveSourceIdForModel;
  const { t, i18n } = useTranslation();
  const favoritePluginModelCount = useFavoritePluginModelCount(pluginModels?.models ?? []);
  const { received: receivedShares } = useProviderShareReceived();
  // ── 远程 Agent:面板在本机目录与其他电脑的目录之间切换浏览 ─────────────────────
  // 打开时停在草稿当前的落点(Agent 在哪台电脑就先列哪台);左侧栏点到另一台电脑的供应商时,
  // 下面整套目录(能力 / 供应商 / 可见性 / 用量 / 收藏)都随 deviceId 换成那台电脑的。
  const remoteAgentDeviceId = remoteAgent?.selectedDeviceId ?? null;
  // 统一判定智能路由与合并供应商路由模式：决定初始浏览目录、跨机目录宿主以及是否保留具体成员单列。
  const routingMode = useMemo(
    () =>
      resolveModelSelectorRoutingMode({
        modelGroups: modelGroupsProp,
        hasUnifiedSelect: !!onUnifiedSelectProp,
        providersOverride: !!providersOverride,
        sshCatalog: sshCodex !== undefined,
        currentProviderId: currentProviderIdProp,
        modelId,
        remoteAgentDeviceId,
        catalogHostDeviceId: remoteAgent?.catalogHostDeviceId,
        homeDeviceId: remoteAgent?.homeDeviceId,
        deviceIdProp,
      }),
    [
      modelGroupsProp,
      onUnifiedSelectProp,
      providersOverride,
      sshCodex,
      currentProviderIdProp,
      modelId,
      remoteAgentDeviceId,
      remoteAgent?.catalogHostDeviceId,
      remoteAgent?.homeDeviceId,
      deviceIdProp,
    ],
  );
  const { activeSourceRouteAtOpen } = routingMode;
  // 面板里「当前选择」显示在哪份目录里。选着合并条目下的模型时是任务所在电脑的目录(合并后的那一格)：草稿里记的那个
  // 成员可以在别的电脑上或是分享来的，按它算的话，面板会认为当前选择不在眼前这份目录里——不显示选中的行。
  // 只管显示；引擎集合、档位记忆这些仍按草稿实际的运行位置(remoteAgentDeviceId)。
  const selectionCatalogDeviceId = activeSourceRouteAtOpen ? null : remoteAgentDeviceId;
  const preferredBrowseDeviceId = pluginEngines?.active || activeSourceRouteAtOpen ? null : remoteAgentDeviceId;
  const [remoteBrowse, setRemoteBrowse] = useState<{
    deviceId: string;
    /** null = 还不知道该落在哪个供应商格(等那台的目录到了再按当前来源 / 首个供应商定)。 */
    providerId: string | null;
  } | null>(() =>
    preferredBrowseDeviceId ? { deviceId: preferredBrowseDeviceId, providerId: currentProviderIdProp ?? null } : null,
  );
  // 落点在面板之外变了(那台电脑被解除配对而回到本机等):跟到新落点,不停在旧目录上。
  const lastPreferredBrowseDeviceIdRef = useRef(preferredBrowseDeviceId);
  useEffect(() => {
    if (lastPreferredBrowseDeviceIdRef.current === preferredBrowseDeviceId) return;
    lastPreferredBrowseDeviceIdRef.current = preferredBrowseDeviceId;
    setRemoteBrowse((current) =>
      (current?.deviceId ?? null) === preferredBrowseDeviceId
        ? current
        : preferredBrowseDeviceId
          ? { deviceId: preferredBrowseDeviceId, providerId: null }
          : null,
    );
  }, [preferredBrowseDeviceId]);
  // 没在浏览其他电脑时列任务所在电脑的目录:本机任务是本机,被控电脑上的任务是那台。
  const homeDeviceId = remoteAgent?.homeDeviceId;
  const deviceId = remoteAgent ? (remoteBrowse?.deviceId ?? homeDeviceId) : deviceIdProp;
  const catalogDeviceId = modelCatalogKey(deviceId, remoteAgent?.catalogHostDeviceId);
  /**
   * 「最近」记录没有设备字段:面板正在浏览**其他电脑**的目录时(远程 Agent 入口的模型格 /
   * device-link 被控电脑)选中不得写进本机历史 —— 两台电脑若存在同来源同模型 id,回到本机会把
   * 这条远程记录解析成本机模型,点击就用错运行位置;只在那台存在的记录也白占本机容量
   * (2026-10-08 review P1)。任务归属判不出草稿(本机草稿的 deviceLinkDeviceId 是 null),
   * 所以按**当前浏览的目录**再禁一次。
   */
  const recordRecentModelsOnSelect = recordRecentUsage && !deviceId;
  /** 正在浏览的就是草稿当前落点的目录 —— 选中态、档位记忆与引擎集合只对它成立。 */
  const browsingSelectedCatalog =
    !remoteAgent || (remoteBrowse?.deviceId ?? null) === remoteAgentDeviceId;
  /** 当前选择就显示在正在浏览的这份目录里(见 selectionCatalogDeviceId)：选中的行按它判断。 */
  const browsingSelectionCatalog =
    !remoteAgent || (remoteBrowse?.deviceId ?? null) === selectionCatalogDeviceId;
  const modelMemory = preferenceStore?.memoryForLocation
    ? preferenceStore.memoryForLocation(remoteBrowse?.deviceId ?? null)
    : !remoteAgent || browsingSelectedCatalog
      ? (preferenceStore?.memory ?? modelMemoryProp)
      : remoteBrowse
        ? remoteAgent.deviceModelMemory?.(remoteBrowse.deviceId)
        : remoteAgent.localModelMemory;
  // 列表底部「配置模型」:本机目录照旧;分享来的供应商在本机设置里有详情页(provider-sharing.md §5.2),
  // 带上分享直达那一条。被控电脑与自己其他电脑上的目录要到那台电脑上改,不显示。
  const browsingShareId =
    remoteAgent && !homeDeviceId ? providerShareIdOfAgentDeviceId(deviceId) : null;
  const showProvidersEntry = !!onNavigateToProviders && (!deviceId || browsingShareId !== null);
  const navigateToProviders = () =>
    onNavigateToProviders?.(browsingShareId ? { shareId: browsingShareId } : undefined);
  // 列表样式试用开关(本机偏好):footer 的切换按钮 + 面板行样式共用。
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
  const handleBrowseVendorChange = (next: 'cc' | 'codex' | 'pi') => {
    if (!interactionDisabled) setBrowseVendor(next);
  };
  // 会话引擎在外部变化(切换完成 / 换会话)时重置浏览态,跟随新的当前引擎。
  useEffect(() => {
    if (agentSwitch) setBrowseVendor(agentSwitch.currentVendor);
  }, [agentSwitch?.currentVendor]);
  const browsing = !!agentSwitch && browseVendor !== agentSwitch.currentVendor;
  const agentKind = agentSwitch
    ? vendorKeyToAgentKind(browseVendor)
    : vendorKeyToAgentKind(vendorKey);
  // A field that only persists a model must not offer another Harness.
  // 调用方给的引擎集合是**草稿当前落点**那台电脑上已注册的;浏览另一台时不套用(fail-open)。
  const unifiedAgents = (browsingSelectedCatalog ? requestedUnifiedAgents : undefined) ??
    (vendorKey && agentKind && !onUnifiedSelectProp && !sessionEngineFilter ? [agentKind] : undefined);
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
  const cc = useAgentCapabilities('claude-code', catalogDeviceId);
  const codex = useAgentCapabilities('codex', catalogDeviceId);
  const pi = useAgentCapabilities('pi', catalogDeviceId);
  // 本机折扣 GPT 仍按本机 API key gate；device-link 必须只看被控端 provider 状态。
  // 旧被控端不支持 provider:list 时按远端 capabilities 退化，不得误用控制端 key。
  const { hasSavedKey, canReadKey } = useApiKey();
  // 供应商来源:本机会话用本机 useProviders;device-link 远程会话用**被控端**供应商目录
  // (useDeviceProviders,隧道 maker:provider:list)。两 hook 都无条件调用(hooks 规则),按 deviceId 取。
  const localProviders = useProviders();
  const remoteProviders = useDeviceProviders(catalogDeviceId);
  // 任务所在电脑那一格:本机任务用本机目录与可见性偏好;被控电脑上的任务用被控电脑的目录与它的
  // 可见性快照(顺序沿用被控端快照,不套本机排序,同远程控制)。
  const homeDeviceProviders = useDeviceProviders(homeDeviceId);
  const remoteDisable = useRemoteProviderDisable();
  // 远程 Agent 只能用那台电脑「允许被远程调用」的供应商(远程控制照常列全部,被控电脑上的任务
  // 浏览被控电脑自己的目录时也一样)。
  const remoteAgentBrowsing = remoteAgent !== undefined && remoteBrowse !== null;
  const remoteCatalogProviders = useMemo(
    () =>
      remoteAgentBrowsing
        ? remoteAgentProviders(remoteProviders.providers).filter(provider =>
          !catalogDeviceId || !remoteDisable.isDisabled(catalogDeviceId, provider.id)
            || (remoteAgentDeviceId === catalogDeviceId && currentProviderIdProp === provider.id))
        : remoteProviders.providers.map(withEffectiveModelContextWindows),
    [remoteAgentBrowsing, remoteProviders.providers, catalogDeviceId, remoteDisable, remoteAgentDeviceId, currentProviderIdProp],
  );
  const sshCodexProviders = sshCodex?.providers;
  const sshCatalogProviders = useMemo(
    () => (sshCodexProviders ? mergeSshCodexCatalog(localProviders.providers, sshCodexProviders) : null),
    [localProviders.providers, sshCodexProviders],
  );
  const localTaskProviders = useMemo(
    () => withFollowedAccountSource(localProviders.providers.map(withSubscriptionDisplayModels), taskSourceProvider ?? null),
    [localProviders.providers, taskSourceProvider],
  );
  const listedProviders = deviceId
    ? remoteCatalogProviders
    : providersOverride ?? sshCatalogProviders ?? localTaskProviders;
  const rawHomeSourceRouteConfig = routingMode.homeSourceRouteConfig;
  const [autoPrioritySnapshot, setAutoPrioritySnapshot] = useState(() => ({
    open: pickerOpen, priorities: rawHomeSourceRouteConfig?.autoModelPriorities,
  }));
  // MorphPopover can stay mounted through a close/reopen. Freeze even an empty
  // snapshot for the entire opening, and capture fresh priorities on the next one.
  if (autoPrioritySnapshot.open !== pickerOpen) {
    setAutoPrioritySnapshot({
      open: pickerOpen,
      priorities: pickerOpen ? rawHomeSourceRouteConfig?.autoModelPriorities : autoPrioritySnapshot.priorities,
    });
  }
  const missingLocalAutoPriorities = pickerOpen && !homeDeviceId && !remoteAgent?.catalogHostDeviceId && !deviceIdProp
    && !rawHomeSourceRouteConfig?.autoModelPriorities
    && rawHomeSourceRouteConfig?.sourceRoutes?.some((route) => route.strategy === 'expiring' && !route.hidden);
  useEffect(() => {
    if (missingLocalAutoPriorities) void refreshModelGroups();
  }, [missingLocalAutoPriorities]);
  const frozenAutoPriorities = autoPrioritySnapshot.priorities;
  const homeSourceRouteConfig = useMemo(() => {
    if (!rawHomeSourceRouteConfig || frozenAutoPriorities === rawHomeSourceRouteConfig.autoModelPriorities) {
      return rawHomeSourceRouteConfig;
    }
    return { ...rawHomeSourceRouteConfig, autoModelPriorities: frozenAutoPriorities };
  }, [rawHomeSourceRouteConfig, frozenAutoPriorities]);
  const homeBaseProviders = homeDeviceId ? homeDeviceProviders.providers : localProviders.providers;
  useEffect(() => {
    readModelGroupDevices?.();
  }, [readModelGroupDevices]);
  const smartRouting = useModelSelectorSmartRouting({
    modelGroupsProp,
    routingMode: homeSourceRouteConfig === rawHomeSourceRouteConfig
      ? routingMode
      : { ...routingMode, homeSourceRouteConfig },
    onUnifiedSelectProp,
    currentProviderIdProp,
    modelId,
    remoteAgent,
    remoteBrowseActive: remoteBrowse !== null,
    listedProviders,
    homeBaseProviders,
    pluginEngines,
    t,
  });
  const {
    mergedSourceRoutesEnabled,
    effectiveModelGroupsActive,
    sourceRoutes,
    homeSourceRoutes,
    currentProviderId,
    shownModelId,
    activeSourceRoute,
    effectivePluginEngines,
    resolveStoredProviderAlias,
    resolveStoredIdentity,
    onUnifiedSelect,
    checkSourceRouteVisibility,
    tryPickMergedBuiltIn,
    wrapSessionEngineFilter,
  } = smartRouting;
  const providers = sourceRoutes.providers;
  // SSH 目录里 Codex 来自远端主机：本机账号用量、本机供应商组都不能代表它。
  const sshCodexActive = sshCodex !== undefined;
  const mixedCatalog = !!providersOverride || sshCodexActive;
  // 订阅用量跟随目录归属:本机目录读本机账号,远程目录读被控端镜像(与会话用量 chip 共用缓存);
  // 外部注入的目录(providersOverride)与 SSH 混合目录归属不明,不显示任何账号用量。
  const providerUsageScope = useMemo<ProviderUsageScope | null>(
    () => !deviceId && mixedCatalog ? null : ({ deviceId: deviceId ?? null,
      taskId: (!remoteAgent || !remoteBrowse) ? subscriptionTaskId : undefined }),
    [deviceId, mixedCatalog, subscriptionTaskId, remoteAgent, remoteBrowse],
  );
  // Old device-link hosts expose capabilities only. Never substitute local routes.
  const unifiedPanel = useUnifiedPanel && (configurationEnabled === 'harness' || !(deviceId && remoteProviders.unsupported));
  const providersLoading = deviceId ? remoteProviders.loading : !providersOverride && localProviders.loading;
  const remoteModelListStatus = resolveRemoteModelListStatus({
    deviceId,
    agentKind,
    cc,
    codex,
    pi,
    providers: remoteProviders,
  });
  // 分享来的供应商：分享者电脑上的 Cindy 太旧，只答得了模型目录、答不了 Agent 能力
  // (新版受邀者才会读它)。如实说要对方更新，不报笼统的「读取失败」。
  const remoteFailureMessage =
    isProviderShareAgentDeviceId(deviceId) &&
    [cc.error, codex.error, pi.error].some(
      (error) =>
        error != null &&
        extractIpcError(new Error(error))?.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED',
    )
      ? t('providerShare.picker.hostOutdated')
      : undefined;
  const retryRemoteModels = useCallback(() => {
    if (!catalogDeviceId) return;
    if (isProviderShareAgentDeviceId(deviceId)) {
      void retryProviderShareCatalog(catalogDeviceId).catch(() => undefined);
      return;
    }
    evictDeviceCapabilities(catalogDeviceId);
    evictDeviceProviders(catalogDeviceId);
    void Promise.allSettled([
      prefetchDeviceCapabilities(catalogDeviceId),
      prefetchDeviceProviders(catalogDeviceId),
    ]);
  }, [catalogDeviceId, deviceId]);

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
  // deviceLinkModelMirror),不经本组件的 editTick。订阅三份 store 的版本号,任一变化即重渲染、
  // 重算行 effort/fast 显示(本机用 providerModelMemory,远程控制用被控端镜像,远程 Agent 用
  // agentDeviceModelMemory)。
  const storeVersion =
    editTick +
    useProviderModelMemoryVersion() +
    useDeviceLinkModelMirrorVersion() +
    useAgentDeviceModelMemoryVersion();
  void storeVersion;

  const listRef = useRef<HTMLDivElement | null>(null);
  // Classic list and options panel: one glide highlight each, following the pointer, the
  // keyboard-focused row or the row whose options are open (MorphPopover owns the width).
  const highlightOptions = {
    current: (rows: readonly HTMLElement[]) =>
      currentFocusedRow(rows) ?? rows.find((r) => r.getAttribute('data-state') === 'open'),
  };
  const legacyListHighlightRef = useMenuPanel(listRef, { lockWidth: false, options: highlightOptions });
  const configHighlightRef = useMenuPanel<HTMLDivElement>(undefined, {
    lockWidth: false,
    options: { current: currentFocusedRow },
  });
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
    ): boolean => {
      // SSH 的 Codex 行是远端 model/list 已筛过的可选清单，本机可见性偏好不适用。
      if (providersOverride || (sshCodexActive && agent === 'codex')) return true;
      const checkHost = (memberProviderId: string, memberModel: { id: string; defaultEnabled?: boolean }, memberAgent: AgentKind) =>
        deviceId
          ? isDeviceModelVisible(remoteProviders.modelVisibilityOverrides, memberAgent, memberProviderId, memberModel)
          : isModelEnabled(memberAgent, memberProviderId, memberModel);
      const mergedVisible = checkSourceRouteVisibility(providerId, model, agent, checkHost, 'active');
      if (mergedVisible !== null) return mergedVisible;
      return checkHost(providerId, model, agent);
    },
    // biome-ignore lint/correctness/useExhaustiveDependencies: visibilityVersion 是本机可见性偏好的外部刷新信号(值本身不进判定)。
    [providersOverride, sshCodexActive, deviceId, remoteProviders.modelVisibilityOverrides, visibilityVersion, checkSourceRouteVisibility],
  );
  const unifiedExcludeProvider = useMemo(
    () =>
      excludeChatBridgedCodex
        ? (provider: ProviderView, agent: AgentKind): boolean =>
            isLocalOnlyProviderForAgent(provider, agent)
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

  // ── 远程 Agent 的左侧栏数据 ──────────────────────────────────────────────────
  // 栏位要同时列出本机与各台电脑的供应商,而列表此刻只装着其中一份目录:本机格与远程格
  // 各自按**自己的**目录与可见性派生,不借用正在浏览的那一份。
  const remoteAgentDevices = remoteAgent?.devices;
  const routedFavoriteSources = useMemo(() => remoteAgent?.catalogHostDeviceId
    ? new Map((remoteAgentDevices ?? []).flatMap(device => device.favoriteSource
      ? [[device.deviceId, device.favoriteSource] as const] : []))
    : undefined, [remoteAgentDevices, remoteAgent?.catalogHostDeviceId]);
  const remoteAgentDeviceIds = useMemo(
    () => (remoteAgentDevices ?? []).map((device) => device.deviceId),
    [remoteAgentDevices],
  );
  const remoteCatalogKeys = useMemo(
    () => remoteAgentDeviceIds.map(id => modelCatalogKey(id, remoteAgent?.catalogHostDeviceId)!),
    [remoteAgentDeviceIds, remoteAgent?.catalogHostDeviceId],
  );
  // Keep each computer's rows while its catalog refreshes (and through a temporary read failure), as
  // the single-device catalog already does; disconnects, refusals and expiry still clear them.
  const scopedCatalogs = useDevicesProviders(remoteCatalogKeys, { retainDisplaySnapshot: true });
  const remoteDeviceCatalogs = useMemo(() => new Map(remoteAgentDeviceIds.map((id, index) =>
    [id, scopedCatalogs.get(remoteCatalogKeys[index])!] as const)), [remoteAgentDeviceIds, remoteCatalogKeys, scopedCatalogs]);
  const localProviderGroups = useLocalProviderGroups();
  // 供应商组(provider-groups.md §10)：组里的电脑与分享收起，只列组那一项。组可以在其他电脑上
  // (看它们目录里的组摘要)，也可以是任务所在电脑自己建的(本机任务读本机设置，被控电脑上的任务看那台的
  // 目录)。任务此刻正在组员上运行也照样收起，显示在组那一项下(2026-10-11 用户要求：组里的都聚合成一项)。
  const remoteProviderGroups = useMemo(
    () => collectRemoteProviderGroups(
      [
        ...(remoteAgentDevices ?? []).flatMap((device) => {
          const catalog = remoteDeviceCatalogs.get(device.deviceId);
          return catalog ? [{ deviceId: device.deviceId, providers: catalog.providers }] : [];
        }),
        ...(homeDeviceId ? [{ deviceId: homeDeviceId, providers: homeDeviceProviders.providers }] : []),
      ],
      homeDeviceId ? {} : localProviderGroups,
    ),
    [remoteAgentDevices, remoteDeviceCatalogs, homeDeviceId, homeDeviceProviders.providers, localProviderGroups],
  );
  // 组那一项在面板里的位置：任务所在电脑自己的供应商(被控电脑上的任务即被控电脑的)在本机那一栏，记为 null。
  const groupEntryAt = useCallback(
    (entry: RemoteProviderGroupEntry | undefined | null): RemoteProviderGroupEntry | null =>
      entry ? (entry.deviceId === homeDeviceId ? { deviceId: null, providerId: entry.providerId } : entry) : null,
    [homeDeviceId],
  );
  // 这个任务此刻归哪个组(面板每次打开读一次，位置或来源变了再读)。
  const readProviderGroup = remoteAgent?.readProviderGroup;
  const [boundGroup, setBoundGroup] = useState<RemoteProviderGroupEntry | null>(null);
  useEffect(() => {
    if (!readProviderGroup) {
      setBoundGroup(null);
      return;
    }
    let cancelled = false;
    readProviderGroup().then(
      (entry) => !cancelled && setBoundGroup(entry),
      () => !cancelled && setBoundGroup(null),
    );
    return () => {
      cancelled = true;
    };
  }, [readProviderGroup, remoteAgentDeviceId, currentProviderId]);
  // 归的组那一项此刻在列表里(组所在电脑在线、组还在)才按组显示；不然照常列出任务实际所在的那台。
  // 任务所在电脑自己建的组：本机任务看本机设置，被控电脑上的任务看那台目录里的组摘要。
  const boundEntry = useMemo(() => {
    if (!boundGroup) return null;
    const visible = boundGroup.deviceId === null
      ? homeDeviceId
        ? remoteProviderGroups.groups.has(remoteProviderEntryKey(homeDeviceId, boundGroup.providerId))
        : localProviderGroups[boundGroup.providerId] !== undefined
      : remoteProviderGroups.groups.has(remoteProviderEntryKey(boundGroup.deviceId, boundGroup.providerId));
    return visible ? boundGroup : null;
  }, [boundGroup, homeDeviceId, localProviderGroups, remoteProviderGroups]);
  /**
   * 任务归组、此刻却不在组那一项本身上运行(被组分到或换到了组里另一台)：在组那一项里选模型 = 留在那台只换
   * 模型，组那一项显示为正在用的(§10)。
   */
  const stayInGroup =
    boundEntry !== null &&
    !(boundEntry.deviceId === remoteAgentDeviceId && boundEntry.providerId === currentProviderId);
  // 面板不停在收起的组员上：任务正跑在组员上时打开即停在组那一项(没归组的任务只是这样显示，选它照旧是
  // 把 Agent 挪过去)；归组的任务即使就在这台运行，第一次打开也先停在组那一项。用户自己点过别的格之后不再挪。
  const [remoteBrowseTouched, setRemoteBrowseTouched] = useState(false);
  const [groupBrowseShown, setGroupBrowseShown] = useState<string | null>(null);
  const browseHiddenEntry = remoteBrowse
    ? groupEntryAt(remoteProviderGroups.memberOf.get(remoteProviderEntryKey(
        remoteBrowse.deviceId,
        remoteBrowse.providerId ?? (remoteBrowse.deviceId === remoteAgentDeviceId ? (currentProviderId ?? '') : ''),
      )))
    : null;
  const boundEntryKey = boundEntry ? remoteProviderEntryKey(boundEntry.deviceId ?? '', boundEntry.providerId) : null;
  const groupBrowseTarget =
    browseHiddenEntry ??
    (stayInGroup && !remoteBrowseTouched && groupBrowseShown !== boundEntryKey ? boundEntry : null);
  if (groupBrowseTarget) {
    if (boundEntryKey !== null && groupBrowseShown !== boundEntryKey) setGroupBrowseShown(boundEntryKey);
    setRemoteBrowse(
      groupBrowseTarget.deviceId
        ? { deviceId: groupBrowseTarget.deviceId, providerId: groupBrowseTarget.providerId }
        : null,
    );
  }
  /** 正在浏览归的组那一项所在的目录：那一项里的模型显示为正在用的，选中时留在此刻运行的那台。 */
  const browsingBoundGroupEntry =
    stayInGroup && boundEntry !== null && (remoteBrowse?.deviceId ?? null) === boundEntry.deviceId;
  /**
   * 同一个来源只列一次：与设置页、手机选择器用同一条规则（listedSourceFolds）。以任务所在电脑为基准
   * （本机任务是本机，被控电脑上的任务是那台）；其他电脑上的同一来源收进基准那一项，或按「运行于」
   * 列在那台电脑；供应商组、不同账号、模型更多的来源各自保留；当前任务正在用的那一项始终保留。
   */
  const runLocationFold = useMemo(() => {
    const hiddenRemote = new Set<string>();
    const hiddenLocal = new Set<string>();
    // Never use the viewer's catalog or provider groups for a task on another computer.
    // Without location choices ChatInput supplies only deviceId, not remoteAgent.
    const taskDeviceId = homeDeviceId ?? (!remoteAgent ? deviceId : undefined);
    const taskProviders = taskDeviceId ? (homeDeviceId ? homeDeviceProviders : remoteProviders).providers : localProviders.providers;
    const others = (remoteAgentDevices ?? []).flatMap((device) => {
      if (isProviderShareAgentDeviceId(device.deviceId) || device.deviceId === taskDeviceId) return [];
      const providers = remoteAgentProviders(remoteDeviceCatalogs.get(device.deviceId)?.providers ?? []);
      for (const provider of providers) {
        if (remoteDisable.isDisabled(device.deviceId, provider.id)
          && !(remoteAgentDeviceId === device.deviceId && currentProviderId === provider.id))
          hiddenRemote.add(remoteProviderEntryKey(device.deviceId, provider.id));
      }
      return [{ deviceId: device.deviceId, providers: providers.filter(provider =>
        !remoteProviderGroups.hidden.has(remoteProviderEntryKey(device.deviceId, provider.id))
        && !hiddenRemote.has(remoteProviderEntryKey(device.deviceId, provider.id))) }];
    });
    const folds = listedSourceFolds({
      base: taskProviders,
      baseExempt: (providerId) => taskDeviceId
        ? remoteProviderGroups.groups.has(remoteProviderEntryKey(taskDeviceId, providerId))
        : !!localProviderGroups[providerId],
      others,
      current: currentProviderIdProp ? { deviceId: remoteAgentDeviceId, providerId: currentProviderIdProp } : null,
      honorRunLocation: true,
    });
    for (const id of folds.hiddenBase) hiddenLocal.add(id);
    for (const [otherDeviceId, ids] of folds.hiddenOther)
      for (const id of ids) hiddenRemote.add(remoteProviderEntryKey(otherDeviceId, id));
    const unavailableReasons = new Map<string, string>();
    const homeName = taskDeviceId ? deviceDisplayName(taskDeviceId, remoteAgent?.homeDeviceName) : null;
    for (const [key, baseProviderId] of folds.askBeforeUse) {
      const split = key.indexOf('\n');
      const baseProvider = taskProviders.find((provider) => provider.id === baseProviderId);
      const provider = baseProvider ? providerDisplayName(baseProvider, t) : baseProviderId;
      const reason = homeName
        ? t('newChat.modelSelector.discoveredCopy.unavailableOn', { device: homeName, provider })
        : t('newChat.modelSelector.discoveredCopy.unavailableHere', { provider });
      unavailableReasons.set(remoteProviderEntryKey(key.slice(0, split), key.slice(split + 1)), reason);
    }
    return { hiddenRemote, hiddenLocal, unavailableReasons };
  }, [remoteAgent, deviceId, remoteProviders.providers, remoteAgentDevices, homeDeviceId, homeDeviceProviders.providers,
    localProviders.providers, localProviderGroups, remoteDeviceCatalogs,
    remoteAgentDeviceId, currentProviderIdProp, remoteDisable, remoteProviderGroups.hidden, remoteProviderGroups.groups, t]);
  const remoteAgentGroups = useMemo(() => {
    if (!remoteAgentDevices) return [];
    // A share always has exactly one provider: key its rail cell by it whatever the catalog state
    // (loading, failed, offline), so the cell is not remounted while the user is clicking it.
    const shareProviderIdOf = (deviceId: string) =>
      receivedShares.find((share) => providerShareAgentDeviceId(share.shareId) === deviceId)?.providerId ?? '';
    return remoteAgentDevices.flatMap((device) => {
      const catalog = remoteDeviceCatalogs.get(device.deviceId);
      // 只列那台电脑开了「允许被远程调用」的供应商；一个都没开的电脑整段不出现。
      const shared = catalog
        ? remoteAgentProviders(catalog.providers).filter(
          (provider) => !remoteProviderGroups.hidden.has(remoteProviderEntryKey(device.deviceId, provider.id))
            && (!remoteDisable.isDisabled(device.deviceId, provider.id)
              || (remoteAgentDeviceId === device.deviceId && currentProviderIdProp === provider.id)),
        )
        : [];
      // A known share must remain browsable while its first catalog is loading or
      // failed, so the existing status/retry panel is reachable without cached models.
      if (shared.length === 0 && isProviderShareAgentDeviceId(device.deviceId)
        && (!catalog || catalog.loading || catalog.error)) {
        return [{ deviceId: device.deviceId, providers: [], providerIds: [shareProviderIdOf(device.deviceId)], entries: [] }];
      }
      if (!catalog || shared.length === 0) return [];
      const entries = unifiedModelEntries({
        providers: shared,
        isVisible: (providerId, model, agent) =>
          isDeviceModelVisible(catalog.modelVisibilityOverrides, agent, providerId, model),
        includePaymentRequired: true,
        // 这份 entries 同时是那台电脑上收藏的解析目录(UnifiedModelPanel.resolveDeviceFavorite):
        // 那台电脑自己隐藏的供应商不能从这里剔掉,否则它名下的收藏会直接消失。左栏另行收起。
        includeHiddenProviders: true,
        scope: 'draft',
      });
      // 「运行于」收起的供应商只是不占左栏；那台电脑上的收藏仍按完整目录解析，不因收起消失。
      // 被隐藏的供应商同理(那台电脑自己隐藏的,或用户在本机设置里对它隐藏的):不占左栏,
      // 收藏与正在用的那一项照常解析。
      const hiddenThere = new Set(shared.filter((provider) => provider.hidden === true).map((provider) => provider.id));
      const providerIds = [...new Set(entries.map((entry) => entry.providerId))].filter(
        (providerId) =>
          !runLocationFold.hiddenRemote.has(remoteProviderEntryKey(device.deviceId, providerId)) &&
          // 已经并进某条供应商路由的成员不再单列一格。
          !homeSourceRoutes.hidesRemote(device.deviceId, providerId) &&
          ((!hiddenThere.has(providerId) && !remoteDisable.isHidden(device.deviceId, providerId)) ||
            (remoteAgentDeviceId === device.deviceId && currentProviderIdProp === providerId)),
      );
      if (entries.length > 0) return [{ deviceId: device.deviceId, providers: shared, providerIds, entries }];
      // A received share whose provider is listed but has no usable models right now (its owner
      // computer went offline, so the provider reads as disconnected) stays in the rail like a
      // loading or failed share, so it does not vanish and reappear with the owner's presence
      // (2026-11-23 用户裁决「保留并标注」). The empty panel shows the existing status note.
      // Same rail rule as above: a share the owner or the user hid, or one folded by run location,
      // stays out of the rail unless the task is using it.
      if (isProviderShareAgentDeviceId(device.deviceId) && shared.length > 0) {
        const listed = shared.map((provider) => provider.id).filter((providerId) =>
          !runLocationFold.hiddenRemote.has(remoteProviderEntryKey(device.deviceId, providerId))
          && !homeSourceRoutes.hidesRemote(device.deviceId, providerId)
          && ((!hiddenThere.has(providerId) && !remoteDisable.isHidden(device.deviceId, providerId))
            || (remoteAgentDeviceId === device.deviceId && currentProviderIdProp === providerId)));
        if (listed.length > 0) return [{ deviceId: device.deviceId, providers: shared, providerIds: listed, entries: [] }];
      }
      return [];
    });
  }, [remoteAgentDevices, remoteDeviceCatalogs, remoteProviderGroups, runLocationFold, remoteDisable, remoteAgentDeviceId, currentProviderIdProp,
    receivedShares, homeSourceRoutes]);
  // 面板展开后，凡是左栏已经拿到可选模型的远程/共享来源，立刻在后台预取其 capabilities，
  // 避免用户点击该来源图标时再经历第二段「加载远程模型…」转圈。
  const warmCapabilityKeysKey = useMemo(
    () => remoteAgentGroups
      .filter((group) => group.entries.length > 0)
      .map((group) => modelCatalogKey(group.deviceId, remoteAgent?.catalogHostDeviceId))
      .filter((key): key is string => !!key)
      .join('\n'),
    [remoteAgentGroups, remoteAgent?.catalogHostDeviceId],
  );
  useEffect(() => {
    if (!warmCapabilityKeysKey) return;
    for (const key of warmCapabilityKeysKey.split('\n')) {
      void prefetchDeviceCapabilities(key);
    }
  }, [warmCapabilityKeysKey]);
  // 其他电脑的模式只在那台电脑已列在「其他电脑」那一段时出现，且剥离其展开供应商路由与不可远程调用的路由
  // (model-groups.md §3.1、§6.3)。
  const deviceModelGroupChoices = useMemo(
    () =>
      resolveModelSelectorDeviceGroups({
        devices: modelGroupsProp?.devices,
        remoteAgentGroups,
        pluginEngines: pluginEngines?.engines,
        active: effectiveModelGroupsActive,
      }),
    [modelGroupsProp?.devices, remoteAgentGroups, pluginEngines?.engines, effectiveModelGroupsActive],
  );
  const modelGroups = useMemo(
    () =>
      buildPanelModelGroups({
        modelGroups: modelGroupsProp,
        mergedSourceRoutesEnabled,
        devices: deviceModelGroupChoices,
      }),
    [modelGroupsProp, mergedSourceRoutesEnabled, deviceModelGroupChoices],
  );
  const modelGroupRows = useModelGroupPickerRows(modelGroups?.config ?? MODEL_GROUPS_DEFAULTS);
  const favoriteModelGroupCount = useFavoriteModelGroupCount(modelGroups?.config ?? MODEL_GROUPS_DEFAULTS);
  // 目录还在读或读取失败的其他电脑(分享不算):收藏区里它们的收藏置灰列出,不当作模型已下架。
  const remoteAgentUnavailableDeviceIds = useMemo(
    () =>
      (remoteAgentDevices ?? []).flatMap((device) => {
        if (isProviderShareAgentDeviceId(device.deviceId)) return [];
        const catalog = remoteDeviceCatalogs.get(device.deviceId);
        return !catalog || catalog.loading || catalog.error ? [device.deviceId] : [];
      }),
    [remoteAgentDevices, remoteDeviceCatalogs],
  );
  const hasRemoteAgent = remoteAgent !== undefined;
  const homeProviders = homeSourceRoutes.providers;
  const homeModelVisibilityOverrides = homeDeviceProviders.modelVisibilityOverrides;
  const remoteAgentLocalRailItems = useMemo(() => {
    if (!hasRemoteAgent) return undefined;
    void visibilityVersion;
    const checkHost = homeDeviceId
      ? (providerId: string, model: { id: string; defaultEnabled?: boolean }, agent: AgentKind) =>
          isDeviceModelVisible(homeModelVisibilityOverrides, agent, providerId, model)
      : (providerId: string, model: { id: string; defaultEnabled?: boolean }, agent: AgentKind) =>
          isModelEnabled(agent, providerId, model);
    const entries = unifiedModelEntries({
      providers: homeProviders.filter((provider) => !runLocationFold.hiddenLocal.has(provider.id)),
      isVisible: (providerId, model, agent) =>
        checkSourceRouteVisibility(providerId, model, agent, checkHost, 'home') ?? checkHost(providerId, model, agent),
      includePaymentRequired: true,
      scope: 'draft',
    });
    return buildUnifiedRail(entries, undefined, homeDeviceId ? undefined : localProviders.providerOrder);
  }, [
    hasRemoteAgent,
    homeDeviceId,
    homeProviders,
    homeModelVisibilityOverrides,
    localProviders.providerOrder,
    visibilityVersion,
    runLocationFold,
    checkSourceRouteVisibility,
  ]);
  // 供应商组在分组标题与左栏提示里带上台数(provider-groups.md §10)：「Anthropic · 供应商组 · 2 台电脑」。
  // 只算任务所在电脑就是本机时本机建的组；被控电脑上的任务看那台的目录，不在这里标。远程 Agent 面板正在浏览
  // 另一台电脑的目录时，左栏本机那几格仍是本机的供应商，照样带台数。
  const localGroupsApply = (remoteAgent ? true : !deviceId) && !homeDeviceId && !mixedCatalog;
  const withLocalGroupSize = useCallback(
    (providerId: string, label: string): string => {
      const config = localGroupsApply ? localProviderGroups[providerId] : undefined;
      return config
        ? t('newChat.modelSelector.unified.providerGroupLabel', {
          provider: label,
          group: t('settings.providers.remote.groupBadge', { count: providerGroupDeviceCount(config.members) }),
        })
        : label;
    },
    [localGroupsApply, localProviderGroups, t],
  );
  const remoteAgentLocalLabel = useCallback(
    (providerId: string): string => {
      const provider = homeProviders.find((entry) => entry.id === providerId);
      return withLocalGroupSize(providerId, provider ? providerDisplayName(provider, t) : providerId);
    },
    [homeProviders, t, withLocalGroupSize],
  );
  const remoteAgentLabelOf = useCallback(
    (targetDeviceId: string, providerId: string): string => {
      const device = remoteAgentDevices?.find((entry) => entry.deviceId === targetDeviceId);
      if (!providerId) return deviceDisplayName(targetDeviceId, device?.name);
      const provider = remoteAgentGroups
        .find((group) => group.deviceId === targetDeviceId)
        ?.providers.find((entry) => entry.id === providerId);
      // 组只写有几台，不写是哪几台(2026-10-10 用户要求)；分享来的组目录里本来就只有台数。
      // 台数按电脑算：一台电脑上的几个账号算一台。
      const groupMembers = remoteProviderGroups.groups.get(remoteProviderEntryKey(targetDeviceId, providerId))?.members;
      const groupSize = groupMembers ? providerGroupDeviceCount(groupMembers) : readProviderShareGroupSize(provider);
      const values = {
        provider: provider ? providerDisplayName(provider, t) : providerId,
        device: deviceDisplayName(targetDeviceId, device?.name),
      };
      return groupSize != null
        ? t('newChat.modelSelector.unified.railRemoteProviderGroup', {
          ...values,
          group: t('settings.providers.remote.groupBadge', { count: groupSize }),
        })
        : t('newChat.modelSelector.unified.railRemoteProvider', values);
    },
    [remoteAgentDevices, remoteAgentGroups, remoteProviderGroups, t],
  );
  // 供应商组那一项的用量跟着任务实际运行的那台(provider-groups.md §10)：组分好电脑后任务记录改成那台的
  // 位置与供应商，与输入框下方的用量同一份；还没分到电脑(草稿、没运行过、用的不是这个组)时不显示某一台
  // 的配额，免得把组所在电脑一台的余量看成整个组的。
  const selfDeviceId = remoteAgent?.selfDeviceId ?? null;
  const providerGroupUsage = useCallback<ProviderGroupUsageOf>(
    (directoryDeviceId, providerId) => {
      if (mixedCatalog) return null;
      let config: ProviderGroupConfig | undefined;
      if (directoryDeviceId !== null) {
        config = remoteProviderGroups.groups.get(remoteProviderEntryKey(directoryDeviceId, providerId));
      } else if (homeDeviceId) {
        config = remoteProviderGroups.groups.get(remoteProviderEntryKey(homeDeviceId, providerId));
      } else if (remoteAgent || !deviceIdProp) {
        config = localProviderGroups[providerId];
      }
      if (!config) return null;
      if (!taskStarted || !currentProviderId) return { kind: 'unassigned' };
      // 读到了任务归哪个组时只认那个组：同一台电脑可能同时在几个组里。
      if (boundEntry && !(boundEntry.deviceId === directoryDeviceId && boundEntry.providerId === providerId)) {
        return { kind: 'unassigned' };
      }
      const member = providerGroupMemberOfRoute(
        config,
        directoryDeviceId,
        { agentDeviceId: remoteAgentDeviceId, providerId: currentProviderId },
        homeDeviceId ?? selfDeviceId,
      );
      if (!member) return { kind: 'unassigned' };
      const location = member.agentDeviceId;
      if (location === null) {
        const provider = (homeDeviceId ? homeDeviceProviders.providers : localProviders.providers).find(
          (entry) => entry.id === member.providerId,
        );
        return {
          kind: 'running',
          deviceName: homeDeviceId ? deviceDisplayName(homeDeviceId, remoteAgent?.homeDeviceName) : null,
          usage: provider ? { provider, scope: { deviceId: homeDeviceId ?? null } } : null,
        };
      }
      const deviceName =
        remoteAgentDevices?.find((device) => device.deviceId === location)?.name || location;
      // 别人分享的电脑：分享者的配额不对受邀者开放(模型列表里那一项本来也不显示)。
      if (isProviderShareAgentDeviceId(location)) return { kind: 'running', deviceName, usage: null };
      const provider = remoteDeviceCatalogs
        .get(location)
        ?.providers.find((entry) => entry.id === member.providerId);
      return {
        kind: 'running',
        deviceName,
        usage: provider ? { provider, scope: { deviceId: location } } : null,
      };
    },
    [
      mixedCatalog,
      remoteProviderGroups,
      homeDeviceId,
      remoteAgent,
      deviceIdProp,
      localProviderGroups,
      taskStarted,
      currentProviderId,
      boundEntry,
      remoteAgentDeviceId,
      selfDeviceId,
      homeDeviceProviders.providers,
      localProviders.providers,
      remoteAgentDevices,
      remoteDeviceCatalogs,
    ],
  );

  // 官方默认推荐 → 一次性**种子收藏**(Chris 2026-08-16 裁决,替代列表里的「默认」
  // 小节):服务端目录用 `newSessionDefault` 标记推荐模型(gateway 下发),首个命中
  // 项以收藏形态投放。只投一次、取消不复种、已有收藏的用户不打扰 —— 这三条都由
  // seedDefaultFavorite 内部保证,这里重复跑只是 no-op。device-link 远程视图不投:
  // 标记来自被控端目录,控制端的本机收藏不该被它污染。
  useEffect(() => {
    if (!unifiedPanel || deviceId || mixedCatalog || unifiedSelectionPolicy === 'official') return;
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
      // 避免把虚拟的 sroute: 条目落进本机种子收藏：还原成真实本机成员身份。
      const stored = resolveStoredIdentity(entry.providerId, entry.modelId);
      if (isSourceRouteProviderId(entry.providerId) && !stored) continue;
      seedDefaultFavorite({
        providerId: stored?.providerId ?? entry.providerId,
        modelId: stored?.modelId ?? entry.modelId,
        agent: markedAgent === 'claude-code' ? 'cc' : markedAgent === 'codex' ? 'codex' : 'pi',
      });
      break;
    }
    // 一行都没命中 → **什么都不做**(不落 seeded):目录还没到 / 这一版没下发推荐时落
    // 标记,等于把这一版的官方推荐永久作废。
    // biome-ignore lint/correctness/useExhaustiveDependencies: unifiedAgents 以 unifiedAgentsKey 表达身份(数组每次 render 都是新引用)。
  }, [
    providers,
    resolveStoredIdentity,
    mixedCatalog,
    unifiedPanel,
    deviceId,
    unifiedIsVisible,
    unifiedExcludeProvider,
    unifiedExcludeModel,
    unifiedScope,
    unifiedAgentsKey,
    unifiedSelectionPolicy,
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
        ? resolveCurrentSourceId(providers, currentProviderId, shownModelId, currentAgentKind)
        : null,
    [providers, currentProviderId, shownModelId, currentAgentKind, resolveCurrentSourceId],
  );
  const currentModelProvider = useMemo(
    () =>
      activeSourceId ? providers.find((provider) => provider.id === activeSourceId) : undefined,
    [activeSourceId, providers],
  );
  const currentCatalogModel =
    currentModelProvider && currentAgentKind
      ? getModel(currentModelProvider, shownModelId, currentAgentKind)
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
  // 快照选择与折扣叠加的规则在 `lib/modelPricePresentation.ts`,与设置页 → 模型列表共用
  // 同一份实现(那三条判断复制一份就会漂,见该文件头注)。这里只做选择器特有的两件事:
  // 远程会话不展示价格,以及「行来源未知时回溯解析」。
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
    return resolveModelPricePresentation({
      providerId: effectiveProviderId,
      modelId: id,
      agent: priceAgentKind,
      providers,
      gatewayPricing,
      referencePricing,
    });
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
  const modelDisabledOf = (provider: ProviderView | null, id: string, rowAgent?: AgentKind): boolean => {
    if (!deviceId) {
      if (subscriptionDirectDisabledReason(id)) return true;
      // openai-codex/ 与 codex/ 的本机 key gate 只属于 XD 网关折扣路由。自定义(user)供应商目录里的
      // 同前缀模型由该供应商自身配置路由(codex-proxy-host 按会话显式供应商解析,
      // 不按前缀落网关),不依赖 Cindy 登录/网关 key(#1568)。flat 列表(provider
      // 为 null,无供应商概念)与内置来源保持原前缀判定。
      if (isCustomRoutedProvider(provider)) return false;
      // Auxiliary windows cannot inspect local credentials and use Main's catalog verdict.
      // Full renderers retain the existing key gate when a stale catalog still says connected.
      if (provider?.id === 'xd' && canReadKey === false) return !provider.connected;
      return isCodexGatewayWireModel(id) && !hasSavedKey;
    }
    if (remoteModelListStatus !== 'ready') return true;
    if (remoteProviders.error) return remoteProviders.unsupported ? false : true;
    const rowAgentKind = rowAgent ?? resolveVisibleModelAgentKind({
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
    const candidates = provider ? [provider] : providers;
    return !candidates.some(
      (provider) =>
        provider.connected &&
        !provider.suspended &&
        provider.agents.includes(rowAgentKind) &&
        provider.routing?.[rowAgentKind]?.disabled !== true &&
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
      includePaymentRequired: true,
    }).map((section) => ({
      ...section,
      models: section.models.filter((model) => matchesModelName(model, query, t)),
    })).filter((section) => section.models.length > 0);
    // visibilityVersion 仅作刷新触发器(设置页改显示开关后强制重算);deviceId 切换需重算分段。
  }, [
    sourcesEnabled,
    sectionProviders,
    orderedSectionProviders,
    suspendedActiveSourceId,
    currentAgentKind,
    modelId,
    activeSourceId,
    t,
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
      (m) => matchesModelName(m, q, t),
    );
  }, [
    sections,
    visibleModels,
    t,
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
  const fastOnOf = (providerId: string | null, m: RowModel): boolean | 'ultrafast' => {
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
    fastOverride?: boolean | 'ultrafast',
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
        !unifiedPanel && selectedRowClickOpensConfiguration && configurationEnabled === true && selectedModelHasConfiguration;
      // A selected row can be the effective fallback for a stale explicit
      // provider.  Repair that route before opening its configuration, but do
      // not persist the row's derived/default effort just by opening the card.
      let reselectApplied: void | boolean | Promise<void | boolean> = undefined;
      if (reselectEmitsChange) {
        if (sections && providerId) {
          const needsProviderRepair = !!currentProviderId && currentProviderId !== providerId;
          if (!opensConfiguration || needsProviderRepair) {
            reselectApplied =
              !opensConfiguration && fastOverride !== undefined
                ? onProviderChange?.(providerId, id, reconciledEffort, fastOverride)
                : onProviderChange?.(
                    providerId,
                    id,
                    opensConfiguration ? undefined : reconciledEffort,
                  );
          }
        } else if (!opensConfiguration) {
          reselectApplied = onModelChange(id);
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
      const applied =
        fastOverride !== undefined
          ? onProviderChange?.(providerId, id, reconciledEffort, fastOverride)
          : onProviderChange?.(providerId, id, reconciledEffort);
      dismissAfterSelection();
      return applied;
    }
    const applied = onModelChange(id);
    dismissAfterSelection();
    return applied;
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
    targetFast: boolean | 'ultrafast',
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
    dismiss?: boolean;
  }): Promise<boolean> => {
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
      !reselectEmitsChange &&
      isSelectedRow(args.providerId, args.wireModelId) &&
      liveAgentKind !== null &&
      vendorKeyToAgentKind(args.config.engine) === liveAgentKind
    ) {
      if (!(await applyLiveRowConfig(args.effort, args.config.fast))) return false;
      onSessionFavoriteAnchorChange?.(anchor);
      if (args.dismiss !== false) {
        closeOptionsPanel();
        onDismiss?.();
      }
      return true;
    }
    const applied = await runLiveWrite(async () => {
      if (onProviderChange) {
        return onProviderChange(args.providerId, args.wireModelId, args.effort ?? '', args.config.fast);
      }
      if ((await onModelChange(args.wireModelId)) === false) return false;
      return applyLiveRowConfig(args.effort, args.config.fast);
    });
    if (!applied) return false;
    onSessionFavoriteAnchorChange?.(anchor);
    if (args.dismiss !== false) {
      closeOptionsPanel();
      onDismiss?.();
    }
    return true;
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
    configurationEnabled === true &&
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
    canConfigure && ((editingModel?.displayEfforts ?? editingModel?.efforts)?.length ?? 0) > 0 && !editThinkingToggle;

  // 配置列当前 effort 值(选中 → live;否则记忆/默认)。
  const editEffortValue: Effort | null = editingModel
    ? rowEffortOf(editingProviderId, editingModel)
    : null;
  const editFastValue: boolean | 'ultrafast' = editingModel
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
  const editingDisplayPricingModel = editingProvider && editingModel && currentAgentKind
    ? findCatalogModel(editingProvider, editingModel.id, currentAgentKind, { exact: true }) : undefined;
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
  const editingDescription = editingModel ? localizedModelDescription(editingModel, t) : undefined;
  const configPanel = editingModel ? (
    <div
      ref={configHighlightRef}
      role="group"
      aria-label={`${localizedModelName(editingModel.displayName, t)} ${t('newChat.modelSelector.options')}`}
      {...menuPanelAttrs}
      className="relative flex flex-col gap-0.5"
    >
      <MenuHighlightLayer />
      {/* 名字 / 简介先帮助确认模型；面板整体居中后，操作区仍贴近当前 hover 行。 */}
      <div {...menuSkipAttrs} className="flex flex-col gap-1 px-2 py-1.5">
        <span className="min-w-0 text-14 font-medium text-[var(--model-item-text)]">
          {localizedModelName(editingModel.displayName, t)}
        </span>
        {editingDescription && (
          <span className="line-clamp-2 text-12 font-normal leading-[1.4] text-[var(--text-secondary)]">
            {editingDescription}
          </span>
        )}
      </div>
      {(editShowFast || editHasEfforts || editThinkingToggle) && (
        <div className="mx-1 my-1 h-px bg-[var(--model-dropdown-border)]" />
      )}
      {editShowFast && (
        <div {...menuSkipAttrs} className="px-0.5">
          {/* 遵循设计稿:单色反色(轨/文字 --text-primary,钮 --surface-on-card),不用品牌橙。 */}
          <FastModeToggle
            enabled={!!editFastValue}
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
        <div {...menuSkipAttrs} className="px-0.5">
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
            <span className="text-12 font-medium leading-[1.33] text-[var(--cmd-palette-item-meta)]">
              {t('newChat.modelSelector.effortLabel')}
            </span>
          </div>
          {(editingModel.displayEfforts ?? editingModel.efforts).map((e) => {
            const available = editingModel.efforts.includes(e);
            const selected = editEffortValue === e;
            return (
              <button
                type="button"
                key={e}
                disabled={!available}
                onClick={() => available && handleEditEffort(e)}
                role="option"
                aria-selected={selected}
                // Shared menu row (DESIGN §4 Composer dropdown rows): glide highlight. Model
                // menu exception: the chosen effort keeps its whole-row fill and the check.
                {...menuRowAttrs({ checked: selected, disabled: !available })}
                className={cn(
                  COMPOSER_MENU_ROW,
                  'flex w-full items-center justify-between px-3 py-2 text-left',
                  selected && 'bg-sidebar-item-hover data-[menu-active]:bg-transparent',
                  !available && 'cursor-not-allowed opacity-45',
                )}
              >
                {withMenuLabels(<span className="truncate">{effortLabelFor(editingModel, e)}</span>)}
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
      {editingDisplayPricingModel?.displayPricing && editingDisplayPricingModel.currency && (
        <div {...menuSkipAttrs} className="max-h-72 overflow-y-auto border-t border-[var(--model-dropdown-border)] pt-2.5">
          <DisplayPricingDetails model={editingDisplayPricingModel} />
        </div>
      )}
      {!editingDisplayPricingModel?.displayPricing && editingPricePresentation && (
        <>
          <div {...menuSkipAttrs} className="px-2 pb-1 pt-1">
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
    const displayName = localizedModelName(model.displayName, t);
    const showModelId = isCustomRoutedProvider(statusProvider) && model.id !== displayName;
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
    const rowEffort = configurationEnabled === true ? rowEffortOf(providerId, model) : null;
    const rowFastOn = configurationEnabled === true ? fastOnOf(providerId, model) : false;
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
                ? [displayName, showModelId ? model.id : null, t('newChat.modelSelector.paymentRequired.unlock')].filter(Boolean).join(' · ')
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
            // Shared menu row (DESIGN §4 Composer dropdown rows): the list's glide highlight
            // marks the pointer / keyboard-focused row and the row whose options are open.
            {...menuRowAttrs()}
            data-state={isEditingThis ? 'open' : isSelected ? 'checked' : undefined}
            className={cn(
              COMPOSER_MENU_ROW,
              'group/row flex w-full cursor-pointer flex-col px-3 py-2',
              // Model menu exception (DESIGN §4): the chosen row keeps its whole-row fill.
              isSelected && 'bg-sidebar-item-hover data-[menu-active]:bg-transparent',
              constrainedListMaxHeight !== undefined && 'min-h-9',
              (disabled || paymentRequired) && 'opacity-50',
            )}
          >
            <div className="flex w-full items-center justify-between">
              <span className="flex min-w-0 flex-1 items-center gap-2.5">
                {provider && (
                  <ModelIconMark
                    icon={model.icon}
                    providerId={provider.id}
                    name={provider.name}
                    routing={provider.routing}
                    logoKind={provider.logoKind}
                    customIcon={provider.customIcon}
                    colorClass="text-[var(--text-secondary)]"
                    withMargin={false}
                    dense
                  />
                )}
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="truncate font-medium leading-5">
                      {displayName}
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
                        <Badge data-payment-required-badge icon={<Lock size={11} />}>
                          {t('newChat.modelSelector.paymentRequired.badge')}
                        </Badge>
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
                        <Badge
                          aria-label={t('settings.providers.models.subscription')}
                          title={t('settings.providers.models.subscription')}
                        >
                          {t('newChat.modelSelector.meta.subscriptionBadgeCompact', {
                            defaultValue: t('settings.providers.models.subscription'),
                          })}
                        </Badge>
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
            {showModelId && (
              <div className="w-0 min-w-full break-words pl-[26px] pt-px text-12 font-normal leading-[1.4] text-[var(--text-secondary)] [overflow-wrap:anywhere]">
                {model.id}
              </div>
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
              'w-[248px] overflow-hidden rounded-xl p-2 shadow-[shadow:var(--shadow-menu)] duration-100',
              'border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]',
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
    !unifiedPanel &&
    sourcesEnabled &&
    !deviceId &&
    currentAgentKind &&
    !providersLoading &&
    connected.length === 0 ? (
      <div className="flex flex-col gap-3.5 p-2">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--model-item-hover)]">
            <Unplug size={16} className="text-[var(--text-secondary)]" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
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
            onClick={() => onNavigateToProviders()}
            className={cn(
              'flex h-[34px] w-full items-center justify-center rounded-lg',
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
  // 分组标题与左栏提示：本机建的组带上台数，每行的来源名不带。
  const unifiedProviderHeading = useCallback(
    (providerId: string): string => withLocalGroupSize(providerId, unifiedProviderLabel(providerId)),
    [unifiedProviderLabel, withLocalGroupSize],
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
      (typeof fastModeConfigurable === 'boolean' ? fastModeConfigurable : fastModeConfigurable.includes(agent)) && !!(onFastModeChange || onUnifiedSelect) && (agent === 'claude-code'
        ? !!cc.capabilities?.hasFastMode
        : agent === 'codex'
          ? !!codex.capabilities?.hasFastMode
          : !!pi.capabilities?.hasFastMode),
    [cc.capabilities, codex.capabilities, pi.capabilities, onFastModeChange, onUnifiedSelect, fastModeConfigurable],
  );

  if (providersOverrideState && providersOverrideState.status !== 'ready') {
    return <RemoteModelLoadNotice status={providersOverrideState.status} onRetry={providersOverrideState.refresh} />;
  }
  const sshCodexPending =
    sshCodex?.status === 'loading' || sshCodex?.status === 'error' ? sshCodex.status : null;
  // 兼容列表只列当前引擎：当前是 Codex 时远端清单就是整张列表。统一面板里其余引擎照常可选，
  // 提示只占列表上方一行。
  if (sshCodex && sshCodexPending && !unifiedPanel && currentAgentKind === 'codex') {
    return <RemoteModelLoadNotice status={sshCodexPending} onRetry={sshCodex.refresh} />;
  }
  const sshCodexNotice = sshCodex && sshCodexPending
    ? <RemoteModelLoadNotice compact status={sshCodexPending} onRetry={sshCodex.refresh} /> : null;

  const localCatalogNotice = !deviceId && !providersOverride && localProviders.error
    ? <LocalModelCatalogNotice failure={localProviders.error} onRetry={localProviders.refetch} /> : null;
  // 后续刷新失败时,快照里可能仍没有当前引擎的已连接来源。emptyState 不得盖住恢复提示;
  // 有引导卡时叠在下方,连接入口仍可用。
  if (localCatalogNotice && (localProviders.loading || emptyState)) {
    return (
      <div className="flex w-[320px] max-w-full flex-col">
        <div className={emptyState ? 'p-2 pb-0' : 'p-2'}>{localCatalogNotice}</div>
        {emptyState}
      </div>
    );
  }
  if (emptyState) return emptyState;

  const hasAnyModel = sections ? sections.length > 0 : (flatModels?.length ?? 0) > 0;
  const trimmedQuery = query.trim();
  const remoteStatusInList =
    deviceId && (remoteModelListStatus === 'loading' || remoteModelListStatus === 'error')
      ? remoteModelListStatus
      : null;
  const showRemoteStatusFooter =
    remoteStatusInList !== null && (hasAnyModel || trimmedQuery.length > 0);

  // 搜索框 —— 共享 SearchInput(panel 档),**只给既有分段面板用**。统一面板的搜索行是设计稿的无框平铺形态
  // (见下方 unifiedPanel 分支),与这里的胶囊框是两套视觉,刻意不共用;共用的只有
  // placeholder / a11y 名的同一条 i18n key。
  const searchField = (
    <SearchInput
      surface="panel"
      disabled={interactionDisabled}
      value={query}
      onChange={setQuery}
      placeholder={t('newChat.modelSelector.search.placeholderAll')}
      aria-label={t('newChat.modelSelector.search.placeholderAll')}
    />
  );

  // ── 统一模型选择器面板(opt-in,M3 / M4)────────────────────────────────────
  // 联合列表的可见性 / 排除口径必须与既有面板**逐条对齐**(否则「统一面板里能看到、
  // 切回旧面板就没了」),故这里复用同一批判定函数,只是补上 agent 维度。
  // unifiedProviderLabel / unifiedEffortLabel / unifiedAgentFastCapable 三个回调声明在
  // emptyState 提前返回之前(hooks 数量恒定的硬要求,见彼处注释)。
  if (unifiedPanel) {
    // 可见性 / 排除谓词与 scope 一律从组件作用域取(见 unifiedIsVisible 的定义处):
    // 种子收藏 effect 用的是同一份,两边不能各写一遍。
    //
    // 远程 Agent:正在浏览的远程供应商格。打开时只知道落点电脑,供应商格按当前来源 /
    // 那台的首个供应商补齐;那台的目录到齐之前列表只显示加载态。
    const remoteActiveProviderId = remoteBrowse
      ? (remoteBrowse.providerId ??
        (browsingSelectedCatalog ? activeSourceId : null) ??
        remoteAgentGroups.find((group) => group.deviceId === remoteBrowse.deviceId)?.providerIds[0] ??
        null)
      : null;
    // The owner computer of the browsed share is temporarily offline (providerSharePickerState, the
    // same rule as the rail label and Mobile): say so above its last models instead of an empty list.
    const browsedShareOffline = !!remoteBrowse && isProviderShareAgentDeviceId(remoteBrowse.deviceId)
      && receivedShares.some((share) => providerShareAgentDeviceId(share.shareId) === remoteBrowse.deviceId
        && providerSharePickerState(share) === 'offline');
    const browsedShareOfflineNote = browsedShareOffline
      ? <div role="status" className="px-3 py-2 text-13 text-[var(--text-secondary)]">{t('providerShare.received.offlineNote')}</div>
      : null;
    const browsedShareGroupSize = remoteBrowse && isProviderShareAgentDeviceId(remoteBrowse.deviceId)
      ? readProviderShareGroupSize(remoteAgentGroups.find((group) => group.deviceId === remoteBrowse.deviceId)
        ?.providers.find((provider) => provider.id === remoteActiveProviderId))
      : null;
    const remoteBrowseDevice: UnifiedSelectionAgentDevice = remoteBrowse
      ? {
          deviceId: remoteBrowse.deviceId,
          name:
            remoteAgentDevices?.find((device) => device.deviceId === remoteBrowse.deviceId)?.name ||
            remoteBrowse.deviceId,
        }
      : null;
    const withAgentDevice = remoteAgent ? { agentDevice: remoteBrowseDevice } : {};
    // 浏览的不是草稿当前落点的目录时,没有任何一行是「正在用的那一行」;归组的任务在组那一项里显示为正在用的。
    const panelSelection = browsingSelectionCatalog
      ? {
          providerId: configurationEnabled === 'harness' ? (currentProviderId ?? null) : activeSourceId,
          modelId: configurationEnabled === 'harness' ? modelId : shownModelId,
        }
      : browsingBoundGroupEntry
        ? { providerId: boundEntry!.providerId, modelId }
        : { providerId: null, modelId: '' };
    // 正在用的那一行显示在哪份目录里，它实际的深度、Fast 与引擎就跟到哪份目录。选着合并供应商路由下的模型、草稿记的成员
    // 在别的电脑上或是分享来的时，那一行列在任务所在电脑的目录里(见 selectionCatalogDeviceId)：只按运行位置判断的话，
    // 选中行读不到实际档位，滑杆显示推荐档，松手写进去了却弹回(2026-11-27 用户录屏)。
    const browsingLiveCatalog = browsingSelectedCatalog || browsingSelectionCatalog || browsingBoundGroupEntry;
    // 归组的任务在组那一项里选模型:留在此刻运行的那台(换成那台上这个供应商的 id),只换模型,不挪 Agent。
    const currentAgentDevice: UnifiedSelectionAgentDevice = remoteAgentDeviceId
      ? {
          deviceId: remoteAgentDeviceId,
          name:
            remoteAgentDevices?.find((device) => device.deviceId === remoteAgentDeviceId)?.name ||
            remoteAgentDeviceId,
        }
      : null;
    // 已建任务浏览的不是 Agent 落点那台的目录:选中的行要连运行位置一起换,同引擎 / 跨引擎
    // 两条会话链路都按当前落点的目录工作,这里一律改道给 onRelocate。
    const relocate =
      remoteAgent?.onRelocate && !onUnifiedSelect && !browsingSelectedCatalog
        ? remoteAgent.onRelocate
        : undefined;
    const relocateRow = (
      row: { providerId: string; modelId: string; agent: AgentKind; effort?: Effort; fast: boolean | 'ultrafast' },
      dismiss: boolean,
    ): Promise<boolean> =>
      runLiveWrite(() =>
        relocate!(
          browsingBoundGroupEntry && row.providerId === boundEntry!.providerId && currentProviderId
            ? { ...row, providerId: currentProviderId, agentDevice: currentAgentDevice, retryQueuedSend: dismiss }
            : { ...row, agentDevice: remoteBrowseDevice, retryQueuedSend: dismiss },
        ),
      ).then((applied) => {
        if (applied && dismiss) {
          closeOptionsPanel();
          onDismiss?.();
        }
        return applied;
      });
    /**
     * 收藏区里另一台电脑上的收藏(浏览任务所在电脑的目录时列出):效果与左侧栏切到那台电脑再选中它相同。
     *   - 草稿:整行带着那台电脑交给 onUnifiedSelect(同浏览那台时的 withAgentDevice);
     *   - 已建任务、Agent 不在那台:连运行位置一起换(onRelocate,同浏览那台时的 relocate);
     *   - 已建任务、Agent 已在那台 / 那一项是任务归的供应商组:这一选择要走那台目录里的会话链路
     *     (同引擎直切 / 跨引擎事务 / 组内留在原处),这里不另起一套 —— 切到那台的目录,同一条收藏在
     *     那里照样列出,由用户在那里选。
     */
    const selectDeviceFavorite: NonNullable<
      NonNullable<UnifiedModelPanelProps['remoteSources']>['onSelectDeviceFavorite']
    > = ({ deviceId: targetDeviceId, providerId, modelId: id, effort: rowEffort, config: rowConfig }) => {
      const rowEffortValue = rowEffort === '' ? undefined : rowEffort;
      const agentDevice = {
        deviceId: targetDeviceId,
        name: deviceDisplayName(targetDeviceId, undefined, remoteAgentDevices ?? []),
      };
      const dismissIfApplied = (applied: boolean) => {
        if (applied) {
          closeOptionsPanel();
          onDismiss?.();
        }
        return applied;
      };
      if (onUnifiedSelect) {
        return runLiveWrite(() =>
          onUnifiedSelect({
            providerId,
            modelId: id,
            ...(rowEffortValue ? { effort: rowEffortValue } : {}),
            engine: rowConfig.engine,
            fast: rowConfig.fast,
            favoriteUid: rowConfig.favoriteUid,
            agentDevice,
          }),
        ).then(dismissIfApplied);
      }
      const agent = vendorKeyToAgentKind(rowConfig.engine);
      const inBoundGroup =
        stayInGroup && boundEntry?.deviceId === targetDeviceId && boundEntry.providerId === providerId;
      const onRelocate = remoteAgent?.onRelocate;
      if (onRelocate && agent && targetDeviceId !== remoteAgentDeviceId && !inBoundGroup) {
        return runLiveWrite(() =>
          onRelocate({
            providerId,
            modelId: id,
            agent,
            ...(rowEffortValue ? { effort: rowEffortValue } : {}),
            fast: rowConfig.fast,
            agentDevice,
            retryQueuedSend: true,
          }),
        ).then(dismissIfApplied);
      }
      closeOptionsPanel();
      setRemoteBrowseTouched(true);
      setRemoteBrowse({ deviceId: targetDeviceId, providerId });
      return false;
    };
    const baseSessionEngineFilter =
      sessionEngineFilter && relocate
        ? {
            ...sessionEngineFilter,
            onCrossEngineSelect: (args: Parameters<NonNullable<typeof sessionEngineFilter>['onCrossEngineSelect']>[0]) =>
              relocateRow(
                {
                  providerId: args.providerId,
                  modelId: args.modelId,
                  agent: args.targetAgent,
                  ...(args.effort ? { effort: args.effort } : {}),
                  fast: (args.fast === 'ultrafast' ? 'ultrafast' : args.fast === true),
                },
                true,
              ),
            onCrossEngineConfigure: (args: Parameters<NonNullable<typeof sessionEngineFilter>['onCrossEngineSelect']>[0]) =>
              relocateRow(
                {
                  providerId: args.providerId,
                  modelId: args.modelId,
                  agent: args.targetAgent,
                  ...(args.effort ? { effort: args.effort } : {}),
                  fast: (args.fast === 'ultrafast' ? 'ultrafast' : args.fast === true),
                },
                false,
              ),
          }
        : sessionEngineFilter;
    const dismissMergedPick = () => {
      closeOptionsPanel();
      onDismiss?.();
    };
    const panelSessionEngineFilter = wrapSessionEngineFilter(
      baseSessionEngineFilter,
      dismissMergedPick,
    );
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
            // 紧凑宽度契约见 UNIFIED_COMPACT_PANEL_WIDTH_CLASS；field 入口仍绑 trigger。
            fluidWidth ? 'w-full min-w-0' : UNIFIED_COMPACT_PANEL_WIDTH_CLASS,
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
                  ? 'cursor-not-allowed text-[var(--text-disabled)] placeholder:text-[var(--text-disabled)]'
                  : 'text-[var(--model-item-text)] placeholder:text-[var(--text-placeholder)]',
              )}
              aria-label={t('newChat.modelSelector.search.placeholderAll')}
            />
          </div>
          {localCatalogNotice && <div className="shrink-0 p-2">{localCatalogNotice}</div>}
          {sshCodexNotice && <div className="shrink-0 p-2">{sshCodexNotice}</div>}
          <UnifiedModelPanel
            // The offline note above already explains why this share lists no models; skip the
            // generic "no matching models" line under it (a search still reports no results).
            {...(browsedShareOffline && !query.trim() ? { emptyCatalogNotice: <></> } : {})}
            {...(!deviceId && !providersOverride && localProviders.loading && !localProviders.error && providers.length === 0
              ? {
                  emptyCatalogNotice: (
                    <div role="status" className="flex items-center justify-center gap-1.5 px-3 py-6 text-13 text-[var(--text-tertiary)]">
                      <Spinner size={14} />
                      {t('newChat.modelSelector.trigger.loading')}
                    </div>
                  ),
                }
              : {})}
            {...(pluginModels || modelGroups ? {
              // 模型组与插件路由模型排在「全部」收藏区之后、插件引擎与内置模型之前。
              pinnedTop: (
                <>
                  {pluginModels && (
                    <PluginModelsSection
                      picker={pluginModels}
                      query={query}
                      onPicked={() => onDismiss?.()}
                      allowFavorites={unifiedSelectionPolicy === 'personalized'}
                    />
                  )}
                  {modelGroups && (
                    <ModelGroupsPickerSection picker={modelGroups} query={query} onPicked={() => onDismiss?.()}
                      variant={query.trim() ? 'search' : 'all'} />
                  )}
                  {/* 搜索时也列出其他电脑命中的模式，每台一段、标题带电脑名(不搜索时它们在各自那一格) */}
                  {modelGroups && query.trim() && deviceModelGroupChoices.map((device) => (
                    <ModelGroupsPickerSection key={`model-groups:${device.deviceId}`} picker={modelGroups} query={query}
                      deviceId={device.deviceId} onPicked={() => onDismiss?.()} variant="search" />
                  ))}
                </>
              ),
              pinnedTopHasRows: (pluginModels ? matchPluginModels(pluginModels.models, query).length > 0 : false)
                || (!!modelGroups && !query.trim() && !!modelGroups.managedMeta && !!modelGroups.onDetach)
                || (!!modelGroups && matchModelGroupRows(modelGroupRows, query) > 0)
                || (!!modelGroups && !!query.trim() && deviceModelGroupChoices.some((device) =>
                  matchModelGroupRows(buildModelGroupPickerRows(device.config, t, device.deviceId), query) > 0)),
            } : {})}
            {...(modelGroups && (modelGroupRows.length > 0 || (!!modelGroups.managedMeta && !!modelGroups.onDetach)) ? {
              modelGroupsView: <ModelGroupsPickerSection picker={modelGroups} query="" onPicked={() => onDismiss?.()} />,
            } : {})}
            {...((modelGroups && modelGroupRows.length > 0) || (pluginModels && unifiedSelectionPolicy === 'personalized') ? {
              favoritesPinned: (
                <>
                  {pluginModels && unifiedSelectionPolicy === 'personalized' && (
                    <PluginModelsSection picker={pluginModels} query="" onPicked={() => onDismiss?.()} variant="favorites" />
                  )}
                  {modelGroups && modelGroupRows.length > 0 && (
                    <ModelGroupsPickerSection picker={modelGroups} query="" onPicked={() => onDismiss?.()} variant="favorites" />
                  )}
                </>
              ),
              favoritesPinnedHasRows:
                (modelGroups && modelGroupRows.length > 0 ? favoriteModelGroupCount > 0 : false)
                || (pluginModels && unifiedSelectionPolicy === 'personalized' ? favoritePluginModelCount > 0 : false),
            } : {})}
            {...(modelGroups && deviceModelGroupChoices.length ? {
              // 其他电脑自己的模式：每台一格，排进那台电脑那一段；由那台选来源(model-groups.md §6.3)。
              deviceModelGroupTabs: deviceModelGroupChoices.map((device) => ({ deviceId: device.deviceId, name: device.name })),
              renderDeviceModelGroups: (deviceId: string) => (
                <ModelGroupsPickerSection picker={modelGroups} query="" deviceId={deviceId} onPicked={() => onDismiss?.()} />
              ),
            } : {})}
            {...(effectivePluginEngines && effectivePluginEngines.engines.length > 0 ? {
              pluginEngines: effectivePluginEngines,
              onPluginEnginePicked: () => onDismiss?.(),
            } : {})}
            {...(!remoteAgentBrowsing && deviceId && (remoteModelListStatus === 'loading' || remoteModelListStatus === 'error')
              ? {
                  catalogNotice: (
                    <RemoteModelLoadNotice
                      status={remoteModelListStatus}
                      onRetry={retryRemoteModels}
                      message={remoteFailureMessage}
                    />
                  ),
                }
              : {})}
            deviceId={deviceId}
            providerUsage={providerUsageScope}
            providerGroupUsage={providerGroupUsage}
            routeUsageMember={remoteAgent ? homeSourceRoutes.usageMember : sourceRoutes.usageMember}
            resolveStoredProviderAlias={resolveStoredProviderAlias}
            resolveStoredIdentity={resolveStoredIdentity}
            providers={providers}
            // 等价来源从来源栏与模型分组收起；收藏和最近仍按完整目录解析。
            {...((!remoteAgent || !deviceId || (homeDeviceId && !remoteBrowse)) && runLocationFold.hiddenLocal.size > 0
              ? { listHiddenProviderIds: runLocationFold.hiddenLocal }
              : {})}
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
              sshCodexActive ? 'ssh' : '',
            ].join('|')}
            query={query}
            // field 形态的面板宽度绑 trigger,定宽 sizer 无用武之地(见该 prop 说明)。
            panelWidthFluid={fluidWidth}
            readableRows={readableRows}
            // 选中插件模型或草稿智能路由(非供应商路由、非进行中任务托管)时，普通模型行不再同时显示选中底色。
            selected={pluginModels?.active || (effectiveModelGroupsActive && !activeSourceRoute && !modelGroups?.managedMeta) || pluginEngines?.active ? NO_MODEL_SELECTION : panelSelection}
            selectedFavoriteUid={browsingSelectionCatalog && !pluginModels?.active && !(effectiveModelGroupsActive && !activeSourceRoute && !modelGroups?.managedMeta) && !pluginEngines?.active
              ? selectedFavoriteUid : null}
            liveAgentKind={
              !browsingLiveCatalog || (unifiedSelectionPolicy === 'official' && configurationEnabled !== 'harness')
                ? null : currentAgentKind
            }
            fastMode={unifiedSelectionPolicy === 'official' || !browsingLiveCatalog ? false : fastMode}
            selectedEffort={
              unifiedSelectionPolicy === 'official' || !browsingLiveCatalog ? undefined : effort
            }
            {...(modelMemory ? { modelMemory } : {})}
            {...(preferenceStore ? { preferenceStore } : {})}
            {...(remoteAgent && remoteAgentLocalRailItems
              ? {
                  remoteSources: {
                    localRailItems: remoteAgentLocalRailItems,
                    localProviders: homeProviders,
                    localUsageDeviceId: homeDeviceId ?? null,
                    localProviderLabel: remoteAgentLocalLabel,
                    groups: remoteAgentGroups,
                    labelOf: remoteAgentLabelOf,
                    homeUnavailableReasonOf: (deviceId: string, providerId: string) =>
                      runLocationFold.unavailableReasons.get(remoteProviderEntryKey(deviceId, providerId)),
                    // 远程收藏按任务所在电脑共享(§1.5):被控电脑上的任务读写那台的收藏,本机任务读写本机。
                    ...(homeDeviceId ? { favoritesDeviceId: homeDeviceId } : {}),
                    shareFavoriteSources: routedFavoriteSources,
                    homeDeviceId: homeDeviceId ?? selfDeviceId,
                    unavailableDeviceIds: remoteAgentUnavailableDeviceIds,
                    onSelectDeviceFavorite: selectDeviceFavorite,
                    active: remoteBrowse
                      ? { deviceId: remoteBrowse.deviceId, providerId: remoteActiveProviderId ?? '' }
                      : null,
                    ready:
                      remoteBrowse === null ||
                      (remoteModelListStatus === 'ready' && remoteActiveProviderId !== null),
                    ...(remoteBrowse && remoteActiveProviderId && browsedShareGroupSize !== null
                      ? {
                          status: <>
                            {browsedShareOfflineNote}
                            <SharedProviderGroupStatus
                              key={JSON.stringify([remoteBrowse.deviceId, remoteActiveProviderId])}
                              deviceId={modelCatalogKey(remoteBrowse.deviceId, remoteAgent.catalogHostDeviceId) ?? remoteBrowse.deviceId}
                              providerId={remoteActiveProviderId}
                              initialSize={browsedShareGroupSize}
                              compact
                            />
                          </>,
                        }
                      : browsedShareOfflineNote ? { status: browsedShareOfflineNote } : {}),
                    ...(remoteBrowse && remoteModelListStatus === 'error'
                      ? {
                          failure: (
                            <RemoteModelLoadNotice
                              status="error"
                              onRetry={retryRemoteModels}
                              compact
                              message={remoteFailureMessage}
                            />
                          ),
                        }
                      : {}),
                    onActivate: (target: { deviceId: string; providerId: string } | null) => {
                      closeOptionsPanel();
                      setRemoteBrowseTouched(true);
                      setRemoteBrowse(target && !target.providerId ? { deviceId: target.deviceId, providerId: null } : target);
                    },
                  },
                }
              : {})}
            agentFastModeCapable={unifiedAgentFastCapable}
            priceOf={(providerId, id, agent) => pricePresentationOf(providerId, id, agent)}
            // 浏览其他电脑的目录时,分组标题带上电脑名(「Claude 订阅 · 工作室 Mac」)。
            providerLabel={
              remoteBrowse
                ? (providerId: string) => remoteAgentLabelOf(remoteBrowse.deviceId, providerId)
                : unifiedProviderLabel
            }
            // 供应商组的分组标题与左栏提示带上台数(其他电脑的组已在 remoteAgentLabelOf 里带上)。
            {...(remoteBrowse ? {} : { providerHeading: unifiedProviderHeading })}
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
            selectionPolicy={unifiedSelectionPolicy}
            recordRecentUsage={recordRecentModelsOnSelect}
            isRouteDisabled={(providerId, id, rowAgent) => providersOverride || (sshCodexActive && rowAgent === 'codex') ? false : modelDisabledOf(providers.find((provider) => provider.id === providerId) ?? null, id, rowAgent)}
            {...(panelSessionEngineFilter ? { sessionEngineFilter: panelSessionEngineFilter } : {})}
            {...(followSession ? { followSession: {
              ...followSession,
              onFollow: async () => {
                if (!(await runLiveWrite(followSession.onFollow))) return false;
                closeOptionsPanel();
                onDismiss?.();
                return true;
              },
            } } : {})}
            onSelect={(providerId, id, rowEffort, rowConfig) => {
              const rowEffortValue = rowEffort === '' ? undefined : rowEffort;
              // 草稿(M5):整行原样直通给调用方 —— 引擎跟着模型一起落，中途不再被单引擎
              // 链路重解析一次(见 onUnifiedSelect 的说明)。
              if (onUnifiedSelect) {
                return runLiveWrite(() =>
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
                    ...withAgentDevice,
                  }),
                ).then((applied) => {
                  if (applied) {
                    closeOptionsPanel();
                    onDismiss?.();
                  }
                  return applied;
                });
              }
              const mergedPicked = tryPickMergedBuiltIn(providerId, id, {
                effort: rowEffortValue,
                fast: rowConfig.fast,
                onCommitted: dismissMergedPick,
              });
              if (mergedPicked !== null) return mergedPicked;
              if (relocate) {
                const agent = vendorKeyToAgentKind(rowConfig.engine);
                if (!agent) return false;
                return relocateRow(
                  {
                    providerId,
                    modelId: id,
                    agent,
                    ...(rowEffortValue ? { effort: rowEffortValue } : {}),
                    fast: rowConfig.fast,
                  },
                  true,
                );
              }
              // 已建会话(M6):同引擎行照旧走 onProviderChange 直切;跨引擎行在 selectRow
              // 里就已经改道 sessionEngineFilter.onCrossEngineSelect,到不了这里。
              // 「同模型不同配置的收藏」与「锚点只在真的应用后才记」两件事收在
              // applyUnifiedSessionSelect 里(见其头注,M3 / M4)。
              return applyUnifiedSessionSelect({
                providerId,
                wireModelId: id,
                effort: rowEffortValue,
                config: rowConfig,
              });
            }}
            onConfigure={(providerId, id, rowEffort, rowConfig) => {
              const nextEffort = rowEffort === '' ? undefined : rowEffort;
              if (onUnifiedSelect) {
                return onUnifiedSelect({
                  providerId,
                  modelId: id,
                  ...(nextEffort ? { effort: nextEffort } : {}),
                  engine: rowConfig.engine,
                  fast: rowConfig.fast,
                  favoriteUid: rowConfig.favoriteUid,
                  ...(rowConfig.resetToRecommended ? { resetToRecommended: true as const } : {}),
                  ...withAgentDevice,
                });
              }
              const mergedConfigured = tryPickMergedBuiltIn(providerId, id, {
                effort: nextEffort,
                fast: rowConfig.fast,
              });
              if (mergedConfigured !== null) return mergedConfigured;
              if (relocate) {
                const agent = vendorKeyToAgentKind(rowConfig.engine);
                if (!agent) return false;
                return relocateRow(
                  {
                    providerId,
                    modelId: id,
                    agent,
                    ...(nextEffort ? { effort: nextEffort } : {}),
                    fast: rowConfig.fast,
                  },
                  false,
                );
              }
              return applyUnifiedSessionSelect({
                providerId,
                wireModelId: id,
                effort: nextEffort,
                config: rowConfig,
                dismiss: false,
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
                return onUnifiedSelect({
                  providerId,
                  modelId: id,
                  ...(rowEffortValue ? { effort: rowEffortValue } : {}),
                  engine: rowConfig.engine,
                  fast: rowConfig.fast,
                  favoriteUid: null,
                  ...withAgentDevice,
                });
              }
              // 浏览别的电脑的目录时没有「正在用的那一行」,也就没有锚点可清。
              if (relocate) return;
              onSessionFavoriteAnchorChange?.(null);
            }}
            {...(onEffortChange
              ? {
                  // 统一面板自己保证同一时刻只提交一笔(在途点击排队),调用方无需再锁 selector。
                  onEffortChangeLive: (effort: Effort) =>
                    onEffortChange(effort, { serializedByPanel: true }),
                }
              : {})}
            {...(onFastModeChange ? { onFastModeChangeLive: onFastModeChange } : {})}
            thinkingEnabled={thinkingEnabled}
            {...(onThinkingChange ? { onThinkingChangeLive: onThinkingChange } : {})}
            panelElement={paneElement}
            {...(overlayContentClassName !== undefined
              ? { overlayClassName: overlayContentClassName }
              : {})}
          />
          {/* 「配置模型」只对本机目录与分享来的供应商展示(见 showProvidersEntry)。 */}
          {showProvidersEntry && (
            <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--model-dropdown-border)] px-3.5 py-2">
              <button
                type="button"
                disabled={interactionDisabled}
                onClick={navigateToProviders}
                className={cn(
                  'flex min-w-0 items-center gap-1.5 text-13 text-[var(--text-secondary)]',
                  'transition-colors hover:text-[var(--text-primary)]',
                  interactionDisabled && 'cursor-not-allowed opacity-50',
                )}
              >
                <Plus size={14} className="shrink-0" />
                <span className="truncate">{t('newChat.modelSelector.source.connect')}</span>
              </button>
            </div>
          )}
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
            data-state={followSession.active ? 'checked' : undefined}
            className={cn(
              COMPOSER_MENU_ROW,
              'flex w-full items-center justify-between px-3 py-2',
              'hover:bg-sidebar-item-hover focus-visible:bg-sidebar-item-hover',
              followSession.active && 'bg-sidebar-item-hover',
            )}
          >
            {withMenuLabels(<span>{followSession.label}</span>)}
            {followSession.active && (
              <Check size={16} className="ml-2 shrink-0 text-[var(--model-item-check)]" />
            )}
          </button>
          <div className="mx-1 h-px bg-[var(--model-dropdown-border)]" />
        </>
      )}
      {searchField}
      {localCatalogNotice}

      {/* 模型列表 —— 单栏;分段(供应商)或 flat。 */}
      <div
        ref={legacyListHighlightRef}
        {...menuPanelAttrs}
        // -mr-2 把滚动条挪进面板右侧 8px 留白;scrollbar-gutter:stable 让无滚动时
        // 行宽与有滚动时一致(否则行会比搜索框宽 8px);细滚动条见 globals.css
        className="morph-panel-list-scroll relative -mr-2 flex max-h-[300px] flex-col gap-0.5 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
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
        <MenuHighlightLayer />
        {!hasAnyModel ? (
          // 发现还在途、且用户没在搜索时不摆「无结果」:那句话和下方的「正在获取」自相矛盾,
          // 而用户看到「没有模型」就会走。搜索无命中是本地过滤的确定结论,照常显示。
          remoteStatusInList && trimmedQuery.length === 0 ? (
            <RemoteModelLoadNotice
              status={remoteStatusInList}
              onRetry={retryRemoteModels}
              message={remoteFailureMessage}
            />
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
                <div className="flex min-w-0 items-center gap-2 px-3 pb-0.5 pt-1 text-12 font-medium leading-[1.33] text-[var(--cmd-palette-item-meta)]">
                  <span className="min-w-0 truncate">{providerDisplayName(sec.provider, t)}</span>
                  {!deviceId && sec.provider.id === 'xd' && modelAccessAccountTier === 'free' && (
                    <Badge data-testid="cindy-ai-model-group-free-tier-badge" className="ml-auto">
                      {t('settings.providers.xd.accountTier.free')}
                    </Badge>
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
        <RemoteModelLoadNotice
          status={remoteStatusInList}
          onRetry={retryRemoteModels}
          compact
          message={remoteFailureMessage}
        />
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

      {/* 「配置模型」只对本机目录与分享来的供应商展示(见 showProvidersEntry)。 */}
      {showProvidersEntry && (
        <>
          <div className="mx-1 h-px bg-[var(--model-dropdown-border)]" />
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              disabled={interactionDisabled}
              onClick={navigateToProviders}
              className={cn(
                COMPOSER_MENU_ROW,
                'flex min-w-0 items-center gap-1.5 px-3 py-2',
                'hover:bg-sidebar-item-hover focus-visible:bg-sidebar-item-hover',
              )}
            >
              <Plus size={14} className="shrink-0 text-[var(--text-tertiary)]" />
              <span className="truncate text-13 font-normal text-[var(--text-tertiary)]">
                {t('newChat.modelSelector.source.connect')}
              </span>
            </button>
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

// 收起尾部后一次撑回去至少需要多宽的位移：门槛内不重渲，也不来回抖。
const TAIL_RETRY_WIDTH_DELTA = 16;

/**
 * composer pill 尾部（引擎小标 + 思考档 + Fast）是否让位给模型名。
 *
 * 工具行真挤时，名字和尾部会一起被压扁：模型名只剩「GPT-…」，档名被挤成半截「超.」。
 * 名字比装饰重要，所以**名字一被截断就整组收起尾部**，把空间全给名字。
 * 收起后 pill 贴着名字变窄，名字本身不再被截断（无法自证空间回来了），所以只在
 * composer 宽度一次变 ≥16px 或内容变化（换模型 / 换档 / 换引擎 / 开关 Fast）时重试；
 * 实测截断与否在 layout / 尺寸回调里完成，不靠逐像素重渲，试回后若仍放不下会在同一次
 * 绘制前再次收起。
 */
function useTailCollapse(
  enabled: boolean,
  composerRef: { readonly current: HTMLElement | null } | undefined,
  labelRef: { current: HTMLElement | null },
  resetKey: string,
): boolean {
  const [collapsed, setCollapsedState] = useState(false);
  // 同值也 setState 会让父层多渲一帧，这里用 ref 挡掉。
  const collapsedRef = useRef(false);
  const setCollapsed = useCallback((next: boolean) => {
    if (collapsedRef.current === next) return;
    collapsedRef.current = next;
    setCollapsedState(next);
  }, []);
  // 内容变了（换模型 / 换档 / 换引擎 / 开关 Fast）先给尾部一次机会，再由实测决定。
  useEffect(() => {
    if (enabled) setCollapsed(false);
  }, [enabled, resetKey, setCollapsed]);
  // 无依赖数组：每次渲染后实测一次截断（只读两个盒子尺寸），截断即让位。
  useLayoutEffect(() => {
    if (!enabled || collapsed) return;
    const label = labelRef.current;
    if (label && label.scrollWidth > label.clientWidth + 1) setCollapsed(true);
  });
  // 拖动分屏 / 侧栏时 composer 变窄不会让 ChatInput 重渲（它按宽度档位收敛），
  // 名字被截断这件事只能在这里发现；收起后再按 ≥16px 位移决定要不要试回去。
  useEffect(() => {
    const composer = composerRef?.current;
    if (!enabled || !composer || typeof ResizeObserver === 'undefined') return;
    let width = composer.clientWidth;
    const observer = new ResizeObserver(() => {
      const label = labelRef.current;
      if (!label) return;
      const nextWidth = composer.clientWidth;
      const widened = nextWidth - width >= TAIL_RETRY_WIDTH_DELTA;
      width = nextWidth;
      if (collapsedRef.current) {
        // 变窄没有帮助；只有变宽才值得再试一次（试回后放不下会在绘制前再次收起）。
        if (widened) setCollapsed(false);
      } else if (label.scrollWidth > label.clientWidth + 1) {
        setCollapsed(true);
      }
    });
    observer.observe(composer);
    return () => observer.disconnect();
  }, [composerRef, enabled, labelRef, setCollapsed]);
  return enabled && collapsed;
}

export function ModelSelector({
  openRequest = 0,
  onOpenRequestConsumed,
  pluginModels,
  modelGroups,
  readModelGroupDevices,
  pluginEngines,
  pluginEngineSession,
  pluginEnginePending,
  providersOverride,
  providersOverrideState,
  taskSourceProvider,
  sshCodex,
  modelId: selectedModelId,
  draftModelPending = false,
  currentSelection,
  selectionPreparation,
  onReconnectSource,
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
  remoteAgent,
  agentDevice = null,
  excludeSubscriptionDirect,
  excludeChatBridgedCodex,
  switching = false,
  disabled = false,
  dense = false,
  compactToolbar = false,
  ultraCompactToolbar = false,
  composerRef,
  triggerVariant = 'toolbar',
  fieldPanelWidth = 'trigger',
  visualVariant = 'default',
  useMorphPopover = false,
  showEffortShortcut = false,
  restoreFocusTarget,
  popoverSide = 'top',
  maxVisibleModelRows,
  configurationEnabled = true,
  fastModeConfigurable = true,
  unifiedPanel: useUnifiedPanel = true,
  sessionEngineFilter,
  unifiedAgents,
  unifiedSelectionPolicy = 'personalized',
  engineMarkVendor = null,
  recordRecentUsage = false,
  selectedFavoriteUid = null,
  onSessionFavoriteAnchorChange,
  onUnifiedSelect,
  fallbackOption,
  reselectEmitsChange = false,
  selectedRowClickOpensConfiguration = false,
  unknownModelLabel,
  unknownModelDescription,
  ariaContext,
  'data-setting-id': settingId,
  currentProviderId,
  sourceDisconnected = false,
  checkSavedSource = false,
  preserveDraftModel = false,
  actualRoute = false,
  subscriptionTaskId,
  taskStarted = false,
  onProviderChange,
  onNavigateToProviders,
  agentSwitch,
}: ModelSelectorProps) {
  const modelId = draftModelPending ? '' : selectedModelId;
  const { t, i18n } = useTranslation();
  // 插件引擎的显示名：在自己另一台电脑上的带电脑名。
  const pluginEngineChoiceLabel = usePluginEngineChoiceLabel();
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const sshCodexRefresh = sshCodex?.refresh;
  // 只列该插件引擎模型的面板(任务不能换引擎时)；能换引擎时与内置任务同一个面板。
  const pluginEngineSessionActive = !!pluginEngineSession && !pluginEngines;
  const [keepOpenForAgentSwitch, setKeepOpenForAgentSwitch] = useState(false);
  const composerResizeGenerationRef = useRef(0);
  useProviderShareQuotaViewing(open || keepOpenForAgentSwitch);
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
      if (nextOpen && !wasOpen && providersOverrideState) {
        providersOverrideState.refresh();
      } else if (nextOpen && !wasOpen && !deviceId && !providersOverride && !pluginEngineSessionActive) {
        // 插件引擎任务的面板只列该引擎的模型，不读供应商目录，也就不触发目录发现。
        // SSH:远端 Codex 清单按需读取(首次打开才读),其余引擎照常刷新本机目录。
        sshCodexRefresh?.();
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
    [deviceId, disabled, discovery, resetDiscoveryPresentation, providersOverride, providersOverrideState, sshCodexRefresh,
      pluginEngineSessionActive],
  );

  const consumedOpenRequest = useRef(0);
  useEffect(() => {
    if (!openRequest || consumedOpenRequest.current === openRequest || disabled) return;
    consumedOpenRequest.current = openRequest;
    handleOpenChange(true);
    onOpenRequestConsumed?.(openRequest);
  }, [openRequest, disabled, handleOpenChange, onOpenRequestConsumed]);

  useEffect(() => {
    const composer = composerRef?.current;
    if (!composer || !(open || keepOpenForAgentSwitch) || typeof ResizeObserver === 'undefined') return;
    let width = composer.clientWidth;
    const observer = new ResizeObserver(() => {
      const nextWidth = composer.clientWidth;
      if (nextWidth === width) return;
      width = nextWidth;
      composerResizeGenerationRef.current += 1;
      setKeepOpenForAgentSwitch(false);
      handleOpenChange(false);
    });
    observer.observe(composer);
    return () => observer.disconnect();
  }, [composerRef, open, keepOpenForAgentSwitch, handleOpenChange]);

  // Keep the panel mounted while the switch intent is saved. A successful row
  // selection closes it; configuration edits and rejected writes leave it open.
  const contentSessionEngineFilter = useMemo(() => {
    if (!sessionEngineFilter) return undefined;
    const { onCrossEngineSelect } = sessionEngineFilter;
    const switchEngine = async (
      args: Parameters<typeof onCrossEngineSelect>[0],
      configuring: boolean,
    ): Promise<boolean> => {
      const resizeGeneration = composerResizeGenerationRef.current;
      setKeepOpenForAgentSwitch(true);
      try {
        const applied = await onCrossEngineSelect(args);
        // 配置浮层里的切换保持展开；选中模型行成功后才收起。
        if (composerResizeGenerationRef.current === resizeGeneration) {
          setOpenWithoutAutoRefresh(configuring || applied === false);
        }
        return applied !== false;
      } catch {
        if (composerResizeGenerationRef.current === resizeGeneration) setOpenWithoutAutoRefresh(true);
        return false;
      } finally {
        setKeepOpenForAgentSwitch(false);
      }
    };
    return {
      ...sessionEngineFilter,
      onCrossEngineSelect: (args: Parameters<typeof onCrossEngineSelect>[0]) =>
        switchEngine(args, false),
      onCrossEngineConfigure: (args: Parameters<typeof onCrossEngineSelect>[0]) =>
        switchEngine(args, true),
    };
  }, [sessionEngineFilter, setOpenWithoutAutoRefresh]);

  const agentKind = vendorKeyToAgentKind(agentIdentity?.vendorKey ?? vendorKey);
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
  const sshCodexProviders = sshCodex?.providers;
  const sshCatalogProviders = useMemo(
    () => (sshCodexProviders ? mergeSshCodexCatalog(localProviders.providers, sshCodexProviders) : null),
    [localProviders.providers, sshCodexProviders],
  );
  const localTaskProviders = useMemo(
    () => withFollowedAccountSource(localProviders.providers.map(withSubscriptionDisplayModels), taskSourceProvider ?? null),
    [localProviders.providers, taskSourceProvider],
  );
  const providers = deviceId
    ? remoteProviders.providers
    : providersOverride ?? sshCatalogProviders ?? localTaskProviders;
  // 当前是 SSH Codex 时 trigger 的加载 / 失败 / 来源都以远端清单为准;其余引擎仍看本机目录。
  const sshCodexCurrent = sshCodex !== undefined && agentKind === 'codex';
  // Old device-link hosts expose capabilities only. Never substitute local routes.
  const unifiedPanel = useUnifiedPanel && !(deviceId && remoteProviders.unsupported);
  const remoteModelListStatus = resolveRemoteModelListStatus({
    deviceId,
    agentKind,
    cc,
    codex,
    pi,
    providers: remoteProviders,
  });
  const remoteModelLoading = draftModelPending || providersOverrideState?.status === 'loading' ||
    (sshCodexCurrent && sshCodex?.status === 'loading') || (!!deviceId && remoteModelListStatus === 'loading');
  const localModelLoading = !deviceId && !providersOverride && !sshCodexCurrent && !localProviders.loadFailed && (
    localProviders.loading ||
    (agentKind === 'codex' ? codex.loading : agentKind === 'pi' ? pi.loading : cc.loading)
  );
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

  const routeProvider = currentProviderId ? providers.find((p) => p.id === currentProviderId) : undefined;
  const unconfirmedList = !!actualRoute && !deviceId && !providersOverride && !sshCodexCurrent &&
    routeProvider?.subscriptionReadUnavailable === true && !routeProvider.suspended && !routeProvider.removed;
  const routeModel = routeProvider && agentKind ? getModel(routeProvider, modelId, agentKind) : undefined;
  const currentModel = routeModel
    ? { ...routeModel, displayName: routeModel.name, id: modelId }
    : visibleModels.find((m) => m.id === modelId);
  // Keep directory refresh errors in the picker when the task model is known
  // and the selected engine still reports its capabilities.
  const agentCapabilities = agentKind === 'claude-code' ? cc : agentKind === 'codex' ? codex : pi;
  const confirmedRemoteModel = actualRoute && agentIdentity?.state === 'current' && !!currentModel &&
    agentCapabilities.capabilities != null && !agentCapabilities.error &&
    !isProviderAccessDeniedError(remoteProviders.error);
  const remoteModelLoadFailed = providersOverrideState?.status === 'error' ||
    (sshCodexCurrent && sshCodex?.status === 'error') ||
    (!!deviceId && remoteModelListStatus === 'error' && !confirmedRemoteModel);
  // Wire IDs can differ from catalog IDs during a switch. Resolve display metadata
  // through the existing alias lookup without changing routing/capability decisions.
  const displayProvider = agentKind
    ? modelDisplayProvider(providers, currentProviderId, modelId, agentKind, actualRoute)
    : undefined;
  // 目标目录(另一台电脑 / 共享供应商)已就绪却没有这个模型:新建草稿此刻回落到本机默认
  // 模型(PR #9369 review),名称也回本机目录取 —— trigger 显示真实名字而不是
  // 「模型信息暂不可用」。仅显示口径:路由 / 能力 / 面板候选仍只看目标目录;加载中与
  // 读取失败保持原有提示(失败态有重试入口,不做名称回退)。
  // 只限新建草稿(!actualRoute):已建会话的模型身份由目标目录决定,目标目录里没有这个
  // 模型时不能用本机同名模型的名字顶替 —— 路由与候选仍指向远端目标,名字却来自本机,
  // 会显示成一个「看着正常但其实不对」的模型。
  const localFallbackName = !actualRoute && deviceId && remoteModelListStatus === 'ready' && agentKind
    ? localProviders.providers
        .map((provider) => findCatalogModel(provider, modelId, agentKind, { exact: true })?.name)
        .find((name) => name !== undefined)
    : undefined;
  const catalogName = (agentKind ? findCatalogModel(displayProvider, modelId, agentKind)?.name : undefined)
    ?? currentModel?.displayName;
  const labelKey = JSON.stringify([deviceId ?? null, currentProviderId ?? null, agentKind, modelId]);
  const lastModelName = useRef<{ key: string; name: string | undefined } | null>(null);
  const modelName = catalogName
    ?? localFallbackName
    ?? (lastModelName.current?.key === labelKey ? lastModelName.current.name : undefined);
  useEffect(() => {
    // Retain only this selection's label through catalog refresh/failure. Never
    // borrow the previous model, source, engine or device's name for a new choice.
    // 只有**目录里查到的**名字进缓存:本机目录回退出来的名字不能进 —— 目录后来读失败时
    // 它会消失,而缓存里那份还在,trigger 就继续显示一个「看着可用」的本机型号,失败状态
    // (重试入口)被藏起来(Codex review #9369)。
    if (catalogName !== undefined) {
      lastModelName.current = { key: labelKey, name: catalogName };
    } else if (lastModelName.current?.key !== labelKey) {
      lastModelName.current = { key: labelKey, name: undefined };
    }
  }, [labelKey, catalogName]);
  const localizedName = modelName ? localizedModelName(modelName, t) : undefined;
  // Explicit diagnostic fields can supply unknownModelLabel; ordinary triggers
  // must not expose internal wire IDs when no display metadata is available.
  // unknown label 空串/全空白按缺省处理(否则 ?? 不回落,trigger 渲染成空白)。
  const unknownLabel = modelId && unknownModelLabel ? unknownModelLabel(modelId).trim() : '';
  const displayLabel = fallbackOption?.active
    ? fallbackOption.label
    : (localizedName ??
      (remoteModelLoading ? t('newChat.modelSelector.remoteLoading') : null) ??
      (remoteModelLoadFailed ? t('newChat.modelSelector.remoteLoadFailedShort') : null) ??
      (unknownLabel !== '' ? unknownLabel : null) ??
      (preserveDraftModel && modelId ? displayNameOfStoredModelId(modelId) : null) ??
      (unconfirmedList ? modelId : null) ??
      (modelId
        ? t(localModelLoading
            ? 'newChat.modelSelector.trigger.loading'
            : 'newChat.modelSelector.trigger.unresolved')
        : t('newChat.modelSelector.trigger.placeholder')));
  const agentName =
    agentIdentity && !fallbackOption?.active
      ? agentIdentity.vendorKey === 'cc'
        ? t('newChat.modelSelector.trigger.agent.claudeCode')
        : agentIdentity.vendorKey === 'pi'
          ? t('newChat.modelSelector.trigger.agent.pi')
          : t('newChat.modelSelector.trigger.agent.codex')
      : null;
  const baseDisplayIdentityLabel = agentName
    ? `${agentName} · ${displayLabel}`
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
  // 草稿没有已连接来源时显示连接 CTA；已建任务保留保存的模型和恢复入口。
  // device-link 远程会话不走此 CTA(控制端无法替被控端连来源;hasConnectedSource 是本机口径)。
  // SSH Codex 用远端主机自己的登录，本机有没有 Codex 来源与它无关。
  const noSource =
    !providersOverride &&
    !sshCodexCurrent &&
    !actualRoute &&
    !preserveDraftModel &&
    !!onProviderChange &&
    !!onNavigateToProviders &&
    !deviceId &&
    !!currentAgentKind &&
    !providersLoading &&
    !hasConnectedSource &&
    !providers.some(provider => !provider.suspended && !provider.removed &&
      provider.subscriptionDisplayModels?.[currentAgentKind]?.length);
  // trigger 上仍展示当前模型的 effort(模型支持时)。
  const triggerProvider = actualRoute && routeProvider
    ? routeProvider
    : providers.find((provider) => provider.id === activeSourceId);
  const triggerProviderModel = triggerProvider && currentAgentKind
    ? getModel(triggerProvider, modelId, currentAgentKind)
    : undefined;
  const activeThinkingToggle =
    currentAgentKind === 'pi' &&
    triggerProviderModel?.thinkingToggle === true;
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
  const triggerActiveProvider = triggerProvider;
  // trigger 图标的统一规则:当前 (来源, 模型) 条目的 icon(AI Gateway / 目录设定)优先,
  // 缺省回落来源供应商标 —— 与列表行、手机版同一套口径(ModelIconMark)。
  const triggerModelIcon = triggerProviderModel?.icon;
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
  const triggerFastOn = triggerFastSupported ? fastMode ?? false : false;
  // Saved partner routes have no task binding. Inspect the picker catalog once
  // it is ready, preserving the saved identity when its source disconnects.
  const canCheckSavedSource = checkSavedSource && !deviceId && !localModelLoading
    && !localProviders.loadFailed && !routeProvider?.subscriptionReadUnavailable;
  const movedAutoSource = canCheckSavedSource && currentAgentKind && modelId !== 'auto'
    && movedCindyAutoSourceId(providers, { agent: currentAgentKind, model: modelId, providerId: currentProviderId ?? null });
  const savedSourceDisconnected = canCheckSavedSource && !movedAutoSource && isSelectedSourceDisconnected({
    providers,
    agent: currentAgentKind,
    modelId,
    selectedProviderId: currentProviderId,
    providersLoading: false,
  });
  // 选着合并条目下的模型、或进行中的任务正由智能路由持续托管时，画路由角标并在 tooltip 标明所属路由。
  // 伙伴已保存的固定来源只有显式选择路由后才交给路由托管。
  const triggerRouting = resolveModelSelectorTriggerRouting({
    modelGroups,
    hasUnifiedSelect: !!onUnifiedSelect,
    providersOverride: !!providersOverride,
    sshCatalog: sshCodex !== undefined,
    checkSavedSource: !!checkSavedSource,
    currentProviderId,
    activeSourceId,
    modelId,
    agentDeviceId: remoteAgent?.selectedDeviceId ?? agentDevice?.deviceId ?? null,
    t,
  });
  const {
    effectiveTriggerModelGroup,
    activeSourceRouteName,
    activeManagedRouteName,
    activeRouteBadgeName,
    shownModelGroupRow,
  } = triggerRouting;
  // 已建任务的断开态保留模型身份；菜单同时提供重新连接与改选其他来源。
  // 草稿处于未隐藏的供应商路由下时，单个成员断开由路由在发送时改走其他可用成员，不误报整条断连。
  const showSourceDisconnected = !noSource && !!currentProviderId &&
    (savedSourceDisconnected || (sourceDisconnected && (actualRoute || !activeSourceRouteName)));
  // A connected provider lacking this model is unavailable, not signed out.
  const selectedSourceUnavailable = showSourceDisconnected && disconnectedProvider?.connected === true &&
    !!currentAgentKind && chatEligibleSourcesForModel([disconnectedProvider], modelId, currentAgentKind, { includeDisabled: true }).length === 0;
  const lastConfirmedAt = unconfirmedList ? routeProvider?.subscriptionModelsConfirmedAt : undefined;
  const showStaleList = unconfirmedList && (showSourceDisconnected || lastConfirmedAt !== undefined);
  // The read failed because the provider's service could not be reached: say that, not "not updated".
  const staleUnreachable = showStaleList && routeProvider?.subscriptionReadUnreachable === true;
  const showSourceIssue = showSourceDisconnected || showStaleList;
  const issueColor = showStaleList ? 'text-[var(--text-secondary)]' : 'text-[var(--error-fg)]';
  const IssueIcon = staleUnreachable ? WifiOff : showStaleList ? Clock3 : selectedSourceUnavailable ? CircleAlert : Unplug;
  const unreachableVendorKey = routeProvider?.subscriptionAccountPool
    ? PROVIDER_TITLE_KEY[routeProvider.subscriptionAccountPool] : undefined;
  const sourceIssueLabel = staleUnreachable
    ? t('newChat.modelSelector.source.unreachable', {
      source: unreachableVendorKey ? t(unreachableVendorKey) : routeProvider ? providerDisplayName(routeProvider, t) : currentProviderId,
    })
    : t(showStaleList ? 'newChat.modelSelector.source.unconfirmed' : selectedSourceUnavailable
      ? 'newChat.modelSelector.source.unavailable'
      : 'newChat.modelSelector.source.disconnected');
  // The panel header already names the source and account.
  const sourceIssueHeaderLabel = staleUnreachable ? t('newChat.modelSelector.source.unreachableDetail') : sourceIssueLabel;
  const baseAriaLabel = noSource
    ? t('newChat.modelSelector.source.connect')
    : showSourceIssue
      ? `${sourceIssueLabel}: ${displayIdentityLabel}`
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
  const describeSelection = (selection: SessionRuntimeProfileProjection): string => {
    const provider = modelDisplayProvider(providers, selection.providerId, selection.model, selection.agentKind, true);
    const model = findCatalogModel(provider, selection.model, selection.agentKind);
    const selectionKey = JSON.stringify([deviceId ?? null, selection.providerId, selection.agentKind, selection.model]);
    const name = selectionKey === labelKey ? localizedName : model?.name ? localizedModelName(model.name, t) : undefined;
    const vendor = selection.agentKind === 'claude-code' ? 'Claude Code' : selection.agentKind === 'pi' ? 'Pi' : 'Codex';
    return [vendor, name ?? t('newChat.modelSelector.trigger.placeholder'), provider ? providerDisplayName(provider, t) : selection.providerId,
      selection.effort ? modelEffortLabel(t, model, selection.effort) : null,
      selection.fastMode ? t(selection.fastMode === 'ultrafast' ? 'newChat.modelSelector.speed.ultrafast' : 'newChat.modelSelector.meta.fastBadge') : null].filter(Boolean).join(' · ');
  };
  const pendingSelectionTitle = currentSelection && agentIdentity?.state === 'pending' && currentAgentKind
    ? t('newChat.modelSelector.trigger.currentAndNext', {
        current: describeSelection(currentSelection),
        next: describeSelection({ agentKind: currentAgentKind, model: modelId, providerId: currentProviderId ?? null, effort: showEffort ? effort : null, fastMode: triggerFastOn }),
      })
    : null;
  // Agent 在另一台电脑运行:图标上的信号波纹之外,悬停 / 读屏也要说出是哪台。
  const agentDeviceLabel = activeManagedRouteName
    ? t('modelGroups.picker.managedBy', { name: activeManagedRouteName })
    : activeSourceRouteName
    ? t('modelGroups.picker.routeDecides', { name: activeSourceRouteName })
    : agentDevice
    ? agentDevice.name
      ? t('newChat.modelSelector.trigger.agentDevice', { device: agentDevice.name })
      : t('newChat.modelSelector.trigger.agentDeviceUnnamed')
    : null;
  const withAgentDeviceLabel = (label: string): string =>
    agentDeviceLabel ? `${label} · ${agentDeviceLabel}` : label;
  const activePluginModel = pluginModels?.active ?? null;
  const triggerTitleBase = withAgentDeviceLabel(pendingSelectionTitle
    ? `${pendingSelectionTitle}${showSourceIssue ? ` · ${sourceIssueLabel}` : ''}`
    : showSourceIssue ? baseAriaLabel : displayIdentityLabel);
  // 插件引擎(草稿里选中的引擎，或运行在插件引擎上的任务)：trigger 写「引擎名 · 模型」，
  // 不画任何内置 Harness 的名字或标志(docs/plans/acp-plugin-bridge.md)。已建任务待切到插件引擎时
  // 与内置引擎的意图一样写成「下条：引擎 · 模型」，前面带等待标记。
  const triggerEngine: {
    name: string;
    engine: PluginEngineChoice | null;
    modelId: string;
    effort: PluginEngineEffort | null;
    pending?: boolean;
  } | null = pluginEnginePending
    ? {
        name: pluginEnginePending.engineName,
        engine: pluginEnginePending.engine,
        modelId: pluginEnginePending.modelId,
        effort: resolvePluginEngineEffort(pluginEnginePending.engine, pluginEnginePending.modelId, pluginEnginePending.effort),
        pending: true,
      }
    : pluginEngineSession
    ? {
        name: pluginEngineSession.engineName,
        engine: pluginEngineSession.engine,
        modelId: pluginEngineSession.modelId,
        effort: resolvePluginEngineEffort(pluginEngineSession.engine, pluginEngineSession.modelId, pluginEngineSession.effort, 'session'),
      }
    : (() => {
        const active = pluginEngines?.active;
        const engine = active ? pluginEngines?.engines.find((item) => isSamePluginEngineChoice(item, active)) : undefined;
        return active
          ? {
              name: activeSourceRouteName
                ?? (engine ? pluginEngineChoiceLabel(engine) : t('newChat.pluginEngines.genericName')),
              engine: engine ?? null,
              modelId: active.modelId,
              effort: resolvePluginEngineEffort(engine, active.modelId, active.effort),
            }
          : null;
      })();
  // The engine's level reads like a built-in task's: compact name after the model, full name in the title.
  const triggerEngineEffortLabel = triggerEngine?.effort
    ? modelCompactEffortLabel(resolvedTranslationLanguage(i18n), t, null, triggerEngine.effort)
    : null;
  const triggerEngineFullEffortLabel = triggerEngine?.effort
    ? modelEffortLabel(t, null, triggerEngine.effort)
    : null;
  const triggerEngineKnownModelName = triggerEngine
    ? pluginEngineModelName(triggerEngine.engine, triggerEngine.modelId) ?? null
    : null;
  const triggerEngineModelLabel = triggerEngine
    ? triggerEngineKnownModelName
      ?? (!triggerEngine.modelId || triggerEngine.modelId === PLUGIN_ENGINE_DEFAULT_MODEL
        ? t('newChat.pluginEngines.defaultModel')
        // 引擎已不在或还没报告这个模型：不把内部 id 当名字显示。
        : t('newChat.modelSelector.trigger.unresolved'))
    : null;
  const triggerEngineIsDraftRoute = !!activeSourceRouteName && !pluginEnginePending && !pluginEngineSession;
  const triggerTitle = triggerEngine
    ? [
        triggerEngine.pending
          ? t('newChat.modelSelector.trigger.agent.pending', { agent: triggerEngine.name })
          : triggerEngine.name,
        triggerEngineModelLabel,
        triggerEngineFullEffortLabel,
        triggerEngineIsDraftRoute ? agentDeviceLabel : null,
      ].filter(Boolean).join(' · ')
    : activePluginModel
    ? `${activePluginModel.name} · ${activePluginModel.pluginName}`
    : shownModelGroupRow
      ? [shownModelGroupRow.name, shownModelGroupRow.hint].filter(Boolean).join(' · ')
      : triggerTitleBase;
  // 多实例同屏(IM 目录偏好)时前置「字段名 · 行别名」,读屏才能区分行与行。
  const accessibleLabel = triggerEngine
    ? triggerEngine.pending
      ? t('newChat.modelSelector.trigger.pendingAria', {
          agent: triggerEngine.name,
          model: [triggerEngineModelLabel, triggerEngineFullEffortLabel]
            .filter(Boolean).join(' · '),
        })
      : t('newChat.modelSelector.trigger.aria', { model: triggerTitle })
    : activePluginModel || shownModelGroupRow ? triggerTitle : (pendingSelectionTitle ? triggerTitle : withAgentDeviceLabel(baseAriaLabel));
  const ariaLabel = ariaContext ? `${ariaContext}:${accessibleLabel}` : accessibleLabel;
  const isBudget = isCodexGatewayWireModel(modelId);
  const isFieldTrigger = triggerVariant === 'field';
  const readableFieldPanel = isFieldTrigger && fieldPanelWidth === 'readable';
  const fieldPanelFollowsTrigger = isFieldTrigger && fieldPanelWidth === 'trigger';
  const isSettingsTrigger = triggerVariant === 'settings';
  const modelDescription = isSettingsTrigger && unknownLabel && !localizedName &&
    !remoteModelLoading && !remoteModelLoadFailed && !fallbackOption?.active
    ? unknownModelDescription : undefined;
  const modelLabelContent = modelDescription ? (
    <>
      <span>{modelId}</span>
      <span className="block text-12 leading-5 text-[var(--model-trigger-meta)]">
        {modelDescription}
      </span>
    </>
  ) : displayLabel;
  const isCreateAgentVariant = visualVariant === 'create-agent';
  // compact 是 composer 容器宽度状态，不是 create-agent 的视觉私有状态。
  // 正常会话在侧栏 + 浏览器 split-pane 下也必须让长模型名承担收缩。
  const isCompactToolbar = compactToolbar && !isFieldTrigger && !isSettingsTrigger;
  const isUltraCompactToolbar = ultraCompactToolbar && isCompactToolbar;
  // ── composer pill 的引擎小标(model-selector-unified §1.1)─────────────────────
  // 传了 engineMarkVendor 就走新形态:harness 名字文本让位给尾部的一枚 mark,和深度档字
  // 紧挨着收尾(与面板行右侧三元组同构)。没传的入口一个像素都不变。
  const engineMarkOption = engineMarkVendor ? agentOptionOf(engineMarkVendor) : null;
  // 引擎小标 + 深度在窄工具条下保留；极窄时让位给模型名。
  const showTriggerTail = (engineMarkOption || !!triggerEngine) ? !isUltraCompactToolbar : !isCompactToolbar;
  // 工具行真挤时，尾部整组让位给模型名（只看 composer 里的 trigger，不影响表单入口）。
  const pillLabelRef = useRef<HTMLSpanElement | null>(null);
  const collapseTriggerTail = useTailCollapse(
    showTriggerTail && !isFieldTrigger && !isSettingsTrigger,
    composerRef,
    pillLabelRef,
    `${dense}|${compactToolbar}|${ultraCompactToolbar}|${engineMarkVendor ?? ''}|${modelId}|${effort ?? ''}|${triggerFastOn}|${triggerEngine?.engine?.providerId ?? ''}|${triggerEngine?.modelId ?? ''}|${triggerEngine?.effort ?? ''}|${triggerEngine?.pending ? '1' : '0'}`,
  );
  const showTriggerTailContent = showTriggerTail && !collapseTriggerTail;
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
            : 'text-[var(--composer-pill-icon)]',
        )}
      />
    </span>
  ) : null;
  const agentIdentityPrefix =
    agentName &&
    !isCompactToolbar &&
    (!engineMarkOption || agentIdentity?.state === 'pending') ? (
      <>
        <span
          className={cn(
            'shrink-0 font-normal text-[var(--model-trigger-meta)]',
            isCreateAgentVariant ? 'text-12' : dense ? 'text-12' : 'text-13',
          )}
        >
          {agentName}
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
  const morphEnabled = useMorphPopover && !isFieldTrigger && !isSettingsTrigger;
  const shortcutEfforts = triggerProviderModel?.efforts ?? [];
  const splitEffortTrigger = showEffortShortcut && morphEnabled && configurationEnabled &&
    showTriggerTailContent && !!effortLabel && shortcutEfforts.length > 1 &&
    shortcutEfforts.some((level) => level === effort) && !!triggerProvider?.connected &&
    !triggerEngine && !activePluginModel && !effectiveTriggerModelGroup && !modelGroups?.managedMeta &&
    !noSource && !showSourceIssue && !remoteModelLoading && !remoteModelLoadFailed;
  const effortMenuLabel = t('newChat.modelSelector.effortLabel');
  const effortShortcutLabel = `${effortMenuLabel} · ${fullEffortLabel}`;
  const triggerAriaLabel = splitEffortTrigger
    ? t('newChat.modelSelector.trigger.aria', { model: displayIdentityLabel })
    : ariaLabel;
  const toolbarPillChrome =
    'rounded-full border border-transparent bg-transparent hover:border-[var(--border-default)] hover:bg-[var(--composer-pill-bg)]';
  const budgetGradientStyle: CSSProperties | undefined = isBudget
    ? {
        background: 'var(--model-budget-gradient)',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        color: 'transparent',
      }
    : undefined;

  // 远控被控电脑(catalogHostDeviceId 已选定)时，在草稿/会话就绪后立刻后台预热它名下的共享模型
  // 与远程来源目录(providers → capabilities)，避免点开选择器或切到共享来源时出现加载过程；
  // 本机任务不在启动时扇出，改在鼠标悬停/键盘聚焦触发器时预热，兼顾零启动风暴与首开速度。
  const controlledWarmKeys = useMemo(
    () => (remoteAgent?.catalogHostDeviceId
      ? orderedRemoteCatalogKeys(remoteAgent.devices, remoteAgent.catalogHostDeviceId)
      : []),
    [remoteAgent?.catalogHostDeviceId, remoteAgent?.devices],
  );
  const controlledWarmKeysKey = controlledWarmKeys.join('\n');
  useEffect(() => {
    if (disabled || !controlledWarmKeysKey) return;
    warmRemoteModelCatalogs(controlledWarmKeysKey.split('\n'));
  }, [disabled, controlledWarmKeysKey]);
  const triggerWarmKeys = useMemo(
    () => orderedRemoteCatalogKeys(remoteAgent?.devices, remoteAgent?.catalogHostDeviceId),
    [remoteAgent?.devices, remoteAgent?.catalogHostDeviceId],
  );
  const handleTriggerWarmIntent = useCallback(() => {
    if (disabled || switching || openRef.current || triggerWarmKeys.length === 0) return;
    warmRemoteModelCatalogs(triggerWarmKeys);
  }, [disabled, switching, triggerWarmKeys]);

  const trigger = (
    <button
      data-setting-id={settingId}
      type="button"
      disabled={switching || disabled}
      // 阻 mousedown 抢焦点 —— 否则点 pill 会先把光标从输入框挪走,选完模型后
      // 还要再点一次才能接着打字。键盘 Tab 仍可正常 focus。
      onMouseDown={morphEnabled ? (event) => event.preventDefault() : undefined}
      onPointerEnter={handleTriggerWarmIntent}
      onFocus={handleTriggerWarmIntent}
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
          : splitEffortTrigger
            ? 'h-full shrink overflow-hidden rounded-full pl-2.5 pr-0.5 hover:bg-[var(--surface-hover-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring-soft)]'
            : cn(
              // 裸态工具条(2026-07-22 用户定稿):默认无框,hover 才浮现胶囊外框。
              // create-agent(新建对话框)与会话内共用同一套裸态,不再分叉 —— 静息/hover 逐字一致。
              'max-w-full shrink px-2.5',
              isSettingsTrigger ? 'min-h-[30px] items-baseline py-1 text-left leading-5' : 'h-[30px] overflow-hidden',
              // 模型名按内容取宽，由工具行的剩余空间决定截断位置。
              isSettingsTrigger ? 'min-w-0' : 'min-w-[72px]',
              toolbarPillChrome,
            ),
        // device-link 远程切换 in-flight:置灰 + 禁用点击(复用本文件 disabled 行的 opacity-50 习惯)。
        (switching || disabled) && 'pointer-events-none opacity-50',
      )}
      aria-label={triggerAriaLabel}
    >
      {selectionPreparation ? (
        <span className="flex shrink-0 items-center gap-1 text-12 text-[var(--model-trigger-meta)]" role="status">
          {selectionPreparation === 'preparing' ? <Spinner size={12} /> : selectionPreparation === 'failed'
            ? <CircleAlert size={12} aria-hidden /> : <Clock3 size={12} aria-hidden />}
          {t(`newChat.modelSelector.preparation.${selectionPreparation}`)}
        </span>
      ) : (triggerEngine ? triggerEngine.pending : agentIdentity?.state === 'pending') && (
        <Clock3 size={dense ? 11 : 12} data-model-selection-pending aria-hidden className="shrink-0 text-[var(--model-trigger-meta)]" />
      )}
      {triggerEngine ? (
        <>
          <span data-plugin-engine-trigger className="flex shrink-0 items-center" aria-hidden="true">
            {triggerEngine.engine?.deviceId && !triggerEngineIsDraftRoute ? (
              // 引擎在自己的另一台电脑上：与远程供应商同一个信号波纹，图标大小与位置与内置 ModelIconMark 一致。
              <RemoteSourceMark
                markSize={isCreateAgentVariant ? 12 : dense ? 12.3 : 13}
                className={cn(
                  'mr-1.5',
                  isCreateAgentVariant
                    ? 'text-[var(--create-agent-control-icon)]'
                    : 'text-[var(--model-trigger-text)]',
                )}
              >
                <PluginEngineIcon
                  size={isCreateAgentVariant ? 12 : dense ? 12.3 : 13}
                  iconDataUrl={triggerEngine.engine.iconDataUrl}
                  className="text-current"
                />
              </RemoteSourceMark>
            ) : (
              <PluginEngineIcon
                size={isCreateAgentVariant ? 12 : dense ? 12.3 : 13}
                iconDataUrl={triggerEngine.engine?.iconDataUrl}
                className={cn(
                  'mr-1.5',
                  isCreateAgentVariant
                    ? 'text-[var(--create-agent-control-icon)]'
                    : 'text-[var(--model-trigger-text)]',
                )}
              />
            )}
          </span>
          {/* 与内置 composer trigger 保持一致：稳态且已知具体模型名时图标已表明引擎，不再前置「引擎名 ·」；
              待切引擎（下条：…）或仅有「默认模型」/不可用回退时保留引擎名前缀，完整「引擎 · 模型 · 深度」仍在 title / aria-label 里。 */}
          {!isCompactToolbar && (triggerEngine.pending || !triggerEngineKnownModelName) && (
            <>
              <span
                className={cn(
                  'min-w-0 max-w-[50%] truncate font-normal text-[var(--model-trigger-meta)]',
                  isCreateAgentVariant ? 'text-12' : dense ? 'text-12' : 'text-13',
                )}
              >
                {triggerEngine.pending
                  ? t('newChat.modelSelector.trigger.agent.pending', { agent: triggerEngine.name })
                  : triggerEngine.name}
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
          )}
          <span
            ref={pillLabelRef}
            className={cn(
              'min-w-0 font-normal',
              isSettingsTrigger
                ? 'whitespace-normal [overflow-wrap:anywhere]'
                : isCreateAgentVariant
                  ? 'truncate'
                  : isFieldTrigger
                    ? 'max-w-[260px] truncate'
                    : 'truncate',
              isCreateAgentVariant ? 'text-[var(--create-agent-control-text)]' : 'text-[var(--text-primary)]',
              isCreateAgentVariant ? 'text-12' : dense ? 'text-12' : 'text-13',
            )}
          >
            {triggerEngineModelLabel}
          </span>
          {triggerEngineEffortLabel && showTriggerTailContent && (
            <>
              <span
                className={cn(
                  'shrink-0 font-normal',
                  isCreateAgentVariant ? 'text-[var(--create-agent-control-text)]' : 'text-[var(--model-trigger-meta)]',
                  isCreateAgentVariant ? 'text-12' : dense ? 'text-12' : 'text-13',
                )}
                aria-hidden="true"
              >
                ·
              </span>
              <span
                data-plugin-engine-trigger-effort
                title={triggerEngineFullEffortLabel ?? undefined}
                className={cn(
                  'min-w-0 font-normal',
                  isCreateAgentVariant ? 'text-[var(--create-agent-control-text)]' : 'text-[var(--text-primary)]',
                  isSettingsTrigger
                    ? 'max-w-[40%] shrink-0 whitespace-normal [overflow-wrap:anywhere]'
                    : isCreateAgentVariant
                      ? 'truncate'
                      : isFieldTrigger
                        ? 'max-w-[120px] truncate'
                        : 'shrink-0 whitespace-nowrap',
                  isCreateAgentVariant ? 'text-12' : dense ? 'text-12' : 'text-13',
                )}
              >
                {triggerEngineEffortLabel}
              </span>
            </>
          )}
        </>
      ) : activePluginModel ? (
        <>
          <PluginModelIcon model={activePluginModel} size={14} />
          <span ref={pillLabelRef} className={cn('min-w-0 truncate font-medium text-[var(--text-primary)]', dense ? 'text-12' : 'text-13')}>
            {activePluginModel.name}
          </span>
        </>
      ) : shownModelGroupRow ? (
        <>
          <ModelGroupIcon size={14} />
          <span ref={pillLabelRef} className={cn('min-w-0 truncate font-medium text-[var(--text-primary)]', dense ? 'text-12' : 'text-13')}>
            {shownModelGroupRow.name}
          </span>
        </>
      ) : noSource ? (
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
              isSettingsTrigger
                ? 'whitespace-normal [overflow-wrap:anywhere]'
                : isCreateAgentVariant
                  ? 'truncate'
                  : cn('truncate', isFieldTrigger ? 'max-w-[260px]' : ''),
              isCreateAgentVariant ? 'text-12' : dense ? 'text-12' : 'text-13',
            )}
          >
            {t('newChat.modelSelector.source.connect')}
          </span>
        </>
      ) : showSourceIssue && currentProviderId ? (
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
            customIcon={disconnectedProvider?.customIcon}
            colorClass={issueColor}
          />
          {agentIdentityPrefix}
          <span
            ref={pillLabelRef}
            className={cn(
              'min-w-0 font-normal text-[var(--text-primary)]',
              isSettingsTrigger
                ? 'whitespace-normal [overflow-wrap:anywhere]'
                : isCreateAgentVariant
                  ? 'truncate'
                  : isFieldTrigger
                    ? 'max-w-[260px] truncate'
                    : 'truncate',
              isCreateAgentVariant ? 'text-12' : dense ? 'text-12' : 'text-13',
            )}
          >
            {modelLabelContent}
          </span>
          {/* 来源断开是**来源**的事,引擎身份位照常保留(规格 §1.2:引擎可见性靠一致的
              结构位,不靠出错才显示)。 */}
          {showTriggerTailContent && engineMarkNode}
          <IssueIcon size={dense ? 11 : 12} className={cn('ml-0.5 shrink-0', issueColor)} aria-hidden />
          {!isCompactToolbar && (
            <span
              className={cn(
                'shrink-0 font-medium', issueColor,
                dense ? 'text-11' : 'text-12',
              )}
            >
              {sourceIssueLabel}
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
          {/* 图标统一规则:模型条目 icon(AI Gateway / 目录设定)优先、缺省回落
              当前真正路由的来源标(activeSourceId)——客户端不按 model id 猜厂牌。 */}
          {activeSourceId && activeRouteBadgeName ? (
            // 选着合并整个供应商的路由下的模型或处于智能路由持续托管：画路由角标。
            <span className={cn('mr-1.5 inline-flex', isCreateAgentVariant ? 'text-[var(--create-agent-control-icon)]' : 'text-[var(--model-trigger-text)]')}>
              <RouteSourceMark markSize={14}>
                <ModelIconMark
                  icon={triggerModelIcon}
                  providerId={activeSourceId}
                  name={triggerActiveProvider?.name}
                  routing={triggerActiveProvider?.routing}
                  logoKind={triggerActiveProvider?.logoKind}
                  customIcon={triggerActiveProvider?.customIcon}
                  colorClass="text-current"
                  withMargin={false}
                />
              </RouteSourceMark>
            </span>
          ) : activeSourceId && agentDevice ? (
            // Agent 在另一台电脑:Logo 原大小原位置不变，右上角外侧叠信号波纹。
            <RemoteSourceMark
              className={cn(
                'mr-1.5',
                isCreateAgentVariant
                  ? 'text-[var(--create-agent-control-icon)]'
                  : 'text-[var(--model-trigger-text)]',
              )}
            >
              <ModelIconMark
                icon={triggerModelIcon}
                providerId={activeSourceId}
                name={triggerActiveProvider?.name}
                routing={triggerActiveProvider?.routing}
                logoKind={triggerActiveProvider?.logoKind}
                customIcon={triggerActiveProvider?.customIcon}
                colorClass="text-current"
                withMargin={false}
              />
            </RemoteSourceMark>
          ) : activeSourceId ? (
            <ModelIconMark
              icon={triggerModelIcon}
              providerId={activeSourceId}
              name={triggerActiveProvider?.name}
              routing={triggerActiveProvider?.routing}
              logoKind={triggerActiveProvider?.logoKind}
              customIcon={triggerActiveProvider?.customIcon}
              colorClass={
                isCreateAgentVariant ? 'text-[var(--create-agent-control-icon)]' : undefined
              }
            />
          ) : null}
          {agentIdentityPrefix}
          <span
            ref={pillLabelRef}
            className={cn(
              'min-w-0 font-normal',
              isSettingsTrigger
                ? 'whitespace-normal [overflow-wrap:anywhere]'
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
            {modelLabelContent}
          </span>
          {/* 引擎小标 + 深度 = pill 的收尾身份组(新形态,见 engineMarkVendor)。
              旧形态没有 mark,深度前保留「·」分隔;有 mark 时图标本身就是分隔,再加点
              会读成「模型 · 引擎 · 深度」三段。 */}
          {showTriggerTailContent && !splitEffortTrigger && engineMarkNode}
          {effortLabel && showTriggerTailContent && !splitEffortTrigger && (
            <>
              {/* 固定表单入口尾部没有引擎 mark 作视觉分隔时,
                  深度前补「·」—— 否则「名字 深度」贴着读会粘成一个词。 */}
              {!engineMarkOption && (
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
                // 尾部一旦显示就是给人看的身份组：名字被截断时整组让位（见 useTailCollapse），
                // 所以不再让档名自己缩成半个字；完整档名仍留在 title / aria-label 里。
                className={cn(
                  'min-w-0 font-normal',
                  isCreateAgentVariant
                    ? 'text-[var(--create-agent-control-text)]'
                    : 'text-[var(--text-primary)]',
                  isSettingsTrigger
                    ? 'max-w-[40%] shrink-0 whitespace-normal [overflow-wrap:anywhere]'
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
          {triggerFastOn && showTriggerTailContent && !splitEffortTrigger && (
            <SpeedIcon
              mode={triggerFastOn}
              size={isCreateAgentVariant ? 11 : dense ? 12 : 13}
              className={cn(
                'ml-0.5 shrink-0',
                isCreateAgentVariant
                  ? 'text-[var(--create-agent-control-icon)]'
                  : 'text-[var(--composer-pill-icon)]',
              )}
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
            : 'text-[var(--composer-pill-icon)]' /* spec 2026-07-17, token by 一哥 */,
          isFieldTrigger && 'ml-auto',
        )}
      />
    </button>
  );

  const content = pluginEngineSession && pluginEngineSessionActive ? (
    <PluginEngineSessionPanel
      picker={pluginEngineSession}
      disabled={switching || disabled}
      deviceId={deviceId}
      usageScope={!deviceId && providersOverride ? null : { deviceId: deviceId ?? null }}
      selectionPolicy={unifiedSelectionPolicy}
      onPicked={() => setOpenWithoutAutoRefresh(false)}
    />
  ) : (
    <>
      {showSourceIssue && (showStaleList || onReconnectSource) && !deviceId && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border-default)] px-3 py-2" role="status">
          <div className="min-w-0 text-12 text-[var(--text-secondary)]">
            <div className="truncate">{disconnectedProvider ? providerDisplayName(disconnectedProvider, t) : currentProviderId} · {sourceIssueHeaderLabel}</div>
            {lastConfirmedAt !== undefined && (
              <time dateTime={new Date(lastConfirmedAt).toISOString()}>
                {t('newChat.modelSelector.source.lastConfirmed', { time: new Date(lastConfirmedAt).toLocaleString(i18n.language) })}
              </time>
            )}
          </div>
          <button type="button" className="shrink-0 text-12 text-[var(--text-primary)] hover:underline"
            disabled={showStaleList && discovery.pending}
            onClick={() => {
              if (showStaleList && currentProviderId) {
                discovery.begin(() => currentProviderId === 'openai' || currentProviderId === 'anthropic'
                  ? window.electronAPI.maker.refreshBuiltinProviderModels(currentProviderId)
                  : window.electronAPI.maker.rediscoverModels(currentProviderId));
              } else {
                setOpenWithoutAutoRefresh(false);
                onReconnectSource?.();
              }
            }}>
            {t(showStaleList ? 'newChat.modelSelector.retryRemoteModels' : selectedSourceUnavailable ? 'newChat.modelSelector.source.manage' : 'newChat.modelSelector.source.reconnect')}
          </button>
        </div>
      )}
    <ModelSelectorContentView
      pickerOpen={open || keepOpenForAgentSwitch}
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
      {...(remoteAgent ? { remoteAgent } : { remoteAgent: undefined })}
      excludeSubscriptionDirect={excludeSubscriptionDirect}
      excludeChatBridgedCodex={excludeChatBridgedCodex}
      onDismiss={() => setOpenWithoutAutoRefresh(false)}
      actualRoute={actualRoute}
      subscriptionTaskId={subscriptionTaskId}
      taskStarted={taskStarted}
      maxVisibleModelRows={maxVisibleModelRows}
      currentProviderId={currentProviderId}
      onProviderChange={onProviderChange}
      onNavigateToProviders={onNavigateToProviders}
      configurationEnabled={configurationEnabled}
      fastModeConfigurable={fastModeConfigurable}
      providersOverride={providersOverride}
      providersOverrideState={providersOverrideState}
      {...(taskSourceProvider ? { taskSourceProvider } : {})}
      sshCodex={sshCodex}
      unifiedPanel={unifiedPanel}
      sessionEngineFilter={contentSessionEngineFilter}
      unifiedAgents={unifiedAgents}
      unifiedSelectionPolicy={unifiedSelectionPolicy}
      recordRecentUsage={recordRecentUsage}
      // 浏览其他电脑目录时的禁记门在 Content 内按 remoteAgent 派生(它才知道 remoteBrowse)。
      selectedFavoriteUid={selectedFavoriteUid}
      onSessionFavoriteAnchorChange={onSessionFavoriteAnchorChange}
      onUnifiedSelect={onUnifiedSelect}
      {...(pluginModels ? { pluginModels } : {})}
      {...(modelGroups ? { modelGroups } : {})}
      readModelGroupDevices={readModelGroupDevices}
      {...(pluginEngines ? { pluginEngines } : {})}
      reselectEmitsChange={reselectEmitsChange}
      selectedRowClickOpensConfiguration={selectedRowClickOpensConfiguration}
      pointerRevealRequiresIntent={morphEnabled}
      optionsPanelUsesLayoutPositioning={isCreateAgentVariant}
      fluidWidth={fieldPanelFollowsTrigger || readableFieldPanel}
      readableRows={readableFieldPanel}
      agentSwitch={agentSwitch}
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
    </>
  );

  if (morphEnabled) {
    return (
      <MorphPopover
        open={open || keepOpenForAgentSwitch}
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
        // rail 图标在指针底下移位。统一面板主体使用固定高度，仅随窗口可用空间收缩。
        stickyWidth
        panelAriaLabel={ariaLabel}
        {...(restoreFocusTarget ? { restoreFocusTarget } : {})}
        trigger={splitEffortTrigger ? (
          <span className={cn('inline-flex h-[30px] min-w-0 max-w-full items-center', toolbarPillChrome)}>
            {trigger}
            <DropdownMenu
              modal={false}
              onOpenChange={(next) => {
                if (next && openRef.current) setOpenWithoutAutoRefresh(false);
              }}
            >
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={switching || disabled}
                  aria-label={effortShortcutLabel}
                  title={effortShortcutLabel}
                  className={cn(
                    'flex h-full shrink-0 items-center gap-1 rounded-full pr-2.5 pl-1',
                    'text-[var(--text-primary)] hover:bg-[var(--surface-hover-soft)]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring-soft)] disabled:opacity-50',
                    dense ? 'text-12' : 'text-13',
                  )}
                >
                  {engineMarkNode}
                  {effortLabel}
                  {triggerFastOn && (
                    <SpeedIcon
                      mode={triggerFastOn}
                      size={dense ? 12 : 13}
                      className="ml-0.5 shrink-0 text-[var(--composer-pill-icon)]"
                    />
                  )}
                </button>
              </DropdownMenuTrigger>
              {/* Release the menu layer immediately so it can reopen while a save is pending. */}
              <DropdownMenuContent
                side={popoverSide}
                align="end"
                aria-label={effortMenuLabel}
                className="data-[state=closed]:animate-none"
              >
                <DropdownMenuRadioGroup value={effort}>
                  {shortcutEfforts.map((level) => (
                    <DropdownMenuRadioItem
                      key={level}
                      value={level}
                      onSelect={() => {
                        // The displayed effort may still be the old value while a write is queued.
                        void onEffortChange(level);
                      }}
                    >
                      {labelOf(level)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        ) : trigger}
      >
        <ProviderShareQuotaViewingContext.Provider value={open || keepOpenForAgentSwitch}>
          {content}
        </ProviderShareQuotaViewingContext.Provider>
      </MorphPopover>
    );
  }

  return (
    <ModelSelectorPopover
      open={open || keepOpenForAgentSwitch}
      onOpenChange={handleOpenChange}
      side={popoverSide}
      width={isFieldTrigger ? fieldPanelWidth : undefined}
      trigger={trigger}
    >
      {content}
    </ModelSelectorPopover>
  );
}

/** Shared popover for the picker, including settings rows that already have a display label. */
export function ModelSelectorPopover({ open, onOpenChange, side, width, trigger, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side: ModelSelectorBaseProps['popoverSide'];
  width?: ModelSelectorBaseProps['fieldPanelWidth'];
  trigger: React.ReactElement;
  children: React.ReactNode;
}) {
  const readable = width === 'readable';
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side={side}
        align="end"
        sideOffset={4}
        collisionPadding={readable ? 12 : 8}
        className={cn(
          readable ? 'w-[max(var(--radix-popover-trigger-width),440px)] max-w-[calc(100vw-24px)]'
            : width === 'trigger' ? 'w-[var(--radix-popover-trigger-width)]'
            : width ? 'w-auto min-w-[var(--radix-popover-trigger-width)]' : 'w-auto',
          'flex min-h-0 max-h-[var(--radix-popover-content-available-height)] flex-col overflow-hidden rounded-xl p-0',
          'bg-[var(--model-dropdown-bg)]',
          'border border-[var(--model-dropdown-border)]',
        )}
      >
        <ProviderShareQuotaViewingContext.Provider value={open}>
          {children}
        </ProviderShareQuotaViewingContext.Provider>
      </PopoverContent>
    </Popover>
  );
}
