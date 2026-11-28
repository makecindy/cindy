/**
 * 模型选择器的智能路由编排层（单一事实来源）：
 *
 * 将原本散落在 `ModelSelector.tsx` 面板体、触发器与回调中的智能路由规则收拢到一处：
 * 1) 统一判定本入口是否启用「按供应商合并路由」、当前生效路由（含隐式命中）及跨机目录宿主；
 * 2) 统一净化传给 `ModelGroupsPickerSection` 的配置：宿主「智能路由」格与「其他电脑」模式格
 *    都只列用户按模型排的路由，其中「其他电脑」还按该电脑允许远程调用的来源过滤；
 * 3) 统一构建内置供应商、插件执行引擎与宿主侧栏的合并路由投影，支持真实成员级可见性判定与
 *    收藏/最近身份去虚拟化（避免 `sroute:` 泄漏落盘）；
 * 4) 统一拦截草稿(`onAttach`)与进行中任务(`onPickMerged`)对合并模型行的点选、配置与跨引擎切换；
 * 5) 统一计算触发器（trigger）的路由名、托管徽标与断连抑制状态。
 */
import { useCallback, useMemo } from 'react';
import type { AgentKind, CatalogModel, ProviderView } from '@cindy/model-providers';
import type { TFunction } from 'i18next';

import {
  filterRemoteDeviceModelGroupsConfig,
  implicitSourceRouteSelection,
  isSourceRouteProviderId,
  withSourceRoutePluginEngines,
  withSourceRouteProviders,
  type SourceRoutePluginEngines,
  type SourceRouteProviders,
} from '@/features/model-groups/sourceRouteProviders';
import { useDevicesProviders } from '@/hooks/useDevicesProviders';
import { deviceDisplayName } from '@/lib/deviceName';
import { isDeviceModelVisible } from '@/lib/providerModels';

import { modelCatalogKey } from '../../../shared/controlledModelCatalog';
import {
  MODEL_GROUPS_DEFAULTS,
  type ModelGroupRoute,
  type ModelGroupSelection,
  type ModelGroupsConfig,
} from '../../../shared/modelGroups';
import {
  buildModelGroupPickerRows,
  isModelGroupSelected,
  type ModelGroupsPickerDevice,
  type ModelGroupsPickerProps,
} from './ModelGroupsPickerSection';
import type { PluginEnginesPickerProps } from './PluginEnginesSection';
import { remoteAgentProviders } from './unifiedModelSelection';
import type { UnifiedModelPanelProps } from './UnifiedModelPanel';

export interface ModelSelectorRoutingModeInput {
  modelGroups?: ModelGroupsPickerProps;
  hasUnifiedSelect: boolean;
  providersOverride: boolean;
  sshCatalog: boolean;
  currentProviderId?: string | null;
  modelId: string;
  remoteAgentDeviceId: string | null;
  catalogHostDeviceId?: string;
  homeDeviceId?: string;
  deviceIdProp?: string;
  /** 伙伴已保存的固定来源：有显式 providerId 且未显式选路由时，不隐式吸附进供应商路由。 */
  checkSavedSource?: boolean;
}

export interface ModelSelectorRoutingMode {
  /** 是否将供应商路由作为虚拟供应商并入本入口的供应商列表。 */
  mergedSourceRoutesEnabled: boolean;
  /** 宿主目录（非「浏览其他电脑」时）生效的供应商路由配置。 */
  homeSourceRouteConfig: ModelGroupsConfig | null;
  /** 面板/触发器视角的生效路由（显式 active 优先，否则草稿未隐藏合并成员隐式命中）。 */
  effectiveActive: ModelGroupSelection | null;
  /** 当前生效路由若属于宿主某条未隐藏的供应商路由展开项，返回该展开路由；远程设备路由不命中。 */
  activeExpandedRoute: ModelGroupRoute | null;
  /** 打开面板时当前选择是否落在合并供应商路由下（决定初始浏览目录与是否保留具体成员单列）。 */
  activeSourceRouteAtOpen: boolean;
  /** 进行中任务未绑定合并路由时，保留当前真实运行成员单列，不强行收进 `sroute:`。 */
  keepCurrentMember: boolean;
  /** 读取合并路由里的跨机/分享成员目录时，应向哪台电脑发起目录转发（undefined = 本机）。 */
  sourceRouteCatalogHostId: string | undefined;
}

