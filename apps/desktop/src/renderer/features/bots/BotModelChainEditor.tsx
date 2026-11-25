import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { isSharedTaskPeer } from '@cindy/device-link';

import { DefaultOverrideControls } from '@/components/settings/DefaultOverrideControls';
import { SettingsRow } from '@/components/ui/settings-rows';
import { useOptionalAuthDeviceId } from '@/contexts/AuthContext';
import type { AgentKind } from '@/hooks/useAgentCapabilities';
import { useSelectableDevices } from '@/hooks/useControllableDevices';
import { useDeviceProviders } from '@/hooks/useDeviceProviders';
import {
  findPluginEngine,
  requestPluginEnginesRefresh,
  useDevicesPluginEngines,
  usePluginEngines,
  useRemotePluginEngines,
} from '@/hooks/usePluginEngines';
import { deviceDisplayName } from '@/lib/deviceName';
import {
  PLUGIN_ENGINE_DEFAULT_MODEL,
  isPluginEngineSelectable,
  remotePluginEngineChoices,
  type PluginEngineChoice,
  type PluginEngineSelection,
} from '@/lib/pluginEngineSelection';
import { providerAccountLabel, providerDisplayName } from '@/lib/providerDisplayName';
import { toast } from '@/lib/toast';
import { ModelRouteSelector } from '@/components/new-chat/ModelRouteSelector';
import type { MakerVendor } from '@/lib/ccAgent.types';
import { previewModelGroup, useModelGroups } from '@/features/model-groups/modelGroupsClient';
import { useProviderShareAgentDevices } from '@/features/provider-share/useProviderShareAgentDevices';
import {
  BOT_MODEL_CHAIN_MAX,
  type BotHarness,
  type BotModelRoute,
} from '../../../shared/botModelChain';
import { MODEL_GROUPS_DEFAULTS, type ModelGroupSelection, type ModelGroupsConfig } from '../../../shared/modelGroups';
import { isPluginEngineEffort } from '../../../shared/pluginEngines';
import { isProviderShareAgentDeviceId } from '../../../shared/providerShare';
import { useBotTranslation } from './botPronounContext';
import { ResetGroupButton } from '@/components/ui/reset-buttons';

function vendorFor(harness: BotHarness): 'cc' | 'codex' | 'pi' {
  return harness === 'claude' ? 'cc' : harness === 'acp' ? 'pi' : harness;
}

function harnessFor(vendor: 'cc' | 'codex' | 'pi'): BotHarness {
  return vendor === 'cc' ? 'claude' : vendor;
}

function agentKindFor(vendor: 'cc' | 'codex' | 'pi'): AgentKind {
  return vendor === 'cc' ? 'claude-code' : vendor;
}

