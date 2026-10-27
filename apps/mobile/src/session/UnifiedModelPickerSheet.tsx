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
} from "@cindy/device-link";
import { useTranslation } from "react-i18next";
import type { MobileProviderMarkProps } from "./MobileProviderMark";
import type { AgentKind } from "@cindy/model-providers/types";
import type { UnifiedModelEntry } from "@cindy/model-providers";
import type { MobileAgentCapabilities } from "./agentCapabilities";
import type { ModelPickerSheetProps } from "./ModelPickerSheet";
import { buildMobileModelSections } from "./providerModelSections";
import { useMobileModelPreferences } from "./mobileModelPreferences";
import {
  addModelFavorite,
  matchesEntry,
  mobileUnifiedEntries,
  modelKey,
  resolveMobileModelConfig,
  sameConfiguration,
  type MobileModelConfiguration,
  type MobileModelFavorite,
} from "./unifiedMobileModels";
import { useDraftModelMemoryVersion } from "./draftModelMemory";
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

export interface UnifiedMobilePickerOptions {
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
  /**
   * 远程 Agent(已建任务):同账号其他电脑上开放了远程调用的供应商,接在被控电脑自己的供应商
   * 之后,每个供应商一段、标题带电脑名(与桌面模型面板同口径)。缺省 = 只列被控电脑的目录。
   */
  remote?: {
    catalogs: readonly RemoteAgentCatalog[];
    /** 当前选中态(下一条消息时 Agent 所在电脑)属于哪份目录;null = 被控电脑。 */
    selectedDeviceId: string | null;
    /**
     * 被控电脑的设备 id:按目录里的组摘要把组里其他电脑上的这个供应商收进组那一项,标题带台数
     * (provider-groups.md §10)。缺省 = 不收起。
     */
    hostDeviceId?: string;
    /**
     * 已建任务:这个任务此刻归哪个组(null = 没归组)与 Agent 此刻在哪台、用哪个供应商(null = 被控电脑)。
     * 归组的任务在组那一项里显示为正在用的,在里面选模型 = 留在此刻运行的那台、只换模型。
     */
    providerGroup?: {
      bound: MobileProviderGroupEntry | null;
      running: { deviceId: string | null; providerId: string | null };
    };
  };
  /** source.deviceId = 这一行来自哪台电脑的目录(null / 缺省 = 被控电脑)。 */
  onSelect(
    configuration: MobileModelConfiguration,
    source?: { deviceId: string | null },
  ): Promise<boolean>;
}
export interface UnifiedMobileRow {
  key: string;
  entry: UnifiedModelEntry;
  config: MobileModelConfiguration;
  favorite?: MobileModelFavorite;
  selected: boolean;
  disabled: boolean;
  subtitle: string;
  costMarks: string | null;
  effortLabel: string;
  quotaLabel: string | null;
  providerMark: MobileProviderMarkProps;
  /** 这一行来自哪台其他电脑的目录(图标带远程标记);缺省 = 被控电脑自己的。 */
  remoteDevice?: { deviceId: string; name: string };
}
export interface UnifiedMobileGroup {
  key: string;
  title: string;
  rows: UnifiedMobileRow[];
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
    quota?: { remaining: number; label: string };
    /**
     * 另一台电脑上的供应商:来源页里每台电脑单独一块(块标题 = 电脑名,行标题 = providerLabel),
     * 图标带远程标记;label 是带电脑名的完整说法,用在搜索栏旁的来源按钮上。
     */
    remote?: { deviceId: string; deviceName: string; providerLabel: string };
  }[];
  groups: UnifiedMobileGroup[];
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
}
const ALL_AGENTS: readonly AgentKind[] = ["claude-code", "codex", "pi"];
export function UnifiedModelPickerSheet(
  p: ModelPickerSheetProps & { unified: UnifiedMobilePickerOptions },
) {
  const { t } = useTranslation();
  const { quotas, now } = useMobileModelQuotas(
    p.unified.scope,
    p.visible,
    p.providers,
  );
  const prefs = useMobileModelPreferences(p.unified.scope, p.visible);
  useDraftModelMemoryVersion();
  useSessionModelMirrorVersion();
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
  // 另一台电脑目录里的行:手机这边的偏好与档位记忆都按被控电脑的供应商记,不写给它们;
  // 详情页里调的档位 / 引擎只在这次打开期间跟着那一行。
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
  const [notice, setNotice] = useState<string | null>(null);
  const [caps, setCaps] = useState<
    Partial<Record<AgentKind, MobileAgentCapabilities>>
  >({});
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const opening = useRef(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!p.visible) return;
    opening.current += 1;
    setQuery("");
    setFilter("all");
    initialRemoteFilter.current = true;
    filterTouched.current = false;
    setTarget(null);
    setRemoteConfigs(new Map());
    setFavoriteEdit(null);
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
  }, [p.visible, p.unified.scope]);
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
  const describe = (
    entry: UnifiedModelEntry,
    config: MobileModelConfiguration,
    providers: readonly (typeof p.providers)[number][] = p.providers,
  ) => {
    const provider = providers.find((item) => item.id === entry.providerId);
    const identity =
      provider?.openAiAccount?.identity?.trim() ||
      provider?.subscriptionAccount?.identity?.trim();
    return [identity, effortText(config)].filter(Boolean).join(" · ");
  };
  const makeRow = (
    entry: UnifiedModelEntry,
    favorite?: MobileModelFavorite,
  ): UnifiedMobileRow => {
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
      providerMark: (() => {
        const provider = p.providers.find(
          (item) => item.id === entry.providerId,
        );
        return {
          providerId: entry.providerId,
          name: provider?.name ?? entry.providerId,
          routing: provider?.routing,
          logoKind: provider?.logoKind,
        };
      })(),
      selected: !favorite && selected,
      disabled:
        !caps[config.agent] ||
        budgetRowDisabled(
          config.modelId,
          p.apiKeyStatus ?? "unknown",
          p.providers.find((item) => item.id === entry.providerId),
        ),
      subtitle: describe(entry, config),
      effortLabel: effortText(config),
      costMarks: mobileCostMarks(
        p.providers.find((item) => item.id === entry.providerId),
        config.modelId,
        config.agent,
        p.pricing,
      ),
      quotaLabel: (() => {
        const q = quotas[entry.providerId];
        const modelQuota = q
          ? mobileWeeklyQuota(q.source, q.raw, now, entry.modelId)
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
      })(),
    };
  };
  const rows = entries.map((entry) => makeRow(entry));
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
    return withGroupBadge(null, id, mobileProviderAccountTitle(provider));
  };
  // 另一台电脑目录里的供应商,说法带电脑名(「Claude 订阅 · 工作室 Mac」)。
  const remoteAccountTitle = (catalog: RemoteAgentCatalog, id: string) => {
    const provider = catalog.providers.find((item) => item.id === id);
    return provider ? mobileProviderAccountTitle(provider) : id;
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
    // 不用手机这边按被控电脑供应商记的引擎偏好与档位记忆:同 id 的供应商在两台电脑上不是同一个。
    // 收藏行按收藏副本解析(位置已从 providerId 里拆出来,这里是那台电脑上的供应商 id)。
    const config =
      (!selected && !favorite ? remoteConfigs.get(key) : undefined) ??
      resolveMobileModelConfig(entry, {
        favorite,
        live: selected
          ? { ...selection, providerId: directory.sourceId ?? "" }
          : undefined,
        pinned: p.existingSessionRoute ? p.agentKind : undefined,
        // Remote catalog capabilities are independent of the host installation.
        fastCapable: () => true,
      });
    const details = describe(entry, config, catalog.providers);
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
      },
      remoteDevice: { deviceId: catalog.deviceId, name: catalog.name },
      selected,
      disabled: !entry.capabilities[config.agent],
      // 「收藏」一节没有带电脑名的分段标题,电脑名写进说明行,和本机同名模型的收藏区分开。
      subtitle: favorite
        ? [catalog.name, details].filter(Boolean).join(" · ")
        : details,
      effortLabel: effortText(config),
      costMarks: mobileCostMarks(
        provider,
        config.modelId,
        config.agent,
        p.pricing,
      ),
      // 用量镜像按被控电脑的供应商取,另一台电脑的不在这里显示。
      quotaLabel: null,
    };
  };
  const remoteRows = remoteDirectories.map((directory) => ({
    catalog: directory.catalog,
    rows: directory.entries.map((entry) => makeRemoteRow(directory, entry)),
  }));
  // 收藏和本机收藏排在同一节里:位置编在 providerId 里的,到那台电脑的目录里找模型,
  // 点开即在那台运行。那台电脑离线(包括只因任务的 Agent 在那台、靠缓存留在列表里)或没开放远程调用时
  // 先不显示,收藏本身保留。
  const favorites = prefs.value.favorites.flatMap((item) => {
    const source = parseAgentDeviceFavoriteSource(item.providerId);
    if (source) {
      const directory = remoteDirectories.find(
        (value) =>
          value.catalog.deviceId === source.deviceId && !value.catalog.offline,
      );
      const entry = directory?.entries.find(
        (value) =>
          value.providerId === source.providerId &&
          matchesEntry(value, item.modelId),
      );
      return directory && entry
        ? [
            makeRemoteRow(directory, entry, {
              ...item,
              providerId: source.providerId,
            }),
          ]
        : [];
    }
    const entry = entries.find(
      (entry) =>
        entry.providerId === item.providerId &&
        matchesEntry(entry, item.modelId),
    );
    return entry ? [makeRow(entry, item)] : [];
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
    (row) => matches(row) && (all || shownFilter === row.entry.providerId),
  );
  const groups: UnifiedMobileGroup[] = [];
  const favoriteRows = favorites.filter(matches);
  if ((all || shownFilter === "favorites") && favoriteRows.length)
    groups.push({
      key: "favorites",
      title: t("models.unified.favorites"),
      rows: favoriteRows,
    });
  const recommended =
    all && p.existingSessionRoute
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
          rows: group,
        });
    }
  // 其他电脑的供应商接在后面:每个供应商一段,标题带电脑名;「收藏」与本机供应商视图里不出现。
  for (const { catalog, rows: deviceRows } of remoteRows)
    for (const provider of catalog.providers) {
      const id = remoteFilterId(catalog.deviceId, provider.id);
      if (!all && shownFilter !== id) continue;
      const group = deviceRows.filter(
        (row) => row.entry.providerId === provider.id && matches(row),
      );
      if (group.length)
        groups.push({
          key: id,
          title: remoteProviderLabel(catalog, provider.id),
          rows: group,
        });
    }
  const sourceRow = target
    ? (target.deviceId
        ? remoteRows.find((item) => item.catalog.deviceId === target.deviceId)
            ?.rows
        : rows
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
  // 这一行存进收藏时用的来源:被控电脑自己的供应商照旧;同账号另一台电脑的供应商把电脑编进去
  // (同 id 供应商在两台电脑上不是同一个)。分享来的供应商暂不支持收藏,返回 null。
  const favoriteSourceOf = (value: UnifiedMobileRow): string | null => {
    const device = value.remoteDevice;
    if (!device) return value.entry.providerId;
    if (isProviderShareAgentDeviceId(device.deviceId)) return null;
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
  // A source model can have several saved configurations. Match the complete
  // configuration without applying capability fallbacks to the saved values.
  const matchingFavorite =
    row &&
    favoriteSource !== null &&
    prefs.value.favorites.find(
      (item) =>
        item.providerId === favoriteSource &&
        matchesEntry(row.entry, item.modelId) &&
        sameConfiguration(
          { ...item, providerId: row.config.providerId, modelId: row.config.modelId },
          row.config,
        ),
    );
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
  // 另一台电脑目录里的行:只有这次打开期间调过档位 / 引擎才能恢复推荐。
  const canReset = row?.remoteDevice
    ? !row.selected && remoteConfigs.has(row.key)
    : localCanReset;
  useEffect(() => {
    if (target && !row) {
      setTarget(null);
      setFavoriteEdit(null);
    }
  }, [target, row]);
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
  const change = (config: MobileModelConfiguration, reset = false) => {
    if (!row) return;
    if (favoriteEdit) {
      if (!lock.current && !p.disabled)
        setFavoriteEdit({ ...favoriteEdit, config });
      return;
    }
    const remoteDevice = row.remoteDevice;
    if (remoteDevice) {
      // 另一台电脑目录里的行:正在用的那行直接生效;其余只在这次打开期间跟着该行,
      // 不写手机的引擎偏好与档位记忆(那些按被控电脑的供应商记)。
      const key = row.key;
      void transact(async (isCurrent) => {
        if (
          row.selected &&
          !(await p.unified.onSelect(
            ...(boundRoute(row, config) ?? [config, { deviceId: remoteDevice.deviceId }]),
          ))
        )
          return;
        if (!isCurrent()) return;
        // 从收藏打开的详情显示的是那份副本(target.config),与本机收藏一样跟着调整走;原收藏不变。
        if (target?.config) {
          setTarget({ ...target, config });
          if (matchingFavorite && !reset)
            setNotice(t("models.unified.originalFavoriteKept"));
        }
        if (row.selected) return;
        setRemoteConfigs((current) => {
          const next = new Map(current);
          if (reset) next.delete(key);
          else next.set(key, config);
          return next;
        });
      });
      return;
    }
    // 被控电脑自己的组那一项(任务归它、此刻在组里别的电脑上运行)里的行同样留在那台。
    const apply = (next: MobileModelConfiguration) => {
      const routed = boundRoute(row, next);
      return routed ? p.unified.onSelect(...routed) : p.unified.onSelect(next);
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
              : matchingFavorite
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
  const remoteFilters = remoteDirectories.flatMap(({ catalog, entries }) =>
    catalog.providers
      .filter((provider) => entries.some((e) => e.providerId === provider.id))
      .map((provider) => ({
        id: remoteFilterId(catalog.deviceId, provider.id),
        label: remoteProviderLabel(catalog, provider.id),
        providerMark: {
          providerId: provider.id,
          name: provider.name,
          routing: provider.routing,
          logoKind: provider.logoKind,
        },
        remote: {
          deviceId: catalog.deviceId,
          deviceName: catalog.name,
          providerLabel: remoteProviderName(catalog, provider.id),
        },
      })),
  );
  const selectedCatalogStatus = selectedCatalog?.status;
  // 那台被收进组里时同样先停在它上面,随即按 shownFilter 改看组那一项。
  const selectedRemoteFilter =
    selectedDeviceId && selectedSourceId
      ? remoteFilterId(selectedDeviceId, selectedSourceId)
      : null;
  useEffect(() => {
    if (!p.visible || !initialRemoteFilter.current) return;
    if (selectedDeviceId === null) {
      initialRemoteFilter.current = false;
      return;
    }
    // 那台电脑的目录还没读到:等一等再定;读不到就留在「全部模型」。
    if (selectedCatalogStatus === undefined || selectedCatalogStatus === "loading")
      return;
    initialRemoteFilter.current = false;
    if (selectedRemoteFilter) setFilter(selectedRemoteFilter);
  }, [p.visible, selectedDeviceId, selectedCatalogStatus, selectedRemoteFilter]);
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
        row
          ? () => {
              if (lock.current) return;
              if (favoriteEdit) setFavoriteEdit(null);
              else setTarget(null);
              setError(null);
              setNotice(null);
            }
          : undefined
      }
      title={
        favoriteEdit
          ? t("models.unified.editFavorite")
          : (row?.entry.displayName ?? t("models.picker.title"))
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
        ...p.providers
          .filter((provider) =>
            entries.some((e) => e.providerId === provider.id),
          )
          .map((provider) => ({
            id: provider.id,
            label: providerName(provider.id),
            quota:
              quotas[provider.id]?.remaining !== undefined
                ? {
                    remaining: quotas[provider.id]!.remaining!,
                    label: [
                      (quotas[provider.id]!.resetsAt
                        ? formatQuotaResetCountdown(
                            quotas[provider.id]!.resetsAt!,
                            now,
                            t,
                            quotas[provider.id]!.windowMinutes ?? null,
                          )
                        : null) ?? t("session.menu.usage.week"),
                      t("session.menu.usage.remaining", {
                        percent: quotas[provider.id]!.remaining,
                      }),
                    ].join(" · "),
                  }
                : undefined,
            providerMark: {
              providerId: provider.id,
              name: provider.name,
              routing: provider.routing,
              logoKind: provider.logoKind,
            },
          })),
        ...remoteFilters,
      ]}
      groups={groups}
      busy={busy || !!p.disabled || !prefs.ready}
      error={error ?? (selectedDeviceId === null && p.providersReady && modelNeedsReselection(p.modelVisibilityOverrides, p.agentKind, p.activeModelId, p.selectedProviderId)
        ? t('session.common.modelHiddenReselect', { model: p.activeModelId }) : null)}
      loading={!!p.loading}
      emptyHint={p.emptyHint ?? t("models.picker.noResults")}
      onSelect={select}
      onOptions={(row) => {
        if (lock.current) return;
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
              isFavorite: !!matchingFavorite,
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
                    matchingFavorite &&
                    matchingFavorite.uid !== original.uid
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
                            modelId: row.entry.modelId,
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
                  if (matchingFavorite) {
                    await prefs.save({
                      ...prefs.value,
                      favorites: prefs.value.favorites.filter(
                        (item) => item.uid !== matchingFavorite.uid,
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
                          modelId: row.entry.modelId,
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
    />
  );
}