/** 统一判定模型选择器中智能路由与合并供应商路由的生效口径（面板与触发器共用）。 */
export function resolveModelSelectorRoutingMode(
  input: ModelSelectorRoutingModeInput,
): ModelSelectorRoutingMode {
  const {
    modelGroups,
    hasUnifiedSelect,
    providersOverride,
    sshCatalog,
    currentProviderId,
    modelId,
    remoteAgentDeviceId,
    catalogHostDeviceId,
    homeDeviceId,
    deviceIdProp,
    checkSavedSource = false,
  } = input;

  const mergedSourceRoutesEnabled =
    ((!!modelGroups?.onAttach && hasUnifiedSelect) || !!modelGroups?.onPickMerged)
    && !providersOverride
    && !sshCatalog;

  const homeSourceRouteConfig = mergedSourceRoutesEnabled
    ? modelGroups?.config ?? null
    : null;

  const effectiveActive: ModelGroupSelection | null = modelGroups?.active ?? (
    modelGroups?.onAttach && !providersOverride && !sshCatalog && !(checkSavedSource && currentProviderId)
      ? implicitSourceRouteSelection(modelGroups.config, {
          providerId: currentProviderId,
          model: modelId,
          agentDeviceId: remoteAgentDeviceId,
        })
      : null
  );

  const activeExpandedRoute = mergedSourceRoutesEnabled && effectiveActive && !effectiveActive.deviceId
    ? modelGroups!.config.routes.find(
        (route) => route.id === effectiveActive.id && !!route.parent && !route.hidden,
      ) ?? null
    : null;

  const activeSourceRouteAtOpen = !!activeExpandedRoute;
  const keepCurrentMember = !modelGroups?.onAttach && !activeSourceRouteAtOpen;
  // 远控被控电脑但未传 remoteAgent（如协同/无跨机位置列表的会话或设置页）时，回退到 deviceIdProp，
  // 避免被控端合并路由中的分享/跨机成员误查控制端本机目录。
  const sourceRouteCatalogHostId = catalogHostDeviceId ?? homeDeviceId ?? deviceIdProp;

  return {
    mergedSourceRoutesEnabled,
    homeSourceRouteConfig,
    effectiveActive,
    activeExpandedRoute,
    activeSourceRouteAtOpen,
    keepCurrentMember,
    sourceRouteCatalogHostId,
  };
}

export interface RemoteDeviceCatalogReachability {
  deviceId: string;
  /** 该电脑开启「允许被远程调用」的内置供应商列表。 */
  providers: readonly ProviderView[];
}

/**
 * 为「其他电脑」模型组格筛出可展示的远程电脑及其有效路由：
 * - 仅列已出现在 `remoteAgentGroups` 中的电脑（若调用方传入）；
 * - 剥离远程电脑自己的供应商路由展开项(`route.parent`)与隐藏项；
 * - 仅保留在该电脑上至少有一个本地且允许远程调用来源（或经时段例外可达）的路由，以及当前已选中的路由。
 */