export function BotModelChainEditor({
  'data-setting-id': settingId,
  value,
  onChange: onValueChange,
  disabled = false,
  hiddenVendors = [],
  remote = false,
  deviceId,
  label,
  onRestoreDefault,
  onNavigateToProviders,
  allowFallbacks = true,
  layout = 'inline',
  settingsRows,
  hostModelGroups,
}: {
  'data-setting-id'?: string;
  value: BotModelRoute[];
  onChange: (next: BotModelRoute[]) => void;
  disabled?: boolean;
  hiddenVendors?: MakerVendor[];
  remote?: boolean;
  /** Device-link target; `remote` alone denotes the existing SSH restrictions. */
  deviceId?: string;
  label?: string;
  onRestoreDefault?: () => void;
  onNavigateToProviders?: () => void;
  allowFallbacks?: boolean;
  /**
   * `settings`:设置页卡片行排法——首选模型一行(左名称说明、右选择器与恢复默认),
   * 备用模型一行(左名称说明、右添加按钮),已有备用逐条列在其下。需传 `settingsRows`。
   * 默认 `inline` 保持伙伴页等既有排法不变。
   */
  layout?: 'inline' | 'settings';
  settingsRows?: { primaryLabel: string; primaryHint: string };
  /**
   * 伙伴在另一台电脑(deviceId)上：那台电脑的模型组，随伙伴设置一起读来。选中只记下组，
   * 保存时由那台电脑按组此刻会选的来源补全具体模型(model-groups.md §6.2)。旧版本不带时不提供。
   */
  hostModelGroups?: ModelGroupsConfig;
}) {
  const { t } = useBotTranslation();
  const catalog = useDeviceProviders(deviceId);
  const [pendingRoute, setPendingRoute] = useState<BotModelRoute | null>(null);
  const routes = value.slice(0, BOT_MODEL_CHAIN_MAX);
  // Picker content may be portaled outside a form's disabled fieldset.
  const onChange = (next: BotModelRoute[]) => {
    if (!disabled) onValueChange(next);
  };
  const visibleVendors = (['pi', 'codex', 'cc'] as const)
    .filter((vendor) => !hiddenVendors.includes(vendor));
  const unifiedAgents = visibleVendors.map(agentKindFor);
  const selfDeviceId = useOptionalAuthDeviceId();
  const { devices: selectableDevices } = useSelectableDevices();
  const rememberedPluginEngineDeviceIds = useMemo(() => {
    const ids: string[] = [];
    for (const route of pendingRoute ? [...routes, pendingRoute] : routes) {
      if (route.harness === 'acp' && route.agentDeviceId && !ids.includes(route.agentDeviceId)) {
        ids.push(route.agentDeviceId);
      }
    }
    return ids;
  }, [routes, pendingRoute]);
  const {
    pluginEngineDevices: sharedPluginEngineDevices = [],
    nameFor: providerShareDeviceName,
  } = useProviderShareAgentDevices(rememberedPluginEngineDeviceIds, deviceId);

  const pluginEnginesAllowed = !remote;
  const localPluginEnginesNeeded = pluginEnginesAllowed
    && (!deviceId || (!!selfDeviceId && rememberedPluginEngineDeviceIds.includes(selfDeviceId)));
  const localPluginEngines = usePluginEngines(localPluginEnginesNeeded);
  const {
    engines: remoteHostPluginEngines,
    refresh: refreshRemoteHostPluginEngines,
  } = useRemotePluginEngines(
    pluginEnginesAllowed && deviceId ? deviceId : undefined,
    pluginEnginesAllowed && deviceId ? 'once' : false,
  );
  // 与新任务草稿 / 会话模型列表一致：本机伙伴免装列出同账号其他电脑与已收到插件引擎分享；
  // 远程控制的伙伴除宿主电脑的插件引擎外，也保留已保存的远程/分享插件引擎回显。
  const pluginEngineDevicesKey = pluginEnginesAllowed
    ? JSON.stringify(
        !deviceId
          ? [
              ...selectableDevices
                .filter((device) => !isProviderShareAgentDeviceId(device.deviceId) && !isSharedTaskPeer(device.deviceId)
                  && (device.online || rememberedPluginEngineDeviceIds.includes(device.deviceId)))
                .map(({ deviceId: id, name }): [string, string | null] => [id, name ?? null]),
              ...sharedPluginEngineDevices
                .map(({ deviceId: id, name }): [string, string | null] => [id, name || null]),
              ...rememberedPluginEngineDeviceIds
                .filter((id) => isProviderShareAgentDeviceId(id)
                  && !sharedPluginEngineDevices.some((item) => item.deviceId === id))
                .map((id): [string, string | null] => [id, providerShareDeviceName?.(id) ?? null]),
            ]
          : rememberedPluginEngineDeviceIds
              .filter((id) => id !== deviceId && id !== selfDeviceId && !isSharedTaskPeer(id))
              .map((id): [string, string | null] => [
                id,
                selectableDevices.find((item) => item.deviceId === id)?.name
                  ?? providerShareDeviceName?.(id)
                  ?? null,
              ]),
      )
    : '[]';
  const pluginEngineDevices = useMemo(
    () => (JSON.parse(pluginEngineDevicesKey) as Array<[string, string | null]>).map(([id, name]) => ({ deviceId: id, name })),
    [pluginEngineDevicesKey],
  );
  const pluginEngineDeviceIds = useMemo(() => pluginEngineDevices.map((device) => device.deviceId), [pluginEngineDevices]);
  const { catalogues: devicePluginEngines, read: readDevicePluginEngines } = useDevicesPluginEngines(pluginEngineDeviceIds);
  const rememberedPluginEngineDevicesKey = useMemo(
    () => rememberedPluginEngineDeviceIds.filter((id) => pluginEngineDeviceIds.includes(id)).join('\n'),
    [rememberedPluginEngineDeviceIds, pluginEngineDeviceIds],
  );
  useEffect(() => {
    if (!rememberedPluginEngineDevicesKey) return;
    for (const id of rememberedPluginEngineDevicesKey.split('\n')) readDevicePluginEngines(id);
  }, [rememberedPluginEngineDevicesKey, readDevicePluginEngines]);

  const pluginEngineChoices = useMemo<readonly PluginEngineChoice[]>(() => {
    if (!pluginEnginesAllowed) return [];
    if (deviceId) {
      const base: PluginEngineChoice[] = [...(remoteHostPluginEngines ?? [])];
      for (const route of pendingRoute ? [...routes, pendingRoute] : routes) {
        if (route.harness !== 'acp' || !route.providerId || !route.agentDeviceId) continue;
        if (base.some((item) => item.providerId === route.providerId && item.deviceId === route.agentDeviceId)) continue;
        const source = route.agentDeviceId === selfDeviceId
          ? localPluginEngines
          : devicePluginEngines.get(route.agentDeviceId) ?? [];
        const engine = findPluginEngine(source, route.providerId);
        if (!engine) continue;
        const name = selectableDevices.find((item) => item.deviceId === route.agentDeviceId)?.name
          ?? providerShareDeviceName?.(route.agentDeviceId)
          ?? undefined;
        base.push({ ...engine, deviceId: route.agentDeviceId, deviceName: deviceDisplayName(route.agentDeviceId, name) });
      }
      return base;
    }
    const remoteChoices = remotePluginEngineChoices(pluginEngineDevices, devicePluginEngines, deviceDisplayName, localPluginEngines);
    return remoteChoices.length ? [...localPluginEngines, ...remoteChoices] : localPluginEngines;
  }, [
    pluginEnginesAllowed,
    deviceId,
    remoteHostPluginEngines,
    pendingRoute,
    routes,
    selfDeviceId,
    localPluginEngines,
    devicePluginEngines,
    selectableDevices,
    providerShareDeviceName,
    pluginEngineDevices,
  ]);
  const hasLocalPluginEnginesRef = useRef(false);
  hasLocalPluginEnginesRef.current = localPluginEngines.length > 0;
  const readPluginEngineCatalogues = useCallback(() => {
    if (deviceId) {
      refreshRemoteHostPluginEngines();
      readDevicePluginEngines();
      return;
    }
    if (hasLocalPluginEnginesRef.current) requestPluginEnginesRefresh();
    readDevicePluginEngines();
  }, [deviceId, refreshRemoteHostPluginEngines, readDevicePluginEngines]);

  // 模型组属于伙伴所在的电脑：本机伙伴读本机的组；远程控制另一台电脑时用那台随设置带来的组；SSH 不提供。
  const localGroups = !remote && !deviceId;
  const { config: localGroupsConfig } = useModelGroups(localGroups);
  const groupsAllowed = localGroups || (!!deviceId && !!hostModelGroups);
  const groupsConfig = localGroups ? localGroupsConfig : hostModelGroups ?? MODEL_GROUPS_DEFAULTS;

  /** `modelGroup: undefined` in a patch means a plain model was chosen: drop the group. */
  const merge = (route: BotModelRoute, patch: Partial<BotModelRoute>): BotModelRoute => {
    const next = { ...route, ...patch };
    if ('modelGroup' in patch && !patch.modelGroup) delete next.modelGroup;
    return next;
  };
  const replace = (index: number, patch: Partial<BotModelRoute>) => {
    if (disabled) return;
    if (pendingRoute && index === routes.length) {
      const next = merge(pendingRoute, patch);
      if (next.model && routes.length < BOT_MODEL_CHAIN_MAX) {
        onChange([...routes, next]);
        setPendingRoute(null);
      } else setPendingRoute(next);
      return;
    }
    const editable = routes.length
      ? routes
      : [{ harness: 'pi' as const, model: '', providerId: null, effort: '', fastMode: false }];
    onChange(editable.map((route, at) => (at === index ? merge(route, patch) : route)));
  };
  // 预览要等主进程(可能读别处的目录与额度)：结果只落到最新一次渲染的链上。
  const latest = useRef({ entryAt: (_index: number): BotModelRoute | undefined => undefined, replace });
  latest.current = {
    entryAt: (index) => (pendingRoute && index === routes.length ? pendingRoute : routes[index]),
    replace,
  };
  const pickSeq = useRef(0);
  /**
   * 在合并整个供应商的路由下点了一个模型：面板先交来一个真实成员(onUnifiedSelect)，紧接着在同一次点击里补记路由(onAttach)。
   * 两次改动之间链还没重新渲染，补记时把刚才那次改动一起带上，免得第二次改动用旧链盖掉第一次。
   */
  const lastUnified = useRef<{ index: number; patch: Partial<BotModelRoute> } | null>(null);
  /**
   * 选中一个模型组：立刻记下(按钮马上显示组名，紧接着提交也带上组)，这一项暂以原来的模型作存下的具体模型；
   * 再按组的规则预览一次(不推进轮流)，把组此刻会选的来源换进来，旧版本和组被删掉时都按它运行。
   * 预览回来时这一项已不是「这个组 + 原来的模型」(选了普通模型、哪怕还是同一个，或又选了别的组)就作废。
   * 真正用谁在伙伴开始用这个设置时由组的规则决定。
   */
  const pickGroup = async (index: number, selection: ModelGroupSelection) => {
    const seq = ++pickSeq.current;
    const group = groupsConfig.routes.find((route) => route.id === selection.id);
    const name = group?.name ?? '';
    const before = latest.current.entryAt(index);
    const chosenFrom = before?.model ?? '';
    // 预览失败时退回选之前的组(没有就成普通模型)，不把原来的组关联一起丢掉。
    const previousGroup = before?.modelGroup;
    // 另一台电脑的组在那台选来源：这里只记下组，保存时那台补全具体模型。
    // 新加的备用项还没有模型、不会进入要提交的链，先用组里第一个能用的来源占位，那台保存时再换成组的选择。
    if (!localGroups) {
      const source = chosenFrom ? undefined
        : group?.candidates.find((candidate) => !candidate.off && visibleVendors.includes(candidate.agentKind));
      if (!chosenFrom && !source) {
        toast.warning(t('modelGroups.picker.chooseUnavailable', { name }));
        return;
      }
      replace(index, source ? {
        harness: harnessFor(source.agentKind),
        model: source.model,
        providerId: source.providerId,
        effort: group?.effort ?? '',
        fastMode: false,
        agentDeviceId: source.agentDeviceId ?? null,
        modelGroup: selection.id,
      } : { modelGroup: selection.id });
      return;
    }
    replace(index, { modelGroup: selection.id });
    const result = await previewModelGroup(selection);
    const entry = latest.current.entryAt(index);
    // 还没有任何一项时(「请先选择模型」页)只记组的那次修改没有模型、不会被收下，就由预览直接建出第一项。
    const stillChosen = entry ? entry.modelGroup === selection.id && entry.model === chosenFrom : !chosenFrom;
    if (seq !== pickSeq.current || !stillChosen) return;
    // 与选普通模型同一条限制：这个伙伴不能用的引擎不收。
    if (result?.outcome !== 'routed' || !visibleVendors.includes(result.route.agentKind)) {
      toast.warning(t('modelGroups.picker.chooseUnavailable', { name }));
      latest.current.replace(index, { modelGroup: previousGroup });
      return;
    }
    const { route } = result;
    latest.current.replace(index, {
      harness: harnessFor(route.agentKind),
      model: route.model,
      providerId: route.providerId,
      // 组设了推理强度就用它，否则按该模型的默认档；不沿用原来那个模型的档位。
      effort: route.effort ?? '',
      fastMode: false,
      agentDeviceId: route.agentDeviceId ?? null,
      modelGroup: selection.id,
    });
  };
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (index < 1 || target < 1 || target >= routes.length) return;
    const next = [...routes];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };
  const selectablePluginEngine = pluginEngineChoices.find(isPluginEngineSelectable);
  const add = () => {
    if (disabled || pendingRoute || routes.length >= BOT_MODEL_CHAIN_MAX) return;
    const unused = visibleVendors.find(
      (vendor) => !routes.some((route) => route.harness !== 'acp' && vendorFor(route.harness) === vendor),
    );
    const vendor = unused ?? visibleVendors[0];
    if (vendor) {
      setPendingRoute({ harness: harnessFor(vendor), model: '', providerId: null, effort: '', fastMode: false });
      return;
    }
    if (selectablePluginEngine) {
      setPendingRoute({
        harness: 'acp',
        model: '',
        providerId: selectablePluginEngine.providerId,
        ...(selectablePluginEngine.deviceId ? { agentDeviceId: selectablePluginEngine.deviceId } : {}),
        effort: '',
        fastMode: false,
      });
    } else if (pluginEngineDevices.length > 0) {
      setPendingRoute({ harness: 'pi', model: '', providerId: null, effort: '', fastMode: false });
    }
  };

  const picker = (route: BotModelRoute, index: number, wrapperClassName = 'min-w-0 flex-1') => {
    const routeIsPluginEngine = route.harness === 'acp' && !!route.providerId;
    const showPluginEngines = pluginEnginesAllowed
      && (pluginEngineChoices.length > 0 || pluginEngineDevices.length > 0 || routeIsPluginEngine);
    return (
      <div className={wrapperClassName}>
        <ModelRouteSelector
          disabled={disabled}
          deviceId={deviceId}
          agentDeviceId={routeIsPluginEngine ? undefined : route.agentDeviceId}
          sshRemote={remote && !deviceId}
          vendorKey={vendorFor(route.harness)}
          modelId={route.model}
          effort={route.effort}
          currentProviderId={routeIsPluginEngine ? null : route.providerId}
          agentIdentity={{ vendorKey: vendorFor(route.harness), state: 'current' }}
          triggerVariant="settings"
          popoverSide="bottom"
          ariaContext={t('bots.modelChain.routeLabel', { index: index + 1 })}
          excludeSubscriptionDirect={remote && !deviceId}
          excludeChatBridgedCodex={remote && !deviceId}
          fastMode={routeIsPluginEngine ? false : route.fastMode}
          onModelChange={(model) => replace(index, { model, modelGroup: undefined })}
          onEffortChange={(effort) => replace(index, { effort })}
          onFastModeChange={(fastMode) => replace(index, { fastMode: routeIsPluginEngine ? false : fastMode })}
          onNavigateToProviders={remote || deviceId ? undefined : onNavigateToProviders}
          configurationEnabled
          unifiedPanel
          unifiedAgents={unifiedAgents}
          pluginEngines={showPluginEngines ? {
            engines: pluginEngineChoices,
            active: routeIsPluginEngine && route.model
              ? {
                  providerId: route.providerId!,
                  ...(route.agentDeviceId ? { deviceId: route.agentDeviceId } : {}),
                  modelId: route.model,
                  ...(isPluginEngineEffort(route.effort) ? { effort: route.effort } : {}),
                }
              : null,
            readCatalogue: readPluginEngineCatalogues,
            onSelect: (selection: PluginEngineSelection) => {
              replace(index, {
                harness: 'acp',
                ...(route.agentDeviceId || selection.deviceId ? { agentDeviceId: selection.deviceId ?? null } : {}),
                providerId: selection.providerId,
                model: selection.modelId || PLUGIN_ENGINE_DEFAULT_MODEL,
                effort: selection.effort ?? '',
                fastMode: false,
                modelGroup: undefined,
              });
            },
          } : undefined}
          onUnifiedSelect={(selection) => {
            if (!visibleVendors.includes(selection.engine)) return false;
            const patch: Partial<BotModelRoute> = {
              harness: harnessFor(selection.engine),
              ...(route.agentDeviceId || selection.agentDevice ? { agentDeviceId: selection.agentDevice?.deviceId ?? null } : {}),
              providerId: selection.providerId,
              model: selection.modelId,
              effort: selection.effort ?? '',
              fastMode: selection.fast,
              modelGroup: undefined,
            };
            lastUnified.current = { index, patch };
            replace(index, patch);
            return true;
          }}
          {...(groupsAllowed ? {
            modelGroups: {
              config: groupsConfig,
              active: route.modelGroup && groupsConfig.routes.some((item) => item.id === route.modelGroup)
                ? { type: 'route' as const, id: route.modelGroup }
                : null,
              onSelect: (selection: ModelGroupSelection) => { void pickGroup(index, selection); },
              // 本机伙伴：合并整个供应商的路由像一个供应商列出来，选其中的模型 = 记下这个模型，由路由决定每次用哪个成员。
              ...(localGroups ? {
                onAttach: (selection: ModelGroupSelection) => {
                  const last = lastUnified.current;
                  lastUnified.current = null;
                  if (last?.index !== index) return;
                  replace(index, { ...last.patch, modelGroup: selection.id });
                },
              } : {}),
              // The editor also renders outside a router (tests, settings drawers); the app routes by hash.
              ...(localGroups ? { onManage: () => { window.location.hash = '#/settings?tab=model-groups'; } } : {}),
            },
          } : {})}
          unknownModelLabel={(model) => t('bots.modelUnavailable', { model })}
          unknownModelDescription={t('settings.auxiliaryModels.unavailable')}
        />
        {deviceId && !routeIsPluginEngine && !route.agentDeviceId && route.providerId
          ? (() => {
              const provider = catalog.providers.find((item) => item.id === route.providerId);
              return provider ? (
                <p className="mt-1 break-words px-2 text-12 text-[var(--text-secondary)]">
                  {providerAccountLabel(
                    providerDisplayName(provider, t),
                    provider.openAiAccount?.identity?.trim() ||
                      provider.subscriptionAccount?.identity?.trim(),
                  )}
                </p>
              ) : null;
            })()
          : null}
      </div>
    );
  };
  const fallbackRows = routes.slice(1).map((route, fallbackIndex) => {
    const index = fallbackIndex + 1;
    return (
      <div key={index} className="flex min-w-0 items-start gap-2">
        <span className="w-4 shrink-0 pt-1 text-11 leading-5">{index}</span>
        {picker(route, index)}
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            disabled={disabled || index === 1}
            onClick={() => move(index, -1)}
            aria-label={t('bots.modelChain.moveUp')}
            className="rounded-lg p-1.5 hover:bg-[var(--surface-hover)] disabled:opacity-30"
          >
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            disabled={disabled || index === routes.length - 1}
            onClick={() => move(index, 1)}
            aria-label={t('bots.modelChain.moveDown')}
            className="rounded-lg p-1.5 hover:bg-[var(--surface-hover)] disabled:opacity-30"
          >
            <ArrowDown size={14} />
          </button>
          {routes.length > 1 ? (
            <Tip text={t('bots.modelChain.remove')}>
              <Button
                variant="secondary"
                tone="danger"
                size="sm"
                disabled={disabled}
                onClick={() => onChange(routes.filter((_, at) => at !== index))}
                aria-label={t('bots.modelChain.remove')}
                className="w-7 px-0"
              >
                <Trash2 size={14} aria-hidden />
              </Button>
            </Tip>
          ) : null}
        </div>
      </div>
    );
  });
  const pendingRow: ReactNode =
    pendingRoute && routes.length < BOT_MODEL_CHAIN_MAX ? (
      <div className="flex min-w-0 items-start gap-2">
        {picker(pendingRoute, routes.length)}
        <Button
          variant="secondary"
          tone="quiet"
          size="md"
          compact
          type="button"
          disabled={disabled}
          onClick={() => setPendingRoute(null)}
        >
          {t('bots.cancel')}
        </Button>
      </div>
    ) : null;
  const addDisabled =
    disabled ||
    pendingRoute !== null ||
    routes.length >= BOT_MODEL_CHAIN_MAX ||
    (visibleVendors.length === 0 && !selectablePluginEngine && pluginEngineDevices.length === 0);
  const primaryRoute =
    routes[0] ?? { harness: 'pi' as const, model: '', providerId: null, effort: '', fastMode: false };

  if (layout === 'settings' && settingsRows) {
    const listItems = [...fallbackRows, ...(pendingRow ? [pendingRow] : [])];
    return (
      <div className="min-w-0" data-testid="bot-model-chain-editor" data-setting-id={settingId}>
        <SettingsRow
          className="cindy-segmented-row"
          title={settingsRows.primaryLabel}
          hint={settingsRows.primaryHint}
          trailing={
            <div className="flex min-w-0 max-w-full items-start gap-2">
              {onRestoreDefault ? (
                <DefaultOverrideControls
                  isCustomized
                  disabled={disabled}
                  onReset={() => {
                    if (!disabled) onRestoreDefault();
                  }}
                />
              ) : null}
              {picker(primaryRoute, 0, 'min-w-0')}
            </div>
          }
        />
        {allowFallbacks ? (
          <>
            <SettingsRow
              title={t('bots.modelChain.options', { count: Math.max(0, routes.length - 1) })}
              hint={t('bots.modelChain.description')}
              trailing={
                <Button
                  variant="secondary"
                  size="md"
                  compact
                  type="button"
                  className="shrink-0"
                  disabled={addDisabled}
                  onClick={add}
                >
                  <Plus size={14} />
                  {t('bots.modelChain.add')}
                </Button>
              }
            />
            {listItems.length > 0 ? (
              <div className="space-y-2 px-4 pb-4 text-12 text-[var(--text-tertiary)]">
                {listItems.map((item, at) => (
                  <Fragment key={at}>{item}</Fragment>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="min-w-0" data-testid="bot-model-chain-editor" data-setting-id={settingId}>
      <div className="flex min-w-0 items-start gap-3">
        {label ? (
          <span className="shrink-0 pt-1 text-12 leading-5 text-[var(--text-secondary)]">{label}</span>
        ) : null}
        {picker(primaryRoute, 0)}
      </div>
      {allowFallbacks && <div
        className="mt-1 text-12 text-[var(--text-tertiary)]"
        data-testid="bot-model-fallbacks"
      >
        <p className="py-2">
          {t('bots.modelChain.options', { count: Math.max(0, routes.length - 1) })}
        </p>
        <div className="space-y-2 pt-2">
          {fallbackRows}
          {pendingRow}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="md"
              tone="quiet"
              compact
              type="button"
              disabled={addDisabled}
              onClick={add}
            >
              <Plus size={14} />
              {t('bots.modelChain.add')}
            </Button>
            {onRestoreDefault ? (
              <ResetGroupButton
                disabled={disabled}
                onClick={() => {
                  if (!disabled) onRestoreDefault();
                }}
                label={t('bots.model.restoreDefault')}
              />
            ) : null}
          </div>
        </div>
      </div>}
    </div>
  );
}
