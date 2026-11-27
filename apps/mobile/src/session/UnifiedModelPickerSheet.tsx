import { subscriptionQuotaOverview } from '@cindy/maker-shared/subscription-selection';
import { modelNeedsReselection } from './modelReselection';
import { mobileProviderAccountTitle } from "./mobileModelRowPresentation";
import { mobileCostMarks } from "./mobileModelRowPresentation";
import { formatQuotaResetCountdown } from "./sessionUsagePresentation";
import { useMobileModelQuotas } from "./useMobileModelQuotas";
import { useEffect, useMemo, useRef, useState } from "react";
import * as ExpoCrypto from "expo-crypto";
import {
  agentDeviceFavoriteSource,
  parseAgentDeviceFavoriteSource,
  parseProviderShareFavoriteSource,
  PLUGIN_ENGINE_FAVORITE_WIRE_AGENT,
  providerShareFavoriteWireKey,
} from "@cindy/device-link";
import { useTranslation } from "react-i18next";
import type { MobileProviderMarkProps } from "./MobileProviderMark";
import type { AgentKind } from "@cindy/model-providers/types";
import { listedSourceFolds, resolveStoredModelEntry, sameRunLocationProvider, type ProviderView, type UnifiedModelEntry } from "@cindy/model-providers";
import type { MobileAgentCapabilities } from "./agentCapabilities";
import type { ModelPickerSheetProps } from "./ModelPickerSheet";
import {
  buildPluginEngineGroups,
  formatPluginEngineModelQuotaLabel,
  formatPluginEnginePickerQuota,
  isPluginEngineFavoriteProviderId,
  isPluginEngineProviderId,
  isPluginEngineSelectable,
  isSamePluginEngineChoice,
  matchesPluginEngineFavoriteQuery,
  PLUGIN_ENGINE_DEFAULT_MODEL,
  pluginEngineChoiceKey,
  pluginEngineFilterId,
  pluginEngineModelRows,
  resolveMobilePluginEngineFavorite,
  resolvePluginEngineEffort,
  type MobilePluginEngine,
  type MobilePluginEngineSelection,
  type PluginEngineEffort,
  type UnifiedMobilePluginEngineGroup,
  type UnifiedMobilePluginEngineRow,
} from "./pluginEngines";
export { buildPluginEngineGroups, type UnifiedMobilePluginEngineGroup, type UnifiedMobilePluginEngineRow };
import { buildMobileModelSections } from "./providerModelSections";
import { useMobileModelPreferences } from "./mobileModelPreferences";
import {
  addModelFavorite,
  matchesEntry,
  mobileUnifiedEntries,
  listedMobileEntries,
  modelKey,
  resolveMobileModelConfig,
  sameConfiguration,
  type MobileModelConfiguration,
  type MobileModelFavorite,
} from "./unifiedMobileModels";
import {
  useDraftModelMemoryVersion,
  type MobileModelMemoryAccessors,
} from "./draftModelMemory";
import {
  hydrateRemoteAgentModelMemory,
  remoteAgentModelMemoryFor,
  useRemoteAgentModelMemoryVersion,
} from "./remoteAgentModelMemory";
import { useSessionModelMirrorVersion } from "./sessionModelMirror";
import { UnifiedModelPickerView } from "./UnifiedModelPickerView";
import { budgetRowDisabled, presentPickerPrice } from "./modelPickerRows";
import { mobileWeeklyQuota } from "./mobileModelRowPresentation";
import { mobileAgentLabel } from "./sessionAgentSwitch";
import type { RemoteAgentCatalog } from "./remoteAgentCatalogs";
import { isProviderShareAgentDeviceId } from "./providerShareAgentDevice";
import {
  collectMobileProviderGroups,
  providerGroupEntryKey,
  type MobileProviderGroupEntry,
  type MobileProviderGroups,
} from "./remoteProviderGroups";
import { remoteFilterId } from "./remoteSourceFilters";

const NO_REMOTE_CATALOGS: readonly RemoteAgentCatalog[] = [];

function remoteParameterOverride(
  memory: MobileModelMemoryAccessors | undefined,
  entry: UnifiedModelEntry,
  agents: readonly AgentKind[],
): boolean {
  if (!memory) return false;
  return agents.some((agent) => {
    const capability = entry.capabilities[agent];
    if (!capability) return false;
    const effort = memory.getEffort(agent, entry.providerId, capability.wireModelId);
    const fast = memory.getFast(agent, entry.providerId, capability.wireModelId);
    return (
      (effort !== undefined &&
        (!!memory.clearEffort ||
          effort !== (capability.defaultEffort ?? capability.efforts[0] ?? ""))) ||
      (fast !== undefined && (!!memory.clearFast || fast))
    );
  });
}

function rememberRemoteParameters(
  memory: MobileModelMemoryAccessors | undefined,
  entry: UnifiedModelEntry,
  config: MobileModelConfiguration,
  agents: readonly AgentKind[],
  reset: boolean,
): void {
  if (!memory) return;
  if (reset) {
    for (const agent of agents) {
      const capability = entry.capabilities[agent];
      if (!capability) continue;
      memory.clearEffort?.(agent, entry.providerId, capability.wireModelId);
      memory.clearFast?.(agent, entry.providerId, capability.wireModelId);
    }
    return;
  }
  if (config.effort) {
    memory.setEffort(config.agent, entry.providerId, config.modelId, config.effort);
  }
  memory.setFast(config.agent, entry.providerId, config.modelId, config.fast);
}
const NO_PROVIDER_GROUPS: MobileProviderGroups = {
  hidden: new Set(),
  sizes: new Map(),
  memberOf: new Map(),
};

function createFavoriteUid(): string {
  const cryptoWithUuid = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoWithUuid?.randomUUID === "function")
    return cryptoWithUuid.randomUUID();
  const expoWithUuid = ExpoCrypto as typeof ExpoCrypto & {
    randomUUID?: () => string;
  };
  if (typeof expoWithUuid.randomUUID === "function")
    return expoWithUuid.randomUUID();
  const bytes = ExpoCrypto.getRandomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 远程 Agent(已建任务):同账号其他电脑上开放了远程调用的供应商,接在被控电脑自己的供应商
 * 之后,每个供应商一段、标题带电脑名(与桌面模型面板同口径)。
 */
export interface UnifiedMobileRemoteOptions {
  catalogs: readonly RemoteAgentCatalog[];
  /** 当前选中态(下一条消息时 Agent 所在电脑)属于哪份目录;null = 被控电脑。 */
  selectedDeviceId: string | null;
  /**
   * 被控电脑的设备 id:按目录里的组摘要把组里其他电脑上的这个供应商收进组那一项,标题带台数
   * (provider-groups.md §10)。缺省 = 不收起。
   */
  hostDeviceId?: string;
  hostDeviceName?: string | null;
  /**
   * 已建任务:这个任务此刻归哪个组(null = 没归组)与 Agent 此刻在哪台、用哪个供应商(null = 被控电脑)。
   * 归组的任务在组那一项里显示为正在用的,在里面选模型 = 留在此刻运行的那台、只换模型。
   */
  providerGroup?: {
    bound: MobileProviderGroupEntry | null;
    running: { deviceId: string | null; providerId: string | null };
  };
}

/**
 * 每个入口都必须声明模型来源；remote 为 undefined 只表示此刻不可用（如旧版被控电脑）。
 * 手机端目前没有只限本机的入口；新增例外须同时改
 * docs/product-rules/model-selector-unified.md 与 modelPickerSourceGuard.test.ts。
 */
export type MobileModelPickerSource = { remote: UnifiedMobileRemoteOptions | undefined };

export type UnifiedMobilePickerOptions = UnifiedMobilePickerBaseOptions & MobileModelPickerSource;

export interface UnifiedMobilePickerBaseOptions {
  /** Request-owned edits, including favorites, never change persisted preferences. */
  preferenceScope?: 'request';
  /** Editing a selected row can update a draft without submitting the selection. */
  onConfigure?: UnifiedMobilePickerOptions['onSelect'];
  currentSelection?: Pick<
    ModelPickerSheetProps,
    | "agentKind"
    | "activeModelId"
    | "selectedProviderId"
    | "selectedEffort"
    | "selectedFastMode"
  >;
  scope: string;
  agents: readonly AgentKind[];
  loadCapabilities(agent: AgentKind): Promise<MobileAgentCapabilities>;
  /** source.deviceId = 这一行来自哪台电脑的目录(null / 缺省 = 被控电脑)。 */
  onSelect(
    configuration: MobileModelConfiguration,
    source?: { deviceId: string | null },
  ): Promise<boolean>;
  /**
   * 被控电脑上插件提供的执行引擎(Desktop docs/plans/acp-plugin-bridge.md)：「全部」里每个引擎
   * 一段，列在内置模型之前。只给能用插件引擎的入口传(被控电脑本机的普通任务 / 新任务)。
   */
  pluginEngines?: UnifiedMobilePluginEngineOptions;
  /**
   * 被控电脑上的模型组(model-groups.md §6.2)：「全部」最上方一段。只给能用模型组的入口传(伙伴模型设置)。
   */
  modelGroups?: UnifiedMobileModelGroupOptions;
}

export interface UnifiedMobileModelGroupRow {
  id: string;
  title: string;
  /** 来源数 · 选法 · 推理强度。 */
  subtitle: string;
  selected: boolean;
}

export interface UnifiedMobileModelGroupOptions {
  rows: readonly UnifiedMobileModelGroupRow[];
  /** 返回 false = 没有应用(选择器留在原地)。 */
  onSelect(id: string): Promise<boolean> | boolean;
}

export interface UnifiedMobilePluginEngineOptions {
  engines: readonly MobilePluginEngine[];
  /** 当前选中的引擎与模型(新任务的选择、插件引擎任务自己的引擎、或待切到的引擎)；null = 选的是内置模型。 */
  active: MobilePluginEngineSelection | null;
  /** 返回 false = 没有应用(选择器留在原地)。 */
  onSelect(selection: MobilePluginEngineSelection): Promise<boolean> | boolean;
  /** 仅调整当前已选中引擎的思考深度时使用（不关闭选择器）；缺省回落到 onSelect。 */
  onConfigure?(selection: MobilePluginEngineSelection): Promise<boolean> | boolean;
  /** 选择器打开时调用：读一次列表，请插件重新上报模型。 */
  onOpen?(): void;
}

export interface UnifiedMobileRow {
  key: string;
  entry: UnifiedModelEntry;
  config: MobileModelConfiguration;
  favorite?: MobileModelFavorite;
  selected: boolean;
  disabled: boolean;
  subtitle: string;
  sourceUnavailableReason?: string;
  costMarks: string | null;
  effortLabel: string;
  quotaLabel: string | null;
  providerMark: MobileProviderMarkProps;
  /** 这一行来自哪台其他电脑的目录(图标带远程标记);缺省 = 被控电脑自己的。 */
  remoteDevice?: { deviceId: string; name: string };
}
export interface UnifiedMobileQuota {
  remaining?: number;
  label: string;
  summary?: string;
  resetSoon?: boolean;
  reset?: { remaining: number; time: string; level: 'normal' | 'warn' | 'crit' };
  resetParts?: string[];
  resetDescription?: string;
  members?: { remaining?: number; label: string }[];
}
export type UnifiedMobileFavoriteItem =
  | { kind: "model"; row: UnifiedMobileRow }
  | { kind: "pluginEngine"; row: UnifiedMobilePluginEngineRow };