export function resolveModelSelectorDeviceGroups(options: {
  devices: readonly ModelGroupsPickerDevice[] | undefined;
  remoteAgentGroups?: readonly RemoteDeviceCatalogReachability[];
  pluginEngines?: readonly { providerId: string; deviceId?: string }[];
  active?: ModelGroupSelection | null;
}): ModelGroupsPickerDevice[] {
  const { devices, remoteAgentGroups, pluginEngines, active } = options;
  if (!devices || devices.length === 0) return [];
  const remoteByDevice = remoteAgentGroups
    ? new Map(remoteAgentGroups.map((group) => [group.deviceId, group]))
    : null;
  return devices.flatMap((device) => {
    const activeRouteId = active?.deviceId === device.deviceId ? active.id : null;
    if (remoteByDevice && !remoteByDevice.has(device.deviceId) && !activeRouteId) return [];
    const remoteGroup = remoteByDevice?.get(device.deviceId);
    const remoteInvocableProviderIds = remoteGroup
      ? new Set(remoteGroup.providers.map((provider) => provider.id))
      : undefined;
    const remoteInvocablePluginProviderIds = remoteGroup && pluginEngines !== undefined
      ? new Set(
          pluginEngines
            .filter((engine) => engine.deviceId === device.deviceId)
            .map((engine) => engine.providerId),
        )
      : undefined;
    const filtered = filterRemoteDeviceModelGroupsConfig(device.config, {
      ...(remoteInvocableProviderIds ? { remoteInvocableProviderIds } : {}),
      ...(remoteInvocablePluginProviderIds ? { remoteInvocablePluginProviderIds } : {}),
      activeRouteId,
    });
    if (filtered.routes.length === 0) return [];
    return [{ ...device, config: filtered }];
  });
}

/**
 * 构造传给 `ModelGroupsPickerSection` 的净化配置：
 * - 启用合并供应商路由时，宿主「智能路由」格只列用户按模型排的路由（不含 `route.parent`）；
 * - `devices` 替换为经 `resolveModelSelectorDeviceGroups` 净化后的远程设备模式列表。
 */
export function buildPanelModelGroups(options: {
  modelGroups: ModelGroupsPickerProps | undefined;
  mergedSourceRoutesEnabled: boolean;
  devices: readonly ModelGroupsPickerDevice[];
}): ModelGroupsPickerProps | undefined {
  const { modelGroups, mergedSourceRoutesEnabled, devices } = options;
  if (!modelGroups) return undefined;
  const config = mergedSourceRoutesEnabled
    ? { ...modelGroups.config, routes: modelGroups.config.routes.filter((route) => !route.parent) }
    : modelGroups.config;
  return {
    ...modelGroups,
    config,
    ...(devices.length > 0 ? { devices } : { devices: undefined }),
  };
}

/** 从合并供应商路由虚拟行还原真实本机成员身份，避免 `sroute:` 泄漏到跨设备收藏 / 最近 / 种子收藏。 */
export function resolveStoredSourceRouteIdentity(
  sourceRoutes: Pick<SourceRouteProviders, 'hit'>,
  providerId: string,
  storedModelId: string,
): { providerId: string; modelId: string } | null {
  if (!isSourceRouteProviderId(providerId)) return null;
  const hit = sourceRoutes.hit(providerId, storedModelId);
  if (!hit) return null;
  const localCandidate = !hit.candidate.agentDeviceId
    ? hit.candidate
    : hit.route.candidates.find((candidate) => !candidate.off && !candidate.agentDeviceId && candidate.agentKind !== 'acp');
  return localCandidate ? { providerId: localCandidate.providerId, modelId: localCandidate.model } : null;
}

/** 将收藏 / 最近里保存的真实本机成员映射到面板当前展示的合并供应商路由行。 */
export function resolveStoredSourceRouteAlias(
  sourceRoutes: Pick<SourceRouteProviders, 'shownAs' | 'shownModelId'>,
  sourceRoutesListed: boolean,
  providerId: string,
  storedModelId: string,
): { providerId: string; modelId: string } | null {
  if (!sourceRoutesListed) return null;
  const shown = sourceRoutes.shownAs(providerId, null, null);
  if (!shown) return null;
  return {
    providerId: shown,
    modelId: sourceRoutes.shownModelId(providerId, storedModelId, null, null) ?? storedModelId,
  };
}

export function buildMergedPickContext(
  effort?: string | null,
  fast?: boolean | 'ultrafast',
): { effort?: string; fastMode?: true | 'ultrafast' } {
  return {
    ...(effort ? { effort } : {}),
    ...(fast ? { fastMode: fast === 'ultrafast' ? 'ultrafast' : true } : {}),
  };
}

export function applyDraftSourceRouteAttach<T extends void | boolean | Promise<void | boolean>>(
  applied: T,
  routeId: string,
  onAttach?: (selection: ModelGroupSelection) => void,
): T {
  const attach = (ok: void | boolean) => {
    if (ok !== false) onAttach?.({ type: 'route', id: routeId });
  };
  if (applied instanceof Promise) void applied.then(attach);
  else attach(applied);
  return applied;
}

export function invokeMergedRoutePick(
  pickMerged: NonNullable<ModelGroupsPickerProps['onPickMerged']>,
  routeId: string,
  context: { effort?: string; fastMode?: true | 'ultrafast' },
  onCommitted?: () => void,
): boolean | Promise<boolean> {
  const result = pickMerged({ type: 'route', id: routeId }, context);
  const finish = (applied: void | boolean): boolean => {
    const ok = applied !== false;
    if (ok) onCommitted?.();
    return ok;
  };
  if (result && typeof result === 'object' && 'then' in result) {
    return Promise.resolve(result).then(finish, () => false);
  }
  return finish(result);
}

export interface ModelSelectorTriggerRoutingInput {
  modelGroups?: ModelGroupsPickerProps;
  hasUnifiedSelect: boolean;
  providersOverride: boolean;
  sshCatalog: boolean;
  checkSavedSource: boolean;
  currentProviderId?: string | null;
  activeSourceId?: string | null;
  modelId: string;
  agentDeviceId: string | null;
  t: TFunction;
}

export interface ModelSelectorTriggerRouting {
  effectiveTriggerModelGroup: ModelGroupSelection | null;
  /** 草稿下当前模型属于某条未隐藏供应商路由时，该父路由的展示名。 */
  activeSourceRouteName: string | null;
  /** 进行中任务处于智能路由持续托管时的路由名。 */
  activeManagedRouteName: string | null;
  /** 触发器图标角标展示用的路由名（供应商路由或持续托管路由）。 */
  activeRouteBadgeName: string | null;
  /** 选中的非合并用户路由（按钮主文案直接显示该路由名；合并路由与持续托管保留具体模型名）。 */
  shownModelGroupRow: ReturnType<typeof buildModelGroupPickerRows>[number] | null;
}