export interface UnifiedMobileGroup {
  key: string;
  title: string;
  rows: UnifiedMobileRow[];
  /** 收藏区混排内置模型与插件引擎收藏时保留原始添加顺序。 */
  items?: UnifiedMobileFavoriteItem[];
  quota?: UnifiedMobileQuota;
}
export interface UnifiedMobilePickerViewProps {
  visible: boolean;
  onClose(): void;
  onClosed?(): void;
  onBack?: () => void;
  title: string;
  testID: string;
  query: string;
  onQuery(value: string): void;
  filter: string;
  onFilter(value: string): void;
  filters: {
    id: string;
    label: string;
    providerMark?: MobileProviderMarkProps;
    pluginEngineMark?: { name: string; iconDataUrl?: string };
    quota?: UnifiedMobileQuota;
    sourceUnavailableReason?: string;
    /**
     * 另一台电脑上的供应商:来源页里每台电脑单独一块(块标题 = 电脑名,行标题 = providerLabel),
     * 图标带远程标记;label 是带电脑名的完整说法,用在搜索栏旁的来源按钮上。
     */
    remote?: { deviceId: string; deviceName: string; providerLabel: string };
  }[];
  groups: UnifiedMobileGroup[];
  /** 模型组(列在插件引擎与 groups 之前)；搜索时只列命中的。 */
  modelGroups?: {
    title: string;
    rows: readonly UnifiedMobileModelGroupRow[];
    onSelect(id: string): void;
  };
  /** 插件引擎分组(列在内置模型之前)；effort 只改思考深度、不关闭选择器；onOptions 打开配置/收藏详情页。 */
  pluginEngines?: {
    groups: UnifiedMobilePluginEngineGroup[];
    onSelect(row: UnifiedMobilePluginEngineRow, effort?: PluginEngineEffort): void;
    onOptions?(row: UnifiedMobilePluginEngineRow): void;
  };
  busy: boolean;
  error: string | null;
  loading: boolean;
  emptyHint: string;
  onSelect(row: UnifiedMobileRow): void;
  onOptions(row: UnifiedMobileRow): void;
  options?: {
    row: UnifiedMobileRow;
    agents: AgentKind[];
    fastCapable: boolean;
    onChange(config: MobileModelConfiguration): void;
    favoritesDisabled: boolean;
    isFavorite?: boolean;
    canReset?: boolean;
    configurationSummary?: string;
    notice?: string | null;
    editingFavorite?: boolean;
    onEditFavorite?(): void;
    onCancelEdit?(): void;
    onSaveEdit?(): void;
    onFavorite(): void;
    onReset(): void;
    context: string;
    price: string | null;
  };
  pluginEngineOptions?: {
    row: UnifiedMobilePluginEngineRow;
    context: string;
    effort: PluginEngineEffort | null;
    efforts: PluginEngineEffort[];
    onChangeEffort(effort: PluginEngineEffort): void;
    favoritesDisabled: boolean;
    isFavorite: boolean;
    configurationSummary: string;
    notice?: string | null;
    editingFavorite: boolean;
    onEditFavorite?: () => void;
    onCancelEdit?: () => void;
    onSaveEdit?: () => void;
    onFavorite(): void;
  };
}
const ALL_AGENTS: readonly AgentKind[] = ["claude-code", "codex", "pi"];
const PLUGIN_ENGINE_MOBILE_WIRE_AGENT: AgentKind =
  PLUGIN_ENGINE_FAVORITE_WIRE_AGENT === "cc" ? "claude-code" : PLUGIN_ENGINE_FAVORITE_WIRE_AGENT;