/** 触发器（trigger）侧的智能路由投影：统一计算角标、路由文案与是否覆盖模型名。 */
export function resolveModelSelectorTriggerRouting(
  input: ModelSelectorTriggerRoutingInput,
): ModelSelectorTriggerRouting {
  const {
    modelGroups,
    hasUnifiedSelect,
    providersOverride,
    sshCatalog,
    checkSavedSource,
    currentProviderId,
    activeSourceId,
    modelId,
    agentDeviceId,
    t,
  } = input;

  const mode = resolveModelSelectorRoutingMode({
    modelGroups,
    hasUnifiedSelect,
    providersOverride,
    sshCatalog,
    currentProviderId: currentProviderId ?? activeSourceId,
    modelId,
    remoteAgentDeviceId: agentDeviceId,
    checkSavedSource,
  });

  // 草稿（onAttach）选着合并供应商路由下的模型时显示父路由名；远程设备路由不查本机 config。
  const activeSourceRouteName =
    modelGroups?.onAttach && mode.effectiveActive && !mode.effectiveActive.deviceId
      ? modelGroups.config.routes.find(
          (route) => route.id === mode.effectiveActive!.id && !route.hidden,
        )?.parent?.name ?? null
      : null;

  const activeManagedRouteName = modelGroups?.managedMeta?.routeName ?? null;
  const activeRouteBadgeName = activeSourceRouteName ?? activeManagedRouteName;

  const activeModelGroupDevice = modelGroups?.active?.deviceId
    ? modelGroups.devices?.find((device) => device.deviceId === modelGroups.active?.deviceId)
    : undefined;

  const activeModelGroupRow = modelGroups?.active
    ? (activeModelGroupDevice
        ? buildModelGroupPickerRows(
            filterRemoteDeviceModelGroupsConfig(activeModelGroupDevice.config, {
              activeRouteId: modelGroups.active.id,
            }),
            t,
            activeModelGroupDevice.deviceId,
          ).map((row) => ({ ...row, name: `${row.name} · ${activeModelGroupDevice.name}` }))
        : buildModelGroupPickerRows(modelGroups.config ?? MODEL_GROUPS_DEFAULTS, t)
      ).find((row) => isModelGroupSelected(modelGroups.active, row.selection)) ?? null
    : null;

  // 供应商路由下的模型在草稿里保留具体模型名；进行中任务托管时也保留实际运行的模型名（图标叠路由角标）。
  const shownModelGroupRow =
    modelGroups?.managedMeta || (activeModelGroupRow?.parent && (modelGroups?.onAttach || modelGroups?.onPickMerged))
      ? null
      : activeModelGroupRow;

  return {
    effectiveTriggerModelGroup: mode.effectiveActive,
    activeSourceRouteName,
    activeManagedRouteName,
    activeRouteBadgeName,
    shownModelGroupRow,
  };
}

export interface UseModelSelectorSmartRoutingOptions<TUnifiedSelect extends {
  providerId: string;
  modelId: string;
  effort?: string;
  fast: boolean | 'ultrafast';
  agentDevice?: { deviceId: string; name: string } | null;
}> {
  modelGroupsProp?: ModelGroupsPickerProps;
  routingMode: ModelSelectorRoutingMode;
  onUnifiedSelectProp?: (selection: TUnifiedSelect) => void | boolean | Promise<void | boolean>;
  currentProviderIdProp?: string | null;
  modelId: string;
  remoteAgent?: {
    devices: readonly { deviceId: string; name?: string | null }[];
    selectedDeviceId: string | null;
  };
  remoteBrowseActive: boolean;
  listedProviders: ProviderView[];
  homeBaseProviders: ProviderView[];
  pluginEngines?: PluginEnginesPickerProps;
  t: TFunction;
}

/**
 * 面板体（`ModelSelectorContent`）的智能路由 hook：
 * 集中管理跨机成员目录拉取、虚拟供应商合并、插件引擎合并、可见性代理与选择拦截。
 */
export function useModelSelectorSmartRouting<TUnifiedSelect extends {
  providerId: string;
  modelId: string;
  effort?: string;
  fast: boolean | 'ultrafast';
  agentDevice?: { deviceId: string; name: string } | null;
}>(options: UseModelSelectorSmartRoutingOptions<TUnifiedSelect>) {
  const {
    modelGroupsProp,
    routingMode,
    onUnifiedSelectProp,
    currentProviderIdProp,
    modelId,
    remoteAgent,
    remoteBrowseActive,
    listedProviders,
    homeBaseProviders,
    pluginEngines,
    t,
  } = options;

  const remoteAgentDeviceId = remoteAgent?.selectedDeviceId ?? null;

  const {
    mergedSourceRoutesEnabled,
    homeSourceRouteConfig,
    effectiveActive: effectiveModelGroupsActive,
    activeSourceRouteAtOpen,
    keepCurrentMember,
    sourceRouteCatalogHostId,
  } = routingMode;

  const sourceRoutesListed = !!homeSourceRouteConfig && !remoteBrowseActive;
  const sourceRouteConfig = sourceRoutesListed ? homeSourceRouteConfig : null;

  // 成员可以在其他电脑上或是分享来的：读那些位置的目录(与下面列那台模型用的是同一份缓存，不多发请求)。
  const sourceRouteRemoteIds = useMemo(
    () => [
      ...new Set(
        (homeSourceRouteConfig?.sourceRoutes ?? [])
          .filter((route) => !route.hidden)
          .flatMap((route) =>
            route.sources.flatMap((source) => (!source.off && source.agentDeviceId ? [source.agentDeviceId] : [])),
          ),
      ),
    ],
    [homeSourceRouteConfig],
  );
  const sourceRouteRemoteCatalogKeys = useMemo(
    () => sourceRouteRemoteIds.map((id) => modelCatalogKey(id, sourceRouteCatalogHostId) ?? id),
    [sourceRouteRemoteIds, sourceRouteCatalogHostId],
  );
  const sourceRouteRemoteCatalogs = useDevicesProviders(sourceRouteRemoteCatalogKeys, {
    retainDisplaySnapshot: true,
  });
  const sourceRouteRemote = useMemo(
    () =>
      new Map(
        sourceRouteRemoteIds.flatMap((id, index) => {
          const catalog = sourceRouteRemoteCatalogs.get(sourceRouteRemoteCatalogKeys[index]);
          return catalog ? ([[id, remoteAgentProviders(catalog.providers)] as const]) : [];
        }),
      ),
    [sourceRouteRemoteIds, sourceRouteRemoteCatalogKeys, sourceRouteRemoteCatalogs],
  );
  const sourceRouteRemoteVisibilityOverrides = useMemo(
    () =>
      new Map(
        sourceRouteRemoteIds.flatMap((id, index) => {
          const catalog = sourceRouteRemoteCatalogs.get(sourceRouteRemoteCatalogKeys[index]);
          return catalog ? ([[id, catalog.modelVisibilityOverrides] as const]) : [];
        }),
      ),
    [sourceRouteRemoteIds, sourceRouteRemoteCatalogKeys, sourceRouteRemoteCatalogs],
  );

  const sourceRouteCurrent = useMemo(
    () => ({
      providerId: currentProviderIdProp,
      modelId,
      agentDeviceId: remoteAgentDeviceId,
      keepMember: keepCurrentMember,
    }),
    [currentProviderIdProp, modelId, remoteAgentDeviceId, keepCurrentMember],
  );

  const sourceRoutePluginCurrent = useMemo(
    () =>
      pluginEngines?.active
        ? { ...pluginEngines.active, keepMember: keepCurrentMember }
        : null,
    [pluginEngines?.active, keepCurrentMember],
  );

  const sourceRouteLabel = useCallback(
    (name: string, count: number) => t('modelGroups.picker.mergedLabel', { name, count }),
    [t],
  );

  const sourceRoutes = useMemo(
    () => withSourceRouteProviders(listedProviders, sourceRouteConfig, sourceRouteCurrent, sourceRouteRemote, sourceRouteLabel),
    [listedProviders, sourceRouteConfig, sourceRouteCurrent, sourceRouteRemote, sourceRouteLabel],
  );

  // 有其他电脑可选时，宿主侧栏独立从宿主目录构建，切去浏览「其他电脑」时左栏本机/宿主合并格保持稳定。
  const homeSourceRoutes = useMemo(
    () => withSourceRouteProviders(homeBaseProviders, homeSourceRouteConfig, sourceRouteCurrent, sourceRouteRemote, sourceRouteLabel),
    [homeBaseProviders, homeSourceRouteConfig, sourceRouteCurrent, sourceRouteRemote, sourceRouteLabel],
  );

  // 插件引擎格同样属于左栏稳定区：使用 homeSourceRouteConfig（而非随 remoteBrowse 置空的 sourceRouteConfig），
  // 防止切去浏览其他电脑时左栏合并的插件引擎格瞬间拆散成单个成员。
  const sourceRoutePluginEngines = useMemo<SourceRoutePluginEngines>(
    () => withSourceRoutePluginEngines(pluginEngines?.engines ?? [], homeSourceRouteConfig, sourceRoutePluginCurrent, sourceRouteLabel),
    [pluginEngines?.engines, homeSourceRouteConfig, sourceRoutePluginCurrent, sourceRouteLabel],
  );

  const currentProviderId =
    sourceRoutes.shownAs(currentProviderIdProp, effectiveModelGroupsActive?.id, remoteAgentDeviceId) ?? currentProviderIdProp;
  const shownModelId =
    (isSourceRouteProviderId(currentProviderId)
      ? sourceRoutes.shownModelId(currentProviderIdProp, modelId, effectiveModelGroupsActive?.id, remoteAgentDeviceId)
      : null) ?? modelId;

  const activeSourceRoute =
    !!effectiveModelGroupsActive
    && (homeSourceRoutes.shownAs(null, effectiveModelGroupsActive.id) !== null
      || sourceRoutes.shownAs(null, effectiveModelGroupsActive.id) !== null
      || sourceRoutePluginEngines.shownAs(null, effectiveModelGroupsActive.id) !== null);

  const attachSourceRoute = modelGroupsProp?.onAttach;
  const pickMerged = modelGroupsProp?.onPickMerged;

  const effectivePluginEngines = useMemo<PluginEnginesPickerProps | undefined>(() => {
    if (!pluginEngines) return undefined;
    const mapSelection = (sel: PluginEnginesPickerProps['active']): PluginEnginesPickerProps['active'] => {
      if (!sel) return null;
      const shown = sourceRoutePluginEngines.shownAs(sel.providerId, effectiveModelGroupsActive?.id, sel.deviceId);
      if (!shown) return sel;
      return { ...sel, providerId: shown, deviceId: undefined };
    };
    return {
      ...pluginEngines,
      engines: sourceRoutePluginEngines.engines,
      active: mapSelection(pluginEngines.active),
      running: mapSelection(pluginEngines.running ?? null),
      onSelect: (selection) => {
        const hit = sourceRoutePluginEngines.hit(selection.providerId, selection.modelId);
        if (!hit) return pluginEngines.onSelect(selection);
        if (pickMerged) {
          return invokeMergedRoutePick(
            pickMerged,
            hit.route.id,
            selection.effort ? { effort: selection.effort } : {},
          );
        }
        const applied = pluginEngines.onSelect({
          ...selection,
          providerId: hit.candidate.providerId,
          modelId: hit.candidate.model,
          ...(hit.candidate.agentDeviceId ? { deviceId: hit.candidate.agentDeviceId } : { deviceId: undefined }),
        });
        return applyDraftSourceRouteAttach(applied, hit.route.id, attachSourceRoute);
      },
    };
  }, [pluginEngines, sourceRoutePluginEngines, effectiveModelGroupsActive?.id, pickMerged, attachSourceRoute]);

  const resolveStoredProviderAlias = useCallback(
    (providerId: string, storedModelId: string) =>
      resolveStoredSourceRouteAlias(sourceRoutes, sourceRoutesListed, providerId, storedModelId),
    [sourceRoutes, sourceRoutesListed],
  );

  const resolveStoredIdentity = useCallback(
    (providerId: string, storedModelId: string) =>
      resolveStoredSourceRouteIdentity(sourceRoutes, providerId, storedModelId),
    [sourceRoutes],
  );

  const onUnifiedSelect = useMemo<typeof onUnifiedSelectProp>(
    () =>
      onUnifiedSelectProp && ((selection) => {
        const hit = sourceRoutes.hit(selection.providerId, selection.modelId);
        if (!hit) return onUnifiedSelectProp(selection);
        if (pickMerged) {
          return pickMerged(
            { type: 'route', id: hit.route.id },
            buildMergedPickContext(selection.effort, selection.fast),
          );
        }
        const location = hit.candidate.agentDeviceId;
        const applied = onUnifiedSelectProp({
          ...selection,
          providerId: hit.candidate.providerId,
          modelId: hit.candidate.model,
          ...(location
            ? { agentDevice: { deviceId: location, name: deviceDisplayName(location, undefined, remoteAgent?.devices ?? []) } }
            : {}),
        });
        return applyDraftSourceRouteAttach(applied, hit.route.id, attachSourceRoute);
      }),
    [onUnifiedSelectProp, sourceRoutes, attachSourceRoute, pickMerged, remoteAgent?.devices],
  );

  /** 为虚拟 `sroute:` 模型行按其真实成员在各自位置的可见性判定是否显示；非虚拟行返回 null。 */
  const checkSourceRouteVisibility = useCallback(
    (
      providerId: string,
      model: { id: string; defaultEnabled?: boolean },
      agent: AgentKind,
      checkHostMember: (memberProviderId: string, memberModel: CatalogModel, memberAgent: AgentKind) => boolean,
      target: 'active' | 'home' = 'active',
    ): boolean | null => {
      const projection = target === 'home' ? homeSourceRoutes : sourceRoutes;
      return projection.isModelVisible(providerId, model.id, agent, (member) => {
        if (!member.agentDeviceId) {
          return checkHostMember(member.providerId, member.model, member.agent);
        }
        return isDeviceModelVisible(
          sourceRouteRemoteVisibilityOverrides.get(member.agentDeviceId),
          member.agent,
          member.providerId,
          member.model,
        );
      });
    },
    [sourceRoutes, homeSourceRoutes, sourceRouteRemoteVisibilityOverrides],
  );

  const tryPickMergedBuiltIn = useCallback(
    (
      providerId: string,
      chosenModelId: string,
      options: {
        effort?: string;
        fast?: boolean | 'ultrafast';
        onCommitted?: () => void;
      },
    ): boolean | Promise<boolean> | null => {
      if (!pickMerged) return null;
      const hit = sourceRoutes.hit(providerId, chosenModelId);
      if (!hit) return null;
      return invokeMergedRoutePick(
        pickMerged,
        hit.route.id,
        buildMergedPickContext(options.effort, options.fast),
        options.onCommitted,
      );
    },
    [pickMerged, sourceRoutes],
  );

  const wrapSessionEngineFilter = useCallback(
    (
      baseSessionEngineFilter: UnifiedModelPanelProps['sessionEngineFilter'],
      onDismissSelect: () => void,
    ): UnifiedModelPanelProps['sessionEngineFilter'] => {
      if (!baseSessionEngineFilter || !pickMerged) return baseSessionEngineFilter;
      return {
        ...baseSessionEngineFilter,
        onCrossEngineSelect: (args) => {
          const picked = tryPickMergedBuiltIn(args.providerId, args.modelId, {
            effort: args.effort || undefined,
            fast: args.fast,
            onCommitted: onDismissSelect,
          });
          return picked !== null ? picked : baseSessionEngineFilter.onCrossEngineSelect(args);
        },
        onCrossEngineConfigure: (args) => {
          const picked = tryPickMergedBuiltIn(args.providerId, args.modelId, {
            effort: args.effort || undefined,
            fast: args.fast,
          });
          return picked !== null ? picked : (baseSessionEngineFilter.onCrossEngineConfigure?.(args) ?? false);
        },
      };
    },
    [pickMerged, tryPickMergedBuiltIn],
  );

  return {
    mergedSourceRoutesEnabled,
    effectiveModelGroupsActive,
    activeSourceRouteAtOpen,
    sourceRoutesListed,
    sourceRoutes,
    homeSourceRoutes,
    sourceRoutePluginEngines,
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
  };
}