export function UnifiedModelPickerSheet(
  p: ModelPickerSheetProps & { unified: UnifiedMobilePickerOptions },
) {
  const { t, i18n } = useTranslation();
  const { quotas, pluginEngineQuotas, now, quotaOf } = useMobileModelQuotas(
    p.unified.scope,
    p.visible,
    p.providers,
    p.unified.remote?.catalogs ?? NO_REMOTE_CATALOGS,
    p.subscriptionTaskId,
    p.unified.pluginEngines?.engines,
  );
  const prefs = useMobileModelPreferences(p.unified.scope, p.visible, p.unified.preferenceScope === 'request');
  const rememberRemote = p.unified.preferenceScope !== 'request';
  useDraftModelMemoryVersion();
  useSessionModelMirrorVersion();
  useRemoteAgentModelMemoryVersion();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [target, setTarget] = useState<{
    providerId: string;
    modelId: string;
    uid?: string;
    config?: MobileModelConfiguration;
    /** 另一台电脑目录里的行;缺省 = 被控电脑的。 */
    deviceId?: string;
  } | null>(null);
  // 另一台电脑的 effort / Fast 按那台电脑单独记在手机上。引擎调整没有独立记忆,
  // 仍然只在这次打开期间跟着该行。
  const [remoteConfigs, setRemoteConfigs] = useState<
    ReadonlyMap<string, MobileModelConfiguration>
  >(new Map());
  // 打开时 Agent 在另一台电脑:目录读到后停在那台电脑的当前供应商上(用户先手动换过就不再跳)。
  const initialRemoteFilter = useRef(false);
  // 用户这次打开后自己点过来源:归组的任务读回来得晚,也不再把列表挪到组那一项。
  const filterTouched = useRef(false);
  const [favoriteEdit, setFavoriteEdit] = useState<{
    original: MobileModelFavorite;
    config: MobileModelConfiguration;
  } | null>(null);
  const [pluginTarget, setPluginTarget] = useState<{
    providerId: string;
    deviceId?: string;
    modelId: string;
    uid?: string;
    effort?: PluginEngineEffort | null;
  } | null>(null);
  // 未选中的插件引擎模型在详情页调整思考深度后，在本次选择器打开期间保留，返回列表与点击选择继续生效。
  const [pluginEfforts, setPluginEfforts] = useState<
    ReadonlyMap<string, PluginEngineEffort>
  >(new Map());
  const [pluginFavoriteEdit, setPluginFavoriteEdit] = useState<{
    original: MobileModelFavorite;
    effort: PluginEngineEffort | null;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [caps, setCaps] = useState<
    Partial<Record<AgentKind, MobileAgentCapabilities>>
  >({});
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const opening = useRef(0);
  const [error, setError] = useState<string | null>(null);
  // 选择器打开：读一次插件引擎列表，并请那台电脑的插件重新上报模型(不轮询；每次打开同 scope 最多触发一次)。
  const pluginEngineOptions = p.unified.pluginEngines;
  const onPluginEnginesOpen = pluginEngineOptions?.onOpen;
  const onPluginEnginesOpenRef = useRef(onPluginEnginesOpen);
  onPluginEnginesOpenRef.current = onPluginEnginesOpen;
  const pluginEnginesOpenedScopeRef = useRef<string | null>(null);
  const hasOnPluginEnginesOpen = !!onPluginEnginesOpen;
  useEffect(() => {
    if (!p.visible) {
      pluginEnginesOpenedScopeRef.current = null;
      return;
    }
    if (!hasOnPluginEnginesOpen || pluginEnginesOpenedScopeRef.current === p.unified.scope) return;
    pluginEnginesOpenedScopeRef.current = p.unified.scope;
    onPluginEnginesOpenRef.current?.();
  }, [p.visible, p.unified.scope, hasOnPluginEnginesOpen]);
  // 选中的是插件引擎时，内置模型行都不显示选中态(也不列「推荐」)。
  const pluginEngineActive = !!pluginEngineOptions?.active;
  // 选中的是模型组时同理：只有组那一行打勾，具体模型行不打勾、不列「推荐」，打开时停在顶部(和桌面一致)。
  const modelGroupActive = !!p.unified.modelGroups?.rows.some((row) => row.selected);
  const otherChoiceActive = pluginEngineActive || modelGroupActive;
  useEffect(() => {
    if (!p.visible) return;
    if (rememberRemote) void hydrateRemoteAgentModelMemory();
    opening.current += 1;
    setQuery("");
    setFilter("all");
    initialRemoteFilter.current = true;
    filterTouched.current = false;
    setTarget(null);
    setPluginTarget(null);
    setPluginEfforts(new Map());
    setRemoteConfigs(new Map());
    setFavoriteEdit(null);
    setPluginFavoriteEdit(null);
    setNotice(null);
    setError(null);
    let cancelled = false;
    setCaps({ [p.agentKind]: p.capabilities });
    for (const agent of p.unified.agents)
      void p.unified
        .loadCapabilities(agent)
        .then((value) => {
          if (!cancelled)
            setCaps((current) => ({ ...current, [agent]: value }));
        })
        .catch(() => {
          /* The catalog remains visible; selecting retries the authoritative read. */
        });
    return () => {
      cancelled = true;
      opening.current += 1;
    };
  }, [p.visible, p.unified.scope, rememberRemote]);
  const remoteCatalogs = p.unified.remote?.catalogs ?? NO_REMOTE_CATALOGS;
  /** 选中态属于哪台其他电脑的目录;null = 被控电脑自己的(含没有远程 Agent 的情况)。 */
  const selectedDeviceId = p.unified.remote?.selectedDeviceId ?? null;
  const keepModel = useMemo(
    () => ({
      providerId: p.selectedProviderId,
      modelId: p.activeModelId,
      agent: p.agentKind,
    }),
    [p.selectedProviderId, p.activeModelId, p.agentKind],
  );
  // 供应商组(provider-groups.md §10):组里其他电脑上的这个供应商收进组那一项,只列组那一项。
  const hostDeviceId = p.unified.remote?.hostDeviceId;
  const providerGroups = useMemo(
    () =>
      hostDeviceId
        ? collectMobileProviderGroups({
            hostDeviceId,
            hostProviders: p.providers,
            catalogs: remoteCatalogs,
          })
        : NO_PROVIDER_GROUPS,
    [hostDeviceId, p.providers, remoteCatalogs],
  );
  // 任务归的组那一项此刻在列表里(组所在电脑在线、组还在)才按组显示。此刻不在组那一项本身上运行时
  // (被组分到或换到了组里另一台),组那一项显示为正在用的,在里面选模型 = 留在那台只换模型。
  const groupInfo = p.unified.remote?.providerGroup;
  const boundCandidate = groupInfo?.bound ?? null;
  const boundEntry =
    boundCandidate &&
    providerGroups.sizes.has(
      providerGroupEntryKey(boundCandidate.deviceId, boundCandidate.providerId),
    )
      ? boundCandidate
      : null;
  const stayInGroup =
    !!boundEntry &&
    !!groupInfo?.running.providerId &&
    !(
      boundEntry.deviceId === groupInfo.running.deviceId &&
      boundEntry.providerId === groupInfo.running.providerId
    );
  const boundGroup = stayInGroup ? boundEntry : null;
  const boundKeepModel = useMemo(
    () =>
      boundGroup ? { ...keepModel, providerId: boundGroup.providerId } : undefined,
    [boundGroup, keepModel],
  );
  const entries = useMemo(
    () =>
      mobileUnifiedEntries(
        p.providers,
        p.unified.agents,
        p.modelVisibilityOverrides,
        !!p.existingSessionRoute,
        boundGroup?.deviceId === null
          ? boundKeepModel
          : selectedDeviceId === null
            ? keepModel
            : undefined,
      ),
    [
      p.providers,
      p.unified.agents,
      p.modelVisibilityOverrides,
      p.existingSessionRoute,
      keepModel,
      boundKeepModel,
      boundGroup,
      selectedDeviceId,
    ],
  );
  /** Agent 下一条消息时所在的那台电脑上正在用的来源(那台在组里被收起时照样算出来,用来停在组那一项)。 */
  const selectedCatalog = selectedDeviceId
    ? remoteCatalogs.find((catalog) => catalog.deviceId === selectedDeviceId)
    : undefined;
  const selectedSourceId =
    selectedCatalog && selectedCatalog.providers.length > 0
      ? buildMobileModelSections({
          providers: selectedCatalog.providers,
          agentKind: p.agentKind,
          selectedModelId: p.activeModelId,
          selectedProviderId: p.selectedProviderId,
          existingSessionRoute: p.existingSessionRoute,
          visibilityOverrides: selectedCatalog.modelVisibilityOverrides,
        }).activeSourceId
      : null;
  // 另一台电脑的目录:每台按自己的供应商与可见性派生,选中态只落在 Agent 所在那台(那台被收进组里时
  // 不在任何一行上;归组的任务落在组那一项上)。
  const remoteDirectories = useMemo(
    () =>
      remoteCatalogs.flatMap((catalog) => {
        const providers = catalog.providers.filter(
          (provider) =>
            !providerGroups.hidden.has(
              providerGroupEntryKey(catalog.deviceId, provider.id),
            ),
        );
        if (providers.length === 0) return [];
        const selectedHere = catalog.deviceId === selectedDeviceId;
        const boundHere = boundGroup?.deviceId === catalog.deviceId;
        const visibleSource =
          selectedHere &&
          selectedSourceId &&
          providers.some((provider) => provider.id === selectedSourceId)
            ? selectedSourceId
            : null;
        return [
          {
            catalog: providers.length === catalog.providers.length
              ? catalog
              : { ...catalog, providers },
            entries: mobileUnifiedEntries(
              providers,
              p.unified.agents,
              catalog.modelVisibilityOverrides,
              !!p.existingSessionRoute,
              boundHere ? boundKeepModel : selectedHere ? keepModel : undefined,
            ),
            sourceId: boundHere ? boundGroup!.providerId : visibleSource,
          },
        ];
      }),
    [
      remoteCatalogs,
      providerGroups,
      selectedDeviceId,
      selectedSourceId,
      boundGroup,
      keepModel,
      boundKeepModel,
      p.unified.agents,
      p.existingSessionRoute,
    ],
  );
  // Presentation only: keep complete catalogs for favorites and the task's saved route.
  // Same rule as desktop Settings and the desktop picker (listedSourceFolds), based on the browsed computer.
  const { hiddenSources, unavailableBaseByRemoteSource } = useMemo(() => {
    const folds = listedSourceFolds({
      base: p.providers,
      baseExempt: (providerId) => providerGroups.sizes.has(providerGroupEntryKey(null, providerId)),
      others: remoteCatalogs
        .filter(catalog => !isProviderShareAgentDeviceId(catalog.deviceId) && !catalog.offline)
        .map(catalog => ({
          deviceId: catalog.deviceId,
          providers: catalog.providers.filter(provider =>
            !providerGroups.sizes.has(providerGroupEntryKey(catalog.deviceId, provider.id))
            && !providerGroups.hidden.has(providerGroupEntryKey(catalog.deviceId, provider.id))),
        })),
      current: p.selectedProviderId ? { deviceId: selectedDeviceId, providerId: p.selectedProviderId } : null,
      honorRunLocation: true,
    });
    const hidden = new Set(folds.hiddenBase);
    for (const [deviceId, ids] of folds.hiddenOther) for (const id of ids) hidden.add(remoteFilterId(deviceId, id));
    return { hiddenSources: hidden, unavailableBaseByRemoteSource: folds.askBeforeUse };
  }, [p.providers, p.selectedProviderId, providerGroups, remoteCatalogs, selectedDeviceId]);
  const sourceId =
    boundGroup?.deviceId === null
      ? boundGroup.providerId
      : selectedDeviceId === null
        ? buildMobileModelSections({
            providers: p.providers,
            agentKind: p.agentKind,
            selectedModelId: p.activeModelId,
            selectedProviderId: p.selectedProviderId,
            existingSessionRoute: p.existingSessionRoute,
            visibilityOverrides: p.modelVisibilityOverrides,
          }).activeSourceId
        : null;
  const selection: MobileModelConfiguration = {
    providerId: sourceId ?? "",
    modelId: p.activeModelId,
    agent: p.agentKind,
    effort: p.selectedEffort,
    fast: p.selectedFastMode,
  };
  // The visible selection may belong to a pending next-message engine switch.
  // Resolve the running configuration separately when editing its favorite.
  const current = p.unified.currentSelection;
  const live: MobileModelConfiguration = current
    ? {
        providerId:
          buildMobileModelSections({
            providers: p.providers,
            agentKind: current.agentKind,
            selectedModelId: current.activeModelId,
            selectedProviderId: current.selectedProviderId,
            existingSessionRoute: p.existingSessionRoute,
            visibilityOverrides: p.modelVisibilityOverrides,
          }).activeSourceId ?? "",
        modelId: current.activeModelId,
        agent: current.agentKind,
        effort: current.selectedEffort,
        fast: current.selectedFastMode,
      }
    : selection;
  const fastCapable = (agent: AgentKind) => caps[agent]?.hasFastMode === true;
  const effortText = (config: MobileModelConfiguration) =>
    config.effort
      ? t(`models.options.effortLevels.${config.effort}`, {
          defaultValue: config.effort,
        })
      : "";
  const accountQuotaOf = (providerId: string, sourceDeviceId?: string) =>
    sourceDeviceId ? quotaOf(sourceDeviceId, providerId) : quotas[providerId];
  const accountIdentityOf = (providerId: string, sourceDeviceId?: string) => {
    const quota = accountQuotaOf(providerId, sourceDeviceId);
    if (quota?.members?.length) return t('models.unified.accountCount', { count: quota.members.length });
    // null: still reading, failed, or nothing assignable. The account is assigned when the
    // message is sent, so name none here; "" also keeps the CLI default account from showing.
    const identity = quota?.accountIdentity;
    return identity === null ? "" : identity;
  };
  const describe = (
    entry: UnifiedModelEntry,
    config: MobileModelConfiguration,
    providers: readonly (typeof p.providers)[number][] = p.providers,
    sourceDeviceId?: string,
  ) => {
    const provider = providers.find((item) => item.id === entry.providerId);
    const identity = accountIdentityOf(entry.providerId, sourceDeviceId) ?? (
      provider?.openAiAccount?.identity?.trim() || provider?.subscriptionAccount?.identity?.trim());
    return [identity, effortText(config)].filter(Boolean).join(" · ");
  };
  const modelQuotaLabel = (providerId: string, modelId: string, deviceId?: string) => {
    const q = accountQuotaOf(providerId, deviceId);
    if (q?.members?.length) return null;
    const modelQuota = q
      ? mobileWeeklyQuota(q.source, q.raw, now, modelId)
      : null;
    return modelQuota
      ? [
          modelQuota.resetsAt
            ? formatQuotaResetCountdown(
                modelQuota.resetsAt,
                now,
                t,
                modelQuota.windowMinutes,
              )
            : null,
          `${modelQuota.remaining}%`,
        ]
          .filter(Boolean)
          .join(" · ")
      : null;
  };
  const makeRow = (
    entry: UnifiedModelEntry,
    favorite?: MobileModelFavorite,
  ): UnifiedMobileRow => {
    const provider = p.providers.find((item) => item.id === entry.providerId);
    const selected =
      entry.providerId === sourceId && matchesEntry(entry, p.activeModelId);
    const config = resolveMobileModelConfig(entry, {
      favorite,
      live: !favorite && selected ? selection : undefined,
      pinned: p.existingSessionRoute ? p.agentKind : undefined,
      override: prefs.value.engines[modelKey(entry.providerId, entry.modelId)],
      memory: p.modelMemory,
      fastCapable,
    });
    return {
      key: favorite?.uid ?? modelKey(entry.providerId, entry.modelId),
      entry,
      config,
      favorite,
      providerMark: {
        providerId: entry.providerId,
        name: provider?.name ?? entry.providerId,
        routing: provider?.routing,
        logoKind: provider?.logoKind,
        customIcon: provider?.customIcon,
      },
      selected: !favorite && selected && !otherChoiceActive,
      disabled:
        !caps[config.agent] ||
        budgetRowDisabled(
          config.modelId,
          p.apiKeyStatus ?? "unknown",
          provider,
        ),
      subtitle: describe(entry, config),
      sourceUnavailableReason: sourceUnavailableReason(provider, null),
      effortLabel: effortText(config),
      costMarks: mobileCostMarks(
        provider,
        config.modelId,
        config.agent,
        p.pricing,
      ),
      quotaLabel: modelQuotaLabel(entry.providerId, entry.modelId),
    };
  };
  // 供应商组只写组里有几台,不写是哪几台(provider-groups.md §10):「Claude · 供应商组 · 3 台电脑」。
  const groupBadge = (deviceId: string | null, id: string) => {
    const size = providerGroups.sizes.get(providerGroupEntryKey(deviceId, id));
    return size === undefined
      ? null
      : t("models.unified.groupBadge", { count: size });
  };
  const withGroupBadge = (deviceId: string | null, id: string, name: string) => {
    const group = groupBadge(deviceId, id);
    return group
      ? t("models.unified.providerGroup", { provider: name, group })
      : name;
  };
  const providerName = (id: string) => {
    const provider = p.providers.find((item) => item.id === id);
    if (!provider) return id;
    return withGroupBadge(null, id, mobileProviderAccountTitle(provider, accountIdentityOf(id)));
  };
  // 另一台电脑目录里的供应商,说法带电脑名(「Claude 订阅 · 工作室 Mac」)。
  const remoteAccountTitle = (catalog: RemoteAgentCatalog, id: string) => {
    const provider = catalog.providers.find((item) => item.id === id);
    return provider ? mobileProviderAccountTitle(provider, accountIdentityOf(id, catalog.deviceId)) : id;
  };
  const remoteProviderName = (catalog: RemoteAgentCatalog, id: string) =>
    withGroupBadge(catalog.deviceId, id, remoteAccountTitle(catalog, id));
  const remoteProviderLabel = (catalog: RemoteAgentCatalog, id: string) => {
    const values = {
      provider: remoteAccountTitle(catalog, id),
      device: catalog.name,
    };
    const group = groupBadge(catalog.deviceId, id);
    return group
      ? t("models.unified.remoteProviderGroup", { ...values, group })
      : t("models.unified.remoteProvider", values);
  };
  const runningDeviceId = groupInfo?.running.deviceId ?? null;
  const runningCatalog = remoteCatalogs.find(catalog =>
    catalog.deviceId === runningDeviceId && !isProviderShareAgentDeviceId(catalog.deviceId));
  const runningProviders = runningDeviceId === null ? p.providers : runningCatalog?.providers;
  const unavailableRunningProvider = runningProviders?.find(provider =>
    provider.id === groupInfo?.running.providerId
    && (!provider.connected || provider.suspended || provider.removed || runningCatalog?.offline));
  const unavailableOn = (provider: string, device?: string | null) => device
    ? t("models.unified.remoteCopyUnavailableOn", { provider, device })
    : t("models.unified.remoteCopyUnavailableOnTaskComputer", { provider });
  const sourceUnavailableReason = (target: ProviderView | undefined, deviceId: string | null) => {
    if (!p.existingSessionRoute || !target) return undefined;
    // The running source remains authoritative until the next send applies the selection.
    if (unavailableRunningProvider && runningDeviceId !== deviceId
      && !isProviderShareAgentDeviceId(deviceId)
      && target.connected && !target.suspended && !target.removed
      && !providerGroups.sizes.has(providerGroupEntryKey(deviceId, target.id))
      && sameRunLocationProvider(unavailableRunningProvider, target)) {
      return runningCatalog
        ? unavailableOn(remoteProviderName(runningCatalog, unavailableRunningProvider.id), runningCatalog.name)
        : unavailableOn(providerName(unavailableRunningProvider.id), p.unified.remote?.hostDeviceName);
    }
    const baseProviderId = runningDeviceId === null && deviceId
      ? unavailableBaseByRemoteSource.get(`${deviceId}\n${target.id}`)
      : undefined;
    return baseProviderId ? unavailableOn(providerName(baseProviderId), p.unified.remote?.hostDeviceName) : undefined;
  };
  // Providers hidden from the picker stay in `entries` for favorites; only the regular list drops them.
  const currentPick = { providerId: p.selectedProviderId, modelId: p.activeModelId };
  const allRows = entries.map((entry) => makeRow(entry));
  const listedLocal = new Set(listedMobileEntries(entries, p.providers, selectedDeviceId === null ? currentPick : null));
  const rows = allRows.filter((row) => listedLocal.has(row.entry));
  const makeRemoteRow = (
    directory: (typeof remoteDirectories)[number],
    entry: UnifiedModelEntry,
    favorite?: MobileModelFavorite,
  ): UnifiedMobileRow => {
    const { catalog } = directory;
    const selected =
      !favorite &&
      directory.sourceId !== null &&
      entry.providerId === directory.sourceId &&
      matchesEntry(entry, p.activeModelId);
    const key =
      favorite?.uid ??
      `remote:${catalog.deviceId}:${modelKey(entry.providerId, entry.modelId)}`;
    const provider = catalog.providers.find(
      (item) => item.id === entry.providerId,
    );
    // 不用被控电脑自己的引擎偏好和档位记忆:同 id 的供应商在两台电脑上不是同一个。
    // 收藏行按收藏副本解析(位置已从 providerId 里拆出来,这里是那台电脑上的供应商 id)。
    const config =
      (!selected && !favorite ? remoteConfigs.get(key) : undefined) ??
      resolveMobileModelConfig(entry, {
        favorite,
        live: selected
          ? { ...selection, providerId: directory.sourceId ?? "" }
          : undefined,
        pinned: p.existingSessionRoute ? p.agentKind : undefined,
        memory: rememberRemote ? remoteAgentModelMemoryFor(catalog.deviceId) : undefined,
        // Remote catalog capabilities are independent of the host installation.
        fastCapable: () => true,
      });
    const details = describe(entry, config, catalog.providers, catalog.deviceId);
    return {
      key,
      entry,
      config,
      ...(favorite ? { favorite } : {}),
      providerMark: {
        providerId: entry.providerId,
        name: provider?.name ?? entry.providerId,
        routing: provider?.routing,
        logoKind: provider?.logoKind,
        customIcon: provider?.customIcon,
      },
      remoteDevice: { deviceId: catalog.deviceId, name: catalog.name },
      selected: selected && !otherChoiceActive,
      disabled: !entry.capabilities[config.agent],
      // 「收藏」一节没有带电脑名的分段标题,电脑名写进说明行,和本机同名模型的收藏区分开。
      subtitle: favorite
        ? [catalog.name, details].filter(Boolean).join(" · ")
        : details,
      sourceUnavailableReason: catalog.offline ? undefined : sourceUnavailableReason(provider, catalog.deviceId),
      effortLabel: effortText(config),
      costMarks: mobileCostMarks(
        provider,
        config.modelId,
        config.agent,
        p.pricing,
      ),
      quotaLabel: modelQuotaLabel(entry.providerId, entry.modelId, catalog.deviceId),
    };
  };
  const allRemoteRows = remoteDirectories.map((directory) => ({
    catalog: directory.catalog,
    listed: new Set(listedMobileEntries(
      directory.entries,
      directory.catalog.providers,
      directory.catalog.deviceId === selectedDeviceId ? currentPick : null,
    )),
    rows: directory.entries.map((entry) => makeRemoteRow(directory, entry)),
  }));
  const remoteRows = allRemoteRows.map(({ catalog, listed, rows: deviceRows }) => ({
    catalog,
    rows: deviceRows.filter((row) => listed.has(row.entry)),
  }));
  const pluginEngineCountdown = (
    resetsAtSeconds: number,
    currentNow: number,
    windowMinutes: number | null = null,
  ) => formatQuotaResetCountdown(resetsAtSeconds, currentNow, t, windowMinutes);
  const pluginEngineModelQuota = (engine: MobilePluginEngine, modelId: string): string | null => {
    const model = engine.models.find((candidate) => candidate.id === modelId);
    return (
      formatPluginEngineModelQuotaLabel(
        pluginEngineQuotas?.[pluginEngineChoiceKey(engine)],
        { id: modelId, name: model?.displayName },
        now,
        pluginEngineCountdown,
      ) ?? null
    );
  };
  const pluginEngineLabels = {
    defaultModel: t("models.pluginEngines.defaultModel"),
    effort: (effort: PluginEngineEffort) =>
      t(`models.options.effortLevels.${effort}`, { defaultValue: effort }),
    modelQuota: pluginEngineModelQuota,
  };
  // 收藏和本机收藏排在同一节里:位置编在 providerId 里的,到那台电脑的目录里找模型,
  // 点开即在那台运行。那台电脑离线(包括只因任务的 Agent 在那台、靠缓存留在列表里)或没开放远程调用时
  // 先不显示,收藏本身保留。分享来的模型用同一套规则:键必须对上当前这条分享的成员身份。
  // 插件引擎收藏按完整引擎列表解析(含已隐藏但可用的引擎，以及同账号远程与已分享引擎)，与普通模型按收藏顺序混排在同一节。
  const favoriteItemsAll: UnifiedMobileFavoriteItem[] = prefs.value.favorites.flatMap((item): UnifiedMobileFavoriteItem[] => {
    if (isPluginEngineFavoriteProviderId(item.providerId)) {
      if (!pluginEngineOptions) return [];
      const resolved = resolveMobilePluginEngineFavorite(item, pluginEngineOptions.engines, pluginEngineLabels);
      return resolved ? [{ kind: "pluginEngine", row: resolved }] : [];
    }
    const source = parseAgentDeviceFavoriteSource(item.providerId);
    if (source) {
      const directory = remoteDirectories.find(
        (value) =>
          value.catalog.deviceId === source.deviceId && !value.catalog.offline,
      );
      const entry = directory && resolveStoredModelEntry(directory.entries, source.providerId, item.modelId);
      return directory && entry
        ? [
            {
              kind: "model",
              row: makeRemoteRow(directory, entry, {
                ...item,
                providerId: source.providerId,
              }),
            },
          ]
        : [];
    }
    const share = parseProviderShareFavoriteSource(item.providerId);
    if (share) {
      const directory = remoteDirectories.find((value) => {
        const identity = value.catalog.favoriteSource;
        return !!identity && !value.catalog.offline
          && providerShareFavoriteWireKey(identity) === item.providerId;
      });
      const entry = directory && resolveStoredModelEntry(directory.entries, share.providerId, item.modelId);
      return directory && entry
        ? [
            {
              kind: "model",
              row: makeRemoteRow(directory, entry, {
                ...item,
                providerId: share.providerId,
              }),
            },
          ]
        : [];
    }
    const entry = resolveStoredModelEntry(entries, item.providerId, item.modelId);
    return entry ? [{ kind: "model", row: makeRow(entry, item) }] : [];
  });
  const rowProviderName = (row: UnifiedMobileRow) => {
    const device = row.remoteDevice;
    const catalog = device
      ? remoteCatalogs.find((item) => item.deviceId === device.deviceId)
      : undefined;
    return catalog
      ? remoteProviderLabel(catalog, row.entry.providerId)
      : providerName(row.entry.providerId);
  };
  const matches = (row: UnifiedMobileRow) =>
    !query.trim() ||
    `${row.entry.displayName} ${row.entry.modelId} ${row.entry.description ?? ""} ${rowProviderName(row)}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase());
  // 停在(或点过)一个被收进组里的来源时,改看收着它的组那一项:组摘要读到得晚,刚打开时可能先停在了组员上。
  const groupFilterOf = (entry: MobileProviderGroupEntry) =>
    entry.deviceId === null
      ? entry.providerId
      : remoteFilterId(entry.deviceId, entry.providerId);
  const hiddenFilterTarget = (() => {
    for (const catalog of remoteCatalogs)
      for (const provider of catalog.providers)
        if (remoteFilterId(catalog.deviceId, provider.id) === filter) {
          const entry = providerGroups.memberOf.get(
            providerGroupEntryKey(catalog.deviceId, provider.id),
          );
          return entry ? groupFilterOf(entry) : null;
        }
    return null;
  })();
  const shownFilter = hiddenFilterTarget ?? filter;
  const all = query.trim() || shownFilter === "all";
  const filtered = rows.filter(
    (row) => !hiddenSources.has(row.entry.providerId) && matches(row) && (all || shownFilter === row.entry.providerId),
  );
  const groups: UnifiedMobileGroup[] = [];
  const favoriteItems = favoriteItemsAll.filter((item) =>
    item.kind === "pluginEngine"
      ? matchesPluginEngineFavoriteQuery(item.row, query)
      : matches(item.row),
  );
  const hasPluginFavoriteRows = favoriteItems.some((item) => item.kind === "pluginEngine");
  if ((all || shownFilter === "favorites") && favoriteItems.length)
    groups.push({
      key: "favorites",
      title: t("models.unified.favorites"),
      rows: favoriteItems.flatMap((item) => (item.kind === "model" ? [item.row] : [])),
      ...(hasPluginFavoriteRows ? { items: favoriteItems } : {}),
    });
  const recommended =
    all && p.existingSessionRoute && !otherChoiceActive
      ? filtered
          .filter((row) => row.selected || row.config.agent === p.agentKind)
          .sort((a, b) => Number(b.selected) - Number(a.selected))
      : [];
  if (recommended.length)
    groups.push({
      key: "recommended",
      title: t("models.unified.recommended"),
      rows: recommended,
    });
  if (all || shownFilter !== "favorites")
    for (const provider of p.providers) {
      const group = filtered.filter(
        (row) =>
          row.entry.providerId === provider.id && !recommended.includes(row),
      );
      if (group.length)
        groups.push({
          key: provider.id,
          title: providerName(provider.id),
          quota: poolQuota(provider.id),
          rows: group,
        });
    }
  // 其他电脑的供应商接在后面:每个供应商一段,标题带电脑名;「收藏」与本机供应商视图里不出现。
  for (const { catalog, rows: deviceRows } of remoteRows)
    for (const provider of catalog.providers) {
      const id = remoteFilterId(catalog.deviceId, provider.id);
      if (hiddenSources.has(id)) continue;
      if (!all && shownFilter !== id) continue;
      const group = deviceRows.filter(
        (row) => row.entry.providerId === provider.id && matches(row),
      );
      if (group.length)
        groups.push({
          key: id,
          title: remoteProviderLabel(catalog, provider.id),
          quota: poolQuota(provider.id, catalog.deviceId),
          rows: group,
        });
    }
  // 插件引擎(「全部」、搜索命中或来源筛选选中某个插件引擎时)：每个引擎一段，列在内置模型之前(与 Desktop 面板顺序一致)。
  const pluginEffortKey = (choice: { providerId: string; deviceId?: string | null }, modelId: string) =>
    `${pluginEngineChoiceKey(choice)}#${modelId}`;
  const pluginEngineQuotaOf = (choiceKey: string) =>
    formatPluginEnginePickerQuota(
      pluginEngineQuotas?.[choiceKey],
      now,
      i18n?.language ?? "en",
      pluginEngineCountdown,
    );
  const matchingPluginEngines = pluginEngineOptions
    ? all
      ? pluginEngineOptions.engines
      : pluginEngineOptions.engines.filter(
          (engine) => pluginEngineFilterId(engine.providerId, engine.deviceId) === shownFilter,
        )
    : [];
  const pluginEngineGroups = pluginEngineOptions && matchingPluginEngines.length
    ? buildPluginEngineGroups(
        { engines: matchingPluginEngines, active: pluginEngineOptions.active },
        query,
        {
          defaultModel: t("models.pluginEngines.defaultModel"),
          effort: (effort) => t(`models.options.effortLevels.${effort}`, { defaultValue: effort }),
          unavailable: (name, hint) => hint
            ? t("models.pluginEngines.unavailableWithHint", { engine: name, hint })
            : t("models.pluginEngines.unavailable", { engine: name }),
          remoteTitle: (engineName, deviceName) =>
            t("models.unified.remoteProvider", { provider: engineName, device: deviceName }),
          modelQuota: pluginEngineModelQuota,
        },
      ).map((group) => {
        const rowsWithOverrides = pluginEfforts.size
          ? group.rows.map((pluginRow) => {
              if (pluginRow.selected) return pluginRow;
              const override = pluginEfforts.get(pluginEffortKey(pluginRow, pluginRow.modelId));
              if (!override || !pluginRow.efforts.includes(override)) return pluginRow;
              return { ...pluginRow, effort: override, effortLabel: pluginEngineLabels.effort(override) };
            })
          : group.rows;
        const quota = pluginEngineQuotaOf(group.choiceKey);
        return { ...group, rows: rowsWithOverrides, ...(quota ? { quota } : {}) };
      })
    : [];
  // Recommended/favorites can contain the only rows for a source. Keep its
  // overview visible there when no provider section already presents it.
  for (const group of groups) {
    if (group.quota || !group.rows.length || group.items?.some((item) => item.kind === "pluginEngine")) continue;
    const first = group.rows[0];
    const sameSource = (row: UnifiedMobileRow) => row.entry.providerId === first.entry.providerId
      && row.remoteDevice?.deviceId === first.remoteDevice?.deviceId;
    if (group.rows.every(sameSource) && !groups.some(other => other !== group && other.quota && other.rows.every(sameSource)))
      group.quota = poolQuota(first.entry.providerId, first.remoteDevice?.deviceId);
  }
  const sourceRow = target
    ? (target.deviceId
        // A favorite may point into a provider hidden from the regular list: look it up in the full rows.
        ? allRemoteRows.find((item) => item.catalog.deviceId === target.deviceId)
            ?.rows
        : allRows
      )?.find(
        (row) =>
          row.entry.providerId === target.providerId &&
          row.entry.modelId === target.modelId,
      )
    : undefined;
  const sourceRemoteCatalog = sourceRow?.remoteDevice
    ? remoteCatalogs.find(
        (item) => item.deviceId === sourceRow.remoteDevice!.deviceId,
      )
    : undefined;
  const originFavorite = target?.uid
    ? prefs.value.favorites.find((item) => item.uid === target.uid)
    : undefined;
  // Opening a favorite copies its parameters into the detail view. Ordinary
  // adjustments always edit model preferences, never the stored shortcut.
  const row = sourceRow && {
    ...sourceRow,
    key: target?.uid ?? sourceRow.key,
    config: favoriteEdit?.config ?? target?.config ?? sourceRow.config,
    favorite: originFavorite,
  };
  // 这一行存进收藏时用的来源:被控电脑自己的供应商照旧;同账号另一台电脑把电脑编进去。
  // 分享来的供应商用 Desktop 同一套键(分享、成员、供应商、区域),并且必须能经收藏通道往返。
  const favoriteSourceOf = (value: UnifiedMobileRow): string | null => {
    const device = value.remoteDevice;
    if (!device) return value.entry.providerId;
    if (isProviderShareAgentDeviceId(device.deviceId)) {
      const identity = remoteCatalogs.find((item) => item.deviceId === device.deviceId)?.favoriteSource;
      if (!identity || identity.providerId !== value.entry.providerId) return null;
      return providerShareFavoriteWireKey(identity);
    }
    try {
      return agentDeviceFavoriteSource({
        deviceId: device.deviceId,
        providerId: value.entry.providerId,
      });
    } catch {
      return null;
    }
  };
  const favoriteSource = row ? favoriteSourceOf(row) : null;
  // A source model can have several saved configurations. Missing effort is the
  // catalog default (seeded favorites store none). A non-empty effort the catalog
  // no longer offers stays unmatched, so a retired tier is not this default row.
  const favoriteEntries = row?.remoteDevice
    ? remoteDirectories.find(directory => directory.catalog.deviceId === row.remoteDevice!.deviceId)?.entries ?? []
    : entries;
  const storedFavoriteMatches = (item: MobileModelFavorite): boolean => {
    if (!row || favoriteSource === null || item.providerId !== favoriteSource) return false;
    if (resolveStoredModelEntry(favoriteEntries, row.entry.providerId, item.modelId) !== row.entry) return false;
    const capability = row.entry.capabilities[item.agent];
    const effort = item.effort
      ? item.effort
      : capability?.defaultEffort ?? capability?.efforts[0] ?? "";
    return sameConfiguration(
      { ...item, providerId: row.config.providerId, modelId: row.config.modelId, effort },
      row.config,
    );
  };
  const matchingFavorite =
    row && favoriteSource !== null
      ? prefs.value.favorites.find(storedFavoriteMatches)
      : undefined;
  // An opened copy keeps its identity when catalog defaults or capability
  // fallbacks change its displayed configuration (notably seeded favorites).
  // Once the user adjusts parameters, the ordinary match rule applies.
  // Hints use this identity. Explicit edits must ignore the copy being edited:
  // a seeded favorite matches its own default and would hide another copy.
  const favoriteToRemove =
    row && originFavorite && sameConfiguration(
      resolveMobileModelConfig(row.entry, {
        favorite: originFavorite,
        fastCapable: row.remoteDevice ? () => true : fastCapable,
      }),
      row.config,
    ) ? originFavorite : matchingFavorite;
  const recommendedConfig =
    row &&
    resolveMobileModelConfig(row.entry, {
      pinned: p.existingSessionRoute ? p.agentKind : undefined,
      fastCapable: row.remoteDevice ? () => true : fastCapable,
    });
  const resetAgents = row
    ? [...new Set([row.config.agent, recommendedConfig!.agent])]
    : [];
  const localCanReset =
    !!row &&
    (!sameConfiguration(row.config, recommendedConfig!) ||
      prefs.value.engines[modelKey(row.entry.providerId, row.entry.modelId)] !==
        undefined ||
      resetAgents.some((agent) => {
        const capability = row.entry.capabilities[agent];
        if (!capability) return false;
        const effort = p.modelMemory?.getEffort(
          agent,
          row.entry.providerId,
          capability.wireModelId,
        );
        const fast = p.modelMemory?.getFast(
          agent,
          row.entry.providerId,
          capability.wireModelId,
        );
        // Session mirrors cannot delete remote preferences. Like Desktop, those
        // accessors restore values; their default-valued echoes are not overrides.
        return (
          (effort !== undefined &&
            (!!p.modelMemory?.clearEffort ||
              effort !==
                (capability.defaultEffort ?? capability.efforts[0] ?? ""))) ||
          (fast !== undefined && (!!p.modelMemory?.clearFast || fast))
        );
      }));
  // 另一台电脑:推荐值以外的档位 / Fast,或这次打开里改过的引擎,都可以恢复推荐。
  const canReset = row?.remoteDevice
    ? !sameConfiguration(row.config, recommendedConfig!) ||
      remoteParameterOverride(
        rememberRemote ? remoteAgentModelMemoryFor(row.remoteDevice.deviceId) : undefined,
        row.entry,
        resetAgents,
      )
    : localCanReset;
  const pluginEngineFavoriteWireKey = (engine: MobilePluginEngine): string | null => {
    if (!engine.deviceId) return engine.providerId;
    if (isProviderShareAgentDeviceId(engine.deviceId)) {
      if (!engine.favoriteSource || engine.favoriteSource.providerId !== engine.providerId) return null;
      return providerShareFavoriteWireKey(engine.favoriteSource);
    }
    try {
      return agentDeviceFavoriteSource({
        deviceId: engine.deviceId,
        providerId: engine.providerId,
      });
    } catch {
      return null;
    }
  };
  const activePluginEngine =
    pluginTarget && pluginEngineOptions
      ? pluginEngineOptions.engines.find((engine) => isSamePluginEngineChoice(engine, pluginTarget))
      : undefined;
  const originPluginFavorite = pluginTarget?.uid
    ? prefs.value.favorites.find((item) => item.uid === pluginTarget.uid)
    : undefined;
  const activePluginRow: UnifiedMobilePluginEngineRow | undefined = (() => {
    if (!pluginTarget || !activePluginEngine || !isPluginEngineSelectable(activePluginEngine)) return undefined;
    const isDefault = pluginTarget.modelId === PLUGIN_ENGINE_DEFAULT_MODEL;
    if (isDefault && activePluginEngine.defaultModelAllowed === false) return undefined;
    const model = isDefault
      ? undefined
      : activePluginEngine.models.find((item) => item.id === pluginTarget.modelId);
    if (!isDefault && !model) return undefined;
    const selected =
      isSamePluginEngineChoice(pluginEngineOptions?.active, activePluginEngine) &&
      pluginEngineOptions?.active?.modelId === pluginTarget.modelId;
    const rememberedEffort =
      !originPluginFavorite && !selected
        ? pluginEfforts.get(pluginEffortKey(activePluginEngine, pluginTarget.modelId))
        : undefined;
    const effort = pluginFavoriteEdit
      ? pluginFavoriteEdit.effort
      : pluginTarget.effort !== undefined
        ? pluginTarget.effort
        : originPluginFavorite
          ? resolvePluginEngineEffort(activePluginEngine, pluginTarget.modelId, originPluginFavorite.effort)
          : resolvePluginEngineEffort(
              activePluginEngine,
              pluginTarget.modelId,
              selected ? pluginEngineOptions?.active?.effort : rememberedEffort,
            );
    const choiceKey = pluginEngineChoiceKey(activePluginEngine);
    const deviceLabel = activePluginEngine.deviceId
      ? (activePluginEngine.deviceName ?? activePluginEngine.deviceId)
      : null;
    const quotaLabel = pluginEngineModelQuota(activePluginEngine, pluginTarget.modelId);
    return {
      key: pluginTarget.uid ?? `${choiceKey}#${pluginTarget.modelId}`,
      providerId: activePluginEngine.providerId,
      ...(activePluginEngine.deviceId ? { deviceId: activePluginEngine.deviceId } : {}),
      ...(activePluginEngine.deviceId ? { remoteDevice: { deviceId: activePluginEngine.deviceId, name: deviceLabel! } } : {}),
      modelId: pluginTarget.modelId,
      title: isDefault ? pluginEngineLabels.defaultModel : model!.displayName,
      subtitle: deviceLabel ? `${activePluginEngine.name} · ${deviceLabel}` : activePluginEngine.name,
      ...(quotaLabel ? { quotaLabel } : {}),
      engineName: activePluginEngine.name,
      ...(activePluginEngine.iconDataUrl ? { iconDataUrl: activePluginEngine.iconDataUrl } : {}),
      effort,
      efforts: model ? [...model.efforts] : [],
      ...(model?.defaultEffort ? { defaultEffort: model.defaultEffort } : {}),
      effortLabel: effort ? pluginEngineLabels.effort(effort) : "",
      selected: !originPluginFavorite && selected,
      disabled: false,
      ...(originPluginFavorite ? { favorite: originPluginFavorite } : {}),
    };
  })();
  const pluginFavoriteSource = activePluginEngine ? pluginEngineFavoriteWireKey(activePluginEngine) : null;
  const pluginFavoriteMatches = (item: MobileModelFavorite): boolean => {
    if (!activePluginRow || !activePluginEngine || pluginFavoriteSource === null) return false;
    if (item.providerId !== pluginFavoriteSource || item.modelId !== activePluginRow.modelId) return false;
    const itemEffort = resolvePluginEngineEffort(activePluginEngine, activePluginRow.modelId, item.effort);
    return itemEffort === activePluginRow.effort;
  };
  const pluginMatchingFavorite = activePluginRow
    ? prefs.value.favorites.find(pluginFavoriteMatches)
    : undefined;
  const pluginFavoriteToRemove =
    activePluginRow &&
    activePluginEngine &&
    originPluginFavorite &&
    resolvePluginEngineEffort(activePluginEngine, activePluginRow.modelId, originPluginFavorite.effort) ===
      activePluginRow.effort
      ? originPluginFavorite
      : pluginMatchingFavorite;

  useEffect(() => {
    if (target && !row) {
      setTarget(null);
      setFavoriteEdit(null);
    }
  }, [target, row]);
  useEffect(() => {
    if (pluginTarget && !activePluginRow) {
      setPluginTarget(null);
      setPluginFavoriteEdit(null);
    }
  }, [pluginTarget, activePluginRow]);
  const transact = async (
    action: (isCurrent: () => boolean) => Promise<void>,
  ) => {
    if (lock.current || p.disabled || !prefs.ready) return;
    lock.current = true;
    const generation = opening.current;
    const isCurrent = () => generation === opening.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action(isCurrent);
    } catch {
      if (isCurrent()) setError(t("models.unified.saveFailed"));
    } finally {
      // Keep writes serialized across close/reopen until persistence settles.
      // No newer transaction can be unlocked by this completion.
      lock.current = false;
      setBusy(false);
    }
  };
  /**
   * 归组的任务在组那一项里选的行:留在此刻运行的那台(换成那台上这个供应商的 id),只换模型,不把 Agent
   * 挪到组所在电脑(与桌面同口径)。不是这种行返回 null。
   */
  const boundRoute = (
    row: UnifiedMobileRow,
    config: MobileModelConfiguration,
  ): [MobileModelConfiguration, { deviceId: string | null }] | null => {
    const running = groupInfo?.running;
    return boundGroup &&
      running?.providerId &&
      (row.remoteDevice?.deviceId ?? null) === boundGroup.deviceId &&
      row.entry.providerId === boundGroup.providerId
      ? [{ ...config, providerId: running.providerId }, { deviceId: running.deviceId }]
      : null;
  };
  const select = (row: UnifiedMobileRow) => {
    if (row.disabled) return;
    void transact(async (isCurrent) => {
      const [config, source] = boundRoute(row, row.config) ?? [
        row.config,
        { deviceId: row.remoteDevice?.deviceId ?? null },
      ];
      if ((await p.unified.onSelect(config, source)) && isCurrent())
        p.onClose();
    });
  };
  // 插件引擎行：选中模型时关闭选择器；只改思考深度时留在原地。
  const modelGroupOptions = p.unified.modelGroups;
  const modelGroupRows = (modelGroupOptions?.rows ?? []).filter((row) => {
    const needle = query.trim().toLowerCase();
    return !needle || `${row.title} ${row.subtitle}`.toLowerCase().includes(needle);
  });
  const selectModelGroup = (id: string) => {
    if (!modelGroupOptions) return;
    void transact(async (isCurrent) => {
      const applied = await modelGroupOptions.onSelect(id);
      if (applied !== false && isCurrent()) p.onClose();
    });
  };
  const selectPluginEngine = (row: UnifiedMobilePluginEngineRow, effort?: PluginEngineEffort) => {
    if (row.disabled || !pluginEngineOptions) return;
    void transact(async (isCurrent) => {
      const nextEffort = effort ?? row.effort ?? undefined;
      const apply = effort !== undefined
        ? (pluginEngineOptions.onConfigure ?? pluginEngineOptions.onSelect)
        : pluginEngineOptions.onSelect;
      const applied = await apply({
        providerId: row.providerId,
        ...(row.deviceId ? { deviceId: row.deviceId } : {}),
        modelId: row.modelId,
        ...(nextEffort ? { effort: nextEffort } : {}),
      });
      if (applied !== false && isCurrent()) {
        setPluginEfforts((current) => {
          const key = pluginEffortKey(row, row.modelId);
          if (!current.has(key)) return current;
          const next = new Map(current);
          next.delete(key);
          return next;
        });
        if (effort === undefined) p.onClose();
      }
    });
  };
  const openPluginEngineOptions = (pluginRow: UnifiedMobilePluginEngineRow) => {
    if (lock.current || pluginRow.disabled) return;
    setTarget(null);
    setFavoriteEdit(null);
    setPluginFavoriteEdit(null);
    setNotice(null);
    setError(null);
    setPluginTarget({
      providerId: pluginRow.providerId,
      ...(pluginRow.deviceId ? { deviceId: pluginRow.deviceId } : {}),
      modelId: pluginRow.modelId,
      uid: pluginRow.favorite?.uid,
      ...(pluginRow.favorite ? { effort: pluginRow.effort } : {}),
    });
  };
  const changePluginEngineEffort = (nextEffort: PluginEngineEffort) => {
    if (!activePluginRow || !activePluginEngine || !pluginEngineOptions) return;
    if (pluginFavoriteEdit) {
      if (!lock.current && !p.disabled) {
        setPluginFavoriteEdit({ ...pluginFavoriteEdit, effort: nextEffort });
      }
      return;
    }
    const key = pluginEffortKey(activePluginRow, activePluginRow.modelId);
    const liveFavorite =
      !!originPluginFavorite &&
      isSamePluginEngineChoice(pluginEngineOptions.active, activePluginRow) &&
      pluginEngineOptions.active?.modelId === activePluginRow.modelId &&
      resolvePluginEngineEffort(activePluginEngine, activePluginRow.modelId, pluginEngineOptions.active?.effort) ===
        activePluginRow.effort;
    const savedNotice = t(
      pluginTarget?.uid && pluginFavoriteToRemove
        ? "models.unified.originalFavoriteKept"
        : "models.unified.parametersSaved",
    );
    if (activePluginRow.selected || liveFavorite) {
      void transact(async (isCurrent) => {
        const configurePlugin = pluginEngineOptions.onConfigure ?? pluginEngineOptions.onSelect;
        const applied = await configurePlugin({
          providerId: activePluginRow.providerId,
          ...(activePluginRow.deviceId ? { deviceId: activePluginRow.deviceId } : {}),
          modelId: activePluginRow.modelId,
          effort: nextEffort,
        });
        if (applied !== false && isCurrent()) {
          setPluginEfforts((current) => {
            if (!current.has(key)) return current;
            const next = new Map(current);
            next.delete(key);
            return next;
          });
          setPluginTarget((current) => (current ? { ...current, effort: nextEffort } : current));
          setNotice(savedNotice);
        }
      });
      return;
    }
    setPluginEfforts((current) => {
      const next = new Map(current);
      next.set(key, nextEffort);
      return next;
    });
    setPluginTarget((current) => (current ? { ...current, effort: nextEffort } : current));
    setNotice(savedNotice);
  };
  const change = (config: MobileModelConfiguration, reset = false) => {
    if (!row) return;
    if (favoriteEdit) {
      if (!lock.current && !p.disabled)
        setFavoriteEdit({ ...favoriteEdit, config });
      return;
    }
    const remoteDevice = row.remoteDevice;
    if (remoteDevice) {
      // 正在用的那行直接生效。effort / Fast 记在这台远程电脑自己的记忆里,
      // 不写被控电脑的引擎偏好或本机模型记忆。引擎调整仍只留在这次打开期间。
      const key = row.key;
      const canonicalKey = `remote:${remoteDevice.deviceId}:${modelKey(row.entry.providerId, row.entry.modelId)}`;
      void transact(async (isCurrent) => {
        if (
          row.selected &&
          !(await (p.unified.onConfigure ?? p.unified.onSelect)(
            ...(boundRoute(row, config) ?? [config, { deviceId: remoteDevice.deviceId }]),
          ))
        )
          return;
        if (!isCurrent()) return;
        if (rememberRemote) {
          rememberRemoteParameters(
            remoteAgentModelMemoryFor(remoteDevice.deviceId),
            row.entry,
            config,
            resetAgents,
            reset,
          );
        }
        // 从收藏打开的详情显示的是那份副本(target.config),与本机收藏一样跟着调整走;原收藏不变。
        if (target?.config) {
          setTarget({ ...target, config });
          if (favoriteToRemove && !reset)
            setNotice(t("models.unified.originalFavoriteKept"));
        }
        if (row.selected && !reset) return;
        setRemoteConfigs((current) => {
          const next = new Map(current);
          if (reset) {
            next.delete(key);
            next.delete(canonicalKey);
          } else next.set(key, config);
          return next;
        });
      });
      return;
    }
    // 被控电脑自己的组那一项(任务归它、此刻在组里别的电脑上运行)里的行同样留在那台。
    const apply = (next: MobileModelConfiguration) => {
      const routed = boundRoute(row, next);
      const configure = p.unified.onConfigure ?? p.unified.onSelect;
      return routed ? configure(...routed) : configure(next);
    };
    void transact(async (isCurrent) => {
      const previousConfig =
        row.favorite && sameConfiguration(row.config, live)
          ? live
          : row.selected
            ? selection
            : undefined;
      if (previousConfig && !(await apply(config))) return;
      // Selection can await remote work or a confirmation. Do not begin another
      // write for a panel that closed or changed its binding while waiting.
      if (!isCurrent()) return;
      try {
        const engines = { ...prefs.value.engines };
        const key = modelKey(row.entry.providerId, row.entry.modelId);
        if (reset) delete engines[key];
        else engines[key] = config.agent;
        await prefs.save({ ...prefs.value, engines });
        if (reset) {
          // Reset the model's overrides, including the previous engine's
          // parameters. Other models and saved favorite copies stay intact.
          for (const agent of resetAgents) {
            const capability = row.entry.capabilities[agent];
            if (!capability) continue;
            const modelId = capability.wireModelId;
            const effort =
              capability.defaultEffort ?? capability.efforts[0] ?? "";
            if (p.modelMemory?.clearEffort)
              p.modelMemory.clearEffort(agent, config.providerId, modelId);
            else if (effort)
              p.modelMemory?.setEffort(
                agent,
                config.providerId,
                modelId,
                effort,
              );
            if (p.modelMemory?.clearFast)
              p.modelMemory.clearFast(agent, config.providerId, modelId);
            else
              p.modelMemory?.setFast(agent, config.providerId, modelId, false);
          }
        } else {
          if (config.effort)
            p.modelMemory?.setEffort(
              config.agent,
              config.providerId,
              config.modelId,
              config.effort,
            );
          p.modelMemory?.setFast(
            config.agent,
            config.providerId,
            config.modelId,
            config.fast,
          );
        }
        if (!isCurrent()) return;
        if (target?.config) setTarget({ ...target, config });
        setNotice(
          t(
            reset
              ? "models.unified.restoredHint"
              : favoriteToRemove
                ? "models.unified.originalFavoriteKept"
                : "models.unified.parametersSaved",
          ),
        );
      } catch (error) {
        if (previousConfig && isCurrent()) await apply(previousConfig);
        throw error;
      }
    });
  };
  const cap = row?.entry.capabilities[row.config.agent];
  const provider =
    row &&
    (sourceRemoteCatalog?.providers ?? p.providers).find(
      (item) => item.id === row.entry.providerId,
    );
  const price = row
    ? presentPickerPrice({
        pricing: p.pricing ?? null,
        provider: provider ?? null,
        modelId: row.config.modelId,
        agentKind: row.config.agent,
      })
    : null;
  // 来源页:其他电脑的供应商按电脑分块(一个都没开放的电脑没有行,整块不出现)。
  function poolQuota(providerId: string, deviceId?: string): UnifiedMobileQuota | undefined {
    const quota = accountQuotaOf(providerId, deviceId);
    if (!quota?.members?.length) return undefined;
    const overview = subscriptionQuotaOverview(quota.members, now);
    const summary = overview.average === null ? t('models.unified.quotaUpdating')
      : t('models.unified.quotaAverage', { percent: overview.average });
    const members = quota.members.map((member, index) => ({
      remaining: overview.members[index].remaining ?? undefined,
      label: [member.accountIdentity ?? t('models.unified.accountFallback', { index: index + 1 }),
        overview.members[index].remaining === null ? '—' : t('session.menu.usage.remaining', { percent: overview.members[index].remaining }),
        overview.members[index].resetSoon ? t('models.unified.quotaResetSoon') : null,
        member.resetsAt ? formatQuotaResetCountdown(member.resetsAt, now, t, member.windowMinutes ?? null) : null,
      ].filter(Boolean).join(' · '),
    }));
    const nextReset = overview.nextResetIndex === null ? null : quota.members[overview.nextResetIndex];
    const resetDescription = nextReset ? [
      t('models.unified.quotaResetIn', { duration: formatQuotaResetCountdown(nextReset.resetsAt!, now, t, nextReset.windowMinutes ?? null) }),
      t('session.menu.usage.remaining', { percent: overview.members[overview.nextResetIndex!].remaining }),
    ].filter(Boolean).join(' · ') : undefined;
    return { remaining: overview.average ?? undefined, summary, reset: overview.reset ?? undefined, resetParts: t('models.unified.quotaResetIn', { duration: '{time}' }).split('{time}'), resetDescription,
      resetSoon: overview.resetSoonCount > 0, members,
      label: [summary, ...members.map(member => member.label), t('models.unified.quotaAverageHint'),
        overview.resetSoonCount ? t('models.unified.quotaResetHint') : null].filter(Boolean).join('\n'),
    };
  }
  const sourceQuota = (providerId: string, deviceId?: string) => {
    const pool = poolQuota(providerId, deviceId);
    if (pool) return pool;
    const quota = accountQuotaOf(providerId, deviceId);
    return quota?.remaining === undefined ? undefined : {
      remaining: quota.remaining,
      label: [
        (quota.resetsAt ? formatQuotaResetCountdown(quota.resetsAt, now, t, quota.windowMinutes ?? null) : null)
          ?? t("session.menu.usage.week"),
        t("session.menu.usage.remaining", { percent: quota.remaining }),
      ].join(" · "),
    };
  };
  const remoteFilters = remoteDirectories.flatMap(({ catalog }) =>
    catalog.providers
      .filter((provider) => !hiddenSources.has(remoteFilterId(catalog.deviceId, provider.id))
        && remoteRows.some((group) => group.catalog === catalog && group.rows.some((row) => row.entry.providerId === provider.id)))
      .map((provider) => ({
        id: remoteFilterId(catalog.deviceId, provider.id),
        label: remoteProviderLabel(catalog, provider.id),
        quota: sourceQuota(provider.id, catalog.deviceId),
        sourceUnavailableReason: catalog.offline ? undefined : sourceUnavailableReason(provider, catalog.deviceId),
        providerMark: {
          providerId: provider.id,
          name: provider.name,
          routing: provider.routing,
          logoKind: provider.logoKind,
          customIcon: provider.customIcon,
        },
        remote: {
          deviceId: catalog.deviceId,
          deviceName: catalog.name,
          providerLabel: remoteProviderName(catalog, provider.id),
        },
      })),
  );
  const visiblePluginEnginesForSources = (pluginEngineOptions?.engines ?? []).filter((engine) => {
    const active = isSamePluginEngineChoice(pluginEngineOptions?.active, engine) ? pluginEngineOptions?.active : null;
    if ((!isPluginEngineSelectable(engine) || engine.hidden) && !active) return false;
    return pluginEngineModelRows(engine, active?.modelId).length > 0;
  });
  const localPluginFilters: UnifiedMobilePickerViewProps["filters"] = [];
  const remotePluginFilters: (UnifiedMobilePickerViewProps["filters"][number] & {
    remote: NonNullable<UnifiedMobilePickerViewProps["filters"][number]["remote"]>;
  })[] = [];
  for (const engine of visiblePluginEnginesForSources) {
    const choiceKey = pluginEngineChoiceKey(engine);
    const quota = pluginEngineQuotaOf(choiceKey);
    const filterRemaining =
      quota?.remaining ??
      (quota?.groups?.length
        ? Math.min(...quota.groups.map((group) => group.remaining))
        : undefined);
    const filterQuota = quota
      ? {
          ...(filterRemaining !== undefined ? { remaining: filterRemaining } : {}),
          label: quota.summary,
        }
      : undefined;
    const pluginEngineMark = {
      name: engine.name,
      ...(engine.iconDataUrl ? { iconDataUrl: engine.iconDataUrl } : {}),
    };
    const id = pluginEngineFilterId(engine.providerId, engine.deviceId);
    if (engine.deviceId) {
      const deviceName = engine.deviceName ?? engine.deviceId;
      remotePluginFilters.push({
        id,
        label: t("models.unified.remoteProvider", { provider: engine.name, device: deviceName }),
        ...(filterQuota ? { quota: filterQuota } : {}),
        pluginEngineMark,
        remote: {
          deviceId: engine.deviceId,
          deviceName,
          providerLabel: engine.name,
        },
      });
    } else {
      localPluginFilters.push({
        id,
        label: engine.name,
        ...(filterQuota ? { quota: filterQuota } : {}),
        pluginEngineMark,
      });
    }
  }
  // 分享者电脑离线或刚上线还在连接供应商时，分享来的供应商读成未连接、没有可用模型；来源页仍在原位置
  // 列出这一行，不让分享一会儿有一会儿无。离线时块标题已带「暂时离线」，打开后用说明代替「没有结果」
  // (providerSharePickerState，与 Desktop 模型选择器同口径)。
  const offlineShareFilterIds = new Set<string>();
  const sourceFilters = remoteCatalogs.flatMap((catalog) => {
    const listed = remoteFilters.filter((item) => item.remote.deviceId === catalog.deviceId);
    const share = catalog.shareSource;
    if (!share) return listed;
    // Shared plugin engines already listed via remotePluginFilters should not render a duplicate built-in placeholder.
    if (
      isPluginEngineProviderId(share.providerId) &&
      remotePluginFilters.some(
        (item) => item.remote.deviceId === catalog.deviceId && item.id === pluginEngineFilterId(share.providerId, catalog.deviceId),
      )
    ) {
      return listed;
    }
    const id = remoteFilterId(catalog.deviceId, share.providerId);
    if (hiddenSources.has(id) || listed.some((item) => item.id === id)) return listed;
    if (share.offline) offlineShareFilterIds.add(id);
    const provider = catalog.providers.find((item) => item.id === share.providerId);
    return [...listed, {
      id,
      label: provider
        ? remoteProviderLabel(catalog, provider.id)
        : t("models.unified.remoteProvider", { provider: share.providerLabel, device: catalog.name }),
      providerMark: provider
        ? {
            providerId: provider.id,
            name: provider.name,
            routing: provider.routing,
            logoKind: provider.logoKind,
            customIcon: provider.customIcon,
          }
        : { providerId: share.providerId, name: share.providerLabel },
      remote: {
        deviceId: catalog.deviceId,
        deviceName: catalog.name,
        providerLabel: provider ? remoteProviderName(catalog, provider.id) : share.providerLabel,
      },
    }];
  });
  const selectedCatalogStatus = selectedCatalog?.status;
  // 那台被收进组里时同样先停在它上面,随即按 shownFilter 改看组那一项。
  const selectedRemoteFilter =
    selectedDeviceId && selectedSourceId
      ? remoteFilterId(selectedDeviceId, selectedSourceId)
      : null;
  useEffect(() => {
    if (!p.visible || !initialRemoteFilter.current) return;
    if (pluginEngineActive || selectedDeviceId === null) {
      initialRemoteFilter.current = false;
      return;
    }
    // 那台电脑的目录还没读到:等一等再定;读不到就留在「全部模型」。
    if (selectedCatalogStatus === undefined || selectedCatalogStatus === "loading")
      return;
    initialRemoteFilter.current = false;
    if (selectedRemoteFilter) setFilter(selectedRemoteFilter);
  }, [p.visible, pluginEngineActive, selectedDeviceId, selectedCatalogStatus, selectedRemoteFilter]);
  // 归组的任务打开即停在组那一项(组的归属读回来得晚也挪过去,用户自己点过来源就不再挪)。
  const boundFilter = boundGroup ? groupFilterOf(boundGroup) : null;
  useEffect(() => {
    if (!p.visible || filterTouched.current || !boundFilter) return;
    initialRemoteFilter.current = false;
    setFilter(boundFilter);
  }, [p.visible, boundFilter]);
  return (
    <UnifiedModelPickerView
      visible={p.visible}
      onClose={p.onClose}
      onClosed={p.onClosed}
      onBack={
        row || activePluginRow
          ? () => {
              if (lock.current) return;
              if (favoriteEdit) setFavoriteEdit(null);
              else if (pluginFavoriteEdit) setPluginFavoriteEdit(null);
              else if (row) setTarget(null);
              else setPluginTarget(null);
              setError(null);
              setNotice(null);
            }
          : undefined
      }
      title={
        favoriteEdit || pluginFavoriteEdit
          ? t("models.unified.editFavorite")
          : (row?.entry.displayName ?? activePluginRow?.title ?? p.title ?? t("models.picker.title"))
      }
      testID={p.testID ?? "modelSheet"}
      query={query}
      onQuery={setQuery}
      filter={shownFilter}
      onFilter={(value) => {
        initialRemoteFilter.current = false;
        filterTouched.current = true;
        setFilter(value);
      }}
      filters={[
        { id: "all", label: t("models.unified.all") },
        ...(prefs.favoritesReady
          ? [{ id: "favorites", label: t("models.unified.favorites") }]
          : []),
        ...localPluginFilters,
        ...p.providers
          .filter((provider) =>
            !hiddenSources.has(provider.id) && rows.some((row) => row.entry.providerId === provider.id),
          )
          .map((provider) => ({
            id: provider.id,
            label: providerName(provider.id),
            quota: sourceQuota(provider.id),
            sourceUnavailableReason: sourceUnavailableReason(provider, null),
            providerMark: {
              providerId: provider.id,
              name: provider.name,
              routing: provider.routing,
              logoKind: provider.logoKind,
              customIcon: provider.customIcon,
            },
          })),
        ...sourceFilters,
        ...remotePluginFilters,
      ]}
      groups={groups}
      {...(modelGroupRows.length
        ? { modelGroups: { title: t("models.modelGroups.title"), rows: modelGroupRows, onSelect: selectModelGroup } }
        : {})}
      {...(pluginEngineOptions && (pluginEngineGroups.length || hasPluginFavoriteRows)
        ? {
            pluginEngines: {
              groups: pluginEngineGroups,
              onSelect: selectPluginEngine,
              onOptions: openPluginEngineOptions,
            },
          }
        : {})}
      busy={busy || !!p.disabled || !prefs.ready}
      error={error ?? (selectedDeviceId === null && p.providersReady && modelNeedsReselection(p.modelVisibilityOverrides, p.agentKind, p.activeModelId, p.selectedProviderId)
        ? t('session.common.modelHiddenReselect', { model: p.activeModelId }) : null)}
      loading={!!p.loading}
      emptyHint={!query.trim() && offlineShareFilterIds.has(shownFilter)
        ? t("providerShare.picker.offlineNote")
        : (p.emptyHint ?? t("models.picker.noResults"))}
      onSelect={select}
      onOptions={(row) => {
        if (lock.current) return;
        setPluginTarget(null);
        setPluginFavoriteEdit(null);
        setFavoriteEdit(null);
        setNotice(null);
        setError(null);
        setTarget({
          providerId: row.entry.providerId,
          modelId: row.entry.modelId,
          uid: row.favorite?.uid,
          config: row.favorite ? { ...row.config } : undefined,
          ...(row.remoteDevice ? { deviceId: row.remoteDevice.deviceId } : {}),
        });
      }}
      options={
        row
          ? {
              row,
              agents: row.entry.candidates.filter((agent) =>
                ALL_AGENTS.includes(agent),
              ),
              fastCapable:
                !!cap?.supportsFastMode && (!!row.remoteDevice || fastCapable(row.config.agent)),
              onChange: change,
              context: [
                rowProviderName(row),
                cap?.contextWindow
                  ? t("models.picker.contextSuffix", {
                      size: `${Math.round(cap.contextWindow / 1000)}K`,
                    })
                  : null,
              ]
                .filter(Boolean)
                .join(" · "),
              price: price ? `${price.title}\n${price.amountsLine}` : null,
              favoritesDisabled: !prefs.favoritesReady || favoriteSource === null,
              isFavorite: !!favoriteToRemove,
              canReset,
              configurationSummary: [
                mobileAgentLabel(row.config.agent),
                row.config.effort
                  ? t(`models.options.effortLevels.${row.config.effort}`, {
                      defaultValue: row.config.effort,
                    })
                  : null,
                row.config.fast ? "Fast" : null,
              ]
                .filter(Boolean)
                .join(" · "),
              notice,
              editingFavorite: !!favoriteEdit,
              onEditFavorite:
                originFavorite && !favoriteEdit
                  ? () => {
                      if (lock.current || p.disabled) return;
                      setFavoriteEdit({
                        original: { ...originFavorite },
                        config: resolveMobileModelConfig(row.entry, {
                          favorite: originFavorite,
                          fastCapable: row.remoteDevice ? () => true : fastCapable,
                        }),
                      });
                      setNotice(null);
                      setError(null);
                    }
                  : undefined,
              onCancelEdit: () => {
                if (lock.current) return;
                setFavoriteEdit(null);
                setError(null);
                setNotice(null);
              },
              onSaveEdit: () => {
                if (!favoriteEdit) return;
                void transact(async (isCurrent) => {
                  const original = prefs.value.favorites.find(
                    (item) => item.uid === favoriteEdit.original.uid,
                  );
                  if (
                    !original ||
                    !sameConfiguration(original, favoriteEdit.original)
                  ) {
                    setError(t("models.unified.favoriteChanged"));
                    return;
                  }
                  if (
                    prefs.value.favorites.some(
                      (item) =>
                        item.uid !== original.uid && storedFavoriteMatches(item),
                    )
                  ) {
                    setError(t("models.unified.favoriteExists"));
                    return;
                  }
                  const config = favoriteEdit.config;
                  await prefs.save({
                    ...prefs.value,
                    favorites: prefs.value.favorites.map((item) =>
                      item.uid === original.uid
                        ? {
                            ...config,
                            providerId: item.providerId,
                            modelId: row.entry.enginePreferenceId ?? row.entry.modelId,
                            uid: item.uid,
                          }
                        : item,
                    ),
                  });
                  if (!isCurrent()) return;
                  setFavoriteEdit(null);
                  if (target) setTarget({ ...target, config });
                  setNotice(t("models.unified.favoriteUpdated"));
                });
              },
              onFavorite: () => {
                if (!prefs.favoritesReady || favoriteEdit || favoriteSource === null)
                  return;
                void transact(async (isCurrent) => {
                  if (favoriteToRemove) {
                    await prefs.save({
                      ...prefs.value,
                      favorites: prefs.value.favorites.filter(
                        (item) => item.uid !== favoriteToRemove.uid,
                      ),
                    });
                    if (isCurrent())
                      setNotice(t("models.unified.favoriteRemoved"));
                  } else {
                    await prefs.save(
                      addModelFavorite(
                        prefs.value,
                        {
                          ...row.config,
                          providerId: favoriteSource,
                          modelId: row.entry.enginePreferenceId ?? row.entry.modelId,
                        },
                        createFavoriteUid(),
                      ),
                    );
                    if (isCurrent())
                      setNotice(t("models.unified.favoriteSaved"));
                  }
                });
              },
              onReset: () => change(recommendedConfig!, true),
            }
          : undefined
      }
      pluginEngineOptions={
        activePluginRow && activePluginEngine
          ? {
              row: activePluginRow,
              context: activePluginEngine.deviceId
                ? t("models.unified.remoteProvider", {
                    provider: activePluginEngine.name,
                    device: activePluginEngine.deviceName ?? activePluginEngine.deviceId,
                  })
                : activePluginEngine.name,
              effort: activePluginRow.effort,
              efforts: activePluginRow.efforts,
              onChangeEffort: changePluginEngineEffort,
              favoritesDisabled: !prefs.favoritesReady || pluginFavoriteSource === null,
              isFavorite: !!pluginFavoriteToRemove,
              configurationSummary: [
                activePluginEngine.name,
                activePluginEngine.deviceId
                  ? (activePluginEngine.deviceName ?? activePluginEngine.deviceId)
                  : null,
                activePluginRow.effortLabel || null,
              ]
                .filter(Boolean)
                .join(" · "),
              notice,
              editingFavorite: !!pluginFavoriteEdit,
              onEditFavorite:
                originPluginFavorite && !pluginFavoriteEdit && activePluginRow.efforts.length > 1
                  ? () => {
                      if (lock.current || p.disabled) return;
                      setPluginFavoriteEdit({
                        original: { ...originPluginFavorite },
                        effort: resolvePluginEngineEffort(
                          activePluginEngine,
                          activePluginRow.modelId,
                          originPluginFavorite.effort,
                        ),
                      });
                      setNotice(null);
                      setError(null);
                    }
                  : undefined,
              onCancelEdit: () => {
                if (lock.current) return;
                setPluginFavoriteEdit(null);
                setError(null);
                setNotice(null);
              },
              onSaveEdit: () => {
                if (!pluginFavoriteEdit) return;
                void transact(async (isCurrent) => {
                  const original = prefs.value.favorites.find(
                    (item) => item.uid === pluginFavoriteEdit.original.uid,
                  );
                  if (
                    !original ||
                    original.providerId !== pluginFavoriteEdit.original.providerId ||
                    original.modelId !== pluginFavoriteEdit.original.modelId ||
                    original.effort !== pluginFavoriteEdit.original.effort
                  ) {
                    setError(t("models.unified.favoriteChanged"));
                    return;
                  }
                  if (
                    prefs.value.favorites.some(
                      (item) =>
                        item.uid !== original.uid && pluginFavoriteMatches(item),
                    )
                  ) {
                    setError(t("models.unified.favoriteExists"));
                    return;
                  }
                  const nextEffort = pluginFavoriteEdit.effort;
                  await prefs.save({
                    ...prefs.value,
                    favorites: prefs.value.favorites.map((item) =>
                      item.uid === original.uid
                        ? {
                            ...item,
                            agent: PLUGIN_ENGINE_MOBILE_WIRE_AGENT,
                            effort: nextEffort ?? "",
                            fast: false,
                          }
                        : item,
                    ),
                  });
                  if (!isCurrent()) return;
                  setPluginFavoriteEdit(null);
                  setPluginTarget((current) => (current ? { ...current, effort: nextEffort } : current));
                  setNotice(t("models.unified.favoriteUpdated"));
                });
              },
              onFavorite: () => {
                if (!prefs.favoritesReady || pluginFavoriteEdit || pluginFavoriteSource === null) return;
                void transact(async (isCurrent) => {
                  if (pluginFavoriteToRemove) {
                    await prefs.save({
                      ...prefs.value,
                      favorites: prefs.value.favorites.filter(
                        (item) => item.uid !== pluginFavoriteToRemove.uid,
                      ),
                    });
                    if (isCurrent()) setNotice(t("models.unified.favoriteRemoved"));
                  } else {
                    if (prefs.value.favorites.some(pluginFavoriteMatches)) {
                      if (isCurrent()) setNotice(t("models.unified.favoriteSaved"));
                      return;
                    }
                    await prefs.save(
                      addModelFavorite(
                        prefs.value,
                        {
                          providerId: pluginFavoriteSource,
                          modelId: activePluginRow.modelId,
                          agent: PLUGIN_ENGINE_MOBILE_WIRE_AGENT,
                          effort: activePluginRow.effort ?? "",
                          fast: false,
                        },
                        createFavoriteUid(),
                      ),
                    );
                    if (isCurrent()) setNotice(t("models.unified.favoriteSaved"));
                  }
                });
              },
            }
          : undefined
      }
    />
  );
}
